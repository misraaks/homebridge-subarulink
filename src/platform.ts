import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  Service,
  Characteristic,
} from 'homebridge';
import {
  DiscoveredVehicle,
  PLATFORM_NAME,
  PLUGIN_NAME,
  SubaruLinkConfig,
  sanitizeHapName,
} from './settings';
import { SubaruPythonBridge } from './pythonBridge';
import { SubaruVehicleAccessory } from './platformAccessory';

export class SubaruLinkPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];
  public bridge!: SubaruPythonBridge;
  private pollTimer?: NodeJS.Timeout;
  private wakeTimer?: NodeJS.Timeout;
  private activeAccessories = new Map<string, SubaruVehicleAccessory>();

  constructor(
    public readonly log: Logger,
    public readonly config: SubaruLinkConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    if (!this.config || !this.config.username || !this.config.password || !this.config.pin) {
      this.log.warn(
        'SubaruLink is not fully configured yet. Please provide your MySubaru username, password, and 4-digit PIN in the Homebridge UI.',
      );
      return;
    }

    this.bridge = new SubaruPythonBridge(
      this.log,
      this.config,
      this.api.user.storagePath(),
    );

    this.api.on('didFinishLaunching', () => {
      this.initializePlatform().catch((err) => {
        this.log.error('Unexpected error initializing SubaruLink platform:', err);
      });
    });

    this.api.on('shutdown', () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }
      if (this.wakeTimer) {
        clearInterval(this.wakeTimer);
        this.wakeTimer = undefined;
      }
      for (const handler of this.activeAccessories.values()) {
        handler.dispose();
      }
      this.bridge?.stop().catch(() => {});
    });
  }

  public configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading cached accessory:', accessory.displayName);
    this.accessories.push(accessory);
  }

  private async initializePlatform(): Promise<void> {
    const ready = await this.bridge.start();
    if (!ready) {
      return;
    }

    const vehicles = await this.bridge.discoverVehicles();
    if (!vehicles.length) {
      this.log.warn('No vehicles were found on your MySubaru account.');
      return;
    }

    const configuredVin = (this.config.vin || '').trim().toUpperCase();
    const targetVehicles = configuredVin
      ? vehicles.filter((v) => v.vin.toUpperCase() === configuredVin)
      : vehicles.filter((v) => v.has_subscription);

    if (!targetVehicles.length) {
      this.log.warn(
        `No matching active vehicles found (configured VIN: ${configuredVin || 'All'}). Falling back to all discovered vehicles.`,
      );
      targetVehicles.push(...vehicles);
    }

    const discoveredUuids = new Set<string>();

    for (const vehicle of targetVehicles) {
      const uuid = this.api.hap.uuid.generate(`subarulink-${vehicle.vin}`);
      discoveredUuids.add(uuid);

      const existingAccessory = this.accessories.find((acc) => acc.UUID === uuid);
      if (existingAccessory) {
        this.log.info(
          `Restoring existing vehicle accessory: ${vehicle.name} (${vehicle.vin})`,
        );
        existingAccessory.context.vehicle = vehicle;
        const handler = new SubaruVehicleAccessory(this, existingAccessory, vehicle);
        this.activeAccessories.set(vehicle.vin, handler);
        this.api.updatePlatformAccessories([existingAccessory]);
      } else {
        this.log.info(
          `Adding new vehicle accessory: ${vehicle.name} (${vehicle.model_year} ${vehicle.model_name} - ${vehicle.vin})`,
        );
        const safeName = sanitizeHapName(vehicle.name, 'Subaru');
        const accessory = new this.api.platformAccessory(safeName, uuid);
        accessory.context.vehicle = vehicle;
        const handler = new SubaruVehicleAccessory(this, accessory, vehicle);
        this.activeAccessories.set(vehicle.vin, handler);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      // Perform initial non-waking server cache fetch
      const handler = this.activeAccessories.get(vehicle.vin);
      if (handler) {
        await handler.refreshTelemetry({ wake: false, force: true });
      }
    }

    // Remove stale accessories no longer in targetVehicles
    for (const cachedAccessory of [...this.accessories]) {
      if (!discoveredUuids.has(cachedAccessory.UUID)) {
        this.log.info('Removing stale cached accessory:', cachedAccessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          cachedAccessory,
        ]);
      }
    }

    this.setupPollingTimers(targetVehicles);
  }

  private setupPollingTimers(vehicles: DiscoveredVehicle[]): void {
    const fetchMinutes = Math.max(5, this.config.fetchIntervalMinutes ?? 15);
    this.log.info(
      `Scheduled non-waking MySubaru server cache poll every ${fetchMinutes} minutes.`,
    );

    this.pollTimer = setInterval(() => {
      void (async () => {
        for (const v of vehicles) {
          const handler = this.activeAccessories.get(v.vin);
          if (handler) {
            await handler.refreshTelemetry({ wake: false, force: false });
          }
        }
      })();
    }, fetchMinutes * 60 * 1000);
    this.pollTimer.unref?.();

    const updateMinutes = this.config.updateIntervalMinutes ?? 0;
    if (updateMinutes > 0) {
      const safeUpdateMinutes = Math.max(60, updateMinutes);
      this.log.warn(
        `Scheduled active vehicle DCM wake poll (Controller.update) every ${safeUpdateMinutes} minutes. Monitor your 12V battery if the car sits undriven for several days.`,
      );
      this.wakeTimer = setInterval(() => {
        void (async () => {
          for (const v of vehicles) {
            const handler = this.activeAccessories.get(v.vin);
            if (handler) {
              await handler.refreshTelemetry({ wake: true, force: true });
            }
          }
        })();
      }, safeUpdateMinutes * 60 * 1000);
      this.wakeTimer.unref?.();
    }
  }
}
