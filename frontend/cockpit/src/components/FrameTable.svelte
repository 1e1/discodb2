<script lang="ts">
  /**
   * Live frame table: one row per unique CAN id (ID, name, DLC, data hex, rate,
   * last-seen). Driven by the throttled `filteredRows` derived store, so the
   * table re-renders at the worker snapshot cadence, not per CAN frame.
   *
   * The row COUNT is bounded by unique ids on a vehicle bus (~100–200), so a
   * plain keyed {#each} is fine; we never create a DOM node per CAN *frame*.
   *
   * ORDERING. The LIVE table is STABLE: rows stay in ascending-id order so a
   * frame never jumps around as its rate/last-seen tick (a moving target is
   * unreadable on a busy bus). Column sort is therefore ON-DEMAND ONLY: clicking
   * a header FREEZES a one-shot SORTED SNAPSHOT of the current rows and shows
   * that until cleared — the live data keeps flowing underneath but the frozen
   * view never re-sorts. Click the same header to flip direction (re-snapshots);
   * "clear" returns to the live, stable, id-ordered table. This is deliberately
   * NOT a continuous live re-sort.
   */
  import { tick } from 'svelte';
  import { filteredRows, selected, selectedMux, selection, maxTUs, project, activeView, flashKey, renameFrame, getSessionClock, type DisplayRow } from '../state/store';
  import { formatAge } from '../protocol/sessionClock';
  import { badgeStyle } from '../state/badgeColors';
  import { classifyDiagId } from '@shared/diagnostic.ts';
  import { evalFormula } from '../protocol/formula';

  $: clock = getSessionClock();

  // The frame list's "Value" column = the active view's TAB formula, evaluated per
  // row (3-column Explore: Tab is the FRAME-LIST-scoped formula). Edit it in the
  // Frame column's inspector (ComputeEditor mode="tab").
  $: tabFormula = $activeView.formula;

  // Frames that define a multiplexor → show a MUX message-badge (B2 · point 2).
  $: muxKeys = new Set(
    $project.frames
      .filter((f) => f.signals.some((s) => (s as { isMultiplexor?: boolean }).isMultiplexor))
      .map((f) => (f.isExtended ? 'e' : 's') + f.id),
  );

  function rowKeyOf(d: { id: number; isExtended: boolean }): string {
    return `${d.isExtended ? 'e' : 's'}${d.id}`;
  }

  // ── inline frame-name editing (FIX 1) ──────────────────────────────────────
  // DOUBLE-CLICK the Name cell to edit the frame name inline: Enter / blur
  // commits (persisted to the §3.5 Project via renameFrame, so it shows
  // everywhere), Escape cancels. There was previously no way to add/rename a
  // frame name from the global table.
  let editingKey: string | null = null;
  let nameDraft = '';
  let nameInput: HTMLInputElement | null = null;

  async function beginEdit(r: DisplayRow) {
    editingKey = rowKeyOf(r);
    nameDraft = r.name || '';
    await tick();
    nameInput?.focus();
    nameInput?.select();
  }

  function commitEdit(r: DisplayRow) {
    if (editingKey !== rowKeyOf(r)) return;
    const name = nameDraft.trim();
    // Empty clears back to "no name" (the table shows blank; renameFrame stores
    // the empty string so the FrameDef still exists for signals).
    renameFrame(r.id, r.isExtended, name);
    editingKey = null;
  }

  function cancelEdit() {
    editingKey = null;
  }

  function onNameKey(e: KeyboardEvent, r: DisplayRow) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit(r);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }

  // ── on-demand sort snapshot ────────────────────────────────────────────────
  type SortKey = 'id' | 'name' | 'dlc' | 'rate' | 'lastTUs' | 'count';
  // When `frozen` is non-null we display IT (a sorted snapshot taken at click
  // time); otherwise we show the live, stable, id-ordered store.
  let frozen: DisplayRow[] | null = null;
  let sortKey: SortKey | null = null;
  let sortDir: 1 | -1 = 1;

  function snapshotSort(key: SortKey) {
    // Same header again → flip direction; new header → default ascending
    // (descending for rate/count, where "biggest first" is the useful default).
    if (sortKey === key) {
      sortDir = sortDir === 1 ? -1 : 1;
    } else {
      sortKey = key;
      sortDir = key === 'rate' || key === 'count' || key === 'lastTUs' ? -1 : 1;
    }
    const rows = [...$filteredRows]; // snapshot the CURRENT live rows, once.
    const dir = sortDir;
    rows.sort((a, b) => {
      let c: number;
      if (key === 'name') c = (a.name || '').localeCompare(b.name || '');
      else c = (a[key] as number) - (b[key] as number);
      // Stable tiebreak by id so equal keys keep a deterministic order.
      return (c || a.id - b.id) * dir;
    });
    frozen = rows;
  }

  function clearSort() {
    frozen = null;
    sortKey = null;
    sortDir = 1;
  }

  // The rows actually rendered: the frozen snapshot if any, else the live store.
  $: rows = frozen ?? $filteredRows;
  function arrow(key: SortKey): string {
    if (sortKey !== key || frozen === null) return '';
    return sortDir === 1 ? ' ▲' : ' ▼';
  }

  function idHex(r: DisplayRow): string {
    const width = r.isExtended ? 8 : 3;
    return '0x' + r.id.toString(16).toUpperCase().padStart(width, '0');
  }

  function ageSeconds(r: DisplayRow): number {
    // relative: how long ago vs the newest backend timestamp
    return ($maxTUs - r.lastTUs) / 1e6;
  }

  // ── selection (single + multi) and drag-to-tab ─────────────────────────────
  // Click = select one. Ctrl/⌘-click = toggle one. Shift-click = range from the
  // anchor. Ctrl/⌘-A (table focused) = select all visible rows. `selected` (the
  // primary, last-touched row) drives the Inspector; `selection` is the bulk set
  // dragged onto a tab. Dragging a row that's in the selection drags the whole
  // set; dragging an unselected row drags (and selects) just it.
  let anchorIndex: number | null = null;

  function setPrimary(r: DisplayRow) {
    selected.set({ id: r.id, isExtended: r.isExtended });
    // Clicking a FRAME row means "inspect the frame" → always frame scope, even
    // when it's the same frame the focused message belongs to (the store's
    // change-keyed reset wouldn't fire on a same-key set). Message clicks set
    // selectedMux in MessageList; frame clicks clear it here. (Macro coherence:
    // click frame ⇒ frame scope, click message ⇒ message scope.)
    selectedMux.set(null);
  }

  function onRowClick(e: MouseEvent, r: DisplayRow, i: number) {
    const key = rowKeyOf(r);
    if (e.shiftKey && anchorIndex !== null) {
      const [a, b] = anchorIndex < i ? [anchorIndex, i] : [i, anchorIndex];
      const next = new Set<string>();
      for (let j = a; j <= b; j++) next.add(rowKeyOf(rows[j]));
      selection.set(next);
    } else if (e.ctrlKey || e.metaKey) {
      selection.update((s) => {
        const n = new Set(s);
        n.has(key) ? n.delete(key) : n.add(key);
        return n;
      });
      anchorIndex = i;
    } else {
      selection.set(new Set([key]));
      anchorIndex = i;
    }
    setPrimary(r);
  }

  function onKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      selection.set(new Set(rows.map(rowKeyOf)));
      if (rows.length) {
        anchorIndex = 0;
        setPrimary(rows[0]);
      }
    }
  }

  function onDragStart(e: DragEvent, r: DisplayRow, i: number) {
    const key = rowKeyOf(r);
    let keys: string[];
    if ($selection.has(key)) {
      keys = [...$selection];
    } else {
      // Dragging an unselected row drags just it — and makes it the selection.
      keys = [key];
      selection.set(new Set(keys));
      anchorIndex = i;
      setPrimary(r);
    }
    e.dataTransfer?.setData('text/plain', JSON.stringify(keys));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove';
  }

  $: sel = $selected;
</script>

<!-- svelte-ignore a11y-no-noninteractive-tabindex -->
<div class="tablewrap" tabindex="0" role="grid" on:keydown={onKeydown}>
  {#if frozen}
    <div class="frozenbar">
      <span class="dim">sorted snapshot · <strong>{sortKey}</strong> {sortDir === 1 ? 'asc' : 'desc'} · frozen ({rows.length} rows) — live order is stable</span>
      <button on:click={clearSort}>Clear sort → live</button>
    </div>
  {/if}
  <table>
    <thead>
      <tr>
        <th class="id sortable" on:click={() => snapshotSort('id')} title="freeze a sorted snapshot by ID">ID{arrow('id')}</th>
        <th class="name sortable" on:click={() => snapshotSort('name')} title="freeze a sorted snapshot by name — double-click a Name cell to rename">Name{arrow('name')}</th>
        <th class="value" title="Tab formula result (active view) — define it in the inspector below">Value</th>
        <th class="rate sortable" on:click={() => snapshotSort('rate')} title="freeze a sorted snapshot by rate">Rate{arrow('rate')}</th>
        <th class="seen sortable" on:click={() => snapshotSort('lastTUs')} title="freeze a sorted snapshot by last-seen">Last{arrow('lastTUs')}</th>
        <th class="cnt sortable" on:click={() => snapshotSort('count')} title="freeze a sorted snapshot by count">Count{arrow('count')}</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as r, i (`${r.isExtended ? 'e' : 's'}${r.id}`)}
        {@const rkey = rowKeyOf(r)}
        {@const tv = tabFormula ? evalFormula(tabFormula.expr, r.data, tabFormula.unit) : null}
        <tr
          class:selected={$selection.has(rkey)}
          class:primary={sel && sel.id === r.id && sel.isExtended === r.isExtended}
          class:flashing={$flashKey === 'frame:' + rkey}
          class:error={r.isError}
          draggable="true"
          on:click={(e) => onRowClick(e, r, i)}
          on:dragstart={(e) => onDragStart(e, r, i)}
          title="drag onto a tab to add it · Ctrl/⌘+click or Shift+click to multi-select · Ctrl/⌘+A for all"
        >
          <td class="id mono">
            {idHex(r)}
            {#if r.isExtended}<span class="tag" style={badgeStyle('ext')} title="extended (29-bit) id">x</span>{/if}
            {#if r.isRtr}<span class="tag" style={badgeStyle('rtr')} title="remote request frame">R</span>{/if}
            {#if classifyDiagId(r.id, r.isExtended)}<span class="tag" style={badgeStyle('diag')} title="diagnostic (ISO-TP / OBD-UDS)">DIAG</span>{/if}
            {#if muxKeys.has(rkey)}<span class="tag" style={badgeStyle('mux')} title="multiplexed frame (has a multiplexor signal)">MUX</span>{/if}
          </td>
          <td
            class="name"
            class:editing={editingKey === rkey}
            on:dblclick|stopPropagation={() => beginEdit(r)}
            title="double-click to rename"
          >
            {#if editingKey === rkey}
              <!-- svelte-ignore a11y-autofocus -->
              <input
                class="nameedit"
                bind:this={nameInput}
                bind:value={nameDraft}
                on:click|stopPropagation
                on:blur={() => commitEdit(r)}
                on:keydown={(e) => onNameKey(e, r)}
                spellcheck="false"
                placeholder="frame name"
              />
            {:else}
              {r.name || ''}
            {/if}
          </td>
          {#if tv && tv.ok}
            <td class="value mono" title={tv.display}>{tv.display}</td>
          {:else if tv && tv.error}
            <td class="value mono err" title={tv.error}>⚠</td>
          {:else}
            <td class="value dim">—</td>
          {/if}
          <td class="rate mono">{r.rate >= 1 ? r.rate.toFixed(0) : r.rate.toFixed(1)}</td>
          <td class="seen mono dim">{formatAge(ageSeconds(r))}</td>
          <td class="cnt mono dim">{r.count.toLocaleString()}</td>
        </tr>
      {/each}
      {#if rows.length === 0}
        <tr class="empty">
          <td colspan="6" class="dim">
            no frames — connect, then Start a source (sim works with zero hardware)
          </td>
        </tr>
      {/if}
    </tbody>
  </table>
  <div class="hint dim">{clock.hasOrigin() ? '' : 'awaiting first frame…'}</div>
</div>

<style>
  .tablewrap {
    height: 100%;
    overflow: auto;
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
  thead th.sortable {
    cursor: pointer;
    user-select: none;
  }
  thead th.sortable:hover {
    color: var(--text);
  }
  .frozenbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 4px 8px;
    background: var(--bg-elev);
    border-bottom: 1px solid var(--warn);
    font-size: 11px;
  }
  .frozenbar strong {
    color: var(--warn);
  }
  td {
    padding: 3px 8px;
    border-bottom: 1px solid #1a1e25;
    white-space: nowrap;
  }
  tbody tr {
    cursor: pointer;
  }
  tbody tr:hover {
    background: #181c23;
  }
  tr.selected {
    background: var(--accent-dim) !important;
  }
  /* The PRIMARY row (drives the Inspector) gets an accent edge so it stands out
     within a multi-row selection. */
  tr.primary td.id {
    box-shadow: inset 3px 0 0 var(--accent);
  }
  tbody tr {
    -webkit-user-select: none;
    user-select: none;
  }
  tr.error td.id {
    color: var(--err);
  }
  .id {
    width: 110px;
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
  .tag {
    display: inline-block;
    font-size: 10px;
    font-weight: 700;
    padding: 0 4px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    margin-left: 3px;
    /* color / border-color / background come from badgeStyle() inline (B1) */
  }
  .empty td {
    padding: 18px;
    text-align: center;
  }
  .hint {
    padding: 6px 8px;
    font-size: 11px;
  }
</style>
