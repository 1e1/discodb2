<script lang="ts">
  /**
   * CLUSTER — the decoded-signals dashboard (an instrument cluster rebuilt from
   * what you've reverse-engineered). One card per decoded signal / per-frame
   * "Custom" formula: Name + live value (decoded on the main thread against each
   * frame's latest payload) + a sparkline of the value over the recent window
   * (traced in the analysis worker, DESIGN §6.1.2).
   *
   * Phase 1 = the value grid (no worker). Phase 2 = the per-card sparkline fed by
   * the worker `clusterSeries`. A card with no data in the window simply shows no
   * curve; an absent frame shows a dimmed value.
   */
  import {
    clusterCards,
    clusterSeries,
    clusterWindowSeconds,
    selected,
    uiMode,
    type ClusterCard,
  } from '../state/store';
  import Sparkline from './Sparkline.svelte';

  let query = '';
  let showGraphs = true;

  const WINDOWS = [5, 10, 30, 60];

  function idHex(c: ClusterCard): string {
    return '0x' + c.frameId.toString(16).toUpperCase().padStart(c.isExtended ? 8 : 3, '0');
  }

  // Filter by Name / frame name / id (case-insensitive substring).
  $: needle = query.trim().toLowerCase();
  $: cards = needle
    ? $clusterCards.filter(
        (c) =>
          c.name.toLowerCase().includes(needle) ||
          c.frameName.toLowerCase().includes(needle) ||
          idHex(c).toLowerCase().includes(needle),
      )
    : $clusterCards;

  /** Series for a card → {values, times(relative seconds)} for the Sparkline. */
  function seriesFor(key: string): { values: number[]; times: number[] } {
    const s = $clusterSeries.get(key);
    if (!s || s.tUs.length === 0) return { values: [], times: [] };
    const t0 = s.tUs[0];
    return { values: s.values, times: s.tUs.map((t) => (t - t0) / 1e6) };
  }

  /** Click a card → select its frame and jump to Explore to inspect it. */
  function inspect(c: ClusterCard): void {
    selected.set({ id: c.frameId, isExtended: c.isExtended });
    uiMode.set('explore');
  }
</script>

<div class="cluster">
  <div class="bar">
    <span class="title">CLUSTER</span>
    <span class="dim small">{cards.length} / {$clusterCards.length} decoded</span>
    <input class="search" placeholder="filter name / id…" bind:value={query} />
    <div class="spacer"></div>
    <label class="small dim toggle">
      <input type="checkbox" bind:checked={showGraphs} /> graphs
    </label>
    <span class="sep"></span>
    <span class="small dim">window</span>
    <div class="winseg">
      {#each WINDOWS as w}
        <button class:on={$clusterWindowSeconds === w} on:click={() => clusterWindowSeconds.set(w)}>
          {w}s
        </button>
      {/each}
    </div>
  </div>

  {#if $clusterCards.length === 0}
    <div class="empty">
      <p>No decoded signals yet.</p>
      <p class="dim small">
        Name signals in the Inspector or add per-frame “Custom” formulas in Explore — they
        show up here as live gauges.
      </p>
    </div>
  {:else}
    <div class="grid">
      {#each cards as c (c.key)}
        {@const s = seriesFor(c.key)}
        <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
        <div class="card" class:absent={!c.present} on:click={() => inspect(c)} title="click to inspect in Explore">
          <div class="head">
            <span class="name" title={c.name}>{c.name}</span>
            {#if c.kind === 'formula'}<span class="tag">custom</span>{/if}
          </div>
          <div class="value" class:dim={!c.present}>{c.present ? c.display : '—'}</div>
          <div class="meta small dim">
            <span class="mono">{idHex(c)}</span>
            {#if c.kind === 'signal' && c.frameName !== c.name}· {c.frameName}{/if}
            {#if c.present}· {c.rate.toFixed(c.rate < 10 ? 1 : 0)} fps{:else}· absent{/if}
          </div>
          {#if showGraphs}
            <div class="spark">
              <Sparkline values={s.values} times={s.times} width={240} height={56} />
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .cluster {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
    flex-wrap: wrap;
  }
  .title {
    font-size: 10px;
    letter-spacing: 0.1em;
    color: var(--text-dim);
    font-weight: 600;
  }
  .small {
    font-size: 11px;
  }
  .dim {
    color: var(--text-dim);
  }
  .search {
    width: 180px;
  }
  .spacer {
    flex: 1;
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
  }
  .sep {
    width: 1px;
    height: 16px;
    background: var(--border);
  }
  .winseg {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 5px;
    overflow: hidden;
  }
  .winseg button {
    border: none;
    border-radius: 0;
    background: transparent;
    padding: 2px 9px;
    font-size: 11px;
  }
  .winseg button.on {
    background: var(--accent-dim);
    color: var(--accent);
  }
  .grid {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 10px;
    padding: 12px;
    align-content: start;
  }
  .card {
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--bg-elev);
    padding: 10px 12px;
    cursor: pointer;
    transition: border-color 0.1s;
  }
  .card:hover {
    border-color: var(--accent);
  }
  .card.absent {
    opacity: 0.6;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .name {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tag {
    font-size: 9px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--accent);
    border: 1px solid var(--accent-dim);
    border-radius: 3px;
    padding: 0 4px;
    flex: none;
  }
  .value {
    font-size: 22px;
    font-family: var(--mono, monospace);
    margin: 4px 0 2px;
  }
  .value.dim {
    color: var(--text-dim);
  }
  .meta {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .mono {
    font-family: var(--mono, monospace);
  }
  .spark {
    margin-top: 8px;
  }
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    text-align: center;
    padding: 24px;
  }
</style>
