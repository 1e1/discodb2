/**
 * Built-in "sim demo" project — decodes the frames emitted by the bundled
 * `--source sim` bus (see backend/discodb2_backend/adapters/sim.py) so the
 * cockpit shows real, named, decoded signals the instant it boots.
 *
 * Its purpose is reproducible screenshots / demos: combined with the
 * `?project=sim-demo` boot param (see state/urlState.ts) a single URL opens the
 * cockpit already decoding the bus, so deep links like
 *   ?src=sim&project=sim-demo#/explore/f280/srpm
 *   ?src=sim&project=sim-demo#/cluster
 * land on a populated view with no manual setup.
 *
 * Signal `id`s are HAND-PINNED (rpm, coolant, …) so the deep links above stay
 * stable; `makeSignal` would otherwise mint a random id per call.
 *
 * Bit numbering follows the same convention as obd2-starter.ts: bit index =
 * byteIndex*8 + bitInByte; a big-endian (Motorola) multi-byte value starts at
 * the MSB, i.e. byte0 bit7 = 7.
 */
import { emptyProject, makeSignal, type FrameDef, type Project } from '../protocol/datamodel';

/** Engine frame: rpm*4 BE @ b0-1, load @ b2, coolant+40 @ b3, counter @ b6, checksum @ b7. */
function engineFrame(): FrameDef {
  const id = 0x280;
  return {
    id,
    isExtended: false,
    name: 'Engine',
    signals: [
      makeSignal(id, false, {
        id: 'rpm',
        name: 'EngineRPM',
        bitStart: 7, // byte0 bit7 (MSB of the big-endian u16)
        bitLength: 16,
        byteOrder: 'big',
        factor: 0.25, // raw = rpm * 4
        offset: 0,
        unit: 'rpm',
      }),
      makeSignal(id, false, {
        id: 'coolant',
        name: 'CoolantTemp',
        bitStart: 24, // byte3
        bitLength: 8,
        byteOrder: 'little',
        factor: 1,
        offset: -40, // raw = coolant + 40
        unit: 'degC',
      }),
      makeSignal(id, false, {
        id: 'load',
        name: 'EngineLoad',
        bitStart: 16, // byte2
        bitLength: 8,
        byteOrder: 'little',
        factor: 1,
        offset: 0,
        unit: '',
      }),
    ],
  };
}

/** Chassis frame: speed*100 BE @ b0-1, flags @ b2 (bit0 handbrake/1 reverse/2 ignition). */
function chassisFrame(): FrameDef {
  const id = 0x5a0;
  return {
    id,
    isExtended: false,
    name: 'Chassis',
    signals: [
      makeSignal(id, false, {
        id: 'speed',
        name: 'VehicleSpeed',
        bitStart: 7, // byte0 bit7 (MSB of the big-endian u16)
        bitLength: 16,
        byteOrder: 'big',
        factor: 0.01, // raw = speed * 100
        offset: 0,
        unit: 'km/h',
      }),
      makeSignal(id, false, {
        id: 'handbrake',
        name: 'Handbrake',
        bitStart: 16, // byte2 bit0
        bitLength: 1,
        byteOrder: 'little',
        factor: 1,
        offset: 0,
        unit: '',
      }),
      makeSignal(id, false, {
        id: 'reverse',
        name: 'Reverse',
        bitStart: 17, // byte2 bit1
        bitLength: 1,
        byteOrder: 'little',
        factor: 1,
        offset: 0,
        unit: '',
      }),
      makeSignal(id, false, {
        id: 'ignition',
        name: 'Ignition',
        bitStart: 18, // byte2 bit2
        bitLength: 1,
        byteOrder: 'little',
        factor: 1,
        offset: 0,
        unit: '',
      }),
    ],
  };
}

/** Fuel frame: fuel% scaled to 0..255 @ byte0. */
function fuelFrame(): FrameDef {
  const id = 0x480;
  return {
    id,
    isExtended: false,
    name: 'Fuel',
    signals: [
      makeSignal(id, false, {
        id: 'fuel',
        name: 'FuelLevel',
        bitStart: 0, // byte0
        bitLength: 8,
        byteOrder: 'little',
        factor: 100 / 255, // raw = fuel * 255 / 100
        offset: 0,
        unit: '%',
      }),
    ],
  };
}

/** Build the sim demo project: the named signals of the simulated VAG-style bus. */
export function simDemoProject(name = 'Sim demo'): Project {
  const project = emptyProject(name);
  project.frames.push(engineFrame(), chassisFrame(), fuelFrame());
  return project;
}
