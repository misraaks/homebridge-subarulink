import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, Service, Characteristic } from 'homebridge';
import { SubaruLinkConfig } from './settings';
import { SubaruPythonBridge } from './pythonBridge';
export declare class SubaruLinkPlatform implements DynamicPlatformPlugin {
    readonly log: Logger;
    readonly config: SubaruLinkConfig;
    readonly api: API;
    readonly Service: typeof Service;
    readonly Characteristic: typeof Characteristic;
    readonly accessories: PlatformAccessory[];
    bridge: SubaruPythonBridge;
    private pollTimer?;
    private wakeTimer?;
    private activeAccessories;
    constructor(log: Logger, config: SubaruLinkConfig, api: API);
    configureAccessory(accessory: PlatformAccessory): void;
    private initializePlatform;
    private setupPollingTimers;
}
