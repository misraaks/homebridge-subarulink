import { API } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { SubaruLinkPlatform } from './platform';

/**
 * Registers the SubaruLink dynamic platform with Homebridge.
 */
export default (api: API) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, SubaruLinkPlatform);
};