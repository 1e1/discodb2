<script lang="ts">
  /**
   * CORRELATION AGAINST A KNOWN SIGNAL — the fifth passive Scan analyzer (after the
   * bit-activity heatmap, the byte histogram, the signal-discovery sweep and the
   * co-occurrence matrix). Unlike the others it takes ONE operator input: a
   * REFERENCE — an existing §3.5 signal the operator already decoded (rpm, speed,
   * …). The analyzer then ranks every candidate locus by how tightly its decoded
   * series CO-VARIES (Spearman rank correlation ρ) with that reference over the
   * window. The textbook use: find the GEAR by correlating against RPM/SPEED.
   *
   *   • ρ in [-1, 1]: +1 = moves the SAME way as the reference, −1 = moves OPPOSITE
   *     (an inverse relationship — just as informative), 0 = unrelated. We rank by
   *     |ρ| and show the sign, so "tracks" and "inversely tracks" both surface.
   *   • Spearman (rank), not Pearson, so a MONOTONE-but-nonlinear relationship (a
   *     gear staircase, an unknown scale/offset) still scores near ±1.
   *   • counter/checksum byte slots the Brick-0 tagger flags are EXCLUDED up front
   *     (a +1 counter correlates spuriously with any rising reference).
   *
   * The operator picks the reference from the project's §3.5 signals via the
   * dropdown below; choosing one (re)runs the analysis through the parent. Each row
   * shows the candidate LOCUS + a one-click PROMOTE to a §3.5 signal, reusing the
   * SAME addSignal/makeSignal path as the sweep: the parent owns the store, so we
   * emit the chosen candidate up via `onPromote`.
   */
  import type { SignalCorrelationScanResult } from '../hunt/signalCorrelation';
  import type { CorrelationCandidate } from '@shared/analysis/signal-correlation.ts';
  import type { EditableSignal } from '../protocol/datamodel';

  export let scan: SignalCorrelationScanResult | null = null;
  /** The §3.5 signals the operator can pick as a reference (from the project). */
  export let references: EditableSignal[] = [];
  /** The currently selected reference signal's id (EditableSignal.id), or ''. */
  export let referenceId: string = '';
  /** Candidate keys already promoted (so the button shows ✓ added). */
  export let promoted: Set<string> = new Set();
  /** Promote callback — the parent owns the store + makeSignal/addSignal path. */
  export let onPromote: (c: CorrelationCandidate) => void = () => {};
  /** Reference-change callback — the parent re-runs the analysis with the new ref. */
  export let onPickReference: (refId: string) => void = () => {};

  $: candidates = scan ? scan.correlation.candidates : [];
  $: hasReference = referenceId !== '' && references.some((r) => r.id === referenceId);

  function idHex(id: number): string {
    return '0x' + id.toString(16).toUpperCase();
  }

  /** A reference signal's label for the dropdown: "rpm · 0x280 +16b". */
  function refLabel(r: EditableSignal): string {
    const endian = r.bitLength <= 8 ? '' : r.byteOrder === 'little' ? ' LE' : ' BE';
    return `${r.name} · ${idHex(r.frameId)} b${r.bitStart}+${r.bitLength}${endian}`;
  }

  /** Human locus: "byte2 +16b BE signed". */
  function locus(c: CorrelationCandidate): string {
    const endian = c.width === 8 ? '' : c.byteOrder === 'little' ? ' LE' : ' BE';
    const sign = c.signed ? ' signed' : '';
    return `byte${c.byteIndex} +${c.width}b${endian}${sign}`;
  }

  function onSelect(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    onPickReference(v);
  }
</script>

<div class="corrwrap">
  <div class="refpick">
    <label>reference
      <select value={referenceId} on:change={onSelect} disabled={references.length === 0}>
        <option value="">{references.length === 0 ? 'no signals yet — decode one first' : 'pick a known signal…'}</option>
        {#each references as r (r.id)}
          <option value={r.id}>{refLabel(r)}</option>
        {/each}
      </select>
    </label>
    <span class="dim small">rank loci by how they co-vary with this signal (e.g. gear vs rpm/speed)</span>
  </div>

  {#if references.length === 0}
    <div class="dim small empty">
      correlation needs a known signal to compare against — decode one (or promote a
      discovery candidate), then it appears here as a reference
    </div>
  {:else if !hasReference}
    <div class="dim small empty">
      pick a reference signal above, then press Scan to rank loci that track it
    </div>
  {:else if !scan}
    <div class="dim small empty">
      no scan yet — connect to the sim, buffer some traffic, then press Scan
    </div>
  {:else if scan.correlation.referenceSamples === 0}
    <div class="dim small empty">
      the reference signal has no frames in the scanned window — widen the window or
      pick a reference id that's on the bus
    </div>
  {:else if candidates.length === 0}
    <div class="dim small empty">
      no locus tracks the reference in this window — try a longer window, more
      traffic, or a different reference
    </div>
  {:else}
    <div class="head dim small">
      {scan.correlation.candidates.length} candidate{scan.correlation.candidates.length === 1 ? '' : 's'}
      · {scan.correlation.idCount} id{scan.correlation.idCount === 1 ? '' : 's'}
      · ref {scan.correlation.referenceSamples} samples
      · {scan.correlation.framesAnalyzed} frames
      {#if scan.correlation.excludedCount > 0}· {scan.correlation.excludedCount} slot{scan.correlation.excludedCount === 1 ? '' : 's'} excluded (counters/checksums){/if}
    </div>
    <div class="results">
      {#each candidates as c, i (c.key)}
        <div class="cand">
          <span class="rank">#{i + 1}</span>
          <span class="mono id">{idHex(c.id)}</span>
          <span class="mono loc" title="byte index · width · endian · signedness">{locus(c)}</span>
          <div class="bar" title="|Spearman ρ| — how tightly this locus tracks the reference (1 = perfect monotone, 0 = unrelated)">
            <div class="fill" class:neg={c.rho < 0} style="width:{Math.min(100, c.absRho * 100).toFixed(0)}%"></div>
          </div>
          <span class="mono rho" title="Spearman rank correlation with the reference (+ tracks, − inverse)">
            {c.rho >= 0 ? '+' : ''}{c.rho.toFixed(2)}
          </span>
          <span class="mono ev dim" title="aligned sample pairs · distinct decoded values">
            {c.pairs}pt · {c.distinct} distinct
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
  .corrwrap {
    overflow: auto;
    max-height: 60vh;
  }
  .refpick {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }
  .refpick label {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--text-dim);
  }
  .refpick select {
    max-width: 280px;
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
    border-radius: var(--radius-md);
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
    width: 150px;
    font-size: 11px;
  }
  .bar {
    width: 90px;
    height: 8px;
    background: var(--bg);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
  }
  /* An inverse relationship (ρ<0) is colour-coded so "falls as the reference
     rises" reads distinctly from "rises with it". */
  .fill.neg {
    background: var(--warn, #e0a83c);
  }
  .rho {
    width: 42px;
    text-align: right;
  }
  .ev {
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
