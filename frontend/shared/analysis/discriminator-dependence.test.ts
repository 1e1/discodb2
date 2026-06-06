// Unit tests for the DISCRIMINATOR ↔ PAYLOAD DEPENDENCE analyzer
// (analysis/discriminator-dependence.ts).
//
// node:test + node:assert/strict, run with `node --test --experimental-strip-types`.
// Deterministic — cases are constructed from a single counter `n`, using coprime
// periods to build provably-independent pairs (CRT) where needed.
//
// The analyzer answers: does conditioning on a candidate field PREDICT the rest
// of the payload (real multiplexor) or not (status byte)? Tests pin:
//   #1 a field the payload DEPENDS on → dependent, not rejected.
//   #2 a low-card status byte with an INDEPENDENT payload → rejected.
//   #3 the SPARSITY GUARD: an independent HIGH-card target whose plug-in NMI is
//      inflated is still NOT called dependent, because the shifted null is inflated
//      the same way → rejected.
//   #4 too few frames → inconclusive (never rejects).
//   #5 a constant target is skipped (not judgeable).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  payloadDependence,
  type DependenceFrame,
} from "./discriminator-dependence.ts";

function frames(count: number, mk: (n: number) => number[]): DependenceFrame[] {
  const out: DependenceFrame[] = [];
  for (let n = 0; n < count; n++) out.push({ id: 0x100, data: mk(n) });
  return out;
}

test("#1 a payload that depends on the field → dependent, not rejected", () => {
  // key = byte0 = n%2. byte1's HIGH part is set by the key (key0 → 0x0X, key1 →
  // 0x4X), so byte1 depends on the key — a real partition.
  const fs = frames(60, (n) => [n % 2, (n % 2) * 0x40 + (n % 4)]);
  const res = payloadDependence(fs, { byteIndex: 0, bitLo: 0, bitLen: 1 }, [1]);

  assert.equal(res.conclusive, true);
  assert.equal(res.targetsJudged, 1);
  assert.equal(res.dependentBytes, 1);
  assert.equal(res.perByte[0].dependent, true);
  assert.equal(res.rejects, false);
});

test("#2 a status byte with an independent payload → rejected", () => {
  // key = byte0 = n%3 (period 3), byte1 = (n%2)*0x55 (period 2). Coprime periods
  // ⇒ key and byte1 are independent (CRT), well-sampled → MI ≈ 0.
  const fs = frames(60, (n) => [n % 3, (n % 2) * 0x55]);
  const res = payloadDependence(fs, { byteIndex: 0, bitLo: 0, bitLen: 2 }, [1]);

  assert.equal(res.conclusive, true);
  assert.equal(res.targetsJudged, 1);
  assert.equal(res.perByte[0].dependent, false);
  assert.equal(res.rejects, true);
});

test("#3 sparsity guard: an independent HIGH-card target is not called dependent", () => {
  // key = n%3 (period 3). byte1 = ARR[n%16] (16 distinct values, period 16).
  // gcd(3,16)=1 ⇒ independent, but with 3×16 cells the plug-in NMI is inflated by
  // sparsity. The shifted-null NMI is inflated identically → the margin is NOT
  // cleared → not dependent → rejected. This is the whole point of the null.
  const ARR = [0x10, 0x23, 0x4a, 0x05, 0xf1, 0x88, 0x3c, 0x67, 0xb2, 0x09, 0xde, 0x71, 0x55, 0xa0, 0x2e, 0xcc];
  const fs = frames(96, (n) => [n % 3, ARR[n % 16]]);
  const res = payloadDependence(fs, { byteIndex: 0, bitLo: 0, bitLen: 2 }, [1]);

  assert.equal(res.conclusive, true);
  assert.equal(res.perByte[0].dependent, false, "the permutation null must absorb the sparsity inflation");
  assert.equal(res.rejects, true);
});

test("#4 too few paired frames → inconclusive, never rejects", () => {
  const fs = frames(10, (n) => [n % 2, (n % 2) * 0x40]);
  const res = payloadDependence(fs, { byteIndex: 0, bitLo: 0, bitLen: 1 }, [1]);

  assert.equal(res.conclusive, false);
  assert.equal(res.rejects, false);
});

test("#5 a constant target byte is skipped (not judgeable)", () => {
  // byte1 is always 0 → no information → not judged. With it the only target,
  // there is nothing to conclude → no rejection.
  const fs = frames(40, (n) => [n % 2, 0x00]);
  const res = payloadDependence(fs, { byteIndex: 0, bitLo: 0, bitLen: 1 }, [1]);

  assert.equal(res.targetsJudged, 0);
  assert.equal(res.conclusive, false);
  assert.equal(res.rejects, false);
});

test("#6 sampleCap preserves the verdict on a large DEPENDENT history", () => {
  // 40k frames, byte1 high part set by the key → a real partition. With the
  // default cap (8192) the test walks ≤8192 samples but must still call it
  // dependent — the estimate is unchanged by capping a clean partition.
  const fs = frames(40000, (n) => [n % 4, (n % 4) * 0x40 + (n % 7)]);
  const res = payloadDependence(fs, { byteIndex: 0, bitLo: 0, bitLen: 2 }, [1]);

  assert.equal(res.conclusive, true);
  assert.equal(res.dependentBytes, 1);
  assert.equal(res.perByte[0].dependent, true);
  assert.equal(res.rejects, false);
});

test("#7 sampleCap preserves the verdict on a large INDEPENDENT history", () => {
  // 40k frames, coprime periods (3, 2) → key ⊥ byte1 (CRT). Capping must not
  // manufacture a spurious dependence → still rejected.
  const fs = frames(40000, (n) => [n % 3, (n % 2) * 0x55]);
  const res = payloadDependence(fs, { byteIndex: 0, bitLo: 0, bitLen: 2 }, [1]);

  assert.equal(res.conclusive, true);
  assert.equal(res.perByte[0].dependent, false);
  assert.equal(res.rejects, true);
});

test("#8 capping is deterministic and a no-op at or below the cap", () => {
  // Deterministic: a fixed-seed sub-sample → identical NMI across calls.
  const big = frames(40000, (n) => [n % 4, (n % 4) * 0x40 + (n % 7)]);
  const a = payloadDependence(big, { byteIndex: 0, bitLo: 0, bitLen: 2 }, [1]);
  const b = payloadDependence(big, { byteIndex: 0, bitLo: 0, bitLen: 2 }, [1]);
  assert.equal(a.perByte[0].nmi, b.perByte[0].nmi);
  assert.equal(a.perByte[0].nullNmi, b.perByte[0].nullNmi);

  // No-op below the cap: capped (default) ≡ uncapped (sampleCap 0) bit-exact when
  // the history is smaller than the cap.
  const small = frames(2000, (n) => [n % 3, (n % 2) * 0x55]);
  const capped = payloadDependence(small, { byteIndex: 0, bitLo: 0, bitLen: 2 }, [1]);
  const uncapped = payloadDependence(small, { byteIndex: 0, bitLo: 0, bitLen: 2 }, [1], { sampleCap: 0 });
  assert.equal(capped.perByte[0].nmi, uncapped.perByte[0].nmi);
  assert.equal(capped.perByte[0].nullNmi, uncapped.perByte[0].nullNmi);
  assert.equal(capped.rejects, uncapped.rejects);
});
