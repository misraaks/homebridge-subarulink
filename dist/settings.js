"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLUGIN_NAME = exports.PLATFORM_NAME = void 0;
exports.sanitizeHapName = sanitizeHapName;
exports.PLATFORM_NAME = 'SubaruLink';
exports.PLUGIN_NAME = 'homebridge-subarulink';
/**
 * Sanitizes a display/service name so it strictly conforms to Apple HomeKit /
 * `@homebridge/hap-nodejs` v2 naming rules (starts and ends with a letter or number,
 * contains only allowed characters, and is at least 2 characters long).
 */
function sanitizeHapName(raw, fallback = 'Subaru') {
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
//# sourceMappingURL=settings.js.map