#!/usr/bin/env python3
"""
Persistent JSON-RPC over stdio bridge for G-Two/subarulink (>= 0.7.21).

Maintains a single asynchronous aiohttp.ClientSession and subarulink.Controller
instance so Homebridge can execute commands (`remote_start`, `remote_stop`, `lock`,
`unlock`, `horn`, `horn_stop`, `lights`, `lights_stop`, `charge_start`, `fetch`,
`update`) and query telemetry and climate presets concurrently without paying a
cold login handshake penalty on every HomeKit interaction.
"""

import asyncio
import datetime
import json
import os
import sys
import traceback
from typing import Any, Dict, Iterable, Optional, Set

import aiohttp
import subarulink
from subarulink import Controller
import subarulink.const as sc


BAD_BINARY_VALUES: Set[str] = {
    str(v).upper()
    for v in getattr(sc, "BAD_BINARY_SENSOR_VALUES", ["UNKNOWN", "NOT_EQUIPPED"])
    if v is not None
} | {"UNKNOWN", "NOT_EQUIPPED", "NONE", ""}

BAD_NUMERIC_STRINGS: Set[str] = {
    str(v)
    for v in getattr(sc, "BAD_SENSOR_VALUES", ["16383", "65535", "32767"])
    if v is not None
} | {"UNKNOWN", "NOT_EQUIPPED", "NONE", ""}


def _first_valid(*candidates: Any) -> Any:
    """Return the first non-None candidate that is not a sentinel error value (preserving 0 / 0.0)."""
    for val in candidates:
        if val is None:
            continue
        if isinstance(val, str) and val.strip().upper() in BAD_NUMERIC_STRINGS:
            continue
        if val in getattr(sc, "BAD_SENSOR_VALUES", []):
            continue
        return val
    return None


def _to_float(val: Any) -> Optional[float]:
    if val is None or isinstance(val, bool):
        return None
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


class SubaruBridgeDaemon:
    def __init__(self) -> None:
        self.session: Optional[aiohttp.ClientSession] = None
        self.ctrl: Optional[Controller] = None
        self.config: Dict[str, Any] = {}
        self.connected: bool = False
        self._init_lock = asyncio.Lock()

    def _serialize_value(self, val: Any) -> Any:
        if isinstance(val, (datetime.datetime, datetime.date)):
            return val.isoformat()
        if isinstance(val, dict):
            return {str(k): self._serialize_value(v) for k, v in val.items()}
        if isinstance(val, (list, tuple, set, frozenset)):
            return [self._serialize_value(v) for v in val]
        if hasattr(val, "__dict__"):
            return {
                k: self._serialize_value(v)
                for k, v in vars(val).items()
                if not k.startswith("_")
            }
        return val

    def _resolve_contact_method(self, requested: str, methods: Dict[str, Any]) -> str:
        """Match contact method key exact first, then case-insensitively."""
        if requested in methods:
            return requested
        req_lower = requested.lower()
        for key in methods:
            if str(key).lower() == req_lower:
                return str(key)
        return requested

    async def init_controller(self, params: Dict[str, Any]) -> Dict[str, Any]:
        async with self._init_lock:
            if self.session and not self.session.closed:
                await self.session.close()

            self.config = params
            username = str(params["username"])
            password = str(params["password"])
            pin = str(params.get("pin", ""))
            device_id = int(params.get("device_id", 1719482051))
            device_name = str(params.get("device_name", "homebridge-subarulink"))
            country = str(params.get("country", sc.COUNTRY_USA)).upper()
            fetch_interval = max(60, int(params.get("fetch_interval", 900)))
            update_interval = max(300, int(params.get("update_interval", 7200)))
            configured_vin = str(params.get("vin") or "").strip().upper()
            default_preset = str(params.get("default_preset") or "").strip()
            pkg_version = getattr(subarulink, "__version__", "0.7.21")

            # Persist CLI-compatible subarulink.cfg in Homebridge storage (matches subarulink/app/cli.py)
            state_file = params.get("state_file")
            if state_file:
                os.makedirs(os.path.dirname(state_file), exist_ok=True)
                cfg_payload: Dict[str, Any] = {
                    "country": country,
                    "username": username,
                    "password": password,
                    "pin": pin,
                    "device_id": device_id,
                    "device_name": device_name,
                    "save_creds": "Y",
                }
                if configured_vin:
                    cfg_payload["default_vin"] = configured_vin
                if default_preset:
                    cfg_payload["remote_start_preset"] = default_preset
                try:
                    with open(state_file, "w", encoding="utf-8") as f:
                        json.dump(cfg_payload, f, indent=2)
                    os.chmod(state_file, 0o600)
                except Exception as exc:
                    sys.stderr.write(f"[subaru_bridge] Could not write state file: {exc}\n")

            self.session = aiohttp.ClientSession()
            self.ctrl = Controller(
                self.session,
                username=username,
                password=password,
                device_id=device_id,
                pin=pin,
                device_name=device_name,
                country=country,
                update_interval=update_interval,
                fetch_interval=fetch_interval,
            )

            connected = await self.ctrl.connect()
            if not getattr(self.ctrl, "device_registered", True):
                contact_methods = getattr(self.ctrl, "contact_methods", {}) or {}
                two_fa_code = str(params.get("two_factor_code") or "").strip()
                two_fa_method = str(params.get("two_factor_contact_method") or "").strip()

                if two_fa_code:
                    ok = await self.ctrl.submit_auth_code(two_fa_code)
                    if ok:
                        if not self.ctrl.get_vehicles():
                            connected = await self.ctrl.connect()
                        else:
                            connected = True
                        self.connected = bool(connected)
                        return {
                            "status": "connected" if self.connected else "failed",
                            "device_registered": True,
                            "version": pkg_version,
                            "message": "2FA code accepted and device registered!",
                        }
                    return {
                        "status": "2fa_failed",
                        "device_registered": False,
                        "contact_methods": contact_methods,
                        "message": "Submitted 2FA code was rejected by MySubaru.",
                    }

                if two_fa_method:
                    resolved_method = self._resolve_contact_method(two_fa_method, contact_methods)
                    req_ok = await self.ctrl.request_auth_code(resolved_method)
                    return {
                        "status": "2fa_code_sent",
                        "device_registered": False,
                        "contact_methods": contact_methods,
                        "requested_method": resolved_method,
                        "request_success": bool(req_ok),
                    }

                return {
                    "status": "2fa_required",
                    "device_registered": False,
                    "contact_methods": contact_methods,
                }

            self.connected = bool(connected)
            return {
                "status": "connected" if self.connected else "failed",
                "device_registered": True,
                "version": pkg_version,
            }

    async def request_2fa(self, params: Dict[str, Any]) -> Dict[str, Any]:
        if not self.ctrl:
            raise RuntimeError("Controller not initialized")
        contact_methods = getattr(self.ctrl, "contact_methods", {}) or {}
        method = self._resolve_contact_method(str(params["contact_method"]).strip(), contact_methods)
        ok = await self.ctrl.request_auth_code(method)
        return {"success": bool(ok), "contact_method": method}

    async def submit_2fa(self, params: Dict[str, Any]) -> Dict[str, Any]:
        if not self.ctrl:
            raise RuntimeError("Controller not initialized")
        code = str(params["code"]).strip()
        ok = await self.ctrl.submit_auth_code(code)
        if ok:
            if not self.ctrl.get_vehicles():
                await self.ctrl.connect()
            self.connected = True
        return {
            "success": bool(ok),
            "device_registered": bool(getattr(self.ctrl, "device_registered", False)),
        }

    async def discover_vehicles(self, _params: Dict[str, Any]) -> Dict[str, Any]:
        if not self.ctrl:
            raise RuntimeError("Controller not initialized")
        vins = self.ctrl.get_vehicles()
        vehicles = []
        for vin in vins:
            has_res = bool(self.ctrl.get_res_status(vin))
            is_ev = bool(self.ctrl.get_ev_status(vin))
            presets = []
            if has_res or is_ev:
                try:
                    presets = await self.ctrl.list_climate_preset_names(vin) or []
                except Exception:
                    presets = ["Full Heat", "Full Cool", "Auto"]

            vehicles.append(
                {
                    "vin": vin,
                    "name": self.ctrl.vin_to_name(vin) or f"Subaru {vin[-6:]}",
                    "model_year": str(self.ctrl.get_model_year(vin) or "2024"),
                    "model_name": str(self.ctrl.get_model_name(vin) or "Subaru"),
                    "api_gen": str(self.ctrl.get_api_gen(vin) or "g2"),
                    "is_ev": is_ev,
                    "has_remote": bool(self.ctrl.get_remote_status(vin)),
                    "has_res": has_res,
                    "has_safety": bool(self.ctrl.get_safety_status(vin)),
                    "has_subscription": bool(self.ctrl.get_subscription_status(vin)),
                    "has_tpms": bool(self.ctrl.has_tpms(vin)),
                    "has_sunroof": bool(self.ctrl.has_sunroof(vin)),
                    "climate_presets": presets,
                }
            )
        return {"vehicles": vehicles}

    def _extract_raw_fallbacks(self, vin: str) -> Dict[str, Optional[float]]:
        """
        Inspects Controller.get_raw_data(vin) for optional fields (exterior temperature in °C,
        12V battery voltage) in case a vehicle generation or API payload includes them.
        Note: subarulink 0.7.21 removed EXTERNAL_TEMP and BATTERY_VOLTAGE from parsed VehicleInfo.
        """
        result: Dict[str, Optional[float]] = {"external_temp_c": None, "battery_voltage": None}
        if not self.ctrl or not hasattr(self.ctrl, "get_raw_data"):
            return result
        try:
            raw_api = self.ctrl.get_raw_data(vin) or {}
        except Exception:
            return result

        cond_res = ((raw_api.get("condition") or {}).get("data") or {}).get("result") or {}
        vs_data = (raw_api.get("vehicleStatus") or {}).get("data") or {}

        temp_c = _to_float(_first_valid(cond_res.get("externalTemp"), vs_data.get("externalTemp")))
        if temp_c is None:
            temp_f = _to_float(
                _first_valid(
                    cond_res.get("externalTempFahrenheit"),
                    vs_data.get("externalTempFahrenheit"),
                )
            )
            if temp_f is not None and -80.0 <= temp_f <= 160.0:
                temp_c = round((temp_f - 32.0) * 5.0 / 9.0, 1)

        if temp_c is not None and temp_c != -64.0 and -60.0 <= temp_c <= 85.0:
            result["external_temp_c"] = round(temp_c, 1)

        batt_v = _to_float(
            _first_valid(cond_res.get("batteryVoltage"), vs_data.get("batteryVoltage"))
        )
        if batt_v is not None and 5.0 <= batt_v <= 20.0:
            result["battery_voltage"] = round(batt_v, 2)

        return result

    def _extract_binary_map(
        self,
        status: Dict[str, Any],
        raw: Dict[str, Any],
        key_specs: Iterable[tuple[tuple[str, ...], str]],
    ) -> Dict[str, str]:
        extracted: Dict[str, str] = {}
        for attr_candidates, friendly in key_specs:
            val = None
            for attr_name in attr_candidates:
                const_key = getattr(sc, attr_name, attr_name)
                candidate = status.get(const_key)
                if candidate is None:
                    candidate = status.get(attr_name.lower())
                if candidate is None:
                    candidate = raw.get(const_key)
                if candidate is not None:
                    val = candidate
                    break
            if val is not None:
                norm = str(val).strip().upper()
                if norm and norm not in BAD_BINARY_VALUES:
                    extracted[friendly] = norm
        return extracted

    def _extract_vehicle_telemetry(self, vin: str, data: Any) -> Dict[str, Any]:
        """
        Normalizes VehicleInfo (subarulink 0.7.21+) into a clean dictionary for Homebridge.
        """
        raw = self._serialize_value(data)
        if not isinstance(raw, dict):
            raw = {}

        vehicle_status_key = getattr(sc, "VEHICLE_STATUS", "vehicle_status")
        if isinstance(raw.get(vehicle_status_key), dict):
            status = raw[vehicle_status_key]
        elif isinstance(raw.get("status"), dict):
            status = raw["status"]
        else:
            status = raw

        # Door, Trunk/Boot, and Engine Hood positions (exact subarulink.const names + legacy fallbacks)
        door_specs = [
            (("DOOR_FRONT_LEFT_POSITION", "FRONT_LEFT_DOOR_POSITION"), "front_left_door"),
            (("DOOR_FRONT_RIGHT_POSITION", "FRONT_RIGHT_DOOR_POSITION"), "front_right_door"),
            (("DOOR_REAR_LEFT_POSITION", "REAR_LEFT_DOOR_POSITION"), "rear_left_door"),
            (("DOOR_REAR_RIGHT_POSITION", "REAR_RIGHT_DOOR_POSITION"), "rear_right_door"),
            (("DOOR_BOOT_POSITION", "BOOT_POSITION"), "boot"),
            (("DOOR_ENGINE_HOOD_POSITION", "ENGINE_HOOD_POSITION"), "hood"),
        ]
        doors = self._extract_binary_map(status, raw, door_specs)

        # Window and Sunroof/Moonroof statuses
        window_specs = [
            (("WINDOW_FRONT_LEFT_STATUS",), "front_left_window"),
            (("WINDOW_FRONT_RIGHT_STATUS",), "front_right_window"),
            (("WINDOW_REAR_LEFT_STATUS",), "rear_left_window"),
            (("WINDOW_REAR_RIGHT_STATUS",), "rear_right_window"),
            (("WINDOW_SUNROOF_STATUS",), "sunroof"),
        ]
        windows = self._extract_binary_map(status, raw, window_specs)

        # Individual Door/Boot Lock statuses
        lock_specs = [
            (("LOCK_FRONT_LEFT_STATUS",), "front_left_lock"),
            (("LOCK_FRONT_RIGHT_STATUS",), "front_right_lock"),
            (("LOCK_REAR_LEFT_STATUS",), "rear_left_lock"),
            (("LOCK_REAR_RIGHT_STATUS",), "rear_right_lock"),
            (("LOCK_BOOT_STATUS",), "boot_lock"),
        ]
        locks = self._extract_binary_map(status, raw, lock_specs)

        ev_charge_percent = _to_float(
            _first_valid(
                status.get(getattr(sc, "EV_STATE_OF_CHARGE_PERCENT", "EV_STATE_OF_CHARGE_PERCENT")),
                status.get("ev_state_of_charge_percent"),
            )
        )
        ev_plug_state = _first_valid(
            status.get(getattr(sc, "EV_IS_PLUGGED_IN", "EV_IS_PLUGGED_IN")),
            status.get("ev_is_plugged_in"),
        )
        ev_charger_state = _first_valid(
            status.get(getattr(sc, "EV_CHARGER_STATE_TYPE", "EV_CHARGER_STATE_TYPE")),
            status.get("ev_charger_state_type"),
        )
        odometer = _to_float(
            _first_valid(
                status.get(getattr(sc, "ODOMETER", "ODOMETER")),
                status.get("odometer"),
                raw.get("odometer"),
            )
        )
        if odometer is not None and odometer.is_integer():
            odometer_out: Optional[int | float] = int(odometer)
        else:
            odometer_out = odometer

        avg_fuel = _to_float(
            _first_valid(
                status.get(getattr(sc, "AVG_FUEL_CONSUMPTION", "AVG_FUEL_CONSUMPTION")),
                status.get("avg_fuel_consumption"),
                raw.get("avg_fuel_consumption"),
            )
        )
        dist_to_empty = _to_float(
            _first_valid(
                status.get(getattr(sc, "DIST_TO_EMPTY", "DISTANCE_TO_EMPTY_FUEL")),
                status.get("dist_to_empty_fuel"),
                raw.get("dist_to_empty_fuel"),
            )
        )
        remaining_fuel_percent = _to_float(
            _first_valid(
                status.get(getattr(sc, "REMAINING_FUEL_PERCENT", "REMAINING_FUEL_PERCENT")),
                status.get("remaining_fuel_percent"),
            )
        )
        vehicle_state = _first_valid(
            status.get(getattr(sc, "VEHICLE_STATE", "VEHICLE_STATE_TYPE")),
            status.get("vehicle_state_type"),
        )

        raw_fallbacks = self._extract_raw_fallbacks(vin)

        parsed_batt = _to_float(
            _first_valid(
                status.get(getattr(sc, "BATTERY_VOLTAGE", "BATTERY_VOLTAGE")),
                status.get("battery_voltage"),
                raw.get("battery_voltage"),
            )
        )
        battery_voltage = parsed_batt if parsed_batt is not None else raw_fallbacks["battery_voltage"]

        # HomeKit Characteristic.CurrentTemperature strictly expects Celsius (°C).
        # subarulink's EXTERNAL_TEMP (when present) is °C; clamp/validate to [-60, 85] °C.
        parsed_temp = _to_float(
            _first_valid(
                status.get(getattr(sc, "EXTERNAL_TEMP", "EXTERNAL_TEMP")),
                status.get("external_temp"),
                raw.get("external_temp"),
            )
        )
        if parsed_temp is not None and parsed_temp != -64.0 and -60.0 <= parsed_temp <= 85.0:
            external_temp: Optional[float] = round(parsed_temp, 1)
        else:
            external_temp = raw_fallbacks["external_temp_c"]

        return {
            "vin": vin,
            "odometer": odometer_out,
            "dist_to_empty": dist_to_empty,
            "avg_fuel": avg_fuel,
            "remaining_fuel_percent": remaining_fuel_percent,
            "battery_voltage": battery_voltage,
            "external_temp": external_temp,
            "vehicle_state": vehicle_state,
            "ev_charge_percent": ev_charge_percent,
            "ev_plug_state": ev_plug_state,
            "ev_charger_state": ev_charger_state,
            "doors": doors,
            "windows": windows,
            "locks": locks,
            "raw": raw,
        }

    async def get_telemetry(self, params: Dict[str, Any]) -> Dict[str, Any]:
        if not self.ctrl:
            raise RuntimeError("Controller not initialized")
        vin = str(params["vin"]).upper()
        wake_vehicle = bool(params.get("wake", False))
        force_fetch = bool(params.get("force", False))

        if wake_vehicle:
            await self.ctrl.update(vin, force=True)
            await self.ctrl.fetch(vin, force=True)
        elif force_fetch:
            await self.ctrl.fetch(vin, force=True)
        else:
            await self.ctrl.fetch(vin, force=False)

        data = await self.ctrl.get_data(vin)
        presets = []
        if self.ctrl.get_res_status(vin) or self.ctrl.get_ev_status(vin):
            try:
                presets = await self.ctrl.list_climate_preset_names(vin) or []
            except Exception:
                pass

        telemetry = self._extract_vehicle_telemetry(vin, data)
        telemetry["climate_presets"] = presets
        return telemetry

    async def execute_command(self, params: Dict[str, Any]) -> Dict[str, Any]:
        if not self.ctrl:
            raise RuntimeError("Controller not initialized")

        vin = str(params["vin"]).upper()
        command = str(params["command"])
        args = params.get("args") or {}

        if self.ctrl.invalid_pin_entered():
            new_pin = str(args.get("pin") or self.config.get("pin") or "")
            if new_pin:
                self.ctrl.update_saved_pin(new_pin)

        if command == "lock":
            ok = await self.ctrl.lock(vin)
        elif command == "unlock":
            door_mode = str(args.get("door", "ALL_DOORS")).upper()
            door_map = {
                "ALL_DOORS": getattr(sc, "ALL_DOORS", "ALL_DOORS_CMD"),
                "DRIVERS_DOOR": getattr(sc, "DRIVERS_DOOR", "FRONT_LEFT_DOOR_CMD"),
                "TAILGATE_DOOR": getattr(sc, "TAILGATE_DOOR", "TAILGATE_DOOR_CMD"),
            }
            target_door = door_map.get(door_mode, getattr(sc, "ALL_DOORS", "ALL_DOORS_CMD"))
            ok = await self.ctrl.unlock(vin, door=target_door)
        elif command == "remote_start":
            preset_req = str(args.get("preset", "Full Heat")).strip()
            available = await self.ctrl.list_climate_preset_names(vin) or []
            canonical_preset = preset_req
            for p in available:
                if p.lower() == preset_req.lower():
                    canonical_preset = p
                    break
            ok = await self.ctrl.remote_start(vin, canonical_preset)
        elif command == "remote_stop":
            ok = await self.ctrl.remote_stop(vin)
        elif command == "horn":
            ok = await self.ctrl.horn(vin)
        elif command == "horn_stop":
            ok = await self.ctrl.horn_stop(vin)
        elif command == "lights":
            ok = await self.ctrl.lights(vin)
        elif command == "lights_stop":
            ok = await self.ctrl.lights_stop(vin)
        elif command == "charge_start":
            ok = await self.ctrl.charge_start(vin)
        elif command == "update":
            ok = await self.ctrl.update(vin, force=True)
            if ok:
                await self.ctrl.fetch(vin, force=True)
        elif command == "fetch":
            ok = await self.ctrl.fetch(vin, force=True)
        else:
            raise ValueError(f"Unsupported command: {command}")

        return {"success": bool(ok), "command": command, "vin": vin}

    async def shutdown(self, _params: Dict[str, Any]) -> Dict[str, Any]:
        async with self._init_lock:
            if self.session and not self.session.closed:
                await self.session.close()
            self.ctrl = None
            self.connected = False
            return {"shutdown": True}


async def main() -> None:
    daemon = SubaruBridgeDaemon()
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    stdout_lock = asyncio.Lock()
    active_tasks: Set[asyncio.Task[None]] = set()
    shutdown_event = asyncio.Event()

    handlers = {
        "init": daemon.init_controller,
        "request_2fa": daemon.request_2fa,
        "submit_2fa": daemon.submit_2fa,
        "discover_vehicles": daemon.discover_vehicles,
        "get_telemetry": daemon.get_telemetry,
        "command": daemon.execute_command,
        "shutdown": daemon.shutdown,
    }

    async def write_response(response: Dict[str, Any]) -> None:
        async with stdout_lock:
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()

    async def process_line(raw_line: str) -> None:
        req_id = None
        method = None
        try:
            payload = json.loads(raw_line)
            if not isinstance(payload, dict):
                raise ValueError("JSON-RPC payload must be an object")
            req_id = payload.get("id")
            method = payload.get("method")
            params = payload.get("params") or {}

            if method not in handlers:
                raise ValueError(f"Unknown RPC method: {method}")

            result = await handlers[method](params)
            response: Dict[str, Any] = {"id": req_id, "result": result}
        except Exception as exc:
            sys.stderr.write(f"[subaru_bridge] Error handling request ({method}): {exc}\n")
            traceback.print_exc(file=sys.stderr)
            response = {
                "id": req_id,
                "error": f"{type(exc).__name__}: {str(exc)}",
            }

        await write_response(response)
        if method == "shutdown":
            shutdown_event.set()

    while not shutdown_event.is_set():
        read_task = asyncio.create_task(reader.readline())
        stop_task = asyncio.create_task(shutdown_event.wait())
        done, pending = await asyncio.wait(
            {read_task, stop_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for p in pending:
            p.cancel()

        if stop_task in done and shutdown_event.is_set():
            break

        line_bytes = read_task.result()
        if not line_bytes:
            break
        line = line_bytes.decode("utf-8", errors="replace").strip()
        if not line:
            continue

        task = asyncio.create_task(process_line(line))
        active_tasks.add(task)
        task.add_done_callback(active_tasks.discard)

    if active_tasks:
        await asyncio.gather(*active_tasks, return_exceptions=True)

    await daemon.shutdown({})


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
