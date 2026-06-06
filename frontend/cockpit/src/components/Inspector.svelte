<script lang="ts">
  /**
   * Inspector for the selected CAN id:
   *   - per-BIT change grid that flashes on change (BitGrid, canvas),
   *   - payload HISTORY (recent distinct payloads, computed in the analysis worker),
   *   - the §3.5 signals defined on this id + live-decoded values,
   *   - add/name signals; a per-byte sparkline of the value over the window.
   */
  import {
    frameRows,
    selected,
    selectedMux,
    selection,
    project,
    inspectorData,
    addSignal,
    renameFrame,
    frameDefFor,
    getSessionClock,
    setMessageIdMode,
  } from '../state/store';
  import { makeSignal, frameKey, messageKey, multiplexorSignal } from '../protocol/datamodel';
  import type { EffectiveMessageId } from '../protocol/messages';
  import { badgeStyle } from '../state/badgeColors';
  import BitGrid from './BitGrid.svelte';
  import SignalEditor from './SignalEditor.svelte';
  import Sparkline from './Sparkline.svelte';
  import { extractRaw } from '../protocol/decode';
  import {
    decodeDiagnostic,
    type DiagDecode,
    type IsoTpFrame,
  } from '@shared/diagnostic.ts';
  import { decode29BitId, type J1939Decomposition } from '@shared/j1939.ts';

  $: sel = $selected;
  // Multi-selection (point 4-bonus): when more than one frame is selected the
  // inspector can't show "the" frame unambiguously, so it shows a selection
  // summary instead. `selection` holds frame KEYS; map them back to rows.
  $: multi = $selection.size > 1;
  $: selectedRows = multi
    ? $frameRows.filter((r) => $selection.has(frameKey(r.id, r.isExtended)))
    : [];
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

  // Diagnostic lens (point 2): decode the ISO-TP / OBD-UDS structure when the
  // selected id is in the standard diagnostic range; null for normal broadcast
  // frames (so the section only appears where it makes sense).
  $: diag = sel && row ? decodeDiagnostic(sel.id, sel.isExtended, Array.from(row.data)) : null;

  // Multi-frame reassembly (point A): computed in the analysis worker over this
  // id's recent history (DESIGN §6.1.2) and posted into `inspectorData`. The
  // worker gates it the same way (only for a First / Consecutive diagnostic
  // frame), so this is null for normal broadcast frames.
  $: diagReassembled = $inspectorData?.diagReassembled ?? null;

  // 29-bit id decomposition (point B): a generic J1939-style read-out for ANY
  // extended id. Clearly NOT ground truth for a proprietary VW frame — surfaced as
  // an optional, labelled interpretation only.
  $: j1939 = sel && sel.isExtended ? decode29BitId(sel.id) : null;

  function j1939PduLabel(j: J1939Decomposition): string {
    return j.pduType === 'PDU1'
      ? `PDU1 · dest 0x${hexN(j.destinationAddress ?? 0, 2)}`
      : `PDU2 · group ext 0x${hexN(j.groupExtension ?? 0, 2)}`;
  }

  // Multiplexing (B2 · point 2): the frame's multiplexor signal + its live value,
  // so the signal list can mark mode-dependent signals active/inactive.
  $: muxSig = multiplexorSignal(def);

  // ── Message ID (per-frame discriminator) — the friendly high-level control ──
  // The effective field is the SAME detection the message list splits by, computed
  // ONCE in the analysis worker over the full history (DESIGN §6.1.2) and posted
  // here — no separate Inspector resolver, no short-window divergence. The Auto
  // read-out reflects what Auto detected regardless of the active mode.
  $: eff = $inspectorData?.eff ?? null;
  // Auto read-out: show the detected field at BIT granularity (a discriminator is
  // usually a sub-byte field), e.g. "auto: byte 0 bits 0–1 · 4 values".
  function fmtAuto(e: EffectiveMessageId | null): string {
    const f = e?.auto.field;
    if (!f) return 'auto: none detected';
    const byte = f.bitStart >> 3;
    const lo = f.bitStart & 7;
    const where = f.bitLength === 8 ? `byte ${byte}` : `byte ${byte} bits ${lo}–${lo + f.bitLength - 1}`;
    return `auto: ${where} · ${e!.auto.distinct} values`;
  }
  // The active mode shown in the segmented control: Forced if a mux signal
  // exists, else None when the flag is explicitly false, else Auto (default).
  $: midMode = muxSig ? 'forced' : def?.messageIdAuto === false ? 'none' : 'auto';
  // The byte input for Forced: the mux signal's byte if forced, else prefilled
  // with whatever Auto detected (so flipping to Forced pins the proposed byte).
  let forcedByte = 0;
  $: forcedByte = muxSig ? muxSig.bitStart >> 3 : eff?.auto.byteIndex ?? 0;

  function setMode(mode: 'auto' | 'forced' | 'none') {
    if (!sel) return;
    setMessageIdMode(sel.id, sel.isExtended, mode, forcedByte);
  }
  function onForcedByteChange(e: Event) {
    if (!sel) return;
    const n = Math.max(0, Math.min(7, Math.floor(Number((e.target as HTMLInputElement).value) || 0)));
    forcedByte = n;
    setMessageIdMode(sel.id, sel.isExtended, 'forced', n);
  }

  $: liveMux = muxSig && liveData.length ? Number(extractRaw(liveData, muxSig)) : null;
  // The user can pick a specific sub-message in the Message list (`selectedMux`).
  // When set, the Inspector FOCUSES that message: signal active/inactive logic
  // reflects the SELECTED message, not just whatever mux the live payload carries.
  // Falls back to the live mux when nothing is explicitly selected.
  $: currentMux = $selectedMux ?? liveMux;
  // The custom name of the focused sub-message (badge in the header), if any.
  $: focusedMsgName =
    sel && muxSig ? ($project.messageNames ?? {})[messageKey(frameKey(sel.id, sel.isExtended), $selectedMux)] ?? '' : '';

  let nameDraft = '';
  $: if (sel) nameDraft = def?.name ?? idHex(sel.id, sel.isExtended);

  function idHex(id: number, ext: boolean): string {
    return '0x' + id.toString(16).toUpperCase().padStart(ext ? 8 : 3, '0');
  }

  function nameFor(r: { id: number; isExtended: boolean }): string {
    return frameDefFor(r.id, r.isExtended)?.name || idHex(r.id, r.isExtended);
  }

  /** Drill from the multi-selection summary into one frame (collapse to it). */
  function selectOne(r: { id: number; isExtended: boolean }) {
    selected.set({ id: r.id, isExtended: r.isExtended });
    selection.set(new Set([frameKey(r.id, r.isExtended)]));
  }

  // ── diagnostic lens formatting ───────────────────────────────────────────────
  function hexN(n: number, w: number): string {
    return n.toString(16).toUpperCase().padStart(w, '0');
  }
  function diagRole(d: DiagDecode): string {
    const a = d.addressing;
    if (a.role === 'request-functional') return 'Functional request (0x7DF)';
    if (a.role === 'request-physical') return `Physical request · ECU #${a.ecu}`;
    return `Response · ECU #${a.ecu}`;
  }
  function isoTpLabel(f: IsoTpFrame): string {
    switch (f.kind) {
      case 'single': return `Single frame · ${f.length} data byte${f.length === 1 ? '' : 's'}`;
      case 'first': return `First frame · total ${f.length} bytes`;
      case 'consecutive': return `Consecutive frame · seq ${f.seq}`;
      case 'flow-control': return `Flow control · status ${f.flowStatus}`;
      default: return 'unknown PCI';
    }
  }

  function commitName() {
    if (sel) renameFrame(sel.id, sel.isExtended, nameDraft.trim() || idHex(sel.id, sel.isExtended));
  }

  function addNewSignal() {
    if (!sel) return;
    const sig = makeSignal(sel.id, sel.isExtended, { name: `sig_${(def?.signals.length ?? 0) + 1}` });
    addSignal(sel.id, sel.isExtended, sig);
  }

  // ── payload history (recent distinct payloads) ───────────────────────────────
  // Computed in the analysis worker and posted with RAW backend µs; map those to
  // relative seconds here via the SessionClock (its session origin is main-thread
  // state — §4.2).
  interface HistRow {
    relT: number;
    hex: string;
  }
  $: history = ($inspectorData?.history ?? []).map((h): HistRow => ({
    relT: getSessionClock().relSeconds(h.tUs),
    hex: h.hex,
  }));

  // ── sparkline for the first signal (or byte 0) over the last 10 s ────────────
  // Values + labels come from the worker; map the raw µs timestamps via the clock.
  $: sparkValues = $inspectorData?.spark.values ?? [];
  $: sparkTimes = ($inspectorData?.spark.tUs ?? []).map((t) => getSessionClock().relSeconds(t));
  $: sparkLabel = $inspectorData?.spark.label ?? '';
</script>

<div class="inspector">
  {#if !sel}
    <div class="empty dim">select a frame in the table to inspect</div>
  {:else if multi}
    <div class="multi">
      <div class="head">
        <span class="count">{$selection.size} frames selected</span>
      </div>
      <p class="dim small">
        The inspector works on one frame at a time. Click a frame below to inspect
        it, or drag the selection onto a tab to group these frames.
      </p>
      <div class="sellist">
        {#each selectedRows as r (frameKey(r.id, r.isExtended))}
          <button class="selrow" on:click={() => selectOne(r)} title="inspect this frame">
            <span class="mono id">{idHex(r.id, r.isExtended)}</span>
            <span class="nm">{nameFor(r)}</span>
            <span class="mono dim dlc">DLC {r.dlc} · {r.rate >= 1 ? r.rate.toFixed(0) : r.rate.toFixed(1)} fps</span>
          </button>
        {/each}
        {#if selectedRows.length === 0}
          <div class="dim small">selected frames are not in the current table view</div>
        {/if}
      </div>
    </div>
  {:else}
    <div class="head">
      <span class="mono idlabel">{idHex(sel.id, sel.isExtended)}</span>
      <input class="rename" bind:value={nameDraft} on:change={commitName} placeholder="frame name" />
      {#if row}
        <span class="dim mono">DLC {row.dlc} · {row.rate.toFixed(0)} fps · {row.count.toLocaleString()}</span>
      {/if}
    </div>

    <!-- Scope breadcrumb (bug #2): make it unambiguous whether you're inspecting
         the whole FRAME or a specific MESSAGE (sub-message / mux value). Clicking
         "frame …" pops back to whole-frame scope (clears selectedMux). -->
    <div class="scope">
      <span class="dim small">Inspecting</span>
      <button class="crumb" class:active={$selectedMux === null} on:click={() => selectedMux.set(null)} title="inspect the whole frame">
        frame {idHex(sel.id, sel.isExtended)}
      </button>
      {#if $selectedMux !== null}
        {@const mkey = messageKey(frameKey(sel.id, sel.isExtended), $selectedMux)}
        {@const mname = ($project.messageNames ?? {})[mkey]}
        <span class="sep dim">›</span>
        <span class="crumb msg" style={mname ? badgeStyle('msg:' + mkey) : ''}>msg 0x{$selectedMux.toString(16).toUpperCase()}{mname ? ` · ${mname}` : ''}</span>
      {/if}
    </div>

    <section class="msgid">
      <div class="row">
        <h4 title="how this frame's payload is split into messages by a discriminator byte">Message ID</h4>
        <div class="seg" role="group" aria-label="Message ID mode">
          <button class:on={midMode === 'auto'} on:click={() => setMode('auto')} title="auto-detect a discriminator byte; splits only when confident">Auto</button>
          <button class:on={midMode === 'forced'} on:click={() => setMode('forced')} title="pin the discriminator byte (persists as a multiplexor signal; round-trips to DBC)">Forced</button>
          <button class:on={midMode === 'none'} on:click={() => setMode('none')} title="plain frame: one message, full data">None</button>
        </div>
        {#if midMode === 'forced'}
          <label class="byte" title="byte index of the discriminator (0..7)">
            byte
            <input class="num" type="number" min="0" max="7" value={forcedByte} on:change={onForcedByteChange} />
          </label>
        {/if}
        <div class="spacer"></div>
        <span class="dim small auto">{fmtAuto(eff)}</span>
      </div>
    </section>

    {#if diag}
      <section class="diag">
        <h4>Diagnostic <span class="dim">(ISO-TP / OBD-UDS)</span></h4>
        <div class="diagrow"><span class="k">Addressing</span><span class="v">{diagRole(diag)}</span></div>
        <div class="diagrow"><span class="k">ISO-TP</span><span class="v">{isoTpLabel(diag.isotp)}</span></div>
        {#if diag.negative}
          <div class="diagrow"><span class="k">Negative</span><span class="v err">service 0x{hexN(diag.negative.rejectedSid, 2)}{diag.negative.rejectedName ? ` (${diag.negative.rejectedName})` : ''} · NRC 0x{hexN(diag.negative.nrc, 2)}{diag.negative.nrcName ? ` ${diag.negative.nrcName}` : ''}</span></div>
        {:else if diag.service}
          <div class="diagrow"><span class="k">Service</span><span class="v">0x{hexN(diag.service.raw, 2)} — {diag.service.name ?? 'unknown'} <span class="dim">({diag.service.isResponse ? 'response' : 'request'})</span></span></div>
        {/if}
        {#if diag.identifier}
          <div class="diagrow"><span class="k">{diag.identifier.kind}</span><span class="v">0x{hexN(diag.identifier.value, diag.identifier.kind === 'DID' ? 4 : 2)}{diag.identifier.name ? ` — ${diag.identifier.name}` : ''}</span></div>
        {/if}
        <div class="diagrow"><span class="k">Payload</span><span class="v mono">{diag.serviceDataHex || '—'}</span></div>

        {#if diagReassembled}
          {@const r = diagReassembled.reassembly}
          <div class="reasm">
            <div class="diagrow">
              <span class="k">Reassembled</span>
              <span class="v">
                {#if r.complete}
                  <span class="ok">complete · {r.totalLength} bytes</span>
                {:else}
                  <span class="warn">incomplete · {r.data.length}/{r.totalLength} bytes · {r.expected} more expected</span>
                {/if}
              </span>
            </div>
            {#if r.note}
              <div class="diagrow"><span class="k"></span><span class="v dim small">{r.note}</span></div>
            {/if}
            {#if diagReassembled.negative}
              <div class="diagrow"><span class="k">Service</span><span class="v err">negative · service 0x{hexN(diagReassembled.negative.rejectedSid, 2)}{diagReassembled.negative.rejectedName ? ` (${diagReassembled.negative.rejectedName})` : ''} · NRC 0x{hexN(diagReassembled.negative.nrc, 2)}{diagReassembled.negative.nrcName ? ` ${diagReassembled.negative.nrcName}` : ''}</span></div>
            {:else if diagReassembled.service}
              <div class="diagrow"><span class="k">Service</span><span class="v">0x{hexN(diagReassembled.service.raw, 2)} — {diagReassembled.service.name ?? 'unknown'} <span class="dim">({diagReassembled.service.isResponse ? 'response' : 'request'})</span></span></div>
            {/if}
            {#if diagReassembled.identifier}
              <div class="diagrow"><span class="k">{diagReassembled.identifier.kind}</span><span class="v">0x{hexN(diagReassembled.identifier.value, diagReassembled.identifier.kind === 'DID' ? 4 : 2)}{diagReassembled.identifier.name ? ` — ${diagReassembled.identifier.name}` : ''}</span></div>
            {/if}
            <div class="diagrow"><span class="k">Full data</span><span class="v mono">{diagReassembled.serviceDataHex || '—'}</span></div>
          </div>
        {:else if diag.isotp.kind === 'first' || diag.isotp.kind === 'consecutive'}
          <div class="dim small">multi-frame — gathering frames from history…</div>
        {/if}
      </section>
    {/if}

    {#if j1939}
      <section class="diag">
        <h4>ID decomposition <span class="dim">(29-bit / J1939)</span></h4>
        <div class="dim small note">Generic SAE J1939 interpretation of the 29-bit id — NOT ground truth for a proprietary VW frame.</div>
        <div class="diagrow"><span class="k">Priority</span><span class="v">{j1939.priority}</span></div>
        <div class="diagrow"><span class="k">PGN</span><span class="v mono">0x{hexN(j1939.pgn, 4)} <span class="dim">({j1939.pgn})</span></span></div>
        <div class="diagrow"><span class="k">PF / PS</span><span class="v mono">0x{hexN(j1939.pduFormat, 2)} / 0x{hexN(j1939.pduSpecific, 2)}</span></div>
        <div class="diagrow"><span class="k">Type</span><span class="v">{j1939PduLabel(j1939)}</span></div>
        <div class="diagrow"><span class="k">Source addr</span><span class="v mono">0x{hexN(j1939.sourceAddress, 2)}</span></div>
        {#if j1939.dataPage || j1939.extendedDataPage}
          <div class="diagrow"><span class="k">DP / EDP</span><span class="v mono">{j1939.dataPage} / {j1939.extendedDataPage}</span></div>
        {/if}
      </section>
    {/if}

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
        {#if muxSig}
          <span class="dim small">
            · mux = {currentMux ?? '—'} <span class="mono">({muxSig.name})</span>
            {#if $selectedMux !== null}<span class="focus">focused</span>{/if}
            {#if focusedMsgName}<span class="badge" style={badgeStyle('msg:' + messageKey(frameKey(sel.id, sel.isExtended), $selectedMux))}>{focusedMsgName}</span>{/if}
          </span>
        {/if}
        <div class="spacer"></div>
        <button on:click={addNewSignal}>+ signal</button>
      </div>
      {#if def && def.signals.length}
        {#each def.signals as s (s.id)}
          <SignalEditor signal={s} liveData={liveData} hasMux={!!muxSig} currentMux={currentMux} />
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
  .multi {
    padding: 4px 2px;
  }
  .count {
    font-size: 15px;
    font-weight: 700;
    color: var(--accent);
  }
  .sellist {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-top: 8px;
  }
  .selrow {
    display: flex;
    align-items: center;
    gap: 8px;
    text-align: left;
    padding: 4px 8px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 5px;
    width: 100%;
  }
  .selrow:hover {
    border-color: var(--accent-dim);
  }
  .selrow .id {
    color: var(--accent);
    min-width: 72px;
  }
  .selrow .nm {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .selrow .dlc {
    font-size: 11px;
  }
  .diag {
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 6px 8px;
    background: var(--bg-elev);
    margin-bottom: 14px;
  }
  .diagrow {
    display: flex;
    gap: 8px;
    font-size: 12px;
    padding: 1px 0;
  }
  .diagrow .k {
    width: 78px;
    flex: none;
    color: var(--text-dim);
  }
  .diagrow .v {
    flex: 1;
  }
  .diagrow .v.err {
    color: var(--err);
  }
  .reasm {
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px dashed var(--border);
  }
  .reasm .ok {
    color: var(--ok, #6fcf6f);
  }
  .reasm .warn {
    color: var(--warn, #e0b04a);
  }
  .note {
    margin-bottom: 4px;
    font-style: italic;
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
  .scope {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 10px;
  }
  .crumb {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 7px;
    font-size: 11px;
    font-weight: 600;
  }
  .crumb.active {
    border-color: var(--accent);
    color: var(--accent);
  }
  .crumb.msg {
    cursor: default;
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
  .msgid {
    margin-bottom: 12px;
  }
  .msgid .auto {
    white-space: nowrap;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 5px;
    overflow: hidden;
  }
  .seg button {
    padding: 2px 9px;
    font-size: 11px;
    border: none;
    border-right: 1px solid var(--border);
    background: var(--bg-elev);
    color: var(--text-dim);
    cursor: pointer;
  }
  .seg button:last-child {
    border-right: none;
  }
  .seg button.on {
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 700;
  }
  .byte {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 11px;
    color: var(--text-dim);
  }
  .byte .num {
    width: 48px;
  }
  .focus {
    color: var(--accent);
    font-weight: 700;
    margin-left: 4px;
  }
  .badge {
    display: inline-block;
    font-size: 10px;
    font-weight: 700;
    padding: 0 5px;
    border: 1px solid var(--border);
    border-radius: 3px;
    margin-left: 4px;
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
