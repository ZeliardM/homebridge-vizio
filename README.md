# homebridge-vizio

A Homebridge plugin for exposing a Vizio SmartCast display as an external HomeKit Television accessory.

## What it does

- Publishes the display as a separate external HomeKit TV accessory.
- Maps HomeKit TV power to Vizio SmartCast power commands.
- Maps basic Control Center remote buttons to Vizio remote key commands.
- Adds a simple Homebridge UI setup flow for SmartCast pairing.
- Supports optional Wake-on-LAN for displays that sleep their HTTP API.
- Polls display power state so manual remote changes update HomeKit.

## Setup

Install Homebridge first, then install this plugin:

```bash
npm install homebridge-vizio
```

Configure the plugin from the Homebridge UI. The settings screen can start pairing, accept the PIN shown on the display, save the access token, and test communication.

The generated platform config looks like this:

```json
{
  "platform": "VizioDisplay",
  "name": "Homebridge Vizio",
  "devices": [
    {
      "name": "Living Room TV",
      "address": "viziocasttv.local",
      "token": "YOUR ACCESS TOKEN",
      "mac": "00:11:22:33:44:55",
      "broadcastAddress": "255.255.255.255",
      "requestTimeout": 5000,
      "powerOnDelay": 10000,
      "pollInterval": 10000
    }
  ]
}
```

The platform `name` is just the plugin or child bridge label. Each entry under `devices` is published as its own external HomeKit TV accessory. The `mac` field is optional, but recommended if your display needs Wake-on-LAN to turn on from sleep.

When `mac` is set, the plugin uses Wake-on-LAN for power on, waits for the display to wake, then checks the Vizio power state. It only sends a SmartCast power-on command if the display answers and still reports inactive.

The `Active` HomeKit characteristic performs a fresh power-state check whenever HomeKit asks for it. The plugin also polls every `pollInterval` milliseconds, defaulting to 10 seconds, so manual remote changes are pushed into HomeKit without waiting for the Home app to request a refresh.

## Adding To HomeKit

TV accessories are published externally because HomeKit expects one TV per bridge. After Homebridge restarts, add the TV manually in the Home app:

1. Add Accessory.
2. Choose More Options.
3. Select the Vizio TV.
4. Use your normal Homebridge setup code.

If you previously used this plugin as a Switch accessory, remove that old accessory from HomeKit before adding the TV.

## CLI Pairing

The Homebridge UI is the recommended setup path, but the CLI pairing helper still works:

```bash
node node_modules/homebridge-vizio/setup.js
```

## SmartCast API

The plugin uses the same Vizio SmartCast endpoints and key command codes documented by `vizio-smart-cast`, but implements the small subset it needs with Node built-ins so the dependency tree stays clean.
