import { PlatformConfig } from 'homebridge';
export declare const PLATFORM_NAME = "SubaruLink";
export declare const PLUGIN_NAME = "homebridge-subarulink";
/**
 * Sanitizes a display/service name so it strictly conforms to Apple HomeKit /
 * `@homebridge/hap-nodejs` v2 naming rules (starts and ends with a letter or number,
 * contains only allowed characters, and is at least 2 characters long).
 */
export declare function sanitizeHapName(raw: string, fallback?: string): string;
export interface SubaruLinkConfig extends PlatformConfig {
    name: string;
    username?: string;
    password?: string;
    pin?: string;
    country?: 'USA' | 'CAN';
    deviceId?: number;
    deviceName?: string;
    vin?: string;
    defaultPreset?: string;
    additionalPresets?: string[];
    engineRunDurationMinutes?: number;
    unlockMode?: 'ALL_DOORS' | 'DRIVERS_DOOR' | 'TAILGATE_DOOR';
    exposeTailgateUnlockSwitch?: boolean;
    exposeHornSwitch?: boolean;
    exposeLightsSwitch?: boolean;
    exposeLocateSwitch?: boolean;
    exposeDoorWindowSensors?: boolean;
    fetchIntervalMinutes?: number;
    updateIntervalMinutes?: number;
    twoFactorContactMethod?: string;
    twoFactorCode?: string;
}
export interface DiscoveredVehicle {
    vin: string;
    name: string;
    model_year: string;
    model_name: string;
    api_gen: string;
    is_ev: boolean;
    has_remote: boolean;
    has_res: boolean;
    has_safety: boolean;
    has_subscription: boolean;
    has_tpms: boolean;
    has_sunroof?: boolean;
    climate_presets: string[];
}
export interface VehicleTelemetry {
    vin: string;
    odometer?: number | null;
    dist_to_empty?: number | null;
    avg_fuel?: number | null;
    remaining_fuel_percent?: number | null;
    battery_voltage?: number | null;
    external_temp?: number | null;
    vehicle_state?: string | null;
    ev_charge_percent?: number | null;
    ev_plug_state?: boolean | string | null;
    ev_charger_state?: string | null;
    doors: Record<string, string>;
    windows: Record<string, string>;
    locks?: Record<string, string>;
    climate_presets?: string[];
    raw: Record<string, unknown>;
}
