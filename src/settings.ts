import { PlatformConfig } from 'homebridge';

export const PLATFORM_NAME = 'SubaruLink';
export const PLUGIN_NAME = 'homebridge-subarulink';

/**
 * Sanitizes a display/service name so it strictly conforms to Apple HomeKit /
 * `@homebridge/hap-nodejs` v2 naming rules (starts and ends with a letter or number,
 * contains only allowed characters, and is at least 2 characters long).
 */
export function sanitizeHapName(raw: string, fallback = 'Subaru'): string {
  const cleaned = raw
    .replace(/[^\p{L}\p{N}\p{Zs}\u2019'&!._:;()/,-]+/gu, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length >= 2) {
    return cleaned;
  }
  if (cleaned.length === 1) {
    return `${fallback} ${cleaned}`;
  }
  return fallback;
}

/**
 * Strips multi-line HTML error bodies, aiohttp RequestInfo dumps (containing cookies/headers),
 * and collapses whitespace so Homebridge logs stay concise and single-line.
 */
export function formatLogError(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : String(err ?? 'Unknown error');

  let msg = raw;
  let endpoint = '';
  const reqIdx = msg.indexOf('RequestInfo(');
  if (reqIdx !== -1) {
    const urlMatch = msg.slice(reqIdx).match(/url=URL\('https?:\/\/[^/]+([^']*)'\)/);
    if (urlMatch?.[1]) {
      endpoint = urlMatch[1];
    }
    msg = msg.slice(0, reqIdx);
  }

  if (/<!DOCTYPE|<html/i.test(msg)) {
    const h1Match = msg.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const titleMatch = msg.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const summary = (h1Match?.[1] || titleMatch?.[1] || '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const prefix = msg
      .split(/<!DOCTYPE|<html/i)[0]
      .trim()
      .replace(/:+$/, '');
    if (summary) {
      msg = prefix ? `${prefix} (${summary})` : summary;
    } else {
      msg = prefix ? `${prefix} (HTML error response)` : 'HTML error response';
    }
  }

  msg = msg.replace(/\s+/g, ' ').trim().replace(/:+$/, '');
  if (endpoint && !msg.includes(endpoint)) {
    msg = `${msg} [${endpoint}]`;
  }
  if (msg.length > 220) {
    msg = `${msg.slice(0, 217)}...`;
  }
  return msg || 'Unknown error';
}

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
