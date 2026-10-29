#!/usr/bin/env node
/**
 * Self-contained runtime bootstrapper for homebridge-subarulink.
 *
 * Provisions everything inside Homebridge's storage directory (`<storagePath>/subarulink/.runtime`)
 * when launched by the plugin (or a caller-specified `--runtime-dir`):
 * 1. Standalone `uv` binary in `<runtimeDir>/bin/uv` (auto-updated via `uv self update`).
 * 2. Standalone CPython (>=3.14) in `<runtimeDir>/python`.
 * 3. Dedicated virtual environment `<runtimeDir>/venv` with `subarulink>=0.7.21`.
 *
 * Nothing modifies system Python, global `node_modules`, or requires root/sudo privileges.
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PYTHON_SPEC = process.env.SUBARULINK_PYTHON_SPEC || '>=3.14';

function log(msg) {
  console.log(`[homebridge-subarulink:bootstrap] ${msg}`);
}

export function resolveDefaultStorageDir() {
  if (process.env.UIX_STORAGE_PATH) {
    return process.env.UIX_STORAGE_PATH;
  }
  if (fs.existsSync('/var/lib/homebridge')) {
    try {
      fs.accessSync('/var/lib/homebridge', fs.constants.W_OK);
      return '/var/lib/homebridge';
    } catch {
      // Not writable by current user; fall back to ~/.homebridge
    }
  }
  return path.join(os.homedir(), '.homebridge');
}

export function resolveRuntimeDir(explicitDir) {
  if (explicitDir) {
    return path.resolve(explicitDir);
  }
  if (process.env.SUBARULINK_RUNTIME_DIR) {
    return path.resolve(process.env.SUBARULINK_RUNTIME_DIR);
  }
  const argIdx = process.argv.indexOf('--runtime-dir');
  if (argIdx >= 0 && process.argv[argIdx + 1]) {
    return path.resolve(process.argv[argIdx + 1]);
  }
  return path.join(resolveDefaultStorageDir(), 'subarulink', '.runtime');
}

function findSystemUvBinary() {
  const candidates = [
    process.env.HOME ? path.join(process.env.HOME, '.local', 'bin', 'uv') : null,
    process.env.HOME ? path.join(process.env.HOME, '.cargo', 'bin', 'uv') : null,
    '/usr/local/bin/uv',
    '/usr/bin/uv',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  try {
    const whichUv = execSync('command -v uv', { encoding: 'utf8' }).trim();
    if (whichUv && fs.existsSync(whichUv)) {
      return whichUv;
    }
  } catch {
    // Not in PATH
  }

  return null;
}

function ensureUvBinary(binDir) {
  const localUv = path.join(binDir, 'uv');

  if (fs.existsSync(localUv)) {
    log(`Checking for uv updates at ${localUv}...`);
    try {
      execFileSync(localUv, ['self', 'update'], { stdio: 'inherit' });
      return localUv;
    } catch {
      try {
        execFileSync(localUv, ['--version'], { stdio: 'ignore' });
        return localUv;
      } catch {
        log('Existing local uv binary is not executable on this host; reinstalling...');
        fs.rmSync(localUv, { force: true });
      }
    }
  }

  fs.mkdirSync(binDir, { recursive: true });
  log(`Installing latest standalone 'uv' binary into ${binDir}...`);
  try {
    execSync('curl -LsSf https://astral.sh/uv/install.sh | sh', {
      stdio: 'inherit',
      env: {
        ...process.env,
        UV_INSTALL_DIR: binDir,
        INSTALLER_NO_MODIFY_PATH: '1',
        UV_NO_MODIFY_PATH: '1',
      },
    });
    if (fs.existsSync(localUv)) {
      return localUv;
    }
  } catch (err) {
    const fallback = findSystemUvBinary();
    if (fallback) {
      log(`Local uv download failed (${err.message}); falling back to system uv at ${fallback}`);
      return fallback;
    }
    throw new Error(`Failed to install uv into ${localUv}: ${err.message}`, { cause: err });
  }

  const fallback = findSystemUvBinary();
  if (fallback) {
    return fallback;
  }
  throw new Error(`Failed to provision uv binary in ${localUv}`);
}

function isVenvHealthy(venvPython, managedPythonPath) {
  if (!fs.existsSync(venvPython)) {
    return false;
  }
  try {
    const currentReal = fs.realpathSync(venvPython);
    const managedReal = fs.realpathSync(managedPythonPath);
    if (currentReal !== managedReal) {
      return false;
    }
    const ok = execFileSync(
      venvPython,
      ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 14) else 1)'],
      { encoding: 'utf8' },
    );
    return ok !== undefined;
  } catch {
    return false;
  }
}

export function ensurePythonEnvironment(options = {}) {
  const runtimeDir = resolveRuntimeDir(options.runtimeDir);
  const binDir = path.join(runtimeDir, 'bin');
  const pythonInstallDir = path.join(runtimeDir, 'python');
  const venvDir = path.join(runtimeDir, 'venv');
  const venvPython = path.join(venvDir, 'bin', 'python');

  fs.mkdirSync(runtimeDir, { recursive: true });

  const uvBin = ensureUvBinary(binDir);
  log(`Using uv binary at: ${uvBin}`);

  const uvEnv = {
    ...process.env,
    UV_PYTHON_INSTALL_DIR: pythonInstallDir,
  };
  delete uvEnv.UV_PYTHON_PREFERENCE;

  // Step 1: Ensure latest standalone Python (>=3.14) is installed in <runtimeDir>/python
  log(`Ensuring latest standalone Python (${PYTHON_SPEC}) runtime is installed...`);
  execFileSync(uvBin, ['python', 'install', '--managed-python', '--no-bin', '--upgrade', PYTHON_SPEC], {
    stdio: 'inherit',
    env: uvEnv,
  });

  const managedPythonPath = execFileSync(
    uvBin,
    ['python', 'find', '--managed-python', PYTHON_SPEC],
    { encoding: 'utf8', env: uvEnv },
  ).trim();

  // Step 2: Create or refresh virtual environment pointing to the managed Python (>=3.14)
  if (!isVenvHealthy(venvPython, managedPythonPath)) {
    log(`Creating isolated virtual environment at ${venvDir} using ${managedPythonPath}...`);
    execFileSync(
      uvBin,
      ['venv', '--managed-python', '--clear', '--python', managedPythonPath, venvDir],
      {
        stdio: 'inherit',
        env: uvEnv,
      },
    );
  }

  // Step 3: Install or upgrade subarulink inside the virtual environment
  log('Installing/updating latest subarulink (>=0.7.21) inside isolated venv...');
  execFileSync(
    uvBin,
    ['pip', 'install', '--python', venvPython, '--upgrade', 'subarulink>=0.7.21'],
    {
      stdio: 'inherit',
      env: uvEnv,
    },
  );

  // Verify Python & subarulink versions
  const infoOut = execFileSync(
    venvPython,
    [
      '-c',
      'import platform, subarulink; print(f"{platform.python_version()}|{getattr(subarulink, \'__version__\', \'unknown\')}")',
    ],
    { encoding: 'utf8' },
  ).trim();
  const [pyVer, subaruVer] = infoOut.split('|');

  log(`Successfully provisioned subarulink v${subaruVer} on standalone Python ${pyVer} at ${runtimeDir}`);
  return venvPython;
}

// Run immediately if invoked directly via `node scripts/bootstrap-python.mjs`
const invokedScript = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedScript === __filename) {
  try {
    ensurePythonEnvironment();
  } catch (err) {
    console.error('[homebridge-subarulink:bootstrap] Bootstrap failed:', err);
    process.exitCode = 1;
  }
}
