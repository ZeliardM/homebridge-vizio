'use strict';

const dgram = require('node:dgram');
const https = require('node:https');
const { URL } = require('node:url');

const DEFAULT_PORT = 7345;
const DEFAULT_TIMEOUT = 5000;
const DEFAULT_BROADCAST_ADDRESS = '255.255.255.255';
const DEFAULT_POWER_ON_DELAY = 10000;
const WOL_PORTS = [9, 7];
const WOL_REPEATS = 3;

class VizioClient {
  constructor(address, authToken, options = {}) {
    if (!address) {
      throw new Error('A Vizio display address is required.');
    }

    this.origin = normalizeOrigin(address);
    this.authToken = authToken || '';
    this.timeout = Number(options.timeout) || DEFAULT_TIMEOUT;
    this.deviceId = '';
    this.deviceName = '';
    this.pairingRequestToken = '';

    this.power = {
      currentMode: () => this.send('GET', '/state/device/power_mode', this.authToken),
    };

    this.pairing = {
      initiate: this.initiatePairing.bind(this),
      pair: this.pair.bind(this),
      useAuthToken: (token) => {
        this.authToken = token || '';
      },
    };

    this.control = {
      keyCommand: this.keyCommand.bind(this),
      volume: {
        down: () => this.keyCommand(5, 0),
        up: () => this.keyCommand(5, 1),
        unmute: () => this.keyCommand(5, 2),
        mute: () => this.keyCommand(5, 3),
        toggleMute: () => this.keyCommand(5, 4),
      },
      input: {
        cycle: () => this.keyCommand(7, 1),
      },
      channel: {
        down: () => this.keyCommand(8, 0),
        up: () => this.keyCommand(8, 1),
        previous: () => this.keyCommand(8, 2),
      },
      power: {
        off: () => this.keyCommand(11, 0),
        on: () => this.keyCommand(11, 1),
        toggle: () => this.keyCommand(11, 2),
      },
      media: {
        seek: {
          forward: () => this.keyCommand(2, 0),
          back: () => this.keyCommand(2, 1),
        },
        pause: () => this.keyCommand(2, 2),
        play: () => this.keyCommand(2, 3),
      },
      navigate: {
        up: () => this.keyCommand(3, 8),
        down: () => this.keyCommand(3, 0),
        left: () => this.keyCommand(3, 1),
        right: () => this.keyCommand(3, 7),
        ok: () => this.keyCommand(3, 2),
        back: () => this.keyCommand(4, 0),
        exit: () => this.keyCommand(9, 0),
      },
      menu: () => this.keyCommand(4, 8),
      info: () => this.keyCommand(4, 6),
      smartcast: () => this.keyCommand(4, 3),
    };
  }

  async getPowerState() {
    const response = await this.power.currentMode();
    ensureSuccess(response, 'Power state');

    const value = response && response.ITEMS && response.ITEMS[0] && response.ITEMS[0].VALUE;
    return value === 1 || value === true || value === '1';
  }

  async setPowerState(isOn, options = {}) {
    if (!isOn) {
      return this.control.power.off();
    }

    if (!options.mac) {
      return this.control.power.on();
    }

    const wakeResult = await wake(options.mac, {
      address: new URL(this.origin).hostname,
      broadcastAddress: options.broadcastAddress,
    });
    await delay(Number(options.powerOnDelay) || DEFAULT_POWER_ON_DELAY);

    const wakeDetail = describeWakeResult(wakeResult);

    try {
      const isOn = await this.getPowerState();

      if (isOn) {
        return successResponse(`${wakeDetail} Display reports active; skipped follow-up power-on command.`);
      }

      const response = await this.control.power.on();
      response.STATUS = response.STATUS || {};
      response.STATUS.DETAIL = `${wakeDetail} Display answered inactive, so SmartCast power-on command was sent.`;
      return response;
    } catch (error) {
      if (VizioClient.isNetworkError(error)) {
        return successResponse(`${wakeDetail} Display did not answer after Wake-on-LAN; skipped SmartCast power-on command.`);
      }

      throw error;
    }
  }

  async initiatePairing(deviceName, deviceId) {
    const created = Date.now();
    this.deviceName = deviceName || `homebridge-vizio-${created}`;
    this.deviceId = deviceId || `homebridge-vizio-${created}`;

    const response = await this.send('PUT', '/pairing/start', null, {
      DEVICE_NAME: this.deviceName,
      DEVICE_ID: this.deviceId,
    });

    ensureSuccess(response, 'Pairing start');
    this.pairingRequestToken = response.ITEM && response.ITEM.PAIRING_REQ_TOKEN;

    return response;
  }

  async pair(pin, deviceId, pairingRequestToken) {
    if (!pin) {
      throw new Error('A pairing PIN is required.');
    }

    const response = await this.send('PUT', '/pairing/pair', null, {
      DEVICE_ID: deviceId || this.deviceId,
      CHALLENGE_TYPE: 1,
      RESPONSE_VALUE: String(pin).trim(),
      PAIRING_REQ_TOKEN: pairingRequestToken || this.pairingRequestToken,
    });

    ensureSuccess(response, 'Pairing');

    if (response.ITEM && response.ITEM.AUTH_TOKEN) {
      this.authToken = response.ITEM.AUTH_TOKEN;
    }

    return response;
  }

  keyCommand(codeset, code, action = 'KEYPRESS') {
    return this.send('PUT', '/key_command/', this.authToken, {
      KEYLIST: [{
        CODESET: codeset,
        CODE: code,
        ACTION: action,
      }],
    }).then((response) => {
      ensureSuccess(response, 'Key command');
      return response;
    });
  }

  send(method, path, authToken, data) {
    const target = new URL(path, this.origin);
    const body = data === undefined || data === null ? null : JSON.stringify(data);
    const headers = {
      'Content-Type': 'application/json',
    };

    if (body) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    if (authToken) {
      headers.AUTH = authToken;
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let request;
      const timer = setTimeout(() => {
        if (request) {
          request.destroy(new VizioRequestError('Display request timed out.', {
            code: 'ETIMEDOUT',
            networkError: true,
          }));
        }
      }, this.timeout);

      const finish = (error, value) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);

        if (error) {
          reject(error);
          return;
        }

        resolve(value);
      };

      request = https.request(target, {
        method,
        headers,
        rejectUnauthorized: false,
        timeout: this.timeout,
      }, (response) => {
        const chunks = [];

        response.on('data', (chunk) => chunks.push(chunk));
        response.on('aborted', () => {
          finish(new VizioRequestError('Display closed the response early.', {
            code: 'ECONNRESET',
            networkError: true,
            statusCode: response.statusCode,
          }));
        });
        response.on('error', (error) => {
          finish(new VizioRequestError(error.message, {
            cause: error,
            code: error.code,
            networkError: true,
            statusCode: response.statusCode,
          }));
        });
        response.on('close', () => {
          if (!response.complete) {
            finish(new VizioRequestError('Display closed the response before it completed.', {
              code: 'ECONNRESET',
              networkError: true,
              statusCode: response.statusCode,
            }));
          }
        });
        response.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          let parsedBody = {};

          if (rawBody) {
            try {
              parsedBody = JSON.parse(rawBody);
            } catch (error) {
              finish(new VizioRequestError('Display returned invalid JSON.', {
                cause: error,
                responseBody: rawBody,
                statusCode: response.statusCode,
              }));
              return;
            }
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            finish(new VizioRequestError(`Display returned HTTP ${response.statusCode}.`, {
              response: parsedBody,
              statusCode: response.statusCode,
            }));
            return;
          }

          finish(null, parsedBody);
        });
      });

      request.setTimeout(this.timeout, () => {
        request.destroy(new VizioRequestError('Display request timed out.', {
          code: 'ETIMEDOUT',
          networkError: true,
        }));
      });

      request.on('error', (error) => {
        if (error instanceof VizioRequestError) {
          finish(error);
          return;
        }

        finish(new VizioRequestError(error.message, {
          cause: error,
          code: error.code,
          networkError: true,
        }));
      });

      if (body) {
        request.write(body);
      }

      request.end();
    });
  }

  static isNetworkError(error) {
    return Boolean(error && (
      error.networkError
      || error.code === 'ECONNREFUSED'
      || error.code === 'EHOSTUNREACH'
      || error.code === 'ENETUNREACH'
      || error.code === 'ENOTFOUND'
      || error.code === 'ETIMEDOUT'
      || error.code === 'ECONNRESET'
    ));
  }
}

class VizioRequestError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'VizioRequestError';
    this.code = details.code;
    this.cause = details.cause;
    this.networkError = details.networkError || false;
    this.response = details.response;
    this.responseBody = details.responseBody;
    this.statusCode = details.statusCode;
  }
}

function normalizeOrigin(address) {
  let value = String(address).trim();

  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value}`;
  }

  const url = new URL(value);
  url.protocol = 'https:';

  if (!url.port) {
    url.port = String(DEFAULT_PORT);
  }

  url.pathname = '/';
  url.search = '';
  url.hash = '';

  return url.origin;
}

function ensureSuccess(response, action) {
  const result = response && response.STATUS && response.STATUS.RESULT;

  if (result === 'SUCCESS') {
    return;
  }

  const detail = response && response.STATUS && response.STATUS.DETAIL;
  const message = detail || result || 'Unknown display response';
  throw new VizioRequestError(`${action} failed: ${message}`, {
    code: result,
    response,
  });
}

async function wake(mac, options = {}) {
  const wakeOptions = typeof options === 'string'
    ? { broadcastAddress: options }
    : options;
  const packet = createMagicPacket(mac);
  const targets = getWakeTargets(wakeOptions.address, wakeOptions.broadcastAddress);
  const ports = wakeOptions.ports || WOL_PORTS;
  const repeats = wakeOptions.repeats || WOL_REPEATS;
  const errors = [];
  let sent = 0;

  for (let i = 0; i < repeats; i += 1) {
    const results = await Promise.allSettled(targets.flatMap((target) => (
      ports.map((port) => sendWakePacket(packet, target, port))
    )));

    for (const result of results) {
      if (result.status === 'fulfilled') {
        sent += 1;
      } else {
        errors.push(result.reason);
      }
    }

    if (i < repeats - 1) {
      await delay(250);
    }
  }

  if (sent === 0 && errors.length > 0) {
    throw errors[0];
  }

  return {
    packets: sent,
    ports,
    targets,
  };
}

function sendWakePacket(packet, target, port) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;

    const finish = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      try {
        socket.close();
      } catch (closeError) {
        // The socket may already be closed if the OS rejected the packet.
      }

      if (error) {
        reject(error);
        return;
      }

      resolve();
    };

    socket.once('error', finish);
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, 0, packet.length, port, target, finish);
    });
  });
}

function getWakeTargets(address, broadcastAddress) {
  const targets = new Set();

  if (broadcastAddress) {
    targets.add(broadcastAddress);
  }

  targets.add(DEFAULT_BROADCAST_ADDRESS);

  if (isIpv4Address(address)) {
    targets.add(address);
    targets.add(address.replace(/\.\d+$/, '.255'));
  }

  return [...targets];
}

function describeWakeResult(result) {
  return `Wake-on-LAN sent ${result.packets} packets to ${result.targets.join(', ')} on UDP ports ${result.ports.join(', ')}.`;
}

function successResponse(detail) {
  return {
    STATUS: {
      RESULT: 'SUCCESS',
      DETAIL: detail,
    },
  };
}

function isIpv4Address(value) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(value || ''));
}

function createMagicPacket(mac) {
  const normalized = String(mac).replace(/[^a-fA-F0-9]/g, '');

  if (normalized.length !== 12) {
    throw new Error('A valid MAC address is required for Wake-on-LAN.');
  }

  const macBytes = Buffer.from(normalized, 'hex');
  const packet = Buffer.alloc(6 + (16 * macBytes.length), 0xff);

  for (let i = 6; i < packet.length; i += macBytes.length) {
    macBytes.copy(packet, i);
  }

  return packet;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = VizioClient;
module.exports.VizioRequestError = VizioRequestError;
module.exports.wake = wake;
