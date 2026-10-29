#!/usr/bin/env node
/**
 * Optional Interactive CLI helper for testing credentials, migrating an existing
 * `subarulink.cfg`, or completing Two-Factor Authentication (2FA) interactively
 * from the Homebridge terminal.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ensurePythonEnvironment, resolveDefaultStorageDir, resolveRuntimeDir } from './bootstrap-python.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const BRIDGE_SCRIPT = path.join(PLUGIN_ROOT, 'python', 'subaru_bridge.py');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => rl.question(question, (ans) => resolve(ans.trim())));
}

function expandHome(inputPath) {
  if (!inputPath) {
    return '';
  }
  if (inputPath === '~') {
    return os.homedir();
  }
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

async function main() {
  console.log('==========================================================');
  console.log('  Homebridge SubaruLink - Interactive Setup & 2FA Helper  ');
  console.log('==========================================================\n');

  const runtimeDir = resolveRuntimeDir();
  const storageDir = path.join(resolveDefaultStorageDir(), 'subarulink');
  const defaultCfgPath = path.join(storageDir, 'subarulink.cfg');

  const pythonBin = ensurePythonEnvironment({ runtimeDir });

  const promptHint = fs.existsSync(defaultCfgPath)
    ? `Enter path to an existing subarulink.cfg [press Enter to use ${defaultCfgPath}, or type 'manual']: `
    : 'If you have an existing subarulink.cfg file, enter its path to import (or press Enter to enter details manually): ';

  const rawCfgInput = await ask(promptHint);
  let existingCfgPath = '';
  if (rawCfgInput.toLowerCase() === 'manual') {
    existingCfgPath = '';
  } else if (rawCfgInput) {
    existingCfgPath = expandHome(rawCfgInput);
  } else if (fs.existsSync(defaultCfgPath)) {
    existingCfgPath = defaultCfgPath;
  }

  let username = '';
  let password = '';
  let pin = '';
  let country = 'USA';
  let deviceId = Math.floor(Date.now() / 1000);
  let deviceName = 'homebridge-subarulink';
  let defaultVin = '';

  if (existingCfgPath && fs.existsSync(existingCfgPath)) {
    const raw = JSON.parse(fs.readFileSync(existingCfgPath, 'utf8'));
    username = raw.username || '';
    password = raw.password || '';
    pin = String(raw.pin || '');
    country = (raw.country || 'USA').toUpperCase();
    deviceId = Number(raw.device_id || deviceId);
    deviceName = raw.device_name || deviceName;
    defaultVin = raw.default_vin || raw.default || '';
    console.log(`\nImported configuration from ${existingCfgPath}!`);
    console.log(`Preserved registered deviceId: ${deviceId} (device_name: ${deviceName})`);
    if (!username) {
      username = await ask('MySubaru Username (email): ');
    }
    if (!password) {
      password = await ask('MySubaru Password: ');
    }
    if (!pin) {
      pin = await ask('MySubaru 4-digit PIN: ');
    }
  } else {
    if (existingCfgPath) {
      console.log(`Config file not found at "${existingCfgPath}". Proceeding with manual entry.\n`);
    }
    username = await ask('MySubaru Username (email): ');
    password = await ask('MySubaru Password: ');
    pin = await ask('MySubaru 4-digit PIN: ');
    const countryInput = await ask('Country (USA or CAN) [default: USA]: ');
    if (countryInput) {
      country = countryInput.toUpperCase();
    }
  }

  const proc = spawn(pythonBin, ['-u', BRIDGE_SCRIPT], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  let reqId = 1;
  const pending = new Map();

  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg.result);
        }
      } catch {
        console.log('[Python]', line);
      }
    }
  });

  proc.on('exit', () => {
    for (const [, { reject }] of pending) {
      reject(new Error('Python bridge process exited'));
    }
    pending.clear();
  });

  function callRpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = reqId++;
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  try {
    console.log('\nConnecting to MySubaru API...');
    const initRes = await callRpc('init', {
      username,
      password,
      pin,
      country,
      vin: defaultVin,
      device_id: deviceId,
      device_name: deviceName,
      state_file: defaultCfgPath,
    });

    if (initRes.status === '2fa_required') {
      console.log('\nDevice is not yet registered with MySubaru. 2FA verification is required.');
      console.log('Available contact methods:', JSON.stringify(initRes.contact_methods, null, 2));
      const methodKey = await ask(
        'Enter the contact method key from above (e.g., userName or phone): ',
      );
      await callRpc('request_2fa', { contact_method: methodKey });
      console.log('Verification code sent! Check your email or SMS.');
      const code = await ask('Enter the 6-digit verification code: ');
      const verifyRes = await callRpc('submit_2fa', { code });
      console.log('2FA Verification result:', verifyRes);
      if (!verifyRes.success) {
        throw new Error('2FA verification failed.');
      }
    } else if (initRes.status !== 'connected') {
      throw new Error(initRes.message || `Unexpected connection status: ${initRes.status}`);
    }

    const status = await callRpc('discover_vehicles');
    console.log('\nSuccessfully authenticated! Discovered Vehicles:');
    for (const v of status.vehicles) {
      console.log(`- ${v.name} (${v.model_year} ${v.model_name}) [VIN: ${v.vin}]`);
      console.log(
        `  API Gen: ${v.api_gen} | Subscription: ${v.has_subscription} | Remote Lock/Wake: ${v.has_remote} | Remote Start: ${v.has_res} | EV: ${v.is_ev}`,
      );
      console.log(`  Available Climate Presets: ${v.climate_presets.join(', ') || 'None'}`);
    }

    console.log('\n==========================================================');
    console.log('Use these values in your Homebridge SubaruLink settings:');
    console.log(`  "deviceId": ${deviceId}`);
    console.log(`  "deviceName": "${deviceName}"`);
    console.log('==========================================================\n');
  } catch (err) {
    console.error('\nError during setup:', err.message);
    process.exitCode = 1;
  } finally {
    await callRpc('shutdown').catch(() => {});
    proc.kill();
    rl.close();
  }
}

main();
