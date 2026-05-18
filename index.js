'use strict';

const VizioClient = require('./lib/vizio-client');

const PLUGIN_NAME = 'homebridge-vizio';
const PLATFORM_NAME = 'VizioDisplay';
const DEFAULT_DEVICE_NAME = 'Vizio Display';
const INPUT_IDENTIFIER = 1;
const WAKE_GRACE_PERIOD = 60000;
const OFF_SETTLE_PERIOD = 30000;
const ACTIVE_CACHE_TTL = 10000;

let Service;
let Characteristic;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;

  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, VizioPlatform);
};

class VizioPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];

    if (!config) {
      this.log.warn('No VizioDisplay configuration found.');
      return;
    }

    this.api.on('didFinishLaunching', () => {
      this.publishTelevisions();
    });
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  publishTelevisions() {
    const devices = normalizeDevices(this.config);
    const publishedAccessories = [];

    if (devices.length === 0) {
      this.log.warn('No Vizio displays are configured.');
      return;
    }

    for (const deviceConfig of devices) {
      if (!deviceConfig.address) {
        this.log.warn(`Device ${deviceConfig.name}: address is missing; skipping.`);
        continue;
      }

      if (!deviceConfig.token) {
        this.log.warn(`Device ${deviceConfig.name}: access token is missing; pair the display before publishing it.`);
        continue;
      }

      const accessory = this.createTelevisionAccessory(deviceConfig);
      publishedAccessories.push(accessory);
    }

    this.unregisterStaleAccessories(publishedAccessories);

    if (publishedAccessories.length === 0) {
      this.log.warn('No complete Vizio display configurations were found; nothing was published.');
      return;
    }

    this.api.publishExternalAccessories(PLUGIN_NAME, publishedAccessories);
  }

  createTelevisionAccessory(deviceConfig) {
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${deviceConfig.address}`);
    const accessory = this.accessories.find((cached) => cached.UUID === uuid)
      || new this.api.platformAccessory(deviceConfig.name, uuid, this.api.hap.Categories.TELEVISION);

    accessory.category = this.api.hap.Categories.TELEVISION;
    accessory.displayName = deviceConfig.name;
    accessory.context = accessory.context || {};
    accessory.context.address = deviceConfig.address;
    accessory.context.name = deviceConfig.name;

    new VizioTelevisionAccessory(this, accessory, deviceConfig);

    this.log.info(`Published ${deviceConfig.name} as an external Television accessory.`);
    return accessory;
  }

  unregisterStaleAccessories(publishedAccessories) {
    if (!this.api.unregisterPlatformAccessories) {
      return;
    }

    const activeUUIDs = new Set(publishedAccessories.map((accessory) => accessory.UUID));
    const staleAccessories = this.accessories.filter((accessory) => !activeUUIDs.has(accessory.UUID));

    if (staleAccessories.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
    }
  }
}

class VizioTelevisionAccessory {
  constructor(platform, accessory, config) {
    this.platform = platform;
    this.log = platform.log;
    this.accessory = accessory;
    this.config = config;
    this.name = config.name || DEFAULT_DEVICE_NAME;
    this.pendingWakeUntil = 0;
    this.pendingOffUntil = 0;
    this.activeState = null;
    this.activeStateUpdatedAt = 0;
    this.powerCommand = null;
    this.powerCommandDesiredState = null;
    this.client = new VizioClient(config.address, config.token, {
      timeout: config.requestTimeout,
    });

    this.configureInformationService();
    this.configureTelevisionService();
    this.configureInputSourceService();
    this.removeUnsupportedServices();
  }

  configureInformationService() {
    this.accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Vizio')
      .setCharacteristic(Characteristic.Model, 'SmartCast Display')
      .setCharacteristic(Characteristic.Name, this.name)
      .setCharacteristic(Characteristic.SerialNumber, this.config.address);
  }

  configureTelevisionService() {
    this.televisionService = this.accessory.getService(Service.Television)
      || this.accessory.addService(Service.Television, this.name, 'Television');

    this.televisionService
      .setCharacteristic(Characteristic.ConfiguredName, this.name)
      .setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE)
      .setCharacteristic(Characteristic.ActiveIdentifier, INPUT_IDENTIFIER);

    this.televisionService.getCharacteristic(Characteristic.Active)
      .on('get', this.getActive.bind(this))
      .on('set', this.setActive.bind(this));

    this.televisionService.getCharacteristic(Characteristic.ActiveIdentifier)
      .on('set', this.setActiveIdentifier.bind(this));

    this.televisionService.getCharacteristic(Characteristic.RemoteKey)
      .on('set', this.setRemoteKey.bind(this));
  }

  configureInputSourceService() {
    const inputService = this.accessory.getServiceById(Service.InputSource, 'SmartCast')
      || this.accessory.addService(Service.InputSource, 'SmartCast', 'SmartCast');

    inputService
      .setCharacteristic(Characteristic.Identifier, INPUT_IDENTIFIER)
      .setCharacteristic(Characteristic.ConfiguredName, 'SmartCast')
      .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
      .setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.HOME_SCREEN);

    this.televisionService.addLinkedService(inputService);
  }

  removeUnsupportedServices() {
    for (const service of [...this.accessory.services]) {
      if (service.UUID === Service.Switch.UUID || service.UUID === Service.TelevisionSpeaker.UUID) {
        this.accessory.removeService(service);
      }
    }
  }

  getActive(callback) {
    this.getReportedActive()
      .then((isOn) => {
        callback(null, isOn ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
      })
      .catch((error) => {
        this.log.warn(`Device ${this.name}: power query failed: ${formatError(error)}`);
        callback(error);
      });
  }

  setActive(value, callback) {
    const turnOn = value === Characteristic.Active.ACTIVE || value === true;

    if (turnOn && this.isOffSettling()) {
      this.log.debug(`Device ${this.name}: ignoring turn-on while the display is finishing power-off.`);
      callback(null);
      return;
    }

    if (!turnOn && this.isOffSettling()) {
      this.log.debug(`Device ${this.name}: power-off is already settling; skipping duplicate command.`);
      callback(null);
      return;
    }

    if (this.hasFreshActiveState() && this.activeState === turnOn) {
      this.log.debug(`Device ${this.name}: already ${turnOn ? 'active' : 'inactive'}; skipping duplicate command.`);
      callback(null);
      return;
    }

    if (this.powerCommand && this.powerCommandDesiredState === turnOn) {
      this.log.debug(`Device ${this.name}: ${turnOn ? 'on' : 'off'} command already in progress; reusing it.`);
      this.powerCommand
        .then(() => callback(null))
        .catch((error) => callback(error));
      return;
    }

    this.powerCommandDesiredState = turnOn;
    this.powerCommand = this.applyPowerState(turnOn)
      .finally(() => {
        this.powerCommand = null;
        this.powerCommandDesiredState = null;
      });

    this.powerCommand
      .then((result) => {
        const detail = result && result.STATUS && result.STATUS.DETAIL;

        if (detail) {
          this.log.info(`Device ${this.name}: ${detail}`);
        }

        this.televisionService.updateCharacteristic(
          Characteristic.Active,
          turnOn ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE,
        );
        this.setCachedActive(turnOn);
        callback(null);
      })
      .catch((error) => {
        this.log.warn(`Device ${this.name}: power command failed: ${formatError(error)}`);
        callback(error);
      });
  }

  async getReportedActive() {
    if (this.isOffSettling()) {
      this.log.debug(`Device ${this.name}: display is finishing power-off; reporting inactive.`);
      this.setCachedActive(false);
      return false;
    }

    try {
      const isOn = await this.client.getPowerState();

      if (!isOn && this.isWakePending()) {
        this.log.debug(`Device ${this.name}: display is still waking; reporting active.`);
        this.setCachedActive(true);
        return true;
      }

      this.setCachedActive(isOn);
      return isOn;
    } catch (error) {
      if (VizioClient.isNetworkError(error)) {
        if (this.isWakePending()) {
          this.log.debug(`Device ${this.name}: display is still waking; reporting active.`);
          this.setCachedActive(true);
          return true;
        }

        this.log.debug(`Device ${this.name}: did not answer power query; reporting inactive.`);
        this.setCachedActive(false);
        return false;
      }

      throw error;
    }
  }

  async applyPowerState(turnOn) {
    const isOn = await this.getReportedActive();

    if (isOn === turnOn) {
      return {
        STATUS: {
          RESULT: 'SUCCESS',
          DETAIL: `Display already reported ${turnOn ? 'active' : 'inactive'}; skipped duplicate power command.`,
        },
      };
    }

    const options = {
      mac: this.config.mac,
      broadcastAddress: this.config.broadcastAddress,
      powerOnDelay: this.config.powerOnDelay,
    };

    this.log.info(`${turnOn ? 'Turning on' : 'Turning off'} ${this.name}.`);

    if (turnOn) {
      this.pendingWakeUntil = Date.now() + WAKE_GRACE_PERIOD;
      this.pendingOffUntil = 0;
    } else {
      this.pendingWakeUntil = 0;
      this.pendingOffUntil = Date.now() + OFF_SETTLE_PERIOD;
    }

    return this.client.setPowerState(turnOn, options);
  }

  setActiveIdentifier(value, callback) {
    if (value !== INPUT_IDENTIFIER) {
      callback(new Error(`Unsupported input identifier: ${value}`));
      return;
    }

    this.client.control.smartcast()
      .then(() => callback(null))
      .catch((error) => {
        this.log.warn(`Device ${this.name}: input command failed: ${formatError(error)}`);
        callback(error);
      });
  }

  setRemoteKey(value, callback) {
    const RemoteKey = Characteristic.RemoteKey;
    const commands = {
      [RemoteKey.REWIND]: () => this.client.control.media.seek.back(),
      [RemoteKey.FAST_FORWARD]: () => this.client.control.media.seek.forward(),
      [RemoteKey.NEXT_TRACK]: () => this.client.control.channel.up(),
      [RemoteKey.PREVIOUS_TRACK]: () => this.client.control.channel.down(),
      [RemoteKey.ARROW_UP]: () => this.client.control.navigate.up(),
      [RemoteKey.ARROW_DOWN]: () => this.client.control.navigate.down(),
      [RemoteKey.ARROW_LEFT]: () => this.client.control.navigate.left(),
      [RemoteKey.ARROW_RIGHT]: () => this.client.control.navigate.right(),
      [RemoteKey.SELECT]: () => this.client.control.navigate.ok(),
      [RemoteKey.BACK]: () => this.client.control.navigate.back(),
      [RemoteKey.EXIT]: () => this.client.control.navigate.exit(),
      [RemoteKey.PLAY_PAUSE]: () => this.client.control.media.play(),
      [RemoteKey.INFORMATION]: () => this.client.control.info(),
    };

    const command = commands[value];
    if (!command) {
      callback(null);
      return;
    }

    command()
      .then(() => callback(null))
      .catch((error) => {
        this.log.warn(`Device ${this.name}: remote command failed: ${formatError(error)}`);
        callback(error);
      });
  }

  isWakePending() {
    return Date.now() < this.pendingWakeUntil;
  }

  isOffSettling() {
    return Date.now() < this.pendingOffUntil;
  }

  hasFreshActiveState() {
    return this.activeState !== null && Date.now() - this.activeStateUpdatedAt < ACTIVE_CACHE_TTL;
  }

  setCachedActive(isOn) {
    this.activeState = Boolean(isOn);
    this.activeStateUpdatedAt = Date.now();
  }

}

function normalizeDevices(config) {
  return Array.isArray(config.devices)
    ? config.devices.map(normalizeDevice).filter(Boolean)
    : [];
}

function normalizeDevice(device) {
  if (!device) {
    return null;
  }

  return {
    name: device.name || DEFAULT_DEVICE_NAME,
    address: device.address || device.host || '',
    token: device.token || '',
    mac: device.mac || '',
    broadcastAddress: device.broadcastAddress || '255.255.255.255',
    requestTimeout: Number(device.requestTimeout) || 5000,
    powerOnDelay: Number(device.powerOnDelay) || 10000,
  };
}

function formatError(error) {
  if (!error) {
    return 'Unknown error';
  }

  if (error.message) {
    return error.message;
  }

  return String(error);
}
