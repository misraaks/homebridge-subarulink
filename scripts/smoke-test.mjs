#!/usr/bin/env node
/**
 * Comprehensive End-to-End Local & Mocked Verification Suite for homebridge-subarulink.
 *
 * Tests:
 * 1. Real `.runtime/venv/bin/python` + `subarulink>=0.7.21` API signature & constant audit.
 * 2. Real `python/subaru_bridge.py` JSON-RPC framing, malformed payload handling, error reporting, and shutdown.
 * 3. Full `SubaruPythonBridge` <-> `subaru_bridge.py` integration using a realistic MockController:
 *    - CLI-compatible `subarulink.cfg` generation (`0600`, `default_vin`, `save_creds`, `remote_start_preset`)
 *    - 2FA workflows (`2fa_required`, case-insensitive `2fa_code_sent`, `two_factor_code` auto-submit)
 *    - `VehicleInfo["vehicle_status"]` extraction (doors, windows, locks, 0-value edge cases, °F -> °C fallback)
 *    - Remote commands (`lock`, `unlock` door modes, case-insensitive `remote_start` preset, `remote_stop`)
 *    - Concurrent non-blocking RPC execution (urgent `lock` finishes while slow `get_telemetry` is running)
 *    - Automatic daemon SIGKILL crash recovery (respawn + automatic re-`init` before next command)
 * 4. Homebridge v2.4.0 API registration & cached `PlatformAccessory` restart resilience
 *    (verifies zero duplicate UUID/subtype errors and stale service pruning).
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const VENV_PYTHON = path.join(PLUGIN_ROOT, '.runtime', 'venv', 'bin', 'python');
const BRIDGE_SCRIPT = path.join(PLUGIN_ROOT, 'python', 'subaru_bridge.py');

const require = createRequire(import.meta.url);
const { SubaruPythonBridge } = require(path.join(PLUGIN_ROOT, 'dist', 'pythonBridge.js'));
const { SubaruLinkPlatform } = require(path.join(PLUGIN_ROOT, 'dist', 'platform.js'));
const { SubaruVehicleAccessory } = require(path.join(PLUGIN_ROOT, 'dist', 'platformAccessory.js'));
const pluginEntry = require(path.join(PLUGIN_ROOT, 'dist', 'index.js'));
const hbDistDir = path.dirname(require.resolve('homebridge'));
const { HomebridgeAPI } = require(path.join(hbDistDir, 'api.js'));

function createSilentLogger() {
  const logs = [];
  const push = (level) => (...args) => {
    logs.push({ level, msg: args.map(String).join(' ') });
  };
  const logger = Object.assign(push('info'), {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    success: push('info'),
    log: push('info'),
    logs,
  });
  return logger;
}

async function testUpstreamPackageSignatures() {
  console.log('1. Verifying isolated Python (>=3.14) & subarulink (>=0.7.21) upstream signatures...');
  assert.ok(fs.existsSync(VENV_PYTHON), `Missing venv python at ${VENV_PYTHON}`);

  const auditJson = execFileSync(
    VENV_PYTHON,
    [
      '-c',
      `
import inspect, json, sys, subarulink, subarulink.const as sc
from subarulink import Controller, controller

info = {
    "python_version": list(sys.version_info[:3]),
    "subarulink_version": subarulink.__version__,
    "init_params": list(inspect.signature(Controller.__init__).parameters.keys()),
    "unlock_params": list(inspect.signature(Controller.unlock).parameters.keys()),
    "remote_start_params": list(inspect.signature(Controller.remote_start).parameters.keys()),
    "vehicle_info_keys": list(controller.VehicleInfo.__annotations__.keys()),
    "vehicle_status_const": sc.VEHICLE_STATUS,
    "doors": {
        "fl": sc.DOOR_FRONT_LEFT_POSITION,
        "fr": sc.DOOR_FRONT_RIGHT_POSITION,
        "rl": sc.DOOR_REAR_LEFT_POSITION,
        "rr": sc.DOOR_REAR_RIGHT_POSITION,
        "boot": sc.DOOR_BOOT_POSITION,
        "hood": sc.DOOR_ENGINE_HOOD_POSITION,
    },
    "unlock_consts": {
        "all": sc.ALL_DOORS,
        "drivers": sc.DRIVERS_DOOR,
        "tailgate": sc.TAILGATE_DOOR,
    },
}
print(json.dumps(info))
`,
    ],
    { encoding: 'utf8' },
  ).trim();

  const audit = JSON.parse(auditJson);
  assert.ok(
    audit.python_version[0] > 3 || (audit.python_version[0] === 3 && audit.python_version[1] >= 14),
    `Expected Python >= 3.14, got ${audit.python_version.join('.')}`,
  );
  assert.deepEqual(audit.init_params, [
    'self',
    'websession',
    'username',
    'password',
    'device_id',
    'pin',
    'device_name',
    'country',
    'update_interval',
    'fetch_interval',
  ]);
  assert.deepEqual(audit.unlock_params, ['self', 'vin', 'door']);
  assert.deepEqual(audit.remote_start_params, ['self', 'vin', 'preset_name']);
  assert.equal(audit.vehicle_status_const, 'vehicle_status');
  assert.ok(audit.vehicle_info_keys.includes('vehicle_status'));
  console.log(
    `   ✓ Verified Python ${audit.python_version.join('.')} + subarulink v${audit.subarulink_version} API signatures & constants`,
  );
}

async function testRawJsonRpcFramingAndErrors() {
  console.log('2. Testing raw JSON-RPC framing, error handling, and clean shutdown...');
  const proc = spawn(VENV_PYTHON, ['-u', BRIDGE_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const responses = [];
  let buf = '';
  let waiter = null;

  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        responses.push(JSON.parse(line));
        if (waiter) waiter();
      }
    }
  });

  const waitForCount = (n) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timed out waiting for ${n} responses`)), 5000);
      const check = () => {
        if (responses.length >= n) {
          clearTimeout(t);
          waiter = null;
          resolve();
        }
      };
      waiter = check;
      check();
    });

  // Malformed JSON, unknown method, uninitialized controller, then shutdown
  proc.stdin.write('not-valid-json\n');
  proc.stdin.write(JSON.stringify({ id: 10, method: 'non_existent_method', params: {} }) + '\n');
  proc.stdin.write(JSON.stringify({ id: 11, method: 'discover_vehicles', params: {} }) + '\n');
  await waitForCount(3);

  const errParse = responses.find((r) => r.id === null);
  assert.ok(errParse?.error?.includes('JSONDecodeError'), 'Expected JSONDecodeError on invalid JSON');

  const errUnknown = responses.find((r) => r.id === 10);
  assert.ok(errUnknown?.error?.includes('Unknown RPC method'));

  const errUninit = responses.find((r) => r.id === 11);
  assert.ok(errUninit?.error?.includes('Controller not initialized'));

  proc.stdin.write(JSON.stringify({ id: 12, method: 'shutdown', params: {} }) + '\n');
  await waitForCount(4);
  const resShutdown = responses.find((r) => r.id === 12);
  assert.deepEqual(resShutdown.result, { shutdown: true });

  const exitCode = await new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  assert.equal(exitCode, 0, 'Expected clean exit code 0 after shutdown RPC');
  console.log('   ✓ Raw JSON-RPC framing, error responses, and clean shutdown passed');
}

function writeMockSitecustomize(dirPath, stateLogPath) {
  const code = `
import asyncio
import datetime
import json
import os
import subarulink
import subarulink.const as sc

LOG_FILE = ${JSON.stringify(stateLogPath)}

def _record(event):
    items = []
    if os.path.exists(LOG_FILE):
        with open(LOG_FILE, "r", encoding="utf-8") as f:
            items = json.load(f)
    items.append(event)
    with open(LOG_FILE, "w", encoding="utf-8") as f:
        json.dump(items, f)

class MockController:
    def __init__(self, websession, username, password, device_id, pin, device_name, country="USA", update_interval=7200, fetch_interval=300):
        self._pin = pin
        self._pin_invalid = False
        self.device_registered = (username != "needs2fa@example.com")
        self.contact_methods = {"userName": "u***@example.com", "phone": "***-***-1234"}
        _record({"type": "init", "username": username, "device_id": device_id, "pid": os.getpid()})

    async def connect(self):
        return True

    async def request_auth_code(self, method):
        _record({"type": "request_2fa", "method": method})
        return method in self.contact_methods

    async def submit_auth_code(self, code):
        _record({"type": "submit_2fa", "code": code})
        if code == "654321":
            self.device_registered = True
            return True
        return False

    def get_vehicles(self):
        return ["JF2BTANC0R0000001", "JF2GTAPC0P0000002"]

    def vin_to_name(self, vin):
        return "Outback XT" if vin.endswith("1") else "Crosstrek PHEV"

    def get_model_year(self, vin):
        return "2025" if vin.endswith("1") else "2024"

    def get_model_name(self, vin):
        return "Outback" if vin.endswith("1") else "Crosstrek Hybrid"

    def get_api_gen(self, vin):
        return "g3" if vin.endswith("1") else "g2"

    def get_ev_status(self, vin):
        return vin.endswith("2")

    def get_remote_status(self, vin):
        return True

    def get_res_status(self, vin):
        return True

    def get_safety_status(self, vin):
        return True

    def get_subscription_status(self, vin):
        return True

    def has_tpms(self, vin):
        return True

    def has_sunroof(self, vin):
        return True

    async def list_climate_preset_names(self, vin):
        return ["Full Heat", "Full Cool", "Auto", "Winter Defrost"]

    async def fetch(self, vin, force=False):
        if os.environ.get("MOCK_SLOW_FETCH") == "1" and not force:
            await asyncio.sleep(0.35)
        return True

    async def update(self, vin, force=False):
        return True

    async def get_data(self, vin):
        return {
            "model_year": self.get_model_year(vin),
            "model_name": self.get_model_name(vin),
            "vehicle_name": self.vin_to_name(vin),
            "vehicle_status": {
                sc.ODOMETER: 0 if vin.endswith("2") else 12450,
                sc.DIST_TO_EMPTY: 0 if vin.endswith("2") else 310,
                sc.AVG_FUEL_CONSUMPTION: "16383" if vin.endswith("2") else 27.4,
                sc.VEHICLE_STATE: sc.IGNITION_OFF,
                sc.DOOR_FRONT_LEFT_POSITION: sc.DOOR_OPEN,
                sc.DOOR_FRONT_RIGHT_POSITION: sc.DOOR_CLOSED,
                sc.DOOR_REAR_LEFT_POSITION: sc.DOOR_CLOSED,
                sc.DOOR_REAR_RIGHT_POSITION: sc.DOOR_CLOSED,
                sc.DOOR_BOOT_POSITION: sc.DOOR_CLOSED,
                sc.DOOR_ENGINE_HOOD_POSITION: sc.NOT_EQUIPPED,
                sc.WINDOW_FRONT_LEFT_STATUS: sc.WINDOW_CLOSED,
                sc.WINDOW_SUNROOF_STATUS: sc.SUNROOF_TILT,
                sc.WINDOW_REAR_LEFT_STATUS: sc.WINDOW_UNKNOWN,
                sc.LOCK_FRONT_LEFT_STATUS: sc.LOCK_UNLOCKED if vin.endswith("1") else sc.LOCK_LOCKED,
                sc.LOCK_FRONT_RIGHT_STATUS: sc.LOCK_LOCKED,
                sc.EV_STATE_OF_CHARGE_PERCENT: 0.0 if vin.endswith("2") else None,
                sc.EV_CHARGER_STATE_TYPE: sc.CHARGING if vin.endswith("2") else None,
                sc.TIMESTAMP: datetime.datetime(2026, 10, 29, 12, 0, tzinfo=datetime.UTC),
            },
        }

    def get_raw_data(self, vin):
        return {
            "condition": {
                "data": {
                    "result": {
                        "externalTempFahrenheit": 68.0,
                        "batteryVoltage": "12.6",
                    }
                }
            }
        }

    def invalid_pin_entered(self):
        return self._pin_invalid

    def update_saved_pin(self, new_pin):
        self._pin = new_pin
        self._pin_invalid = False
        return True

    async def lock(self, vin):
        _record({"type": "cmd", "cmd": "lock", "vin": vin})
        return True

    async def unlock(self, vin, door=sc.ALL_DOORS):
        _record({"type": "cmd", "cmd": "unlock", "vin": vin, "door": door})
        return door in sc.VALID_DOORS

    async def remote_start(self, vin, preset_name):
        _record({"type": "cmd", "cmd": "remote_start", "vin": vin, "preset": preset_name})
        return preset_name in ["Full Heat", "Full Cool", "Auto", "Winter Defrost"]

    async def remote_stop(self, vin):
        _record({"type": "cmd", "cmd": "remote_stop", "vin": vin})
        return True

    async def horn(self, vin):
        return True

    async def horn_stop(self, vin):
        return True

    async def lights(self, vin):
        return True

    async def lights_stop(self, vin):
        return True

    async def charge_start(self, vin):
        return True

subarulink.Controller = MockController
`;
  fs.writeFileSync(path.join(dirPath, 'sitecustomize.py'), code, 'utf8');
}

async function testBridgeLifecycleConcurrencyAndCrashRecovery() {
  console.log('3. Testing SubaruPythonBridge telemetry, commands, 2FA, concurrency, and SIGKILL crash recovery...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-subarulink-test-'));
  const logPath = path.join(tmpDir, 'events.json');
  writeMockSitecustomize(tmpDir, logPath);

  const mockEnv = {
    PYTHONPATH: tmpDir,
    MOCK_SLOW_FETCH: '1',
  };

  try {
    // 3.0 Verify default paths live 100% inside Homebridge storagePath (Verified Plugin requirement)
    const defaultPathCheck = new SubaruPythonBridge(
      createSilentLogger(),
      { platform: 'SubaruLink', name: 'SubaruLink' },
      tmpDir,
    );
    assert.equal(defaultPathCheck.runtimeDir, path.join(tmpDir, 'subarulink', '.runtime'));
    assert.equal(defaultPathCheck.stateFilePath, path.join(tmpDir, 'subarulink', 'subarulink.cfg'));
    assert.equal(
      defaultPathCheck.venvPythonPath,
      path.join(tmpDir, 'subarulink', '.runtime', 'venv', 'bin', 'python'),
    );

    // 3a. Test 2FA flows (2fa_required -> case-insensitive 2fa_code_sent -> 2fa code accepted)
    const logger2fa = createSilentLogger();
    const bridge2faReq = new SubaruPythonBridge(
      logger2fa,
      {
        platform: 'SubaruLink',
        name: 'SubaruLink',
        username: 'needs2fa@example.com',
        password: 'secret',
        pin: '1234',
        twoFactorContactMethod: 'username', // lowercase on purpose to test canonical matching -> 'userName'
      },
      tmpDir,
      { venvPythonPath: VENV_PYTHON, env: mockEnv },
    );
    const reqSent = await bridge2faReq.start();
    assert.equal(reqSent, false, 'Expected start() to return false while waiting for 2FA code');
    await bridge2faReq.stop();

    const bridge2faSubmit = new SubaruPythonBridge(
      logger2fa,
      {
        platform: 'SubaruLink',
        name: 'SubaruLink',
        username: 'needs2fa@example.com',
        password: 'secret',
        pin: '1234',
        twoFactorContactMethod: 'username',
        twoFactorCode: '654321',
      },
      tmpDir,
      { venvPythonPath: VENV_PYTHON, env: mockEnv },
    );
    const codeAccepted = await bridge2faSubmit.start();
    assert.equal(codeAccepted, true, 'Expected start() to return true when valid 2FA code is submitted');
    await bridge2faSubmit.stop();

    // Remove state file from 2FA test so we also verify automatic deviceId generation + persistence
    fs.rmSync(path.join(tmpDir, 'subarulink', 'subarulink.cfg'), { force: true });

    // 3b. Standard session + CLI config parity + telemetry + commands + concurrency + crash recovery
    const logger = createSilentLogger();
    const bridge = new SubaruPythonBridge(
      logger,
      {
        platform: 'SubaruLink',
        name: 'SubaruLink',
        username: 'driver@example.com',
        password: 'secret',
        pin: '1234',
        country: 'USA',
        deviceName: 'homebridge-pi5',
        vin: 'jf2btanc0r0000001',
        defaultPreset: 'Full Heat',
      },
      tmpDir,
      { venvPythonPath: VENV_PYTHON, env: mockEnv },
    );

    const started = await bridge.start();
    assert.equal(started, true);

    // Check CLI-compatible subarulink.cfg
    const cfgPath = path.join(tmpDir, 'subarulink', 'subarulink.cfg');
    assert.ok(fs.existsSync(cfgPath), 'Expected subarulink.cfg to be written');
    const cfgStat = fs.statSync(cfgPath);
    assert.equal(cfgStat.mode & 0o777, 0o600, 'Expected 0600 permissions on subarulink.cfg');
    const cfgData = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.ok(
      Number.isInteger(cfgData.device_id) && cfgData.device_id > 1700000000,
      'Expected auto-generated persistent integer device_id',
    );
    assert.equal(cfgData.default_vin, 'JF2BTANC0R0000001');
    assert.equal(cfgData.save_creds, 'Y');
    assert.equal(cfgData.remote_start_preset, 'Full Heat');

    // Verify a second SubaruPythonBridge instance reuses the persisted device_id from subarulink.cfg
    const bridgeReloadCheck = new SubaruPythonBridge(
      logger,
      {
        platform: 'SubaruLink',
        name: 'SubaruLink',
        username: 'driver@example.com',
        password: 'secret',
        pin: '1234',
      },
      tmpDir,
      { venvPythonPath: VENV_PYTHON, env: mockEnv },
    );
    await bridgeReloadCheck.start();
    const cfgDataReloaded = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.equal(
      cfgDataReloaded.device_id,
      cfgData.device_id,
      'Expected auto-generated device_id to persist across restarts',
    );
    await bridgeReloadCheck.stop();

    const vehicles = await bridge.discoverVehicles();
    assert.equal(vehicles.length, 2);
    assert.equal(vehicles[0].name, 'Outback XT');
    assert.equal(vehicles[1].is_ev, true);

    // Check Outback telemetry (doors, windows, locks, °F -> °C conversion, NOT_EQUIPPED hood filtered)
    const t1 = await bridge.getTelemetry('JF2BTANC0R0000001', { force: true });
    assert.equal(t1.odometer, 12450);
    assert.equal(t1.doors.front_left_door, 'OPEN');
    assert.equal(t1.doors.front_right_door, 'CLOSED');
    assert.equal(t1.doors.hood, undefined, 'NOT_EQUIPPED hood must be omitted');
    assert.equal(t1.windows.front_left_window, 'CLOSE');
    assert.equal(t1.windows.sunroof, 'TILT');
    assert.equal(t1.windows.rear_left_window, undefined, 'UNKNOWN window must be omitted');
    assert.equal(t1.locks.front_left_lock, 'UNLOCKED');
    assert.equal(t1.external_temp, 20.0, 'Expected 68°F converted to 20.0°C');
    assert.equal(t1.battery_voltage, 12.6);

    // Check PHEV zero-value edge cases & BAD_SENSOR_VALUES ("16383") filtering
    const t2 = await bridge.getTelemetry('JF2GTAPC0P0000002', { force: true });
    assert.equal(t2.odometer, 0, 'Odometer 0 must be preserved as 0, not null');
    assert.equal(t2.dist_to_empty, 0, 'DTE 0 must be preserved as 0, not null');
    assert.equal(t2.ev_charge_percent, 0, 'EV charge 0% must be preserved as 0, not null');
    assert.equal(t2.avg_fuel, null, 'Sentinel 16383 must be filtered out as null');

    // Concurrency test: start slow background poll (350ms) and immediately fire urgent lock command
    const t0 = Date.now();
    const slowPollPromise = bridge.getTelemetry('JF2BTANC0R0000001', { wake: false, force: false });
    await new Promise((r) => setTimeout(r, 20));
    const lockOk = await bridge.executeCommand('JF2BTANC0R0000001', 'lock');
    const lockElapsed = Date.now() - t0;
    assert.equal(lockOk, true);
    assert.ok(
      lockElapsed < 250,
      `Expected urgent lock command to finish concurrently (<250ms), took ${lockElapsed}ms`,
    );
    await slowPollPromise;

    // Test case-insensitive preset matching and door unlock constants
    assert.equal(
      await bridge.executeCommand('JF2BTANC0R0000001', 'remote_start', { preset: 'winter defrost' }),
      true,
    );
    assert.equal(
      await bridge.executeCommand('JF2BTANC0R0000001', 'unlock', { door: 'DRIVERS_DOOR' }),
      true,
    );

    // Crash recovery test: SIGKILL the underlying Python daemon and immediately run executeCommand
    const eventsBeforeKill = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    const initCountBefore = eventsBeforeKill.filter((e) => e.type === 'init').length;
    assert.ok(bridge.proc && bridge.proc.pid, 'Expected active Python child process');
    bridge.proc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 60));

    const postCrashOk = await bridge.executeCommand('JF2BTANC0R0000001', 'remote_stop');
    assert.equal(postCrashOk, true, 'Expected command after daemon crash to auto-respawn, re-init, and succeed');

    const eventsAfterKill = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    const initCountAfter = eventsAfterKill.filter((e) => e.type === 'init').length;
    assert.equal(initCountAfter, initCountBefore + 1, 'Expected automatic init RPC after daemon crash');

    await bridge.stop();
    console.log('   ✓ Bridge 2FA, CLI config sync, telemetry, concurrency, and SIGKILL crash recovery passed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testHomebridgeV2CachedAccessoryRestart() {
  console.log('4. Testing Homebridge v2.4.0 API registration & cached PlatformAccessory restart...');
  const hapWarnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => {
    const line = args.map(String).join(' ');
    if (line.includes('HAP-NodeJS WARNING')) {
      hapWarnings.push(line);
    }
    origWarn(...args);
  };

  try {
    const api = new HomebridgeAPI();
    const initializer = typeof pluginEntry === 'function' ? pluginEntry : pluginEntry.default;
    assert.equal(typeof initializer, 'function', 'Plugin entrypoint must export initializer function');
    initializer(api);

    const logger = createSilentLogger();
    const baseConfig = {
      platform: 'SubaruLink',
      name: 'SubaruLink',
      defaultPreset: 'Full Heat',
      additionalPresets: ['Full Cool', 'Auto', 'Morning (Warm)!'],
      exposeTailgateUnlockSwitch: true,
      exposeLightsSwitch: true,
      exposeHornSwitch: true,
      exposeLocateSwitch: true,
      exposeDoorWindowSensors: true,
    };

    // Instantiate platform without credentials so it doesn't auto-launch daemon on didFinishLaunching
    const platform = new SubaruLinkPlatform(logger, baseConfig, api);

    const mockTelemetry = {
      vin: 'JF2GTAPC0P0000002',
      odometer: 8500,
      external_temp: 18.5,
      ev_charge_percent: 82,
      ev_charger_state: 'CHARGING',
      doors: {
        front_left_door: 'OPEN',
        front_right_door: 'CLOSED',
      },
      windows: {
        front_left_window: 'CLOSE',
        sunroof: 'TILT',
      },
      locks: {
        front_left_lock: 'UNLOCKED',
        front_right_lock: 'LOCKED',
      },
      raw: {},
    };

    platform.bridge = {
      hasActiveCommand: () => false,
      getTelemetry: async () => mockTelemetry,
      executeCommand: async () => true,
    };

    const vehicle = {
      vin: 'JF2GTAPC0P0000002',
      name: 'Crosstrek PHEV',
      model_year: '2024',
      model_name: 'Crosstrek Hybrid',
      api_gen: 'g2',
      is_ev: true,
      has_remote: true,
      has_res: true,
      has_safety: true,
      has_subscription: true,
      has_tpms: true,
      has_sunroof: true,
      climate_presets: ['Full Heat', 'Full Cool', 'Auto'],
    };

    const uuid = api.hap.uuid.generate(`subarulink-${vehicle.vin}`);
    const accessory = new api.platformAccessory(vehicle.name, uuid);

    // Boot #1: Fresh accessory
    const handler1 = new SubaruVehicleAccessory(platform, accessory, vehicle);
    await handler1.refreshTelemetry({ force: true });
    accessory._associatedHAPAccessory.validateAccessory(false);

    const { Service, Characteristic } = api.hap;
    assert.equal(
      accessory
        .getServiceById(Service.ContactSensor, 'sensor-front_left_door')
        .getCharacteristic(Characteristic.ContactSensorState).value,
      Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    );
    assert.equal(
      accessory
        .getServiceById(Service.ContactSensor, 'sensor-front_left_window')
        .getCharacteristic(Characteristic.ContactSensorState).value,
      Characteristic.ContactSensorState.CONTACT_DETECTED,
    );
    assert.equal(
      accessory
        .getServiceById(Service.ContactSensor, 'sensor-sunroof')
        .getCharacteristic(Characteristic.ContactSensorState).value,
      Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    );
    assert.equal(
      accessory
        .getServiceById(Service.LockMechanism, 'lock-doors')
        .getCharacteristic(Characteristic.LockCurrentState).value,
      Characteristic.LockCurrentState.UNSECURED,
    );
    assert.equal(
      accessory
        .getServiceById(Service.TemperatureSensor, 'ext-temp')
        .getCharacteristic(Characteristic.CurrentTemperature).value,
      18.5,
    );
    assert.equal(
      accessory
        .getServiceById(Service.Battery, 'ev-battery')
        .getCharacteristic(Characteristic.BatteryLevel).value,
      82,
    );
    handler1.dispose();

    // Boot #2: Simulated Homebridge restart with cached accessory AND modified config
    platform.config.defaultPreset = 'Winter Defrost';
    platform.config.additionalPresets = ['Full Cool']; // 'Auto' and 'Morning (Warm)!' removed!
    platform.config.exposeHornSwitch = false; // Horn disabled!

    const handler2 = new SubaruVehicleAccessory(platform, accessory, vehicle);
    accessory._associatedHAPAccessory.validateAccessory(false);

    assert.equal(
      accessory.getServiceById(Service.Switch, 'remote-start-auto'),
      undefined,
      'Removed additionalPreset switch should be pruned from cached accessory',
    );
    assert.equal(
      accessory.getServiceById(Service.Switch, 'remote-start-morning-warm'),
      undefined,
      'Removed custom preset switch should be pruned from cached accessory',
    );
    assert.equal(
      accessory.getServiceById(Service.Switch, 'panic-horn'),
      undefined,
      'Disabled horn switch should be pruned from cached accessory',
    );
    assert.equal(
      accessory
        .getServiceById(Service.Switch, 'remote-start-primary')
        .getCharacteristic(Characteristic.ConfiguredName).value,
      'Crosstrek PHEV Remote Start - Winter Defrost',
    );
    assert.deepEqual(hapWarnings, [], `Unexpected HAP-NodeJS warnings: ${hapWarnings.join('; ')}`);
    handler2.dispose();
    console.log('   ✓ Homebridge v2.4.0 cached PlatformAccessory restart, HAP name validation & service pruning passed');
  } finally {
    console.warn = origWarn;
  }
}

async function main() {
  console.log('==============================================================');
  console.log('  homebridge-subarulink End-to-End Verification Smoke Suite   ');
  console.log('==============================================================');
  await testUpstreamPackageSignatures();
  await testRawJsonRpcFramingAndErrors();
  await testBridgeLifecycleConcurrencyAndCrashRecovery();
  await testHomebridgeV2CachedAccessoryRestart();
  console.log('==============================================================');
  console.log('  ALL SMOKE & INTEGRATION TESTS PASSED!                       ');
  console.log('==============================================================');
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err);
  process.exitCode = 1;
});
