<script lang="ts">
  /**
   * DETAIL pane of the master-detail frame view: the MESSAGES of the SELECTED
   * frame (the MASTER row in FrameTable). SCOPE = MUX ONLY (see messages.ts):
   *
   *   • frame WITH a multiplexor → one row per distinct mux value (Message ID =
   *     the mux value),
   *   • frame WITHOUT a multiplexor → one row for the frame itself (Message ID = —).
   *
   * Messages are computed in the ANALYSIS WORKER (DESIGN §6.1.2) from its own
   * ring and posted into the `messages` store on its cadence; this component just
   * binds them (no main-thread ring read).
   *
   * Columns: Message ID | Name | DLC | Data | Custom | Tab | Rate | Last | Count.
   * The "Custom" (per-frame formula) and "Tab" (active view's formula) RESULT
   * columns moved here from the master — they evaluate on each message's latest
   * payload via `evalFormula`, exactly as the old FrameTable cells did.
   *
   * A message can get a CUSTOM NAME shown as a colored badge (shared
   * `badgeStyle` palette). Double-click the Name cell to rename inline (mirrors
   * FrameTable's frame-name editing); names persist in `Project.messageNames`.
   *
   * Clicking a message row sets `selectedMux` (the chosen mux value; null for the
   * non-mux single message) so the Inspector can focus that sub-message.
   *
   * ── FUTURE / virtualization note ─────────────────────────────────────────────
   * This table is NOT virtualized: `{#each shown}` emits one real <tr> (~10 cells
   * + 2 evalFormula calls) per row, and the whole block re-renders on every
   * `$maxTUs` tick (~10 Hz). That is why a too-wide Message-ID field (> MAX_MESSAGES
   * distinct values) is capped to the MAX_MESSAGES most-recent rows instead of
   * rendering all N — the cap keeps the DOM bounded (~64 rows) so even a weak
   * client (frontend served by the Pi) stays smooth.
   *
   * IF we ever want a genuinely large-but-bounded scrollable list (hundreds of
   * REAL messages), virtualize instead of capping:
   *   - render only the ~40-50 visible rows from a scroll-offset window;
   *   - this requires a <table> → CSS-grid/div refactor (virtual-list libs don't
   *     drive <tr>); column widths are already fixed, so layout port is feasible;
   *   - re-verify: sticky header, Data-column ellipsis, and the `→ tab` menu
   *     (position:absolute relative to the row) inside an overflow:auto container.
   *   - it does NOT remove the 10 Hz computeMessages recompute or the per-tick
   *     filter/sort over all N groups (both cheap, left as-is).
   * Not worth it for the "field too wide" case (a wrong-field signal); the cap is
   * the right call there. Revisit only for a legit large bounded list.
   */
  import { tick } from 'svelte';
  import {
    selected,
    selectedMux,
    project,
    views,
    flashKey,
    maxTUs,
    messages as messagesStore,
    messageWindowSeconds,
    messageFilter,
    emptyFilter,
    setMessageName,
    assignMessageToView,
  } from '../state/store';
  import type { FrameFilter } from '../state/store';
  import { formatAge } from '../protocol/sessionClock';
  import { evalFormula } from '../protocol/formula';
  import { badgeStyle } from '../state/badgeColors';
  import { frameKey, messageKey } from '../protocol/datamodel';
  import { MAX_MESSAGES, type MessageRow } from '../protocol/messages';

  $: sel = $selected;

  $: fkey = sel ? frameKey(sel.id, sel.isExtended) : '';
  $: frameFormula = fkey ? ($project.frameFormulas ?? {})[fkey] : undefined;
  $: messageNames = $project.messageNames ?? {};

  // The message rows are computed in the analysis worker (DESIGN §6.1.2): the
  // store posts `select {sel, def, windowSeconds}` on selection/def/window
  // change, the worker folds the cumulative groups + windowed rate from its ring
  // and posts the rows here. This component just binds them — no main-thread ring
  // read, no per-tick recompute.
  $: messages = $messagesStore;
  // bug #1 guard: a too-wide discriminator splits into more rows than the
  // un-virtualized table can comfortably render. We keep the (real) split but
  // cap the rendered rows to MAX_MESSAGES below; `overflow` = total distinct
  // count, used for the banner.
  $: overflow = messages.length > MAX_MESSAGES ? messages.length : null;

  // ── message filter (mirrors FilterBar; one GLOBAL ephemeral store) ───────────
  // Hex-friendly id inputs. Parse "0x..." or decimal; empty → null.
  function parseId(v: string): number | null {
    const s = v.trim();
    if (s === '') return null;
    const n = s.toLowerCase().startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10);
    return Number.isFinite(n) ? n : null;
  }
  function parseByte(v: string, fallback: number): number {
    const s = v.trim();
    if (s === '') return fallback;
    const n = s.toLowerCase().startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10);
    return Number.isFinite(n) ? n & 0xff : fallback;
  }

  let idMinStr = '';
  let idMaxStr = '';
  let byteIndexStr = '';
  let maskStr = 'FF';
  let valueStr = '00';
  let minRateStr = '';
  let maxRateStr = '';

  // One global store, no per-view hydration: just push local inputs into it.
  $: messageFilter.update((f: FrameFilter) => ({
    ...f,
    idMin: parseId(idMinStr),
    idMax: parseId(idMaxStr),
    byteIndex: byteIndexStr.trim() === '' ? null : Math.max(0, parseInt(byteIndexStr, 10) || 0),
    byteMask: parseByte(maskStr, 0xff),
    byteValue: parseByte(valueStr, 0x00),
    minRate: minRateStr.trim() === '' ? null : Number(minRateStr) || 0,
    maxRate: maxRateStr.trim() === '' ? null : Number(maxRateStr) || 0,
  }));

  function resetFilter() {
    messageFilter.set(emptyFilter());
    idMinStr = '';
    idMaxStr = '';
    byteIndexStr = '';
    maskStr = 'FF';
    valueStr = '00';
    minRateStr = '';
    maxRateStr = '';
  }

  /**
   * Does one message pass the filter? Mirrors the frame predicate
   * (`passesFilter`), but `idMin/idMax` test the message-ID (mux) value and the
   * rate is the per-message rate. The mux test is SKIPPED when mux is null (a
   * non-mux single message has no Message ID to range over).
   */
  function matchMsg(m: MessageRow, name: string, f: FrameFilter): boolean {
    if (m.mux !== null) {
      if (f.idMin !== null && m.mux < f.idMin) return false;
      if (f.idMax !== null && m.mux > f.idMax) return false;
    }
    if (f.minRate !== null && m.rate < f.minRate) return false;
    if (f.maxRate !== null && m.rate > f.maxRate) return false;
    if (f.byteIndex !== null && f.byteIndex >= 0) {
      if (f.byteIndex >= m.data.length) return false;
      if ((m.data[f.byteIndex] & f.byteMask) !== (f.byteValue & f.byteMask)) return false;
    }
    const needle = f.nameSubstr.trim().toLowerCase();
    if (needle && !name.toLowerCase().includes(needle)) return false;
    return true;
  }

  // The filter targets the SPLIT sub-messages. The single non-mux message has no
  // Message ID to range over, so it is never filtered away.
  $: filtered =
    messages.length === 1 && messages[0].mux === null
      ? messages
      : messages.filter((m) => matchMsg(m, nameOf(m), $messageFilter));
  // When the field is too wide (overflow), show only the MAX_MESSAGES
  // most-recently-seen matching rows so the un-virtualized table stays bounded
  // (newest first, for a live feel). See the virtualization note below.
  $: shown =
    overflow !== null
      ? [...filtered].sort((a, b) => b.lastTUs - a.lastTUs).slice(0, MAX_MESSAGES)
      : filtered;


  function muxLabel(m: MessageRow): string {
    if (m.mux === null) return '—';
    return `0x${m.mux.toString(16).toUpperCase().padStart(m.idHexWidth, '0')}`;
  }

  function ageSeconds(m: MessageRow): number {
    return ($maxTUs - m.lastTUs) / 1e6;
  }

  function nameOf(m: MessageRow): string {
    return messageNames[messageKey(fkey, m.mux)] ?? '';
  }

  function selectMessage(m: MessageRow): void {
    selectedMux.set(m.mux);
  }

  // Drag a message onto a tab (ViewTabs) — mirrors FrameTable's row drag, but
  // marshals the MESSAGE key (messageKey, not just frameKey). ViewTabs' drop
  // handler adds the dragged string keys to the view's members verbatim, so a
  // message member rides the SAME path as the "→ tab" menu (assignMessageToView).
  function onMsgDragStart(e: DragEvent, m: MessageRow): void {
    selectedMux.set(m.mux);
    e.dataTransfer?.setData('text/plain', JSON.stringify([messageKey(fkey, m.mux)]));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove';
  }

  // ── inline message-name editing (mirrors FrameTable's Name cell) ────────────
  let editingMux: number | null | undefined = undefined; // undefined = not editing
  let nameDraft = '';
  let nameInput: HTMLInputElement | null = null;

  async function beginEdit(m: MessageRow) {
    editingMux = m.mux;
    nameDraft = nameOf(m);
    await tick();
    nameInput?.focus();
    nameInput?.select();
  }

  function commitEdit(m: MessageRow) {
    if (editingMux !== m.mux || !sel) return;
    setMessageName(sel.id, sel.isExtended, m.mux, nameDraft);
    editingMux = undefined;
  }

  function cancelEdit() {
    editingMux = undefined;
  }

  function onNameKey(e: KeyboardEvent, m: MessageRow) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit(m);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }

  function isEditing(m: MessageRow): boolean {
    return editingMux === m.mux;
  }

  // ── "→ tab" menu: add this message to one of the project's custom views ──────
  // A view's `members` is a string[] that already holds frame keys; a MESSAGE
  // member is `messageKey(frameKey, mux)`. Only custom (non-locked) views are
  // assignable targets — the canonical "All" view holds everything implicitly.
  let menuMux: number | null | undefined = undefined; // undefined = no menu open
  $: customViews = $views.filter((v) => !v.locked);

  function toggleMenu(m: MessageRow) {
    menuMux = menuMux === m.mux ? undefined : m.mux;
  }

  function isMenuOpen(m: MessageRow): boolean {
    return menuMux === m.mux;
  }

  function assignTo(viewId: string, m: MessageRow) {
    if (!sel) return;
    assignMessageToView(viewId, sel.id, sel.isExtended, m.mux);
    menuMux = undefined;
  }
</script>

<div class="msgwrap">
  {#if !sel}
    <div class="empty dim">select a frame above to list its messages</div>
  {:else}
    <div class="msgbar">
      <span class="label">FILTER</span>

      <span class="group" title="inclusive message-ID (mux value) range (hex 0x.. or dec)">
        <span class="dim">ID</span>
        <input class="mono id" bind:value={idMinStr} placeholder="min" spellcheck="false" />
        <span class="dim">–</span>
        <input class="mono id" bind:value={idMaxStr} placeholder="max" spellcheck="false" />
      </span>

      <span class="group" title="(data[byte] & mask) == value">
        <span class="dim">byte</span>
        <input class="mono tiny" bind:value={byteIndexStr} placeholder="#" />
        <span class="dim">&</span>
        <input class="mono tiny" bind:value={maskStr} placeholder="FF" />
        <span class="dim">==</span>
        <input class="mono tiny" bind:value={valueStr} placeholder="00" />
      </span>

      <span class="group" title="per-message rate band (fps): ≥min isolates frequent messages, ≤max isolates rare ones">
        <span class="dim">rate</span>
        <input class="mono tiny" bind:value={minRateStr} placeholder="≥" title="min fps" />
        <span class="dim">–</span>
        <input class="mono tiny" bind:value={maxRateStr} placeholder="≤" title="max fps" />
      </span>

      <span class="group" title="case-insensitive substring of the custom message name">
        <span class="dim">name</span>
        <input class="fname" bind:value={$messageFilter.nameSubstr} placeholder="substring" spellcheck="false" />
      </span>

      <button on:click={resetFilter}>Reset</button>

      <div class="spacer"></div>

      <span class="count dim">{shown.length}/{messages.length} msg</span>

      <span class="dim small">window</span>
      <select class="winsel" bind:value={$messageWindowSeconds} title="how far back the message list looks · All = everything still in the buffer">
        <option value={5}>5 s</option>
        <option value={10}>10 s</option>
        <option value={30}>30 s</option>
        <option value={60}>60 s</option>
        <option value={120}>2 min</option>
        <option value={180}>3 min</option>
        <option value={240}>4 min</option>
        <option value={300}>5 min</option>
        <option value={600}>10 min</option>
        <option value={0}>All</option>
      </select>
    </div>
    {#if overflow !== null}
      <div class="warn">⚠ Message-ID field too wide — {overflow} distinct values (over {MAX_MESSAGES}). Showing the {MAX_MESSAGES} most recent. Narrow it to ≤2 bytes, or set Auto / None in the Inspector.</div>
    {/if}
    <table>
      <thead>
        <tr>
          <th class="mid" title="multiplexor value (— = frame has no multiplexor)">Message ID</th>
          <th class="name" title="custom message name — double-click to rename">Name</th>
          <th class="value" title="Custom formula result (per-message) — define it in the inspector below">Value</th>
          <th class="rate">Rate</th>
          <th class="seen">Last</th>
          <th class="cnt">Count</th>
          <th class="totab" title="add this message to a tab"></th>
        </tr>
      </thead>
      <tbody>
        {#each shown as m (m.mux === null ? 'none' : m.mux)}
          {@const nm = nameOf(m)}
          {@const cv = frameFormula ? evalFormula(frameFormula.expr, m.data, frameFormula.unit) : null}
          <tr
            class:selected={$selectedMux === m.mux}
            class:flashing={$flashKey === `msg:${fkey}:${m.mux}`}
            draggable={!isEditing(m)}
            on:click={() => selectMessage(m)}
            on:dragstart={(e) => onMsgDragStart(e, m)}
            title="click to focus · drag onto a tab to add it · double-click the Name to rename"
          >
            <td class="mid mono">{muxLabel(m)}</td>
            <td
              class="name"
              class:editing={isEditing(m)}
              on:dblclick|stopPropagation={() => beginEdit(m)}
              title="double-click to name this message"
            >
              {#if isEditing(m)}
                <!-- svelte-ignore a11y-autofocus -->
                <input
                  class="nameedit"
                  bind:this={nameInput}
                  bind:value={nameDraft}
                  on:click|stopPropagation
                  on:blur={() => commitEdit(m)}
                  on:keydown={(e) => onNameKey(e, m)}
                  spellcheck="false"
                  placeholder="message name"
                />
              {:else if nm}
                <span class="badge" style={badgeStyle('msg:' + messageKey(fkey, m.mux))}>{nm}</span>
              {/if}
            </td>
            {#if cv && cv.ok}
              <td class="value mono" title={cv.display}>{cv.display}</td>
            {:else if cv && cv.error}
              <td class="value mono err" title={cv.error}>⚠</td>
            {:else}
              <td class="value dim">—</td>
            {/if}
            <td class="rate mono">{m.rate >= 1 ? m.rate.toFixed(0) : m.rate.toFixed(1)}</td>
            <td class="seen mono dim">{formatAge(ageSeconds(m))}</td>
            <td class="cnt mono dim">{m.count.toLocaleString()}</td>
            <td class="totab">
              <div class="menuwrap">
                <button
                  class="totabbtn"
                  title={customViews.length
                    ? 'add this message to a tab'
                    : 'no custom tabs yet — create one in the tab bar first'}
                  disabled={customViews.length === 0}
                  on:click|stopPropagation={() => toggleMenu(m)}
                >→ tab</button>
                {#if isMenuOpen(m)}
                  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
                  <div class="backdrop" on:click|stopPropagation={() => (menuMux = undefined)}></div>
                  <div class="menu">
                    {#each customViews as v (v.id)}
                      <button class="row" on:click|stopPropagation={() => assignTo(v.id, m)}>{v.name}</button>
                    {/each}
                  </div>
                {/if}
              </div>
            </td>
          </tr>
        {/each}
        {#if shown.length === 0}
          <tr class="empty">
            {#if messages.length === 0}
              <td colspan="10" class="dim">no frames buffered for this id yet</td>
            {:else}
              <td colspan="10" class="dim">no messages match the filter</td>
            {/if}
          </tr>
        {/if}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .msgwrap {
    height: 100%;
    overflow: auto;
  }
  .empty.dim {
    padding: 18px 8px;
    text-align: center;
    font-size: 12px;
  }
  .warn {
    margin: 6px 8px;
    padding: 5px 8px;
    border: 1px solid var(--warn);
    border-radius: var(--radius-md);
    background: var(--bg-elev);
    color: var(--warn);
    font-size: 11px;
  }
  .msgbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
    flex-wrap: wrap;
  }
  .label {
    font-size: 10px;
    letter-spacing: 0.1em;
    color: var(--text-dim);
  }
  .group {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .id {
    width: 64px;
  }
  .tiny {
    width: 40px;
    text-align: center;
  }
  .fname {
    width: 120px;
  }
  .spacer {
    flex: 1;
  }
  .count {
    font-size: 11px;
  }
  .winsel {
    font-size: 11px;
    padding: 1px 4px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  thead th {
    position: sticky;
    top: 0;
    background: var(--bg-elev2);
    border-bottom: 1px solid var(--border);
    text-align: left;
    padding: 5px 8px;
    font-weight: 600;
    color: var(--text-dim);
    z-index: 1;
  }
  td {
    padding: 3px 8px;
    border-bottom: 1px solid #1a1e25;
    white-space: nowrap;
  }
  tbody tr {
    cursor: pointer;
    -webkit-user-select: none;
    user-select: none;
  }
  tbody tr:hover {
    background: #181c23;
  }
  tr.selected {
    background: var(--accent-dim) !important;
  }
  .mid {
    width: 96px;
    color: var(--accent);
  }
  .value {
    width: 96px;
    max-width: 96px;
    text-align: right;
    color: var(--accent);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .value.err {
    color: var(--warn);
    text-align: center;
  }
  td.name.editing {
    padding: 0;
  }
  .nameedit {
    width: 100%;
    box-sizing: border-box;
    font: inherit;
    padding: 2px 6px;
  }
  /* Color/border/background from badgeStyle() inline; shape from global .badge.
     Local override keeps the inline-block + slightly larger 11px name label. */
  .badge {
    display: inline-block;
    font-size: 11px;
  }
  .rate {
    width: 60px;
    text-align: right;
  }
  .seen {
    width: 60px;
    text-align: right;
  }
  .cnt {
    width: 80px;
    text-align: right;
  }
  .empty td {
    padding: 14px;
    text-align: center;
  }
  .totab {
    width: 64px;
    text-align: right;
    overflow: visible;
  }
  .menuwrap {
    position: relative;
    display: inline-block;
  }
  .totabbtn {
    font-size: 11px;
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-elev);
    color: var(--text-dim);
    cursor: pointer;
    white-space: nowrap;
  }
  .totabbtn:hover:not(:disabled) {
    color: var(--accent);
    border-color: var(--accent);
  }
  .totabbtn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 10;
  }
  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 3px);
    z-index: 11;
    min-width: 140px;
    max-height: 220px;
    overflow: auto;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 4px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  }
  .menu .row {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    background: transparent;
    color: var(--text);
    font-size: 12px;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    white-space: nowrap;
  }
  .menu .row:hover {
    background: var(--bg-elev2);
    color: var(--accent);
  }
</style>
