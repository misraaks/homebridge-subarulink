"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const settings_1 = require("./settings");
const platform_1 = require("./platform");
/**
 * Registers the SubaruLink dynamic platform with Homebridge.
 */
exports.default = (api) => {
    api.registerPlatform(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, platform_1.SubaruLinkPlatform);
};
//# sourceMappingURL=index.js.map