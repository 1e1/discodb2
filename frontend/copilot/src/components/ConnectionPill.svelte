<script lang="ts">
  // Compact status header. M3 / A1: convey state by SHAPE + ICON + COLOUR +
  // NUMBER — never by hue alone (colour-blind safety). The dot carries a
  // DISTINCT SHAPE per state (solid disc = live · hollow ring = working ·
  // square = down) AND a tiny glyph (✓ / ⋯ / ✕), so the state reads without
  // relying on green/amber/red. The label is a short one-word token, the fps a
  // number, the source a tag. Detailed/technical strings (errors) live in
  // title/aria for parked inspection, not as glance text. All RELATIVE.
  import type { ConnState } from "../protocol/client";
  import type { Health } from "../protocol/types";
  import { STR } from "../lib/strings";

  interface Props {
    conn: ConnState;
    fps: number;
    replay: boolean;
    health: Health | null;
    wakeSupported: boolean;
    wakeHeld: boolean;
    lastError: string | null;
    ontoggleWake: () => void;
  }
  let {
    conn,
    fps,
    replay,
    health,
    wakeSupported,
    wakeHeld,
    lastError,
    ontoggleWake,
  }: Props = $props();

  let dotClass = $derived(
    conn === "open"
      ? "ok"
      : conn === "connecting" || conn === "reconnecting"
        ? "warn"
        : "bad",
  );
  // A1: a SHAPE/ICON cue that does not depend on hue. ✓ live · ⋯ working ·
  // ✕ down — paired with the distinct dot shape so a colour-blind glance still
  // separates the three states. (Shape-coded states kept intact.)
  let dotGlyph = $derived(dotClass === "ok" ? "✓" : dotClass === "warn" ? "⋯" : "✕");
  // Short token (≤ one word). LIVE / REPLAY when up; an ellipsis while working
  // (the SHAPE + amber pulse carry the meaning); a one-word token when down.
  let connLabel = $derived(
    conn === "open"
      ? replay
        ? "REPLAY"
        : "LIVE"
      : conn === "connecting" || conn === "reconnecting"
        ? "···"
        : conn === "closed"
          ? STR.offline
          : "—",
  );
  // Full state in the title/aria for parked inspection (not glance text).
  let connTitle = $derived(
    conn === "open"
      ? replay
        ? "replay"
        : "live"
      : conn === "reconnecting"
        ? "reconnecting…"
        : conn === "connecting"
          ? "connecting…"
          : conn === "closed"
            ? "disconnected"
            : "idle",
  );
</script>

<header>
  <div class="left">
    <span class="dot {dotClass}" role="img" aria-label="connection: {connTitle}" title={connTitle}>
      <span class="dot-glyph" aria-hidden="true">{dotGlyph}</span>
    </span>
    <span class="state">{connLabel}</span>
    {#if conn === "open"}
      <span class="fps mono muted">{fps}/s</span>
      {#if health}<span class="src mono muted">{health.source}</span>{/if}
    {/if}
  </div>
  <button
    class="wake"
    class:on={wakeHeld}
    disabled={!wakeSupported}
    onclick={ontoggleWake}
    aria-pressed={wakeHeld}
    aria-label={wakeSupported
      ? wakeHeld
        ? "screen awake — tap to let it sleep"
        : "let it sleep — tap to keep awake"
      : "wake-lock unavailable"}
    title={wakeSupported ? "keep the screen awake" : "wake-lock unavailable"}
  >{wakeHeld ? "☀" : wakeSupported ? "☾" : "⚠"}</button>
</header>
{#if lastError && conn !== "open"}
  <!-- M3 / A4: no full error sentence on the glance surface — a red bar + a
       ⚠ icon + a SINGLE token signals "problem"; the raw detail stays in
       title/aria for parked inspection. -->
  <div class="err" role="img" aria-label="error: {lastError}" title={lastError}>
    <span aria-hidden="true">⚠</span> Link
  </div>
{/if}

<style>
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    background: var(--panel);
    border-radius: 14px;
  }
  .left {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  /* A1: each state has a DISTINCT SHAPE, not just a hue — solid disc (live),
     hollow ring (working), square (down) — and carries a tiny glyph. Sized up
     to ~18px so the shape + glyph read at a glance. */
  .dot {
    width: 18px;
    height: 18px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #0a0a0a;
  }
  .dot-glyph {
    font-size: 11px;
    line-height: 1;
    font-weight: 900;
  }
  .dot.ok {
    /* solid disc */
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent);
  }
  .dot.warn {
    /* hollow ring — distinct shape, glyph rendered in the warn hue */
    border-radius: 50%;
    background: transparent;
    border: 3px solid var(--warn);
    color: var(--warn);
    animation: pulse 1s ease-in-out infinite;
  }
  .dot.bad {
    /* square — unmistakably different from the round live/working states */
    border-radius: 4px;
    background: var(--bad);
  }
  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }
  .state {
    font-weight: 700;
    letter-spacing: 0.04em;
  }
  .fps,
  .src {
    font-size: 0.85rem;
  }
  .wake {
    min-width: 48px;
    min-height: 44px;
    padding: 0;
    border-radius: 12px;
    font-size: 1.3rem;
    line-height: 1;
  }
  .wake.on {
    background: var(--accent);
    color: #003;
    border-color: transparent;
    font-weight: 700;
  }
  .wake:disabled {
    opacity: 0.5;
  }
  .err {
    margin-top: 6px;
    padding: 8px 12px;
    background: rgba(248, 114, 114, 0.12);
    border: 1px solid var(--bad);
    border-radius: 10px;
    color: var(--bad);
    font-size: 0.9rem;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  /* Respect reduced motion: the amber "working" dot stops pulsing. */
  @media (prefers-reduced-motion: reduce) {
    .dot.warn {
      animation: none;
    }
  }
</style>
