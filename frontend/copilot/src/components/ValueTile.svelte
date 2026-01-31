<script lang="ts">
  // A big, glanceable value tile for one watch. Shows the latest value (large),
  // unit, label, and a RELATIVE age. Tapping selects it for the gauge; the
  // trash button removes it. Stale/dead colour-coding from frame age.
  import type { WatchEntry } from "../lib/store.svelte";
  import { relAge, staleness } from "../lib/relTime";

  interface Props {
    entry: WatchEntry;
    tick: number;
    isGauge: boolean;
    onselect: (key: string) => void;
    onremove: (key: string) => void;
  }
  let { entry, tick, isGauge, onselect, onremove }: Props = $props();

  // Recompute from tick (display rate), reading mutable latest in place.
  let view = $derived.by(() => {
    void tick;
    const lv = entry.latest;
    const ageMs = lv.seenAtMs > 0 ? performance.now() - lv.seenAtMs : Infinity;
    return {
      value: lv.value,
      seq: lv.seq,
      isError: lv.isError,
      ageMs,
      stale: lv.seenAtMs > 0 ? staleness(ageMs) : "dead",
    };
  });

  let display = $derived(formatValue(entry.watch.kind, view.value));
  let unit = $derived(entry.watch.kind === "signal" ? entry.watch.unit : "");

  function formatValue(kind: string, v: number): string {
    if (kind === "frame") return "·";
    if (!isFinite(v)) return "—";
    const a = Math.abs(v);
    if (Number.isInteger(v) || a >= 1000) return v.toFixed(0);
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    return v.toFixed(2);
  }
</script>

<div
  class="tile {view.stale}"
  class:gauge={isGauge}
  class:err={view.isError}
  role="button"
  tabindex="0"
  onclick={() => onselect(entry.watch.key)}
  onkeydown={(e) => (e.key === "Enter" || e.key === " ") && onselect(entry.watch.key)}
>
  <div class="head">
    <span class="label">{entry.watch.label}</span>
    {#if view.isError}
      <!-- A1: don't signal error by the red border alone — add a SHAPE/ICON cue
           that reads without relying on hue. -->
      <span class="err-flag" role="img" aria-label="error" title="error">⚠</span>
    {/if}
    <button
      class="x"
      aria-label="remove"
      onclick={(e) => {
        e.stopPropagation();
        onremove(entry.watch.key);
      }}>✕</button
    >
  </div>
  <div class="value mono">
    {display}{#if unit}<span class="u">{unit}</span>{/if}
  </div>
  <div class="foot mono muted">
    <span>{relAge(view.ageMs)}</span>
    {#if isGauge}<span class="badge" aria-label="jauge" title="jauge">◉</span>{/if}
  </div>
</div>

<style>
  .tile {
    background: var(--panel);
    border: 2px solid var(--line);
    border-radius: 18px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    min-height: 120px;
    gap: 6px;
  }
  .tile.gauge {
    border-color: var(--accent);
  }
  .tile.err {
    border-color: var(--bad);
  }
  .tile.stale {
    opacity: 0.85;
  }
  .tile.dead {
    opacity: 0.45;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .label {
    font-size: 0.95rem;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .err-flag {
    flex: none;
    color: var(--bad);
    font-size: 1rem;
    line-height: 1;
  }
  .x {
    min-width: 36px;
    min-height: 36px;
    padding: 0;
    border-radius: 10px;
    background: transparent;
    border: none;
    color: var(--muted);
    font-size: 1rem;
  }
  .x:active {
    background: var(--panel-2);
  }
  .value {
    font-size: clamp(2.6rem, 13vw, 4rem);
    font-weight: 800;
    line-height: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .u {
    font-size: 1.1rem;
    font-weight: 500;
    color: var(--muted);
    margin-left: 6px;
  }
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.85rem;
  }
  .badge {
    color: var(--accent);
    text-transform: uppercase;
    font-size: 0.7rem;
    letter-spacing: 0.08em;
  }
</style>
