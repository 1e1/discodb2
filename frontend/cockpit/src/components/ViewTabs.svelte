<script lang="ts">
  /**
   * View tabs — the "frame list" lives in TABS. The first tab is the
   * CANONICAL "All" view: locked (undeletable, no membership), so it always
   * shows every frame passing its filter — the safety net you can never empty.
   *
   * The `+` button adds a custom WHITELIST tab (positive membership = the frames
   * you've tagged into it). Double-click a tab to rename it; `×` deletes a custom
   * tab. For the active custom tab, two bulk actions:
   *   · "show all" → tag every frame passing this tab's filter,
   *   · "hide all" → empty the tab.
   * Per-frame tagging is in the selected-frame bar (ViewAssign).
   */
  import { tick } from 'svelte';
  import {
    views,
    activeView,
    activeViewId,
    setActiveView,
    createView,
    deleteView,
    renameView,
    tagAllVisible,
    clearViewMembers,
    setFramesInView,
  } from '../state/store';
  import type { FrameView } from '../protocol/datamodel';

  let editingId: string | null = null;
  let draft = '';
  let nameInput: HTMLInputElement | null = null;

  // ── drag-drop: drop frames from the table onto a tab ────────────────────────
  // Drop on a CUSTOM tab → tag those frames into it (no effect on the open tab).
  // Drop on the canonical "All" tab → REMOVE them from the open tab (you can
  // never hide anything in "All" itself, so the gesture means "get these out
  // of my current tab"). No-op when the open tab is itself canonical.
  let dragOverId: string | null = null;

  function onDragOver(e: DragEvent, v: FrameView) {
    // Only the canonical tab is a meaningful drop target when no custom tab is
    // open; both kinds accept drops. preventDefault enables the drop.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = v.locked ? 'move' : 'copy';
    dragOverId = v.id;
  }

  /** Parse the dragged frame keys from a drop event (empty array on failure). */
  function droppedKeys(e: DragEvent): string[] {
    const raw = e.dataTransfer?.getData('text/plain');
    if (!raw) return [];
    let keys: unknown;
    try {
      keys = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(keys)) return [];
    return keys.filter((k): k is string => typeof k === 'string');
  }

  function onDrop(e: DragEvent, v: FrameView) {
    e.preventDefault();
    dragOverId = null;
    const frameKeys = droppedKeys(e);
    if (frameKeys.length === 0) return;
    if (v.locked) {
      // Remove from the currently-open tab (no-op if it's canonical).
      setFramesInView($activeViewId, frameKeys, false);
    } else {
      setFramesInView(v.id, frameKeys, true);
    }
  }

  // Sentinel id for the "+" button as a drop target.
  const ADD_TARGET = '__add__';

  /** Drop on "+" → create a new tab seeded with the dragged selection and open it. */
  function onDropAdd(e: DragEvent) {
    e.preventDefault();
    dragOverId = null;
    const frameKeys = droppedKeys(e);
    if (frameKeys.length === 0) {
      addTab();
      return;
    }
    createView(`Tab ${$views.length}`, frameKeys);
  }

  async function beginRename(id: string, current: string) {
    editingId = id;
    draft = current;
    await tick();
    nameInput?.focus();
    nameInput?.select();
  }

  function commitRename() {
    if (editingId) renameView(editingId, draft);
    editingId = null;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      editingId = null;
    }
  }

  function addTab() {
    createView(`Tab ${$views.length}`);
  }

  function onDelete(id: string, name: string) {
    if (confirm(`Delete tab "${name}"? (frames aren't deleted, only this filter)`)) {
      deleteView(id);
    }
  }

  $: active = $activeView;
</script>

<div class="viewtabs">
  <div class="tabs">
    {#each $views as v (v.id)}
      <div
        class="tab"
        class:active={v.id === $activeViewId}
        class:locked={v.locked}
        class:dropping={dragOverId === v.id}
        on:click={() => setActiveView(v.id)}
        on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && setActiveView(v.id)}
        on:dblclick|stopPropagation={() => !v.locked && beginRename(v.id, v.name)}
        on:dragover={(e) => onDragOver(e, v)}
        on:dragleave={() => (dragOverId = null)}
        on:drop={(e) => onDrop(e, v)}
        role="tab"
        aria-selected={v.id === $activeViewId}
        tabindex="0"
        title={v.locked
          ? 'All frames — cannot be deleted. Drag a frame here to remove it from the current tab.'
          : 'double-click to rename · drag frames here to add them'}
      >
        {#if editingId === v.id}
          <!-- svelte-ignore a11y-autofocus -->
          <input
            class="rename"
            bind:this={nameInput}
            bind:value={draft}
            on:click|stopPropagation
            on:blur={commitRename}
            on:keydown={onKey}
            spellcheck="false"
          />
        {:else}
          {#if v.locked}<span class="lock">🔒</span>{/if}
          <span class="name">{v.name}</span>
          {#if !v.locked}<span class="badge" title="tagged frames">{v.members.length}</span>{/if}
        {/if}
        {#if !v.locked && editingId !== v.id}
          <button class="close" title="delete tab" on:click|stopPropagation={() => onDelete(v.id, v.name)}>×</button>
        {/if}
      </div>
    {/each}
    <button
      class="add"
      class:dropping={dragOverId === ADD_TARGET}
      title="new tab (whitelist) · drag a selection here to create a pre-filled tab"
      on:click={addTab}
      on:dragover={(e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        dragOverId = ADD_TARGET;
      }}
      on:dragleave={() => (dragOverId = null)}
      on:drop={onDropAdd}
    >+</button>
  </div>

  {#if !active.locked}
    <div class="bulk">
      <button on:click={() => tagAllVisible(active.id)} title="tag every frame passing this tab's filter">show all</button>
      <button on:click={() => clearViewMembers(active.id)} title="empty the tab">hide all</button>
    </div>
  {/if}
</div>

<style>
  .viewtabs {
    display: flex;
    align-items: stretch;
    justify-content: space-between;
    gap: 8px;
    background: var(--bg-elev);
    border-bottom: 1px solid var(--border);
    padding: 0 6px;
  }
  .tabs {
    display: flex;
    align-items: stretch;
    gap: 2px;
    flex-wrap: wrap;
    min-width: 0;
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 8px 5px 10px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    color: var(--text-dim);
    user-select: none;
    white-space: nowrap;
  }
  .tab:hover {
    color: var(--text);
  }
  .tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .tab.dropping {
    background: var(--accent-dim);
    box-shadow: inset 0 0 0 1px var(--accent);
    border-radius: var(--radius-sm);
  }
  .tab .name {
    font-size: 12px;
  }
  .lock {
    font-size: 10px;
    opacity: 0.8;
  }
  /* This badge is a member-count pill (rounder than the global default) and gets
     an accent recolor when its tab is active. Base font/bg/border/color come from
     the global .badge primitive; only the rounder shape + active state stay local. */
  .badge {
    border-radius: var(--radius-lg);
  }
  .tab.active .badge {
    border-color: var(--accent);
    color: var(--accent);
  }
  .close {
    border: none;
    background: transparent;
    color: var(--text-dim);
    padding: 0 2px;
    font-size: 13px;
    line-height: 1;
    border-radius: var(--radius-sm);
  }
  .close:hover {
    color: var(--err);
    background: var(--bg-elev2);
  }
  .add {
    border: none;
    background: transparent;
    color: var(--text-dim);
    font-size: 16px;
    line-height: 1;
    padding: 0 8px;
    align-self: center;
    border-radius: var(--radius-sm);
  }
  .add:hover {
    color: var(--accent);
    background: var(--bg-elev2);
  }
  .add.dropping {
    color: var(--accent);
    background: var(--accent-dim);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .rename {
    font: inherit;
    width: 110px;
    padding: 1px 4px;
  }
  .bulk {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  .bulk button {
    font-size: 11px;
    padding: 2px 8px;
  }
</style>
