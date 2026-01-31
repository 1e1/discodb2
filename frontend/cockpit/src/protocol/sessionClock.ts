/**
 * Session clock — owns the mapping between BACKEND monotonic µs timestamps
 * (§3.2 / invariant §4.2) and RELATIVE display time.
 *
 * DESIGN constraints:
 *   - "Timestamps are backend monotonic/HW µs. Wall clock is never trusted"
 *     (§4.2). The backend never sends wall-clock time.
 *   - "Absolute session time is assigned by the connecting client" (§4.2): we
 *     capture the browser wall clock ONCE, on connect, as the session anchor.
 *   - "UI shows RELATIVE time only" (task): all on-screen times are seconds
 *     since the first frame of the session. The absolute anchor is retained
 *     only so exports can be stamped if desired.
 */
export class SessionClock {
  /** Browser wall-clock Date captured at connect. Not shown in the UI. */
  readonly sessionStartWall: Date;
  /** performance.now() at connect, for monotonic UI-side elapsed if needed. */
  readonly sessionStartPerf: number;

  /** Backend µs of the very first frame seen; the relative-time origin. */
  private baseTUs: number | null = null;

  constructor(now: Date = new Date(), perf: number = performance.now()) {
    this.sessionStartWall = now;
    this.sessionStartPerf = perf;
  }

  /** Record a backend µs timestamp; the first one becomes t=0. */
  observe(tUs: number): void {
    if (this.baseTUs === null) this.baseTUs = tUs;
  }

  hasOrigin(): boolean {
    return this.baseTUs !== null;
  }

  /** Relative seconds since the first frame, for a given backend µs timestamp. */
  relSeconds(tUs: number): number {
    if (this.baseTUs === null) return 0;
    return (tUs - this.baseTUs) / 1e6;
  }

  /** The relative "now" = latest observed backend time minus origin. */
  relSecondsFromMax(maxTUs: number): number {
    return this.relSeconds(maxTUs);
  }
}

/** Format relative seconds as mm:ss.mmm for compact display. */
export function formatRel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

/** Format an age (seconds ago) compactly, e.g. "12ms", "1.4s", "—". */
export function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  return `${m}m${Math.round(seconds - m * 60)}s`;
}
