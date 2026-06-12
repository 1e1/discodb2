/**
 * Built-in "VW PQ demo" project — a CURATED subset of the VW PQ DBC
 * (docs/vw/dbc/vw_pq-en.dbc), just the handful of signals shown in the demo
 * cluster. Used for landing-page screenshots taken against the scripted drive
 * replay (infra/sim/scenario.screenshots.yaml → a candump the backend replays),
 * which is DBC-true, so these layouts decode it exactly.
 *
 * Why a hand-authored subset rather than importDbc(full): the full DBC has
 * dozens of messages → an unreadable cluster. This is the curated dashboard.
 *
 * Every field is copied verbatim from the DBC (start bit, length, factor,
 * offset, byte order). The cockpit stores bitStart = the DBC start bit directly
 * (see dbc.ts importDbc), and all these signals are Intel/unsigned (@1+), so
 * byteOrder is 'little' and signed is false throughout. Signal ids are pinned
 * (rpm, coolant, …) so deep links like #/explore/f280/srpm stay stable.
 */
import { emptyProject, makeSignal, type FrameDef, type Project } from '../protocol/datamodel';

// engine_1 (640 = 0x280): engine_rpm 16|16 (0.25,0), throttle 40|8 (0.4,0)
function engine1(): FrameDef {
  const id = 0x280;
  return {
    id,
    isExtended: false,
    name: 'engine_1',
    signals: [
      makeSignal(id, false, {
        id: 'rpm',
        name: 'EngineRPM',
        bitStart: 16,
        bitLength: 16,
        byteOrder: 'little',
        factor: 0.25,
        offset: 0,
        unit: 'rpm',
      }),
      makeSignal(id, false, {
        id: 'throttle',
        name: 'Throttle',
        bitStart: 40,
        bitLength: 8,
        byteOrder: 'little',
        factor: 0.4,
        offset: 0,
        unit: '%',
      }),
    ],
  };
}

// engine_2 (648 = 0x288): MO2_coolant_T 8|8 (0.75,-48)
function engine2(): FrameDef {
  const id = 0x288;
  return {
    id,
    isExtended: false,
    name: 'engine_2',
    signals: [
      makeSignal(id, false, {
        id: 'coolant',
        name: 'CoolantTemp',
        bitStart: 8,
        bitLength: 8,
        byteOrder: 'little',
        factor: 0.75,
        offset: -48,
        unit: 'degC',
      }),
    ],
  };
}

// instrument_cluster_1 (800 = 0x320): displayed_speed 46|10 (0.32,0), fuel 16|7 (1,0)
function cluster1(): FrameDef {
  const id = 0x320;
  return {
    id,
    isExtended: false,
    name: 'instrument_cluster_1',
    signals: [
      makeSignal(id, false, {
        id: 'speed',
        name: 'VehicleSpeed',
        bitStart: 46,
        bitLength: 10,
        byteOrder: 'little',
        factor: 0.32,
        offset: 0,
        unit: 'km/h',
      }),
      makeSignal(id, false, {
        id: 'fuel',
        name: 'FuelLevel',
        bitStart: 16,
        bitLength: 7,
        byteOrder: 'little',
        factor: 1,
        offset: 0,
        unit: 'l',
      }),
    ],
  };
}

// gate_comfort_1 (912 = 0x390): reverse light 17|1, low beam 48|1
function comfort1(): FrameDef {
  const id = 0x390;
  return {
    id,
    isExtended: false,
    name: 'gate_comfort_1',
    signals: [
      makeSignal(id, false, {
        id: 'reverse',
        name: 'ReverseLight',
        bitStart: 17,
        bitLength: 1,
        byteOrder: 'little',
        factor: 1,
        offset: 0,
        unit: '',
      }),
      makeSignal(id, false, {
        id: 'lowbeam',
        name: 'LowBeam',
        bitStart: 48,
        bitLength: 1,
        byteOrder: 'little',
        factor: 1,
        offset: 0,
        unit: '',
      }),
    ],
  };
}

/** Build the curated VW PQ demo project (engine, coolant, cluster, comfort). */
export function vwPqProject(name = 'VW PQ drive'): Project {
  const project = emptyProject(name);
  project.frames.push(engine1(), engine2(), cluster1(), comfort1());
  return project;
}
