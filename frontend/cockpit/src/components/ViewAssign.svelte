<script lang="ts">
  /**
   * Selection → tabs assignment bar. Appears whenever one or more frames are
   * selected in the table.
   *
   * It acts on the WHOLE current selection (the table's multi-select set, plus
   * the primary/last-clicked row shown in the header), so Ctrl/⌘- or Shift-
   * selecting many frames and then toggling a tab here tags/untags them all at
   * once — matching drag-to-tab.
   *
   *   · QUICK — one toggle to show/hide the selection in the CURRENT tab.
   *   · MULTI — a "Tabs ▾" menu with a per-tab tri-state checkbox (all / some /
   *     none of the selection are in that tab), plus a "+" that spins the whole
   *     selection off into a brand-new tab without losing the selection.
   * The canonical "All" tab always contains every frame, so it never appears as a
   * membership target.
   */
  import {
    selected,
    selection,
    views,
    activeView,
    setFramesInView,
    createView,
    frameKeyOfMember,
  } from '../state/store';
  import { frameKey, type FrameView } from '../protocol/datamodel';

  let menuOpen = false;

  $: sel = $selected;
  $: active = $activeView;
  $: customViews = $views.filter((v) => !v.locked);

  // The set this bar acts on: the multi-selection plus the primary (the header
  // shows the primary, so it belongs in the set). Normally the selection already
  // contains the primary; the union just covers the Ctrl-deselected-primary case.
  $: keys = (() => {
    const s = new Set($selection);
    if (sel) s.add(frameKey(sel.id, sel.isExtended));
    return [...s];
  })();
  $: count = keys.length;

  /**
   * How many of the selected frames are already in `view` (locked = all). A
   * member can be a FRAME key or a MESSAGE key (`<frameKey>#<mux>`); a message
   * member implies its frame is shown, so we compare against each member's
   * frame key (matching the frame-table gating in `filteredRows`).
   */
  function inCount(view: FrameView, ks: string[]): number {
    if (view.locked) return ks.length;
    const m = new Set(view.members.map(frameKeyOfMember));
    return ks.reduce((n, k) => n + (m.has(k) ? 1 : 0), 0);
  }

  // Per-view tri-state, recomputed whenever the selection OR the views change.
  $: activeStatus = stateOf(active, keys);
  $: menuRows = customViews.map((v) => ({ v, ...stateOf(v, keys) }));

  function stateOf(view: FrameView, ks: string[]): { all: boolean; some: boolean } {
    const c = inCount(view, ks);
    return { all: ks.length > 0 && c === ks.length, some: c > 0 };
  }

  function idHex(id: number, isExtended: boolean): string {
    return '0x' + id.toString(16).toUpperCase().padStart(isExtended ? 8 : 3, '0');
  }

  /** Toggle the whole selection in/out of a view (add all unless all already in). */
  function toggleIn(view: FrameView) {
    if (view.locked || count === 0) return;
    const allIn = inCount(view, keys) === count;
    setFramesInView(view.id, keys, !allIn);
  }

  /** "+" in the menu: spin the current selection off into a new tab (keeps it). */
  function newTabFromSelection() {
    if (count === 0) return;
    createView(`Tab ${$views.length}`, keys);
  }

  /** Set the indeterminate DOM property (it has no HTML attribute), reactively. */
  function indet(node: HTMLInputElement, value: boolean) {
    node.indeterminate = value;
    return { update: (v: boolean) => (node.indeterminate = v) };
  }
</script>

{#if sel}
  <div class="assign">
    <span class="label">{count > 1 ? 'FRAMES' : 'FRAME'}</span>
    <span class="mono frame">{idHex(sel.id, sel.isExtended)}{#if sel.isExtended}<span class="tag">x</span>{/if}</span>
    {#if count > 1}<span class="more">+{count - 1} more</span>{/if}

    {#if active.locked}
      <span class="dim small">tab "{active.name}" — always visible</span>
    {:else}
      <label class="quick" title={count > 1 ? 'show the selection in the current tab' : 'show this frame in the current tab'}>
        <input
          type="checkbox"
          checked={activeStatus.all}
          use:indet={activeStatus.some && !activeStatus.all}
          on:change={() => toggleIn(active)}
        />
        <span>in "{active.name}"</span>
      </label>
    {/if}

    <div class="spacer"></div>

    <div class="menuwrap">
      <button class="menubtn" on:click={() => (menuOpen = !menuOpen)} title="show/hide the selection in several tabs">
        Tabs ▾
      </button>
      {#if menuOpen}
        <!-- click-catcher to close the menu -->
        <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
        <div class="backdrop" on:click={() => (menuOpen = false)}></div>
        <div class="menu">
          {#each menuRows as row (row.v.id)}
            <label class="row">
              <input
                type="checkbox"
                checked={row.all}
                use:indet={row.some && !row.all}
                on:change={() => toggleIn(row.v)}
              />
              <span class="name">{row.v.name}</span>
              {#if count > 1}<span class="cnt">{inCount(row.v, keys)}/{count}</span>{/if}
            </label>
          {/each}
          <button class="newtab" on:click={newTabFromSelection}>
            ＋ New tab from {count > 1 ? `selection (${count})` : 'frame'}
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .assign {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    background: var(--bg-elev2);
    border-bottom: 1px solid var(--border);
    position: relative;
  }
  .label {
    font-size: 10px;
    letter-spacing: 0.1em;
    color: var(--text-dim);
  }
  .frame {
    color: var(--accent);
    font-weight: 600;
  }
  .more {
    font-size: 11px;
    color: var(--text-dim);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 0 6px;
  }
  .small {
    font-size: 11px;
  }
  .quick {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    cursor: pointer;
    font-size: 12px;
  }
  .spacer {
    flex: 1;
  }
  .tag {
    display: inline-block;
    font-size: 9px;
    padding: 0 3px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    margin-left: 3px;
    color: var(--text-dim);
  }
  .menuwrap {
    position: relative;
  }
  .menubtn {
    font-size: 12px;
    padding: 3px 10px;
  }
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 10;
  }
  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    z-index: 11;
    min-width: 200px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 4px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  }
  .menu .row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 12px;
  }
  .menu .row:hover {
    background: var(--bg-elev2);
  }
  .menu .name {
    flex: 1;
  }
  .menu .cnt {
    font-size: 10px;
    color: var(--text-dim);
  }
  .menu .newtab {
    display: block;
    width: 100%;
    text-align: left;
    margin-top: 4px;
    padding: 6px 8px 4px;
    border: none;
    border-top: 1px solid var(--border);
    border-radius: 0 0 var(--radius-sm) var(--radius-sm);
    background: transparent;
    color: var(--accent);
    font-size: 12px;
    cursor: pointer;
  }
  .menu .newtab:hover {
    background: var(--bg-elev2);
  }
</style>
