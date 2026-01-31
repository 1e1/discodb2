// RELATIVE time only (per spec). The backend's µs timestamps are monotonic and
// have no wall-clock meaning (Pi has no RTC, §4.2); we never render an absolute
// clock. All ages are computed against the local performance.now() at receipt.

/** Format an age in ms as a short relative string: "now", "1.2s", "8s", "3m". */
export function relAge(ageMs: number): string {
  if (!isFinite(ageMs) || ageMs < 0) return "—";
  if (ageMs < 250) return "now";
  if (ageMs < 1000) return `${(ageMs / 1000).toFixed(1)}s`;
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m`;
  return `${Math.round(ageMs / 3_600_000)}h`;
}

/** Staleness bucket for colour-coding a tile. */
export function staleness(ageMs: number): "fresh" | "stale" | "dead" {
  if (ageMs < 1500) return "fresh";
  if (ageMs < 5000) return "stale";
  return "dead";
}
