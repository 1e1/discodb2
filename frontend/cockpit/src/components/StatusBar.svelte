<script lang="ts">
  import {
    connectionState,
    connectionDetail,
    health,
    busFps,
    totalFrames,
    maxTUs,
    ringStats,
    lastError,
    getSessionClock,
  } from '../state/store';
  import { formatRel } from '../protocol/sessionClock';

  $: clock = getSessionClock();
  // RELATIVE time only (task). Absolute start is captured but not shown here.
  $: relNow = formatRel(clock.relSecondsFromMax($maxTUs));
  $: stateClass = $connectionState;
</script>

<div class="status">
  <span class="pill {stateClass}" title={$connectionDetail}>
    <span class="dot"></span>{$connectionState}
  </span>

  <span class="metric"><span class="dim">t+</span> <span class="mono">{relNow}</span></span>
  <span class="metric"><span class="dim">bus</span> <span class="mono">{$busFps.toFixed(0)} fps</span></span>
  <span class="metric"><span class="dim">frames</span> <span class="mono">{$totalFrames.toLocaleString()}</span></span>
  <span class="metric">
    <span class="dim">buffer</span>
    <span class="mono">{$ringStats.size.toLocaleString()}/{$ringStats.capacity.toLocaleString()}</span>
  </span>

  {#if $health}
    <span class="sep"></span>
    <span class="metric"><span class="dim">src</span> <span class="mono">{$health.source}</span></span>
    <span class="metric"><span class="dim">state</span> <span class="mono">{$health.bus.state}</span></span>
    <span class="metric"><span class="dim">ids</span> <span class="mono">{$health.bus.unique_ids}</span></span>
    <span class="metric"><span class="dim">load</span> <span class="mono">{($health.bus.bus_load * 100).toFixed(1)}%</span></span>
    <span class="metric"><span class="dim">errs</span> <span class="mono">{$health.bus.errors}</span></span>
    {#if $health.record.active}
      <span class="pill replay"><span class="dot"></span>REC {$health.record.file ?? ''}</span>
    {/if}
  {/if}

  <div class="spacer"></div>
  <span class="metric dim" title="absolute session start (browser clock, captured on connect)">
    started {clock.sessionStartWall.toLocaleTimeString()}
  </span>

  {#if $lastError}
    <span class="err" title={$lastError}>⚠ {$lastError.slice(0, 80)}</span>
  {/if}
</div>

<style>
  .status {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 4px 10px;
    background: var(--bg-elev);
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    flex-wrap: wrap;
  }
  .metric {
    white-space: nowrap;
  }
  .sep {
    width: 1px;
    height: 14px;
    background: var(--border);
  }
  .err {
    color: var(--err);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 40%;
  }
</style>
