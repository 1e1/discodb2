/**
 * DBC import/export tests.
 *
 * Run with vitest (`npm run test`), which resolves the `@shared` alias from
 * vite.config — the same alias the app uses. Two layers:
 *
 *   1. INLINE fixtures (always run, committed): pin the grammar features that
 *      the old stub silently dropped — most importantly MULTIPLEXING — plus the
 *      import→export→import idempotence the round-trip promise rests on.
 *   2. CORPUS fixtures (opportunistic): if the local, un-committed reference
 *      DBCs under docs/external are present, parse them and assert the
 *      round-trip preserves frame/signal counts. Skipped when absent (CI / fresh
 *      clone) so the suite never depends on un-committed files.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { importDbc, exportDbc } from './dbc';
import { obd2StarterProject, OBD2_REPLY_ID } from './obd2-starter';
import { frameKey, makeSignal, type EditableSignal, type FrameDef } from '../protocol/datamodel';
import { evalFormula, signalToFormula } from '../protocol/formula';
import { decodeSignal } from '../protocol/decode';

describe('importDbc — grammar', () => {
  test('parses a basic BO_/SG_ message', () => {
    const dbc = [
      'BO_ 257 ESP_02: 8 Gateway',
      ' SG_ Speed : 32|16@1+ (0.01,0) [0|655.32] "km/h" ECU',
      ' SG_ Temp : 8|8@1- (1,-40) [-40|215] "degC" ECU',
    ].join('\n');
    const { project, warnings } = importDbc(dbc);
    expect(project.frames).toHaveLength(1);
    const f = project.frames[0];
    expect(f.id).toBe(257);
    expect(f.isExtended).toBe(false);
    expect(f.name).toBe('ESP_02');
    expect(f.signals).toHaveLength(2);

    const [speed, temp] = f.signals as EditableSignal[];
    expect(speed).toMatchObject({
      name: 'Speed',
      bitStart: 32,
      bitLength: 16,
      byteOrder: 'little',
      signed: false,
      factor: 0.01,
      offset: 0,
      unit: 'km/h',
    });
    expect(temp).toMatchObject({ byteOrder: 'little', signed: true, offset: -40 });
    expect(warnings).toHaveLength(0);
  });

  test('parses big-endian (Motorola) byte order', () => {
    const { project } = importDbc('BO_ 100 M: 8 X\n SG_ S : 7|16@0+ (1,0) "" X');
    expect((project.frames[0].signals[0] as EditableSignal).byteOrder).toBe('big');
  });

  test('parses extended (29-bit) ids via the bit31 convention', () => {
    // 0x80000000 | 0x18FF0001 = 2566848513
    const { project } = importDbc('BO_ 2566848513 Ext: 8 X\n SG_ S : 0|8@1+ (1,0) "" X');
    expect(project.frames[0].isExtended).toBe(true);
    expect(project.frames[0].id).toBe(0x18ff0001);
  });

  test('parses MULTIPLEXING markers the old stub dropped', () => {
    const dbc = [
      'BO_ 2024 Mux: 8 X',
      ' SG_ Selector M : 0|8@1+ (1,0) "" X',
      ' SG_ WhenZero m0 : 8|8@1+ (1,0) "" X',
      ' SG_ WhenOne m1 : 8|16@1+ (0.1,0) "rpm" X',
    ].join('\n');
    const { project } = importDbc(dbc);
    const sigs = project.frames[0].signals as EditableSignal[];
    expect(sigs).toHaveLength(3); // <-- the stub regex matched 0 of these
    expect(sigs[0].isMultiplexor).toBe(true);
    expect(sigs[0].multiplexValue).toBeUndefined();
    expect(sigs[1].multiplexValue).toBe(0);
    expect(sigs[1].isMultiplexor).toBeUndefined();
    expect(sigs[2].multiplexValue).toBe(1);
  });

  test('attaches VAL_ enum labels and CM_ comments to the matching signal/frame', () => {
    const dbc = [
      'BO_ 1 A: 1 X',
      ' SG_ S : 0|8@1+ (1,0) "" X',
      'CM_ BO_ 1 "a message";',
      'CM_ SG_ 1 S "the signal";',
      'VAL_ 1 S 0 "off" 1 "on" ;',
    ].join('\n');
    const { project, warnings } = importDbc(dbc);
    expect(project.frames).toHaveLength(1);
    const frame = project.frames[0] as FrameDef;
    const sig = frame.signals[0] as EditableSignal;
    expect(sig.valueLabels).toEqual({ 0: 'off', 1: 'on' });
    // CM_ BO_ / CM_ SG_ are now CAPTURED (not dropped) → no warning.
    expect(frame.comment).toBe('a message');
    expect(sig.comment).toBe('the signal');
    expect(warnings).toHaveLength(0);
  });

  test('a non-modelled CM_ (global / BU_) is still counted as dropped', () => {
    const dbc = ['BO_ 1 A: 1 X', ' SG_ S : 0|8@1+ (1,0) "" X', 'CM_ "a global note";'].join('\n');
    const { warnings } = importDbc(dbc);
    expect(warnings.some((w) => /comment/.test(w))).toBe(true);
  });

  test('tolerates a bare `m` selector (opendbc vw_pq style) instead of dropping it', () => {
    const dbc = [
      'BO_ 648 MO2: 8 X',
      ' SG_ Mp_code m : 6|2@1+ (1,0) "" X', // bare `m` = selector
      ' SG_ when0 m0 : 0|6@1+ (1,0) "" X',
      ' SG_ when1 m1 : 0|6@1+ (1,0) "" X',
    ].join('\n');
    const sigs = importDbc(dbc).project.frames[0].signals as EditableSignal[];
    expect(sigs).toHaveLength(3); // selector no longer fails the regex
    expect(sigs[0].name).toBe('Mp_code');
    expect(sigs[0].isMultiplexor).toBe(true);
    expect(sigs[0].multiplexValue).toBeUndefined();
    expect(sigs[1].multiplexValue).toBe(0);
  });

  test('routes SG_MUL_VAL_ extended multiplexing to basic m<N> + selector', () => {
    const dbc = [
      'BO_ 100 X: 8 N',
      ' SG_ Sel : 0|8@1+ (1,0) "" N', // selector with NO inline marker
      ' SG_ Val : 8|8@1+ (1,0) "" N', // multiplexed signal with NO inline m<N>
      'SG_MUL_VAL_ 100 Val Sel 3-3;',
    ].join('\n');
    const sigs = importDbc(dbc).project.frames[0].signals as EditableSignal[];
    const sel = sigs.find((s) => s.name === 'Sel')!;
    const val = sigs.find((s) => s.name === 'Val')!;
    expect(sel.isMultiplexor).toBe(true); // promoted to selector
    expect(val.multiplexValue).toBe(3); // first range lower bound
  });

  test('seeds a per-frame Custom formula from the most salient signal', () => {
    const dbc = [
      'BO_ 640 engine_1: 8 X',
      ' SG_ CRC : 0|8@1+ (1,0) "" X', // filler — skipped
      ' SG_ flag : 8|1@1+ (1,0) "" X', // narrow — not chosen
      ' SG_ engine_rpm : 16|16@1+ (0.25,0) "rpm" X', // widest non-filler → chosen
    ].join('\n');
    const { project } = importDbc(dbc);
    const key = frameKey(640, false);
    const f = project.frameFormulas?.[key];
    expect(f).toBeDefined();
    expect(f!.unit).toBe('rpm');
    // The seeded formula reproduces decodeSignal for engine_rpm.
    const rpm = project.frames[0].signals.find((s) => s.name === 'engine_rpm') as EditableSignal;
    const data = new Uint8Array([0xff, 0xff, 0x10, 0x27, 0, 0, 0, 0]); // bytes 2-3 = 0x2710 = 10000
    expect(evalFormula(f!.expr, data, f!.unit).value).toBeCloseTo(
      decodeSignal(data, rpm).value,
      6,
    );
  });

  test('parses VAL_ with negative keys, gaps, and out-of-order pairs', () => {
    const dbc = [
      'BO_ 512 Gear: 1 X',
      ' SG_ Direction : 0|8@1- (1,0) "" X',
      'VAL_ 512 Direction 2 "Reverse" 0 "Neutral" -1 "Fault" ;',
    ].join('\n');
    const sig = importDbc(dbc).project.frames[0].signals[0] as EditableSignal;
    expect(sig.valueLabels).toEqual({ '-1': 'Fault', 0: 'Neutral', 2: 'Reverse' });
  });

  test('VAL_ whose signal/message is unknown is counted as dropped', () => {
    const dbc = [
      'BO_ 1 A: 1 X',
      ' SG_ S : 0|8@1+ (1,0) "" X',
      'VAL_ 999 Nope 0 "x" ;',
    ].join('\n');
    const { warnings } = importDbc(dbc);
    expect(warnings.some((w) => /value table/.test(w) && /no matching signal/.test(w))).toBe(true);
  });

  test('VAL_ resolves a signal on an extended-id message (bit31)', () => {
    const dbc = [
      'BO_ 2566848513 Ext: 8 X',
      ' SG_ Mode : 0|8@1+ (1,0) "" X',
      'VAL_ 2566848513 Mode 3 "Sport" ;',
    ].join('\n');
    const sig = importDbc(dbc).project.frames[0].signals[0] as EditableSignal;
    expect(sig.valueLabels).toEqual({ 3: 'Sport' });
  });

  test('warns when no BO_ is present', () => {
    const { project, warnings } = importDbc('VERSION ""\nNS_ :\n');
    expect(project.frames).toHaveLength(0);
    expect(warnings.some((w) => /no BO_/.test(w))).toBe(true);
  });
});

describe('signalToFormula ↔ decodeSignal (DBC → Custom bridge)', () => {
  const cases: { desc: string; sig: Partial<EditableSignal> }[] = [
    { desc: '8-bit aligned', sig: { bitStart: 8, bitLength: 8 } },
    { desc: '16-bit little aligned + factor', sig: { bitStart: 16, bitLength: 16, factor: 0.25, unit: 'rpm' } },
    { desc: '16-bit big aligned', sig: { bitStart: 7, bitLength: 16, byteOrder: 'big' } },
    { desc: '8-bit signed + offset', sig: { bitStart: 8, bitLength: 8, signed: true, factor: 0.75, offset: -48, unit: '°C' } },
    { desc: 'sub-byte unaligned (3 bits @ bit 5)', sig: { bitStart: 5, bitLength: 3 } },
    { desc: 'odd width spanning bytes (12 bits @ bit 4 little)', sig: { bitStart: 4, bitLength: 12, factor: 0.1 } },
    { desc: '4-bit nibble + factor', sig: { bitStart: 0, bitLength: 4, factor: 2 } },
  ];
  // A few deterministic payloads to exercise the generated expression.
  const payloads = [
    new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]),
    new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    new Uint8Array([0x00, 0x80, 0x7f, 0x01, 0x00, 0xaa, 0x55, 0x00]),
  ];
  for (const { desc, sig } of cases) {
    test(desc, () => {
      const s = makeSignal(1, false, { byteOrder: 'little', ...sig }) as EditableSignal;
      const f = signalToFormula(s);
      expect(f).not.toBeNull();
      for (const data of payloads) {
        expect(evalFormula(f!.expr, data, f!.unit).value).toBeCloseTo(decodeSignal(data, s).value, 6);
      }
    });
  }

  test('declines a signal touching a byte beyond A..H', () => {
    const s = makeSignal(1, false, { bitStart: 60, bitLength: 16 }) as EditableSignal; // spills past byte 8
    expect(signalToFormula(s)).toBeNull();
  });
});

describe('exportDbc / round-trip', () => {
  const sample = [
    'BO_ 257 ESP_02: 8 Gateway',
    ' SG_ Speed : 32|16@1+ (0.01,0) [0|655.32] "km/h" ECU',
    ' SG_ Temp : 8|8@1- (1,-40) [-40|215] "degC" ECU',
    'BO_ 2024 Mux: 8 X',
    ' SG_ Selector M : 0|8@1+ (1,0) "" X',
    ' SG_ WhenOne m1 : 8|16@0+ (0.1,0) "rpm" X',
  ].join('\n');

  test('exported text re-imports to an identical model (idempotent)', () => {
    const first = importDbc(sample).project;
    const second = importDbc(exportDbc(first)).project;

    // Frame identity preserved.
    expect(second.frames.map((f) => [f.id, f.isExtended, f.name])).toEqual(
      first.frames.map((f) => [f.id, f.isExtended, f.name]),
    );

    // Signal-level fields that DBC carries survive the round trip.
    const project = (p: typeof first) =>
      p.frames.flatMap((f) =>
        (f.signals as EditableSignal[]).map((s) => ({
          name: s.name,
          bitStart: s.bitStart,
          bitLength: s.bitLength,
          byteOrder: s.byteOrder,
          signed: s.signed,
          factor: s.factor,
          offset: s.offset,
          unit: s.unit,
          isMultiplexor: s.isMultiplexor,
          multiplexValue: s.multiplexValue,
        })),
      );
    expect(project(second)).toEqual(project(first));
  });

  test('export emits the M / m<N> markers', () => {
    const text = exportDbc(importDbc(sample).project);
    expect(text).toMatch(/SG_ Selector M :/);
    expect(text).toMatch(/SG_ WhenOne m1 :/);
  });

  test('VAL_ enum labels round-trip (import → export → import)', () => {
    const withVal = [
      'BO_ 512 Gear: 1 X',
      ' SG_ Direction : 0|8@1- (1,0) "" X',
      'VAL_ 512 Direction -1 "Fault" 0 "Neutral" 2 "Reverse" ;',
    ].join('\n');
    const first = importDbc(withVal).project;
    const text = exportDbc(first);
    expect(text).toMatch(/^VAL_ 512 Direction -1 "Fault" 0 "Neutral" 2 "Reverse" ;$/m);
    const second = importDbc(text).project;
    const sig = second.frames[0].signals[0] as EditableSignal;
    expect(sig.valueLabels).toEqual({ '-1': 'Fault', 0: 'Neutral', 2: 'Reverse' });
  });

  test('CM_ comments round-trip (frame + signal)', () => {
    const dbc = [
      'BO_ 7 Doors: 1 X',
      ' SG_ Lock : 0|1@1+ (1,0) "" X',
      'CM_ BO_ 7 "central locking";',
      'CM_ SG_ 7 Lock "1 = locked";',
    ].join('\n');
    const first = importDbc(dbc).project;
    const text = exportDbc(first);
    expect(text).toMatch(/^CM_ BO_ 7 "central locking";$/m);
    expect(text).toMatch(/^CM_ SG_ 7 Lock "1 = locked";$/m);
    const second = importDbc(text).project;
    expect((second.frames[0] as FrameDef).comment).toBe('central locking');
    expect((second.frames[0].signals[0] as EditableSignal).comment).toBe('1 = locked');
  });
});

describe('OBD2 starter', () => {
  test('builds one 0x7E8 frame with the PID byte as multiplexor', () => {
    const p = obd2StarterProject();
    expect(p.frames).toHaveLength(1);
    const f = p.frames[0];
    expect(f.id).toBe(OBD2_REPLY_ID);
    const sigs = f.signals as EditableSignal[];
    const mux = sigs.filter((s) => s.isMultiplexor);
    expect(mux).toHaveLength(1);
    expect(mux[0].name).toBe('PID');
    expect(mux[0].bitStart).toBe(16); // byte 2
    // Every data signal is multiplexed and big-endian (OBD2 is MSB-first).
    const data = sigs.filter((s) => !s.isMultiplexor);
    expect(data.length).toBeGreaterThan(5);
    expect(data.every((s) => s.multiplexValue !== undefined && s.byteOrder === 'big')).toBe(true);
    // RPM PID 0x0C: 2 bytes, factor 0.25.
    const rpm = data.find((s) => s.multiplexValue === 0x0c)!;
    expect(rpm).toMatchObject({ bitLength: 16, factor: 0.25, unit: 'rpm' });
  });

  test('survives a DBC round trip', () => {
    const before = obd2StarterProject();
    const after = importDbc(exportDbc(before)).project;
    expect(after.frames[0].signals).toHaveLength(before.frames[0].signals.length);
  });
});

// ── Opportunistic: real reference DBCs (un-committed; skip when absent) ───────
const EXT = (rel: string) =>
  fileURLToPath(new URL(`../../../../docs/external/${rel}`, import.meta.url));

const CORPUS: { name: string; path: string }[] = [
  { name: 'VW MQB', path: 'obd2-pack-v5/proprietary-can-dbc/VW/vw_mqb_2010.dbc' },
  { name: 'VW Golf Mk4', path: 'obd2-pack-v5/proprietary-can-dbc/VW/vw_golf_mk4.dbc' },
  { name: 'OBD2 v4.3', path: 'obd2-dbc-files/regular-version/OBD-v4.3.dbc' },
];

describe('corpus (local reference DBCs)', () => {
  for (const { name, path } of CORPUS) {
    const abs = EXT(path);
    const present = existsSync(abs);
    test.skipIf(!present)(`${name}: parses and round-trips`, () => {
      const text = readFileSync(abs, 'utf8');
      const { project } = importDbc(text);
      expect(project.frames.length).toBeGreaterThan(0);

      const reparsed = importDbc(exportDbc(project)).project;
      expect(reparsed.frames.length).toBe(project.frames.length);
      const count = (p: typeof project) => p.frames.reduce((n, f) => n + f.signals.length, 0);
      expect(count(reparsed)).toBe(count(project));
    });
  }
});
