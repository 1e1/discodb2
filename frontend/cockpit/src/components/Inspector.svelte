<script lang="ts">
  /**
   * Inspector for the selected CAN id:
   *   - per-BIT change grid that flashes on change (BitGrid, canvas),
   *   - payload HISTORY (recent distinct payloads, from the ring buffer),
   *   - the §3.5 signals defined on this id + live-decoded values,
   *   - add/name signals; a per-byte sparkline of the value over the window.
   */
  import {
    frameRows,
    selected,
    project,
    ring,
    maxTUs,
    addSignal,
    renameFrame,
    frameDefFor,
    getSessionClock,
  } from '../state/store';
  import { makeSignal, type EditableSignal } from '../protocol/datamodel';
  import BitGrid from './BitGrid.svelte';
  import SignalEditor from './SignalEditor.svelte';
  import Sparkline from './Sparkline.svelte';
  import { decodeSignal } from '../protocol/decode';

  $: sel = $selected;
  $: row = sel ? $frameRows.find((r) => r.id === sel.id && r.isExtended === sel.isExtended) : null;
  // Re-read the FrameDef whenever the selection OR the project changes. We read
  // the project store directly here so this depends on both reactively.
  $: def = lookupDef(sel, $project);

  function lookupDef(
    s: { id: number; isExtended: boolean } | null,
    _project: typeof $project,
  ) {
    return s ? frameDefFor(s.id, s.isExtended) : undefined;
  }

  $: liveData = row ? row.data : new Uint8Array(0);

  let nameDraft = '';
  $: if (sel) nameDraft = def?.name ?? idHex(sel.id, sel.isExtended);

  function idHex(id: number, ext: boolean): string {
    return '0x' + id.toString(16).toUpperCase().padStart(ext ? 8 : 3, '0');
  }

  function commitName() {
    if (sel) renameFrame(sel.id, sel.isExtended, nameDraft.trim() || idHex(sel.id, sel.isExtended));
  }

  function addNewSignal() {
    if (!sel) return;
    const sig = makeSignal(sel.id, sel.isExtended, { name: `sig_${(def?.signals.length ?? 0) + 1}` });
    addSignal(sel.id, sel.isExtended, sig);
  }

  // ── payload history from the ring buffer (recent distinct payloads) ──────────
  interface HistRow {
    relT: number;
    hex: string;
  }
  let history: HistRow[] = [];

  // Recompute history + sparkline series on each snapshot tick (maxTUs changes).
  $: history = computeHistory(sel, $maxTUs);

  function computeHistory(
    s: { id: number; isExtended: boolean } | null,
    _tick: number,
  ): HistRow[] {
    if (!s) return [];
    const clock = getSessionClock();
    const frames = ring.lastSeconds(10, s.id).filter((f) => f.isExtended === s.isExtended);
    const out: HistRow[] = [];
    let prevHex = '';
    // newest first, keep distinct payloads
    for (let i = frames.length - 1; i >= 0 && out.length < 40; i--) {
      const f = frames[i];
      const h = toHex(f.data);
      if (h === prevHex) continue;
      prevHex = h;
      out.push({ relT: clock.relSeconds(f.tUs), hex: h });
    }
    return out;
  }

  function toHex(data: Uint8Array): string {
    let s = '';
    for (let i = 0; i < data.length; i++) {
      s += data[i].toString(16).toUpperCase().padStart(2, '0');
      if (i < data.length - 1) s += ' ';
    }
    return s;
  }

  // ── sparkline for the first signal (or byte 0) over the last 10 s ────────────
  let sparkValues: number[] = [];
  let sparkTimes: number[] = [];
  let sparkLabel = '';

  $: rebuildSpark(sel, def, $maxTUs);

  function rebuildSpark(
    s: { id: number; isExtended: boolean } | null,
    d: typeof def,
    _tick: number,
  ) {
    sparkValues = [];
    sparkTimes = [];
    if (!s) {
      sparkLabel = '';
      return;
    }
    const clock = getSessionClock();
    const frames = ring.lastSeconds(10, s.id).filter((f) => f.isExtended === s.isExtended);
    const sig: EditableSignal | null =
      d && d.signals.length > 0 ? (d.signals[0] as EditableSignal) : null;
    sparkLabel = sig ? sig.name : 'byte 0';
    for (const f of frames) {
      sparkTimes.push(clock.relSeconds(f.tUs));
      if (sig) sparkValues.push(decodeSignal(f.data, sig).value);
      else sparkValues.push(f.data.length > 0 ? f.data[0] : 0);
    }
  }
</script>

<div class="inspector">
  {#if !sel}
    <div class="empty dim">select a frame in the table to inspect</div>
  {:else}
    <div class="head">
      <span class="mono idlabel">{idHex(sel.id, sel.isExtended)}</span>
      <input class="rename" bind:value={nameDraft} on:change={commitName} placeholder="frame name" />
      {#if row}
        <span class="dim mono">DLC {row.dlc} · {row.rate.toFixed(0)} fps · {row.count.toLocaleString()}</span>
      {/if}
    </div>

    <section>
      <h4>Bit change grid <span class="dim">(flashes on change)</span></h4>
      {#if row}
        <BitGrid data={row.data} changedBits={row.changedBits} dlc={row.dlc} />
      {:else}
        <div class="dim">no live payload yet</div>
      {/if}
    </section>

    <section>
      <div class="row">
        <h4>Signals <span class="dim">(§3.5)</span></h4>
        <div class="spacer"></div>
        <button on:click={addNewSignal}>+ signal</button>
      </div>
      {#if def && def.signals.length}
        {#each def.signals as s (s.id)}
          <SignalEditor signal={s} liveData={liveData} />
        {/each}
      {:else}
        <div class="dim small">no signals yet — add one and set its bit range to decode a value</div>
      {/if}
    </section>

    <section>
      <h4>{sparkLabel} <span class="dim">· last 10 s</span></h4>
      <Sparkline values={sparkValues} times={sparkTimes} width={340} height={80} />
    </section>

    <section>
      <h4>Payload history <span class="dim">(distinct, newest first)</span></h4>
      <div class="hist">
        {#each history as h}
          <div class="histrow">
            <span class="mono dim t">{h.relT.toFixed(3)}</span>
            <span class="mono hx">{h.hex}</span>
          </div>
        {/each}
        {#if history.length === 0}
          <div class="dim small">no buffered history for this id</div>
        {/if}
      </div>
    </section>
  {/if}
</div>

<style>
  .inspector {
    height: 100%;
    overflow: auto;
    padding: 8px 10px;
  }
  .empty {
    padding: 24px 8px;
    text-align: center;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .idlabel {
    font-size: 15px;
    font-weight: 700;
    color: var(--accent);
  }
  .rename {
    flex: 1;
    min-width: 80px;
  }
  section {
    margin-bottom: 14px;
  }
  h4 {
    margin: 0 0 6px;
    font-size: 12px;
    font-weight: 600;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .small {
    font-size: 11px;
  }
  .hist {
    max-height: 180px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--bg);
  }
  .histrow {
    display: flex;
    gap: 10px;
    padding: 2px 8px;
    border-bottom: 1px solid #1a1e25;
  }
  .histrow .t {
    width: 64px;
    text-align: right;
    font-size: 11px;
  }
  .hx {
    letter-spacing: 0.04em;
  }
</style>
