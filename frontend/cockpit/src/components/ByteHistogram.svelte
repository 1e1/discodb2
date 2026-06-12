<script lang="ts">
  /**
   * PER-BYTE VALUE HISTOGRAM — the value-distribution cousin of the bit-activity
   * heatmap. For ONE target id (the currently `selected` id), it shows, per byte,
   * how that byte's VALUE is distributed over the scanned window:
   *
   *   • a byte with FEW tall bars (a handful of distinct values) is likely an
   *     ENUM / FLAG — a small set of states;
   *   • a byte with a BROAD spread of bars across [min..max] is likely an ANALOG
   *     signal (speed, rpm, fuel) sampled into a byte.
   *
   * This complements the heatmap (which shows WHICH bits move): the histogram
   * shows HOW a byte's value is distributed. Each byte renders on its OWN small
   * canvas (256 value bins drawn as columns; DESIGN §6: never one DOM node per
   * point) via the ByteHistogramBar child, so it stays light at 256 bins × 8 B.
   *
   * Bytes the Brick-0 tagger flags as counter/checksum get an amber badge: a
   * free-running counter spreads over many values and would otherwise masquerade
   * as a rich analog byte, so the operator can dismiss it.
   *
   * The id shown is the parent's `selected` id (chains from a heatmap row click).
   * When nothing is selected, we show the brief's hint instead.
   */
  import type { ByteHistogramScanResult } from '../hunt/byteHistogram';
  import type { Tag } from '@shared/analysis/tagger.ts';
  import ByteHistogramBar from './ByteHistogramBar.svelte';

  export let scan: ByteHistogramScanResult | null = null;
  /** The id to render (the store's `selected` id); null = nothing selected. */
  export let targetId: number | null = null;

  // The per-id profile for the target id, looked up from the scan result.
  $: profile =
    scan && targetId !== null
      ? scan.histogram.ids.find((p) => p.id === targetId) ?? null
      : null;
  $: tags = scan && targetId !== null ? scan.tagsById.get(targetId) ?? [] : [];

  function idHex(id: number): string {
    return '0x' + id.toString(16).toUpperCase();
  }

  /** The tag (if any) on a given byte index, for the noise badge. */
  function tagFor(byteIndex: number): Tag | undefined {
    return tags.find((t) => t.byteIndex === byteIndex);
  }

  function badgeText(t: Tag): string {
    if (t.kind === 'counter') return t.nibble ? `counter ${t.nibble}` : 'counter';
    return t.scheme ? `checksum ${t.scheme}` : 'checksum';
  }
</script>

<div class="histwrap">
  {#if targetId === null}
    <div class="dim small empty">
      select an id (e.g. click a row in the bit-activity heatmap)
    </div>
  {:else if !profile}
    <div class="dim small empty">
      {idHex(targetId)} — no frames for this id in the scanned window
    </div>
  {:else}
    <div class="head">
      <span class="mono id">{idHex(profile.id)}</span>
      <span class="dim small">{profile.frames} frames · DLC {profile.maxByte}</span>
    </div>
    <div class="grid">
      {#each profile.bytes as b (b.byteIndex)}
        {@const t = tagFor(b.byteIndex)}
        <div class="byte" class:noise={!!t}>
          <div class="byterow">
            <span class="mono blabel">B{b.byteIndex}</span>
            {#if t}
              <span class="badge" title={`flagged by the tagger (confidence ${(t.confidence * 100).toFixed(0)}%)`}>
                {badgeText(t)}
              </span>
            {/if}
          </div>
          <ByteHistogramBar counts={b.counts} min={b.min} max={b.max} />
          <div class="stats dim small mono">
            {#if b.samples === 0}
              no samples
            {:else}
              {b.distinct} val{b.distinct === 1 ? '' : 's'} · [{b.min}–{b.max}] · n{b.samples}
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .histwrap {
    overflow: auto;
    max-height: 60vh;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 6px;
  }
  .id {
    color: var(--accent);
    font-weight: 600;
  }
  .grid {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .byte {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 5px 6px;
    background: var(--bg-elev);
  }
  .byte.noise {
    border-color: #5a4a1e;
  }
  .byterow {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 3px;
  }
  .blabel {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-dim);
  }
  /* Tagger annotation flag (counter/checksum): amber warn color, plus a tighter
     font/padding than the global default for this dense byte grid. Shape/border
     width come from the global .badge primitive. */
  .badge {
    font-size: 9px;
    color: var(--warn);
    border-color: var(--warn);
    padding: 0 4px;
  }
  .stats {
    margin-top: 3px;
    font-size: 10px;
  }
  .small {
    font-size: 11px;
  }
  .empty {
    padding: 16px 8px;
    text-align: center;
  }
</style>
