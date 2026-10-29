import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Logger } from 'homebridge';
import { DiscoveredVehicle, SubaruLinkConfig, VehicleTelemetry } from './settings';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timer: NodeJS.Timeout;
}

export interface SubaruPythonBridgeOptions {
  runtimeDir?: string;
  venvPythonPath?: string;
  bridgeScriptPath?: string;
  env?: NodeJS.ProcessEnv;
}

export type SubaruRemoteCommand =
  | 'lock'
  | 'unlock'
  | 'remote_start'
  | 'remote_stop'
  | 'horn'
  | 'horn_stop'
  | 'lights'
  | 'lights_stop'
  | 'charge_start'
  | 'update'
  | 'fetch';

/**
 * Manages the isolated Python (>=3.14) virtual environment inside Homebridge's
 * storage directory (`<storagePath>/subarulink/.runtime`) and communicates with
 * `python/subaru_bridge.py` over newline-delimited JSON-RPC, including automatic
 * daemon crash recovery and controller re-initialization.
 */
export class SubaruPythonBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private reqCounter = 1;
  private pending = new Map<number, PendingRequest>();
  private stdoutBuffer = '';
  private initialized = false;
  private stopping = false;
  private initPromise: Promise<boolean> | null = null;
  private activeCommands = 0;
  private resolvedDeviceId?: number;

  private readonly pluginRoot: string;
  public readonly subaruStorageDir: string;
  public readonly runtimeDir: string;
  public readonly venvPythonPath: string;
  public readonly stateFilePath: string;
  private readonly bridgeScriptPath: string;
  private readonly bootstrapScriptPath: string;
  private readonly customEnv?: NodeJS.ProcessEnv;

  constructor(
    private readonly log: Logger,
    private readonly config: SubaruLinkConfig,
    storagePath: string,
    options?: SubaruPythonBridgeOptions,
  ) {
    this.pluginRoot = path.resolve(__dirname, '..');
    this.subaruStorageDir = path.join(storagePath, 'subarulink');
    this.runtimeDir = options?.runtimeDir ?? path.join(this.subaruStorageDir, '.runtime');
    this.venvPythonPath =
      options?.venvPythonPath ?? path.join(this.runtimeDir, 'venv', 'bin', 'python');
    this.bridgeScriptPath =
      options?.bridgeScriptPath ?? path.join(this.pluginRoot, 'python', 'subaru_bridge.py');
    this.bootstrapScriptPath = path.join(this.pluginRoot, 'scripts', 'bootstrap-python.mjs');
    this.stateFilePath = path.join(this.subaruStorageDir, 'subarulink.cfg');
    this.customEnv = options?.env;
  }

  public hasActiveCommand(): boolean {
    return this.activeCommands > 0;
  }

  /**
   * Resolves a stable integer `device_id` for MySubaru:
   * 1. Explicit `config.deviceId` from Homebridge settings if provided.
   * 2. Previously persisted `device_id` in `<storagePath>/subarulink/subarulink.cfg` if present.
   * 3. Newly generated timestamp-based 10-digit integer (persisted to `subarulink.cfg` on `init`).
   */
  private resolveDeviceId(): number {
    if (typeof this.config.deviceId === 'number' && Number.isInteger(this.config.deviceId) && this.config.deviceId > 0) {
      return this.config.deviceId;
    }
    if (this.resolvedDeviceId) {
      return this.resolvedDeviceId;
    }
    if (fs.existsSync(this.stateFilePath)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf8'));
        const savedId = Number(saved?.device_id);
        if (Number.isInteger(savedId) && savedId > 0) {
          this.resolvedDeviceId = savedId;
          return savedId;
        }
      } catch {
        // Ignore unreadable state file; generate fresh ID below
      }
    }
    this.resolvedDeviceId = Math.floor(Date.now() / 1000);
    return this.resolvedDeviceId;
  }

  private buildInitParams(): Record<string, unknown> {
    const fetchIntervalSeconds = Math.max(60, (this.config.fetchIntervalMinutes ?? 15) * 60);
    const updateIntervalSeconds =
      this.config.updateIntervalMinutes && this.config.updateIntervalMinutes > 0
        ? Math.max(300, this.config.updateIntervalMinutes * 60)
        : 7200;

    return {
      username: this.config.username,
      password: this.config.password,
      pin: this.config.pin,
      country: this.config.country ?? 'USA',
      device_id: this.resolveDeviceId(),
      device_name: this.config.deviceName ?? 'homebridge-subarulink',
      vin: this.config.vin ?? '',
      default_preset: this.config.defaultPreset ?? 'Full Heat',
      fetch_interval: fetchIntervalSeconds,
      update_interval: updateIntervalSeconds,
      two_factor_contact_method: this.config.twoFactorContactMethod ?? '',
      two_factor_code: this.config.twoFactorCode ?? '',
      state_file: this.stateFilePath,
    };
  }

  /**
   * Asynchronously runs `scripts/bootstrap-python.mjs` without blocking the Homebridge event loop.
   */
  private bootstrapRuntime(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [this.bootstrapScriptPath, '--runtime-dir', this.runtimeDir],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: this.customEnv ? { ...process.env, ...this.customEnv } : process.env,
        },
      );

      const forwardLines = (chunk: Buffer, isErr: boolean) => {
        const lines = chunk
          .toString('utf8')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        for (const line of lines) {
          if (isErr) {
            this.log.debug('[bootstrap]', line);
          } else {
            this.log.info(line.replace(/^\[homebridge-subarulink:bootstrap\]\s*/, ''));
          }
        }
      };

      child.stdout.on('data', (chunk: Buffer) => forwardLines(chunk, false));
      child.stderr.on('data', (chunk: Buffer) => forwardLines(chunk, true));
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Bootstrap script exited with code ${code}`));
        }
      });
    });
  }

  /**
   * Ensures the isolated `<storagePath>/subarulink/.runtime/venv` with Python >=3.14 +
   * subarulink>=0.7.21 exists, then spawns and initializes the persistent Python bridge process.
   */
  public async start(): Promise<boolean> {
    this.stopping = false;

    if (!fs.existsSync(this.venvPythonPath)) {
      this.log.info(
        `Provisioning isolated Python (>=3.14) + subarulink runtime in ${this.runtimeDir} (first-time setup takes ~15-30s)...`,
      );
      try {
        await this.bootstrapRuntime();
      } catch (err: any) {
        this.log.error('Failed to bootstrap isolated Python environment:', err.message);
        return false;
      }
    }

    try {
      return await this.ensureInitialized(true);
    } catch (err: any) {
      this.log.error('Failed to initialize MySubaru Python bridge:', err.message);
      return false;
    }
  }

  private async ensureInitialized(isInitialStart: boolean): Promise<boolean> {
    if (this.initialized && this.proc && this.proc.stdin.writable) {
      return true;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      if (!this.proc || !this.proc.stdin.writable) {
        this.spawnDaemon();
      }

      const initParams = this.buildInitParams();
      const initResult = await this.sendRpc('init', initParams, 60000);

      if (initResult.status === '2fa_required') {
        this.log.warn('====================================================================');
        this.log.warn(
          `MySubaru Two-Factor Authentication (2FA) is required for Device ID ${initParams.device_id}!`,
        );
        this.log.warn(
          'Available Contact Methods:',
          JSON.stringify(initResult.contact_methods, null, 2),
        );
        this.log.warn(
          'To complete 2FA: Open the SubaruLink plugin settings -> "Device Identity & Two-Factor Authentication (2FA)", enter one of the contact method keys above under "2FA Contact Method", and restart Homebridge.',
        );
        this.log.warn('====================================================================');
        return false;
      }

      if (initResult.status === '2fa_code_sent') {
        this.log.warn('====================================================================');
        this.log.warn(
          `2FA verification code has been sent via "${initResult.requested_method}"!`,
        );
        this.log.warn(
          'Check your SMS/Email, enter the 6-digit code into the plugin settings under "2FA 6-Digit Verification Code", and restart Homebridge.',
        );
        this.log.warn('====================================================================');
        return false;
      }

      if (initResult.status === '2fa_failed') {
        this.log.error(initResult.message || '2FA verification failed.');
        return false;
      }

      if (initResult.status !== 'connected') {
        this.log.error('Failed to connect to MySubaru API.');
        return false;
      }

      this.initialized = true;
      if (isInitialStart) {
        this.log.info(
          `Connected to MySubaru API using embedded subarulink v${initResult.version} (Device ID: ${initParams.device_id})`,
        );
      } else {
        this.log.info(
          `Re-initialized MySubaru API session after bridge restart (subarulink v${initResult.version}).`,
        );
      }
      return true;
    })();

    try {
      return await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private spawnDaemon(): void {
    if (this.proc) {
      const oldProc = this.proc;
      this.proc = null;
      this.initialized = false;
      try {
        oldProc.kill();
      } catch {
        // Ignore kill error on dead process
      }
    }

    this.stdoutBuffer = '';
    this.initialized = false;

    const child = spawn(this.venvPythonPath, ['-u', this.bridgeScriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.customEnv ? { ...process.env, ...this.customEnv } : process.env,
    });
    this.proc = child;

    child.stdin.on('error', (err) => {
      if (!this.stopping) {
        this.log.debug('[subarulink-python stdin error]', err.message);
      }
    });

    child.on('error', (err) => {
      if (this.proc === child) {
        this.log.error('Failed to spawn subarulink Python bridge process:', err.message);
      }
    });

    child.stdout.on('data', (chunk: Buffer) => {
      if (this.proc !== child) {
        return;
      }
      this.stdoutBuffer += chunk.toString('utf8');
      let newlineIdx: number;
      while ((newlineIdx = this.stdoutBuffer.indexOf('\n')) >= 0) {
        const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
        if (!line) {
          continue;
        }
        try {
          const msg = JSON.parse(line);
          if (msg.id && this.pending.has(msg.id)) {
            const req = this.pending.get(msg.id)!;
            clearTimeout(req.timer);
            this.pending.delete(msg.id);
            if (msg.error) {
              req.reject(new Error(msg.error));
            } else {
              req.resolve(msg.result);
            }
          }
        } catch {
          this.log.debug('[Python stdout]', line);
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const msg = chunk.toString('utf8').trim();
      if (msg) {
        this.log.debug('[subarulink-python]', msg);
      }
    });

    child.on('exit', (code, signal) => {
      if (this.proc !== child) {
        return;
      }
      if (this.stopping) {
        this.log.debug(`subarulink Python bridge stopped cleanly (code=${code}, signal=${signal})`);
      } else {
        this.log.warn(`subarulink Python bridge exited unexpectedly (code=${code}, signal=${signal})`);
      }
      this.initialized = false;
      this.proc = null;
      for (const [, req] of this.pending) {
        clearTimeout(req.timer);
        req.reject(new Error('Python daemon process terminated unexpectedly'));
      }
      this.pending.clear();
    });
  }

  public async discoverVehicles(): Promise<DiscoveredVehicle[]> {
    const res = await this.callRpc('discover_vehicles', {}, 45000);
    return res.vehicles || [];
  }

  public async getTelemetry(
    vin: string,
    options: { wake?: boolean; force?: boolean } = {},
  ): Promise<VehicleTelemetry> {
    return this.callRpc(
      'get_telemetry',
      {
        vin,
        wake: Boolean(options.wake),
        force: Boolean(options.force),
      },
      90000,
    );
  }

  public async executeCommand(
    vin: string,
    command: SubaruRemoteCommand,
    args: Record<string, unknown> = {},
  ): Promise<boolean> {
    this.activeCommands++;
    try {
      const res = await this.callRpc(
        'command',
        {
          vin,
          command,
          args,
        },
        90000,
      );
      return Boolean(res?.success);
    } finally {
      this.activeCommands = Math.max(0, this.activeCommands - 1);
    }
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    this.initialized = false;
    if (!this.proc) {
      return;
    }
    const child = this.proc;
    try {
      if (child.stdin.writable) {
        await this.sendRpc('shutdown', {}, 5000);
      }
    } catch {
      // Ignore shutdown timeout
    }
    try {
      child.kill();
    } catch {
      // Ignore kill error
    }
    if (this.proc === child) {
      this.proc = null;
    }
  }

  private async callRpc(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 60000,
  ): Promise<any> {
    if (this.stopping && method !== 'shutdown') {
      throw new Error('SubaruPythonBridge is shutting down');
    }

    if (method !== 'init' && method !== 'shutdown') {
      if (!this.proc || !this.proc.stdin.writable || !this.initialized) {
        this.log.warn(
          `Python bridge is not initialized before "${method}"; respawning and re-authenticating...`,
        );
        const ready = await this.ensureInitialized(false);
        if (!ready) {
          throw new Error(`Unable to initialize MySubaru controller for RPC "${method}"`);
        }
      }
    }

    return this.sendRpc(method, params, timeoutMs);
  }

  private sendRpc(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 60000,
  ): Promise<any> {
    if (!this.proc || !this.proc.stdin.writable) {
      this.spawnDaemon();
    }

    return new Promise((resolve, reject) => {
      const id = this.reqCounter++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC call "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      const payload = JSON.stringify({ id, method, params }) + '\n';
      this.proc!.stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }
}
