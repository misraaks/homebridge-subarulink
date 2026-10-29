import { PlatformAccessory } from 'homebridge';
import { SubaruLinkPlatform } from './platform';
import { DiscoveredVehicle } from './settings';
/**
 * Represents a single Subaru vehicle in HomeKit with support for:
 * - Door Lock Mechanism (`lock` / `unlock` with configurable door mode + telemetry lock sync)
 * - Primary Remote Start & Stop Switch (`remote_start` with default preset / `remote_stop`)
 * - Additional Climate Preset Switches (`remote_start` with specific preset / `remote_stop`)
 * - Optional Tailgate Unlock Switch (`unlock` with `TAILGATE_DOOR`)
 * - Optional Flash Lights Switch (`lights` / `lights_stop`)
 * - Optional Panic Horn Switch (`horn` / `horn_stop`)
 * - Optional Force Vehicle Wake & Poll Switch (`update` + `fetch`)
 * - Optional PHEV Charge Start Switch (`charge_start`)
 * - EV Battery Service (for Crosstrek PHEV / EV models)
 * - Door, Trunk, Hood & Power Window / Sunroof Contact Sensors
 * - Optional Exterior Temperature Sensor (if reported by vehicle/API in °C)
 */
export declare class SubaruVehicleAccessory {
    private readonly platform;
    private readonly accessory;
    private readonly vehicle;
    private lockService?;
    private primaryResSwitch?;
    private presetSwitches;
    private tailgateSwitch?;
    private lightsSwitch?;
    private hornSwitch?;
    private locateSwitch?;
    private evChargeSwitch?;
    private evBatteryService?;
    private tempSensorService?;
    private contactSensors;
    private lockTargetState;
    private lockCurrentState;
    private lockCommandInFlight;
    private engineRunning;
    private activePreset;
    private engineTimer?;
    private lightsTimer?;
    private lightsActive;
    private hornActive;
    private isRefreshing;
    constructor(platform: SubaruLinkPlatform, accessory: PlatformAccessory, vehicle: DiscoveredVehicle);
    dispose(): void;
    private getOrAddService;
    private configureServiceName;
    private removeServiceIfPresent;
    private handleLockTargetSet;
    private handleRemoteStartSet;
    private syncRemoteStartSwitches;
    private handleTailgateUnlock;
    private handleLightsSet;
    private handleHornSet;
    private handleForceWakePoll;
    private handleEvChargeStart;
    refreshTelemetry(options?: {
        wake?: boolean;
        force?: boolean;
    }): Promise<void>;
}
