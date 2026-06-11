<script lang="ts">
  /**
   * SIGNAL-DISCOVERY SWEEP — the third passive Scan analyzer (after the
   * bit-activity heatmap and the byte histogram). It SWEEPS candidate bit-range
   * interpretations of an id's payload under multiple conventions (width 8/16,
   * little/big endian, signed/unsigned, common VAG scale factors) and RANKS the
   * ones that behave like a real ANALOG signal:
   *
   *   • non-constant, bounded, and SMOOTHLY varying — a physical quantity ramps
   *     continuously (small sample-to-sample steps relative to its range), where
   *     a counter / checksum / noise JUMPS. The "smoothness" bar is that metric.
   *   • counter/checksum byte slots the Brick-0 tagger flags are EXCLUDED up
   *     front (a +1 counter is "smooth" until it wraps, so it would otherwise
   *     masquerade as a great signal).
   *
   * Each row shows the candidate's LOCUS (byteIndex / bitStart / width / endian /
   * signed / factor) + a one-click PROMOTE to a §3.5 signal. Promotion reuses the
   * SAME addSignal/makeSignal path HuntPanel.promote() uses: the parent owns the
   * store, so we emit the chosen candidate up via the `onPromote` callback and the
   * parent builds the signal (keeping store mutation in one place).
   *
   * Sweep targets the currently `selected` id when one is set (like the byte
   * histogram), else ranks across ALL ids in the window. The parent passes the
   * scan result + the set of already-promoted candidate keys for the ✓ state.
   */
  import type { SignalDiscoveryScanResult } from '../hunt/signalDiscovery';
  import type { SignalCandidate } from '@shared/analysis/signal-discovery.ts';

  export let scan: SignalDiscoveryScanResult | null = null;
  /** Candidate keys already promoted (so the button shows ✓ added). */
  export let promoted: Set<string> = new Set();
  /** Promote callback — the parent owns the store + makeSignal/addSignal path. */
  export let onPromote: (c: SignalCandidate) => void = () => {};

  $: candidates = scan ? scan.discovery.candidates : [];

  function idHex(id: number): string {
    return '0x' + id.toString(16).toUpperCase();
  }

  /** Human locus: "byte2 +16b BE signed ×0.1". */
  function locus(c: SignalCandidate): string {
    const endian = c.width === 8 ? '' : c.byteOrder === 'little' ? ' LE' : ' BE';
    const sign = c.signed ? ' signed' : '';
    const fac = c.factor === 1 ? '' : ` ×${c.factor}`;
    return `byte${c.byteIndex} +${c.width}b${endian}${sign}${fac}`;
  }

  /** A compact display value (trims noise, keeps small magnitudes readable). */
  function fmt(v: number): string {
    if (Number.isInteger(v)) return v.toString();
    const abs = Math.abs(v);
    if (abs >= 1000) return v.toFixed(1);
    if (abs >= 1) return v.toFixed(2);
    return v.toPrecision(3);
  }
</script>

<div class="discwrap">
  {#if !scan}
    <div class="dim small empty">
      no scan yet — connect to the sim, buffer some traffic, then press Scan
    </div>
  {:else if candidates.length === 0}
    <div class="dim small empty">
      no plausible signals found in the scanned window — try a longer window, more
      traffic, or a different id
    </div>
  {:else}
    <div class="head dim small">
      {scan.discovery.candidates.length} candidate{scan.discovery.candidates.length === 1 ? '' : 's'}
      · {scan.discovery.idCount} id{scan.discovery.idCount === 1 ? '' : 's'}
      · {scan.discovery.framesAnalyzed} frames
      {#if scan.discovery.excludedCount > 0}· {scan.discovery.excludedCount} slot{scan.discovery.excludedCount === 1 ? '' : 's'} excluded (counters/checksums){/if}
    </div>
    <div class="results">
      {#each candidates as c, i (c.key)}
        <div class="cand">
          <span class="rank">#{i + 1}</span>
          <span class="mono id">{idHex(c.id)}</span>
          <span class="mono loc" title="byte index · width · endian · signedness · scale">{locus(c)}</span>
          <div class="bar" title="smoothness — how continuously the value moves (1 = smooth ramp, 0 = jumps like a counter)">
            <div class="fill" style="width:{Math.min(100, c.smoothness * 100).toFixed(0)}%"></div>
          </div>
          <span class="mono smooth" title="smoothness score">{c.smoothness.toFixed(2)}</span>
          <span class="mono range dim" title="observed scaled range [min – max] over {c.samples} samples · {c.distinct} distinct">
            [{fmt(c.min)}–{fmt(c.max)}]
          </span>
          <button class="promote" class:done={promoted.has(c.key)} on:click={() => onPromote(c)}>
            {promoted.has(c.key) ? '✓ added' : '→ signal'}
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .discwrap {
    overflow: auto;
    max-height: 60vh;
  }
  .head {
    margin-bottom: 6px;
  }
  .cand {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 5px;
    margin-bottom: 4px;
    background: var(--bg-elev);
  }
  .rank {
    width: 22px;
    font-size: 11px;
    color: var(--text-dim);
    text-align: right;
  }
  .id {
    width: 64px;
    color: var(--accent);
  }
  .loc {
    width: 170px;
    font-size: 11px;
  }
  .bar {
    width: 90px;
    height: 8px;
    background: var(--bg);
    border-radius: 4px;
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
  }
  .smooth {
    width: 36px;
    text-align: right;
  }
  .range {
    flex: 1;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .promote.done {
    color: var(--ok);
    border-color: var(--accent-dim);
  }
  .small {
    font-size: 11px;
  }
  .empty {
    padding: 16px 8px;
    text-align: center;
  }
</style>
