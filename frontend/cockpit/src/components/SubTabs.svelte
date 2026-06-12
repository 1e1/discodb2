<script lang="ts">
  /**
   * SubTabs — the shared sub-navigation bar used by the full-width workspaces
   * (Hunt, Logbook). One rendering for all of them: a visible top BAR with
   * underline tabs, matching the Explore view-tab strip (ViewTabs) — the look the
   * project standardized on. Keep this the single source so the sub-navs never
   * drift apart again.
   *
   * Controlled component: the parent owns the active id and updates it in `onSelect`.
   */
  export let tabs: { id: string; label: string }[] = [];
  export let active: string;
  export let onSelect: (id: string) => void;
</script>

<div class="subtabs" role="tablist">
  {#each tabs as t (t.id)}
    <button
      class="subtab"
      class:active={t.id === active}
      role="tab"
      aria-selected={t.id === active}
      on:click={() => onSelect(t.id)}
    >{t.label}</button>
  {/each}
</div>

<style>
  .subtabs {
    flex: none;
    display: flex;
    align-items: stretch;
    gap: 2px;
    background: var(--bg-elev);
    border-bottom: 1px solid var(--border);
    padding: 0 6px;
  }
  .subtab {
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    background: transparent;
    color: var(--text-dim);
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 600;
  }
  .subtab:hover:not(:disabled) {
    color: var(--text);
    border-color: transparent;
  }
  .subtab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
</style>
