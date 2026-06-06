/**
 * Built-in OBD2 starter project — common standardised Service 01 (current
 * data) PIDs, so a user can decode a generic diagnostic response immediately
 * without hunting it from scratch.
 *
 * This is HAND-AUTHORED from the public SAE J1979 / ISO 15031 PID definitions
 * (the same ones documented at en.wikipedia.org/wiki/OBD-II_PIDs). It is NOT a
 * copy of any third-party DBC, so it ships in-repo with no licensing question.
 * It is intentionally small: the handful of PIDs people actually look at first.
 *
 * Modelling notes
 * ---------------
 * A Service 01 response on classic 11-bit CAN is a single ISO-TP frame on the
 * ECU reply id 0x7E8 (the powertrain ECU; other ECUs answer on 0x7E9..0x7EF):
 *
 *     byte0 = PCI / number of additional data bytes
 *     byte1 = 0x41  (Service 01 + 0x40 "response" bit)
 *     byte2 = PID   ← which measurement this frame carries
 *     byte3.. = data (A, B, C, D), big-endian (A is the most-significant byte)
 *
 * Because byte2 selects WHICH signal the data bytes mean, it is the
 * MULTIPLEXOR: each PID's data signal is tagged with multiplexValue = pid and
 * is only present when byte2 == pid. Multi-byte values are big-endian, so we
 * use byteOrder 'big' with bitStart at the MSB (byte3 bit7 = bit index 31).
 */

import {
  emptyProject,
  makeSignal,
  type EditableSignal,
  type FrameDef,
  type Project,
} from '../protocol/datamodel';

/** ECU reply id for the powertrain controller (Service 01 responses). */
export const OBD2_REPLY_ID = 0x7e8;

interface PidDef {
  pid: number;
  name: string;
  /** 1 = single byte (A) at byte3, 2 = two bytes (A,B) big-endian at byte3-4. */
  bytes: 1 | 2;
  factor: number;
  offset: number;
  unit: string;
}

/**
 * The common Service 01 PIDs. Formulas (from J1979) are encoded as factor +
 * offset over the raw big-endian value:
 *   - A*100/255  → factor 100/255 (load, throttle, fuel level)
 *   - A-40       → offset -40     (temperatures)
 *   - (256A+B)/4 → factor 0.25    (rpm)
 *   - (256A+B)/100, /1000 → MAF, control-module voltage
 */
const PIDS: PidDef[] = [
  { pid: 0x04, name: 'CalculatedEngineLoad', bytes: 1, factor: 100 / 255, offset: 0, unit: '%' },
  { pid: 0x05, name: 'CoolantTemp', bytes: 1, factor: 1, offset: -40, unit: 'degC' },
  { pid: 0x0a, name: 'FuelPressure', bytes: 1, factor: 3, offset: 0, unit: 'kPa' },
  { pid: 0x0b, name: 'IntakeManifoldPressure', bytes: 1, factor: 1, offset: 0, unit: 'kPa' },
  { pid: 0x0c, name: 'EngineRPM', bytes: 2, factor: 0.25, offset: 0, unit: 'rpm' },
  { pid: 0x0d, name: 'VehicleSpeed', bytes: 1, factor: 1, offset: 0, unit: 'km/h' },
  { pid: 0x0e, name: 'TimingAdvance', bytes: 1, factor: 0.5, offset: -64, unit: 'deg' },
  { pid: 0x0f, name: 'IntakeAirTemp', bytes: 1, factor: 1, offset: -40, unit: 'degC' },
  { pid: 0x10, name: 'MAFAirFlowRate', bytes: 2, factor: 0.01, offset: 0, unit: 'g/s' },
  { pid: 0x11, name: 'ThrottlePosition', bytes: 1, factor: 100 / 255, offset: 0, unit: '%' },
  { pid: 0x1f, name: 'RunTimeSinceStart', bytes: 2, factor: 1, offset: 0, unit: 's' },
  { pid: 0x2f, name: 'FuelTankLevel', bytes: 1, factor: 100 / 255, offset: 0, unit: '%' },
  { pid: 0x42, name: 'ControlModuleVoltage', bytes: 2, factor: 0.001, offset: 0, unit: 'V' },
  { pid: 0x46, name: 'AmbientAirTemp', bytes: 1, factor: 1, offset: -40, unit: 'degC' },
];

/**
 * Build the OBD2 starter project: one frame (0x7E8) whose PID byte is the
 * multiplexor and whose data bytes are the per-PID multiplexed signals.
 */
export function obd2StarterProject(name = 'OBD2 (Service 01)'): Project {
  const id = OBD2_REPLY_ID;
  const signals: EditableSignal[] = [];

  // The multiplexor: byte2 = PID. Selects which data signal is present.
  signals.push(
    makeSignal(id, false, {
      name: 'PID',
      bitStart: 16, // byte 2, little-endian (single byte → order is moot)
      bitLength: 8,
      byteOrder: 'little',
      factor: 1,
      offset: 0,
      unit: '',
      isMultiplexor: true,
    }),
  );

  for (const p of PIDS) {
    // Data starts at byte 3. OBD2 multi-byte values are big-endian (A = MSB),
    // so bitStart is the MSB: byte3 bit7 = 24 + 7 = 31 (DBC Motorola numbering).
    const bitStart = p.bytes === 1 ? 24 : 31;
    const bitLength = p.bytes * 8;
    signals.push(
      makeSignal(id, false, {
        name: p.name,
        bitStart,
        bitLength,
        byteOrder: 'big',
        factor: p.factor,
        offset: p.offset,
        unit: p.unit,
        multiplexValue: p.pid,
      }),
    );
  }

  const frame: FrameDef = { id, isExtended: false, name: 'OBD2_Service01_Resp', signals };
  const project = emptyProject(name);
  project.frames.push(frame);
  return project;
}
