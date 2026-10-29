# Homebridge SubaruLink

[![npm](https://img.shields.io/npm/v/homebridge-subarulink.svg)](https://www.npmjs.com/package/homebridge-subarulink)
[![CI](https://github.com/misraaks/homebridge-subarulink/actions/workflows/ci.yml/badge.svg)](https://github.com/misraaks/homebridge-subarulink/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

A self-contained [Homebridge](https://homebridge.io) Dynamic Platform plugin that exposes **MySubaru Connected Services** (formerly **Subaru STARLINK**) vehicles to Apple HomeKit, powered by [G-Two/subarulink](https://github.com/G-Two/subarulink).

---

## Highlights

- **100% Self-Contained Runtime:** Upstream `subarulink >= 0.7.21` requires `Python >= 3.14`, while many Linux distributions (including Debian 13 / Raspberry Pi OS) ship with older system Python versions. On first configured launch, `homebridge-subarulink` automatically provisions an isolated standalone `uv` + CPython (`>= 3.14`) + `subarulink` virtual environment directly inside your Homebridge storage directory (`<homebridge-storage-path>/subarulink/.runtime`)—without `postinstall` scripts, `sudo`/root privileges, or touching system Python.
- **Full Homebridge UI Configuration (Including 2FA):** Configure your MySubaru account, 4-digit PIN, climate presets, polling intervals, and initial Two-Factor Authentication (2FA) directly inside the Homebridge UI—no terminal or manual `subarulink.cfg` file required.
- **Warm Async JSON-RPC Bridge:** Keeps an `aiohttp` session alive in a lightweight background `asyncio` worker so lock, unlock, and remote-start presses execute without cold login delays, with automatic crash recovery and session re-initialization.
- **12V Battery Safe by Default:** Background polling (`fetchIntervalMinutes`, default `15` min) reads **MySubaru's cloud cache only** (`Controller.fetch`) and never wakes your car's telematics module on a timer.

---

## HomeKit Services & Subscription Requirements

Available HomeKit services depend on your vehicle's hardware/generation (`g1`–`g4`) and your active **MySubaru Connected Services** plan (**US** and **Canada** accounts supported):

| HomeKit Service | Action / Telemetry | Required MySubaru Plan |
| :--- | :--- | :--- |
| **Door Lock (`LockMechanism`)** | Lock doors, unlock (`ALL_DOORS`, `DRIVERS_DOOR`, or `TAILGATE_DOOR`), plus lock-state sync when reported by vehicle | **Security / Security Plus / Companion+** |
| **Remote Start (`Switch`)** | Primary switch for default climate preset (e.g., `Full Heat`) + optional switches for extra presets (`Full Cool`, `Auto`, or custom app presets). Turning **Off** early sends `remote_stop` | **Security / Security Plus / Companion+** *(push-button start / RES or PHEV)* |
| **Flash Lights & Horn (`Switch`)** | Trigger or stop hazard lights (`lights` / `lights_stop`) and horn (`horn` / `horn_stop`) | **Security / Security Plus / Companion+** |
| **Unlock Tailgate (`Switch`)** | Optional momentary switch to unlock only the rear gate (`TAILGATE_DOOR`) | **Security / Security Plus / Companion+** *(supported models)* |
| **Refresh Vehicle Status (`Switch`)** | Momentary switch calling `Controller.update` + `fetch` to wake the car's DCM on demand | **Security / Security Plus / Companion+** |
| **EV Battery & Charge (`Battery` / `Switch`)** | State-of-charge %, low-battery status, charging state, and `charge_start` trigger | **Security / Security Plus / Companion+** *(PHEV / EV models)* |
| **Contact Sensors (`ContactSensor`)** | Doors, Trunk/Tailgate, Engine Hood, plus dynamic Power Window & Sunroof sensors when reported | **Security / Security Plus / Companion+** *(required by Subaru API for live door/window condition reports)* |

> **Note:** Accounts with only the base **MySubaru Safety / Companion** plan (or an inactive subscription) can still authenticate and discover vehicles, but Subaru's backend restricts active remote commands (`lock`, `unlock`, `remote_start`, `update`) and live door/window condition queries to **Security / Companion+** subscribers.

---

## Installation

### Option 1: Homebridge UI (Recommended)

1. Open the **Homebridge UI** and go to the **Plugins** tab.
2. Search for **`homebridge-subarulink`** and click **Install**.
3. Enter your **MySubaru Username**, **Password**, **4-Digit PIN**, and **Country** (`USA` or `CAN`), then click **Save**.

### Option 2: Command Line

```bash
npm install -g homebridge-subarulink
```

### Recommended: Enable Child Bridge Mode

Because satellite/cellular vehicle commands take ~8–12 seconds for the vehicle to acknowledge, running SubaruLink as a **Child Bridge** prevents slow cellular responses from delaying other accessories in HomeKit:

1. In Homebridge UI, go to **Plugins → Homebridge SubaruLink → Wrench Icon → Bridge Settings**.
2. Toggle **Run as a Separate Child Bridge** to **On**, click **Save**, and restart Homebridge.
3. Pair the Child Bridge QR code in the Apple Home app.

---

## Completing First-Time Two-Factor Authentication (2FA)

MySubaru requires 2FA once per `deviceId` to authorize a new device on your account.

### Method A: Directly in the Homebridge UI (No Terminal Needed)

1. Configure your **Username**, **Password**, and **PIN** in the plugin settings and restart Homebridge.
2. Check the **Homebridge Logs**—SubaruLink will list the available 2FA contact method keys on your account (typically `userName` for email or `phone` for SMS).
3. Open **Plugin Settings → Device Identity & Two-Factor Authentication (2FA)**, enter your chosen key (e.g., `userName`) in **2FA Contact Method**, save, and restart Homebridge to send the 6-digit verification code.
4. Paste the 6-digit code you received into **2FA 6-Digit Verification Code**, save, and restart Homebridge.
5. Once connected, clear both temporary 2FA fields in settings and save. Your authorized `deviceId` is persisted automatically in `<homebridge-storage-path>/subarulink/subarulink.cfg`.

### Method B: Migrating an Existing `subarulink.cfg` (Skip 2FA)

If you already use `subarulink` (for example via CLI or Home Assistant) and have an existing `subarulink.cfg`, copy its `"device_id"` integer and `"device_name"` into **Device ID** and **Device Name** under **Device Identity & Two-Factor Authentication (2FA)**. MySubaru will recognize your authorized device immediately without requiring 2FA.

---

## 12V Auxiliary Battery Protection

- **Server Cache Poll Interval (`fetchIntervalMinutes`, default: `15`):** Queries Subaru's cloud cache (`Controller.fetch`). Your vehicle automatically uploads fresh status to Subaru's servers whenever you turn off the ignition or run a remote command. **This never wakes the car and uses 0% of your 12V battery.**
- **Active Vehicle Wake Interval (`updateIntervalMinutes`, default: `0` / Disabled):** Leave this set to **`0`** for normal use. Setting a positive value schedules periodic `Controller.update` cellular wakeups (minimum `60` minutes; `120+` recommended), which draw power from the 12V battery if the car sits undriven for several days.

---

## Development

Requires **Node.js** (`22.x`, `24.x`, or `26.x`) and **pnpm**:

```bash
pnpm install
pnpm run build
pnpm run bootstrap   # provisions ./.runtime for local testing
pnpm test            # runs JSON-RPC, crash-recovery, and Homebridge v2 test suite
```

---

## Credits & Disclaimer

- Powered by the [G-Two/subarulink](https://github.com/G-Two/subarulink) Python library (licensed under Apache-2.0).
- **AI Disclosure:** This project is `ai-generated` (built with Google Gemini 4 Argon under human direction, review, and testing) — see [AI_DISCLOSURE.md](./AI_DISCLOSURE.md).
- **Disclaimer:** This project is an independent, unofficial community integration and is not affiliated with, endorsed by, or sponsored by Subaru Corporation, Subaru of America, Inc., or Subaru Canada, Inc. Subaru, MySubaru, and STARLINK are trademarks of Subaru Corporation. Use at your own risk.
