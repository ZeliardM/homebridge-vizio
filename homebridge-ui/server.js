'use strict';

const VizioClient = require('../lib/vizio-client');

(async () => {
  const { HomebridgePluginUiServer, RequestError } = await import('@homebridge/plugin-ui-utils');

  class VizioUiServer extends HomebridgePluginUiServer {
    constructor() {
      super();

      this.onRequest('/pair/start', this.startPairing.bind(this));
      this.onRequest('/pair/finish', this.finishPairing.bind(this));
      this.onRequest('/test', this.testConnection.bind(this));

      this.ready();
    }

    async startPairing(payload) {
      try {
        const client = createClient(payload);
        const response = await client.pairing.initiate('Homebridge Vizio');

        return {
          deviceId: client.deviceId,
          pairingRequestToken: response.ITEM.PAIRING_REQ_TOKEN,
        };
      } catch (error) {
        throw toRequestError(error);
      }
    }

    async finishPairing(payload) {
      try {
        if (!payload.pin) {
          throw new Error('Enter the PIN shown on your display.');
        }

        const client = createClient(payload);
        const response = await client.pairing.pair(
          payload.pin,
          payload.deviceId,
          payload.pairingRequestToken,
        );
        const token = response.ITEM && response.ITEM.AUTH_TOKEN;

        if (!token) {
          throw new Error('Pairing finished, but the display did not return an access token.');
        }

        return {
          token,
        };
      } catch (error) {
        throw toRequestError(error);
      }
    }

    async testConnection(payload) {
      try {
        const client = createClient(payload);
        const isOn = await client.getPowerState();

        return {
          active: isOn,
        };
      } catch (error) {
        if (VizioClient.isNetworkError(error)) {
          return {
            active: false,
            detail: 'Display did not answer; it may be powered off or asleep.',
          };
        }

        throw toRequestError(error);
      }
    }
  }

  function createClient(payload) {
    if (!payload || !payload.address) {
      throw new Error('Enter the display address first.');
    }

    return new VizioClient(payload.address, payload.token, {
      timeout: payload.requestTimeout,
    });
  }

  function toRequestError(error) {
    return new RequestError(error.message || String(error), {
      code: error.code,
      statusCode: error.statusCode,
    });
  }

  return new VizioUiServer();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
