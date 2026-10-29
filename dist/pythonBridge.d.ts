import { Logger } from 'homebridge';
import { DiscoveredVehicle, SubaruLinkConfig, VehicleTelemetry } from './settings';
export interface SubaruPythonBridgeOptions {
    runtimeDir?: string;
    venvPythonPath?: string;
    bridgeScriptPath?: string;
    env?: NodeJS.ProcessEnv;
}
export type SubaruRemoteCommand = 'lock' | 'unlock' | 'remote_start' | 'remote_stop' | 'horn' | 'horn_stop' | 'lights' | 'lights_stop' | 'charge_start' | 'update' | 'fetch';
/**
 * Manages the isolated Python (>=3.14) virtual environment inside Homebridge's
 * storage directory (`<storagePath>/subarulink/.runtime`) and communicates with
 * `python/subaru_bridge.py` over newline-delimited JSON-RPC, including automatic
 * daemon crash recovery and controller re-initialization.
 */
export declare class SubaruPythonBridge {
    private readonly log;
    private readonly config;
    private proc;
    private reqCounter;
    private pending;
    private stdoutBuffer;
    private initialized;
    private stopping;
    private initPromise;
    private activeCommands;
    private resolvedDeviceId?;
    private readonly pluginRoot;
    readonly subaruStorageDir: string;
    readonly runtimeDir: string;
    readonly venvPythonPath: string;
    readonly stateFilePath: string;
    private readonly bridgeScriptPath;
    private readonly bootstrapScriptPath;
    private readonly customEnv?;
    constructor(log: Logger, config: SubaruLinkConfig, storagePath: string, options?: SubaruPythonBridgeOptions);
    hasActiveCommand(): boolean;
    /**
     * Resolves a stable integer `device_id` for MySubaru:
     * 1. Explicit `config.deviceId` from Homebridge settings if provided.
     * 2. Previously persisted `device_id` in `<storagePath>/subarulink/subarulink.cfg` if present.
     * 3. Newly generated timestamp-based 10-digit integer (persisted to `subarulink.cfg` on `init`).
     */
    private resolveDeviceId;
    private buildInitParams;
    /**
     * Asynchronously runs `scripts/bootstrap-python.mjs` without blocking the Homebridge event loop.
     */
    private bootstrapRuntime;
    /**
     * Ensures the isolated `<storagePath>/subarulink/.runtime/venv` with Python >=3.14 +
     * subarulink>=0.7.21 exists, then spawns and initializes the persistent Python bridge process.
     */
    start(): Promise<boolean>;
    private ensureInitialized;
    private spawnDaemon;
    discoverVehicles(): Promise<DiscoveredVehicle[]>;
    getTelemetry(vin: string, options?: {
        wake?: boolean;
        force?: boolean;
    }): Promise<VehicleTelemetry>;
    executeCommand(vin: string, command: SubaruRemoteCommand, args?: Record<string, unknown>): Promise<boolean>;
    stop(): Promise<void>;
    private callRpc;
    private sendRpc;
}
