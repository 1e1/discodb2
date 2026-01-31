// A small built-in Project (§3.5) so the copilot shows NAMED, glanceable
// readouts against the backend `sim` source out of the box.
//
// The sim adapter (app/adapters/can_adapter.py::SimulatedBus) emits 8-byte
// payloads on ids 0x100,0x120,0x180,0x1F0,0x220,0x2A0,0x300 with bytes that
// drift each tick. These signal definitions are PLACEHOLDERS chosen to be
// glanceable (a speed-like u16, an rpm-like u16, a temp byte, a status bit,
// a couple of raw bytes) — they are NOT a reverse-engineered VW Sharan map.
// Real signal maps come from a DBC / the cockpit Wizard later. Replace freely.

import type { Project, Signal } from "../protocol/types";

function sig(p: Omit<Signal, "isExtended">): Signal {
  return { isExtended: false, ...p };
}

export const DEFAULT_PROJECT: Project = {
  name: "sim-demo (placeholder map)",
  frames: [
    {
      id: 0x100,
      isExtended: false,
      name: "FRAME_100",
      signals: [
        sig({
          id: "speed_kph",
          frameId: 0x100,
          name: "Speed",
          bitStart: 0,
          bitLength: 16,
          byteOrder: "little",
          factor: 0.01,
          offset: 0,
          unit: "km/h",
        }),
        sig({
          id: "throttle_pct",
          frameId: 0x100,
          name: "Throttle",
          bitStart: 16,
          bitLength: 8,
          byteOrder: "little",
          factor: 100 / 255,
          offset: 0,
          unit: "%",
        }),
      ],
    },
    {
      id: 0x120,
      isExtended: false,
      name: "FRAME_120",
      signals: [
        sig({
          id: "engine_rpm",
          frameId: 0x120,
          name: "Engine RPM",
          bitStart: 0,
          bitLength: 16,
          byteOrder: "little",
          factor: 0.25,
          offset: 0,
          unit: "rpm",
        }),
      ],
    },
    {
      id: 0x180,
      isExtended: false,
      name: "FRAME_180",
      signals: [
        sig({
          id: "coolant_temp",
          frameId: 0x180,
          name: "Coolant",
          bitStart: 0,
          bitLength: 8,
          byteOrder: "little",
          factor: 1,
          offset: -40,
          unit: "°C",
        }),
        sig({
          id: "ignition_on",
          frameId: 0x180,
          name: "Ignition",
          bitStart: 8, // bit0 of byte 1
          bitLength: 1,
          byteOrder: "little",
          factor: 1,
          offset: 0,
          unit: "",
        }),
      ],
    },
    {
      id: 0x1f0,
      isExtended: false,
      name: "FRAME_1F0",
      signals: [
        sig({
          id: "fuel_level",
          frameId: 0x1f0,
          name: "Fuel",
          bitStart: 0,
          bitLength: 8,
          byteOrder: "little",
          factor: 100 / 255,
          offset: 0,
          unit: "%",
        }),
      ],
    },
  ],
};

/** Raw frame ids worth offering as quick raw watches (all sim ids). */
export const SIM_FRAME_IDS = [
  0x100, 0x120, 0x180, 0x1f0, 0x220, 0x2a0, 0x300,
];
