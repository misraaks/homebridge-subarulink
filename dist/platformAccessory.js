"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubaruVehicleAccessory = void 0;
const settings_1 = require("./settings");
const DOOR_SENSOR_DEFS = [
    { key: 'front_left_door', label: 'Front Left Door' },
    { key: 'front_right_door', label: 'Front Right Door' },
    { key: 'rear_left_door', label: 'Rear Left Door' },
    { key: 'rear_right_door', label: 'Rear Right Door' },
    { key: 'boot', label: 'Trunk / Tailgate' },
    { key: 'hood', label: 'Engine Hood' },
];
const WINDOW_SENSOR_LABELS = {
    front_left_window: 'Front Left Window',
    front_right_window: 'Front Right Window',
    rear_left_window: 'Rear Left Window',
    rear_right_window: 'Rear Right Window',
    sunroof: 'Sunroof',
};
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
class SubaruVehicleAccessory {
    platform;
    accessory;
    vehicle;
    lockService;
    primaryResSwitch;
    presetSwitches = new Map();
    tailgateSwitch;
    lightsSwitch;
    hornSwitch;
    locateSwitch;
    evChargeSwitch;
    evBatteryService;
    tempSensorService;
    contactSensors = new Map();
    // Internal states
    lockTargetState;
    lockCurrentState;
    lockCommandInFlight = false;
    engineRunning = false;
    activePreset = null;
    engineTimer;
    lightsTimer;
    lightsActive = false;
    hornActive = false;
    isRefreshing = false;
    constructor(platform, accessory, vehicle) {
        this.platform = platform;
        this.accessory = accessory;
        this.vehicle = vehicle;
        const { Service, Characteristic } = this.platform;
        this.lockTargetState = Characteristic.LockTargetState.SECURED;
        this.lockCurrentState = Characteristic.LockCurrentState.SECURED;
        // 1. Accessory Information
        this.accessory
            .getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Name, (0, settings_1.sanitizeHapName)(this.vehicle.name, 'Subaru'))
            .setCharacteristic(Characteristic.Manufacturer, 'Subaru')
            .setCharacteristic(Characteristic.Model, `${this.vehicle.model_year} ${this.vehicle.model_name}`)
            .setCharacteristic(Characteristic.SerialNumber, this.vehicle.vin)
            .setCharacteristic(Characteristic.FirmwareRevision, this.vehicle.api_gen);
        // 2. Door Lock Service (if vehicle has remote capability)
        if (this.vehicle.has_remote) {
            const lockName = (0, settings_1.sanitizeHapName)(`${this.vehicle.name} Doors`);
            this.lockService =
                this.accessory.getServiceById(Service.LockMechanism, 'lock-doors') ||
                    this.accessory.getService(Service.LockMechanism) ||
                    this.accessory.addService(Service.LockMechanism, lockName, 'lock-doors');
            this.configureServiceName(this.lockService, lockName);
            this.lockService
                .getCharacteristic(Characteristic.LockCurrentState)
                .onGet(() => this.lockCurrentState);
            this.lockService
                .getCharacteristic(Characteristic.LockTargetState)
                .onGet(() => this.lockTargetState)
                .onSet(this.handleLockTargetSet.bind(this));
        }
        else {
            this.removeServiceIfPresent(Service.LockMechanism, 'lock-doors');
        }
        // 3. Remote Engine / Climate Start Switches (if vehicle has RES or is EV)
        const activePresetSubtypes = new Set();
        if (this.vehicle.has_res || this.vehicle.is_ev) {
            const defaultPreset = (this.platform.config.defaultPreset || 'Full Heat').trim() || 'Full Heat';
            const primaryName = (0, settings_1.sanitizeHapName)(`${this.vehicle.name} Remote Start - ${defaultPreset}`);
            activePresetSubtypes.add('remote-start-primary');
            this.primaryResSwitch = this.getOrAddService(Service.Switch, primaryName, 'remote-start-primary');
            this.primaryResSwitch
                .getCharacteristic(Characteristic.On)
                .onGet(() => this.engineRunning && this.activePreset === defaultPreset)
                .onSet((val) => this.handleRemoteStartSet(defaultPreset, val));
            // Additional Preset Switches
            const extraPresets = this.platform.config.additionalPresets || [];
            for (const preset of extraPresets) {
                const cleanPreset = preset.trim();
                if (!cleanPreset || cleanPreset.toLowerCase() === defaultPreset.toLowerCase()) {
                    continue;
                }
                const slug = cleanPreset
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-+|-+$/g, '');
                if (!slug || slug === 'primary') {
                    continue;
                }
                const subType = `remote-start-${slug}`;
                if (activePresetSubtypes.has(subType)) {
                    continue;
                }
                activePresetSubtypes.add(subType);
                const switchName = (0, settings_1.sanitizeHapName)(`${this.vehicle.name} Start - ${cleanPreset}`);
                const svc = this.getOrAddService(Service.Switch, switchName, subType);
                svc
                    .getCharacteristic(Characteristic.On)
                    .onGet(() => this.engineRunning && this.activePreset === cleanPreset)
                    .onSet((val) => this.handleRemoteStartSet(cleanPreset, val));
                this.presetSwitches.set(cleanPreset, svc);
            }
        }
        // Prune any stale cached remote-start switches no longer configured
        for (const svc of [...this.accessory.services]) {
            if (svc.UUID === Service.Switch.UUID &&
                svc.subtype?.startsWith('remote-start-') &&
                !activePresetSubtypes.has(svc.subtype)) {
                this.accessory.removeService(svc);
            }
        }
        // 4. Optional Tailgate Unlock Momentary Switch
        if (this.vehicle.has_remote && this.platform.config.exposeTailgateUnlockSwitch) {
            const name = `${this.vehicle.name} Unlock Tailgate`;
            this.tailgateSwitch = this.getOrAddService(Service.Switch, name, 'unlock-tailgate');
            this.tailgateSwitch
                .getCharacteristic(Characteristic.On)
                .onGet(() => false)
                .onSet(this.handleTailgateUnlock.bind(this));
        }
        else {
            this.removeServiceIfPresent(Service.Switch, 'unlock-tailgate');
        }
        // 5. Optional Hazard Lights Switch
        if (this.vehicle.has_remote && (this.platform.config.exposeLightsSwitch ?? true)) {
            const name = `${this.vehicle.name} Flash Lights`;
            this.lightsSwitch = this.getOrAddService(Service.Switch, name, 'flash-lights');
            this.lightsSwitch
                .getCharacteristic(Characteristic.On)
                .onGet(() => this.lightsActive)
                .onSet(this.handleLightsSet.bind(this));
        }
        else {
            this.removeServiceIfPresent(Service.Switch, 'flash-lights');
        }
        // 6. Optional Panic Horn Switch
        if (this.vehicle.has_remote && this.platform.config.exposeHornSwitch) {
            const name = `${this.vehicle.name} Horn`;
            this.hornSwitch = this.getOrAddService(Service.Switch, name, 'panic-horn');
            this.hornSwitch
                .getCharacteristic(Characteristic.On)
                .onGet(() => this.hornActive)
                .onSet(this.handleHornSet.bind(this));
        }
        else {
            this.removeServiceIfPresent(Service.Switch, 'panic-horn');
        }
        // 7. Optional Force Wake / Poll Switch (`Controller.update`)
        if (this.vehicle.has_remote && (this.platform.config.exposeLocateSwitch ?? true)) {
            const name = `${this.vehicle.name} Refresh Vehicle Status`;
            this.locateSwitch = this.getOrAddService(Service.Switch, name, 'force-wake-poll');
            this.locateSwitch
                .getCharacteristic(Characteristic.On)
                .onGet(() => false)
                .onSet(this.handleForceWakePoll.bind(this));
        }
        else {
            this.removeServiceIfPresent(Service.Switch, 'force-wake-poll');
        }
        // 8. PHEV / EV Charge Start Switch & Battery Level Service
        if (this.vehicle.is_ev) {
            const chargeName = `${this.vehicle.name} EV Charge`;
            this.evChargeSwitch = this.getOrAddService(Service.Switch, chargeName, 'ev-charge-start');
            this.evChargeSwitch
                .getCharacteristic(Characteristic.On)
                .onGet(() => false)
                .onSet(this.handleEvChargeStart.bind(this));
            const batName = `${this.vehicle.name} EV Battery`;
            this.evBatteryService = this.getOrAddService(Service.Battery, batName, 'ev-battery');
        }
        else {
            this.removeServiceIfPresent(Service.Switch, 'ev-charge-start');
            this.removeServiceIfPresent(Service.Battery, 'ev-battery');
        }
        // 9. Door, Boot, Hood & Window Contact Sensors
        if (this.platform.config.exposeDoorWindowSensors ?? true) {
            for (const def of DOOR_SENSOR_DEFS) {
                const subType = `sensor-${def.key}`;
                const sensorName = `${this.vehicle.name} ${def.label}`;
                const svc = this.getOrAddService(Service.ContactSensor, sensorName, subType);
                this.contactSensors.set(def.key, svc);
            }
            // Restore any cached dynamic window/sunroof contact sensors
            for (const [winKey, label] of Object.entries(WINDOW_SENSOR_LABELS)) {
                const subType = `sensor-${winKey}`;
                const existingWin = this.accessory.getServiceById(Service.ContactSensor, subType);
                if (existingWin) {
                    this.configureServiceName(existingWin, `${this.vehicle.name} ${label}`);
                    this.contactSensors.set(winKey, existingWin);
                }
            }
        }
        else {
            for (const svc of [...this.accessory.services]) {
                if (svc.UUID === Service.ContactSensor.UUID && svc.subtype?.startsWith('sensor-')) {
                    this.accessory.removeService(svc);
                }
            }
        }
        // Restore cached Exterior Temperature Sensor if present
        const existingTemp = this.accessory.getServiceById(Service.TemperatureSensor, 'ext-temp');
        if (existingTemp) {
            this.configureServiceName(existingTemp, `${this.vehicle.name} Exterior Temp`);
            this.tempSensorService = existingTemp;
        }
    }
    dispose() {
        if (this.engineTimer) {
            clearTimeout(this.engineTimer);
            this.engineTimer = undefined;
        }
        if (this.lightsTimer) {
            clearTimeout(this.lightsTimer);
            this.lightsTimer = undefined;
        }
    }
    getOrAddService(serviceClass, displayName, subType) {
        const safeName = (0, settings_1.sanitizeHapName)(displayName);
        const svc = this.accessory.getServiceById(serviceClass, subType) ||
            this.accessory.addService(serviceClass, safeName, subType);
        this.configureServiceName(svc, safeName);
        return svc;
    }
    configureServiceName(service, displayName) {
        const { Characteristic } = this.platform;
        const safeName = (0, settings_1.sanitizeHapName)(displayName);
        service.setCharacteristic(Characteristic.Name, safeName);
        if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
            service.addOptionalCharacteristic(Characteristic.ConfiguredName);
        }
        service.setCharacteristic(Characteristic.ConfiguredName, safeName);
    }
    removeServiceIfPresent(serviceType, subType) {
        const existing = this.accessory.getServiceById(serviceType, subType);
        if (existing) {
            this.accessory.removeService(existing);
        }
    }
    async handleLockTargetSet(value) {
        const { Characteristic } = this.platform;
        const targetSecured = value === Characteristic.LockTargetState.SECURED;
        this.lockTargetState = Number(value);
        this.lockCommandInFlight = true;
        try {
            if (targetSecured) {
                this.platform.log.info(`[${this.vehicle.name}] Sending remote LOCK command...`);
                const ok = await this.platform.bridge.executeCommand(this.vehicle.vin, 'lock');
                if (ok) {
                    this.lockCurrentState = Characteristic.LockCurrentState.SECURED;
                    this.lockService?.updateCharacteristic(Characteristic.LockCurrentState, this.lockCurrentState);
                    this.platform.log.info(`[${this.vehicle.name}] Vehicle LOCKED successfully.`);
                }
                else {
                    throw new this.platform.api.hap.HapStatusError(-70402 /* this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE */);
                }
            }
            else {
                const unlockMode = this.platform.config.unlockMode || 'ALL_DOORS';
                this.platform.log.info(`[${this.vehicle.name}] Sending remote UNLOCK (${unlockMode}) command...`);
                const ok = await this.platform.bridge.executeCommand(this.vehicle.vin, 'unlock', {
                    door: unlockMode,
                });
                if (ok) {
                    this.lockCurrentState = Characteristic.LockCurrentState.UNSECURED;
                    this.lockService?.updateCharacteristic(Characteristic.LockCurrentState, this.lockCurrentState);
                    this.platform.log.info(`[${this.vehicle.name}] Vehicle UNLOCKED (${unlockMode}).`);
                }
                else {
                    throw new this.platform.api.hap.HapStatusError(-70402 /* this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE */);
                }
            }
        }
        catch (err) {
            if (err instanceof this.platform.api.hap.HapStatusError) {
                throw err;
            }
            this.platform.log.error(`[${this.vehicle.name}] Lock/unlock command failed:`, err);
            throw new this.platform.api.hap.HapStatusError(-70402 /* this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE */);
        }
        finally {
            this.lockCommandInFlight = false;
        }
    }
    async handleRemoteStartSet(presetName, value) {
        const turnOn = Boolean(value);
        try {
            if (turnOn) {
                this.platform.log.info(`[${this.vehicle.name}] Sending REMOTE START command with preset "${presetName}"...`);
                const ok = await this.platform.bridge.executeCommand(this.vehicle.vin, 'remote_start', { preset: presetName });
                if (!ok) {
                    this.syncRemoteStartSwitches();
                    throw new this.platform.api.hap.HapStatusError(-70402 /* this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE */);
                }
                this.engineRunning = true;
                this.activePreset = presetName;
                this.syncRemoteStartSwitches();
                const runMinutes = Math.max(1, Math.min(20, this.platform.config.engineRunDurationMinutes ?? 10));
                if (this.engineTimer) {
                    clearTimeout(this.engineTimer);
                }
                this.engineTimer = setTimeout(() => {
                    this.platform.log.info(`[${this.vehicle.name}] Remote start ${runMinutes}-minute cycle finished; resetting HomeKit switch state to Off.`);
                    this.engineRunning = false;
                    this.activePreset = null;
                    this.syncRemoteStartSwitches();
                }, runMinutes * 60 * 1000);
                this.engineTimer.unref?.();
                this.platform.log.info(`[${this.vehicle.name}] Remote Start (${presetName}) active for ${runMinutes} minutes.`);
            }
            else {
                this.platform.log.info(`[${this.vehicle.name}] Sending REMOTE STOP command...`);
                if (this.engineTimer) {
                    clearTimeout(this.engineTimer);
                    this.engineTimer = undefined;
                }
                const ok = await this.platform.bridge.executeCommand(this.vehicle.vin, 'remote_stop');
                this.engineRunning = false;
                this.activePreset = null;
                this.syncRemoteStartSwitches();
                if (!ok) {
                    throw new this.platform.api.hap.HapStatusError(-70402 /* this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE */);
                }
                this.platform.log.info(`[${this.vehicle.name}] Engine stopped.`);
            }
        }
        catch (err) {
            if (err instanceof this.platform.api.hap.HapStatusError) {
                throw err;
            }
            this.platform.log.error(`[${this.vehicle.name}] Remote start/stop failed:`, err);
            this.syncRemoteStartSwitches();
            throw new this.platform.api.hap.HapStatusError(-70402 /* this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE */);
        }
    }
    syncRemoteStartSwitches() {
        const { Characteristic } = this.platform;
        const defaultPreset = (this.platform.config.defaultPreset || 'Full Heat').trim() || 'Full Heat';
        this.primaryResSwitch?.updateCharacteristic(Characteristic.On, this.engineRunning && this.activePreset === defaultPreset);
        for (const [preset, svc] of this.presetSwitches.entries()) {
            svc.updateCharacteristic(Characteristic.On, this.engineRunning && this.activePreset === preset);
        }
    }
    async handleTailgateUnlock(value) {
        if (!value) {
            return;
        }
        this.platform.log.info(`[${this.vehicle.name}] Unlocking Tailgate...`);
        let ok = false;
        try {
            ok = await this.platform.bridge.executeCommand(this.vehicle.vin, 'unlock', {
                door: 'TAILGATE_DOOR',
            });
        }
        catch (err) {
            this.platform.log.error(`[${this.vehicle.name}] Tailgate unlock failed:`, err);
        }
        finally {
            const t = setTimeout(() => {
                this.tailgateSwitch?.updateCharacteristic(this.platform.Characteristic.On, false);
            }, 1000);
            t.unref?.();
        }
        if (!ok) {
            throw new this.platform.api.hap.HapStatusError(-70402 /* this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE */);
        }
    }
    async handleLightsSet(value) {
        const turnOn = Boolean(value);
        const cmd = turnOn ? 'lights' : 'lights_stop';
        this.platform.log.info(`[${this.vehicle.name}] Sending ${cmd} command...`);
        let ok = false;
        try {
            ok = await this.platform.bridge.executeCommand(this.vehicle.vin, cmd);
        }
        catch (err) {
            this.platform.log.error(`[${this.vehicle.name}] ${cmd} command failed:`, err);
        }
        if (!ok) {
            throw new this.platform.api.hap.HapStatusError(-70402 /* this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE */);
        }
        this.lightsActive = turnOn;
        if (this.lightsTimer) {
            clearTimeout(this.lightsTimer);
            this.lightsTimer = undefined;
        }
        if (turnOn) {
            this.lightsTimer = setTimeout(() => {
                this.lightsActive = false;
                this.lightsSwitch?.updateCharacteristic(this.platform.Characteristic.On, false);
            }, 15000);
            this.lightsTimer.unref?.();
        }
    }
    async handleHornSet(value) {
        const turnOn = Boolean(value);
        const cmd = turnOn ? 'horn' : 'horn_stop';
        this.platform.log.info(`[${this.vehicle.name}] Sending ${cmd} command...`);
        let ok = false;
        try {
            ok = await this.platform.bridge.executeCommand(this.vehicle.vin, cmd);
        }
        catch (err) {
            this.platform.log.error(`[${this.vehicle.name}] ${cmd} command failed:`, err);
        }
        if (!ok) {
            throw new this.platform.api.hap.HapStatusError(-70402 /* this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE */);
        }
        this.hornActive = turnOn;
    }
    async handleForceWakePoll(value) {
        if (!value) {
            return;
        }
        this.platform.log.info(`[${this.vehicle.name}] Waking vehicle telematics module (Controller.update) to pull fresh sensor status...`);
        try {
            await this.refreshTelemetry({ wake: true, force: true });
        }
        finally {
            const t = setTimeout(() => {
                this.locateSwitch?.updateCharacteristic(this.platform.Characteristic.On, false);
            }, 1000);
            t.unref?.();
        }
    }
    async handleEvChargeStart(value) {
        if (!value) {
            return;
        }
        this.platform.log.info(`[${this.vehicle.name}] Starting PHEV/EV Charging...`);
        let ok = false;
        try {
            ok = await this.platform.bridge.executeCommand(this.vehicle.vin, 'charge_start');
        }
        catch (err) {
            this.platform.log.error(`[${this.vehicle.name}] EV charge_start failed:`, err);
        }
        finally {
            const t = setTimeout(() => {
                this.evChargeSwitch?.updateCharacteristic(this.platform.Characteristic.On, false);
            }, 1500);
            t.unref?.();
        }
        if (!ok) {
            throw new this.platform.api.hap.HapStatusError(-70402 /* this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE */);
        }
    }
    async refreshTelemetry(options = {}) {
        if (!options.wake && !options.force && this.platform.bridge.hasActiveCommand()) {
            this.platform.log.debug(`[${this.vehicle.name}] Deferring background cache poll while a remote command is in flight.`);
            return;
        }
        if (this.isRefreshing && !options.wake) {
            this.platform.log.debug(`[${this.vehicle.name}] Telemetry refresh already in progress; skipping duplicate poll.`);
            return;
        }
        this.isRefreshing = true;
        try {
            const telemetry = await this.platform.bridge.getTelemetry(this.vehicle.vin, options);
            const { Characteristic, Service } = this.platform;
            // 1. Update Door, Boot & Hood Contact Sensors (ignore UNKNOWN / NOT_EQUIPPED)
            if (this.platform.config.exposeDoorWindowSensors ?? true) {
                for (const def of DOOR_SENSOR_DEFS) {
                    const svc = this.contactSensors.get(def.key);
                    const doorStatus = telemetry.doors?.[def.key]?.toUpperCase();
                    if (!svc || !doorStatus) {
                        continue;
                    }
                    if (doorStatus === 'OPEN') {
                        svc.updateCharacteristic(Characteristic.ContactSensorState, Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
                    }
                    else if (doorStatus === 'CLOSED' || doorStatus === 'CLOSE') {
                        svc.updateCharacteristic(Characteristic.ContactSensorState, Characteristic.ContactSensorState.CONTACT_DETECTED);
                    }
                }
                // 2. Dynamically create/update Power Window & Sunroof Contact Sensors when reported
                for (const [winKey, label] of Object.entries(WINDOW_SENSOR_LABELS)) {
                    const winStatus = telemetry.windows?.[winKey]?.toUpperCase();
                    if (!winStatus) {
                        continue;
                    }
                    let svc = this.contactSensors.get(winKey);
                    if (!svc) {
                        const subType = `sensor-${winKey}`;
                        const sensorName = `${this.vehicle.name} ${label}`;
                        svc = this.getOrAddService(Service.ContactSensor, sensorName, subType);
                        this.contactSensors.set(winKey, svc);
                    }
                    const isClosed = winStatus === 'CLOSE' || winStatus === 'CLOSED';
                    svc.updateCharacteristic(Characteristic.ContactSensorState, isClosed
                        ? Characteristic.ContactSensorState.CONTACT_DETECTED
                        : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
                }
            }
            // 3. Sync Lock Mechanism State if vehicle reports valid LOCKED / UNLOCKED status
            if (this.lockService && !this.lockCommandInFlight && telemetry.locks) {
                const lockValues = Object.values(telemetry.locks)
                    .map((v) => v.toUpperCase())
                    .filter((v) => v === 'LOCKED' || v === 'UNLOCKED');
                if (lockValues.length > 0) {
                    const anyUnlocked = lockValues.includes('UNLOCKED');
                    this.lockCurrentState = anyUnlocked
                        ? Characteristic.LockCurrentState.UNSECURED
                        : Characteristic.LockCurrentState.SECURED;
                    this.lockTargetState = anyUnlocked
                        ? Characteristic.LockTargetState.UNSECURED
                        : Characteristic.LockTargetState.SECURED;
                    this.lockService.updateCharacteristic(Characteristic.LockCurrentState, this.lockCurrentState);
                    this.lockService.updateCharacteristic(Characteristic.LockTargetState, this.lockTargetState);
                }
            }
            // 4. Update Exterior Temperature Sensor if reported (strictly °C within HAP bounds [-270, 100])
            if (typeof telemetry.external_temp === 'number' && Number.isFinite(telemetry.external_temp)) {
                const clampedTempC = Math.max(-270, Math.min(100, telemetry.external_temp));
                if (!this.tempSensorService) {
                    const tempName = `${this.vehicle.name} Exterior Temp`;
                    this.tempSensorService = this.getOrAddService(Service.TemperatureSensor, tempName, 'ext-temp');
                }
                this.tempSensorService.updateCharacteristic(Characteristic.CurrentTemperature, clampedTempC);
            }
            // 5. Update EV Battery Service if vehicle is EV/PHEV
            if (this.evBatteryService &&
                typeof telemetry.ev_charge_percent === 'number' &&
                Number.isFinite(telemetry.ev_charge_percent)) {
                const level = Math.max(0, Math.min(100, Math.round(telemetry.ev_charge_percent)));
                this.evBatteryService.updateCharacteristic(Characteristic.BatteryLevel, level);
                this.evBatteryService.updateCharacteristic(Characteristic.StatusLowBattery, level < 20
                    ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                    : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
                const isCharging = String(telemetry.ev_charger_state || '').toUpperCase() === 'CHARGING';
                this.evBatteryService.updateCharacteristic(Characteristic.ChargingState, isCharging
                    ? Characteristic.ChargingState.CHARGING
                    : Characteristic.ChargingState.NOT_CHARGING);
            }
            this.platform.log.debug(`[${this.vehicle.name}] Telemetry refreshed (odometer=${telemetry.odometer ?? 'N/A'}, state=${telemetry.vehicle_state ?? 'N/A'})`);
        }
        catch (err) {
            this.platform.log.warn(`[${this.vehicle.name}] Could not refresh vehicle telemetry: ${err.message}`);
        }
        finally {
            this.isRefreshing = false;
        }
    }
}
exports.SubaruVehicleAccessory = SubaruVehicleAccessory;
//# sourceMappingURL=platformAccessory.js.map