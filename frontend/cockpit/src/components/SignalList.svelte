<script lang="ts">
  /**
   * COLUMN 3 of the 3-column Explore — the SIGNALS of the focused message.
   * Lists each decoded field (bit range, name, live VALUE, + the message's
   * rate/last/count) and selects one (`selectedSignalId`) for the Signal
   * inspector below. The decoded value is the "human reading" the redesign is
   * about; signals come from `messageSignals` (store), already scoped to the
   * focused sub-message and decoded against its latest payload.
   */
  import {
    messageSignals,
    selected,
    selectedSignalId,
    selectedMux,
    messages,
    flashKey,
    getSessionClock,
  } from '../state/store';

  $: clock = getSessionClock();

  // The focused message row (for the shared rate / last / count columns — a
  // signal ticks at its message's cadence). Falls back to the single message.
  $: focused =
    $messages.find((m) => m.mux === $selectedMux) ??
    ($messages.length === 1 ? $messages[0] : null);
  $: rateStr = focused ? (focused.rate >= 1 ? focused.rate.toFixed(0) : focused.rate.toFixed(1)) : '—';
  $: lastStr = focused ? clock.relSeconds(focused.lastTUs).toFixed(2) : '—';
  $: countStr = focused ? focused.count.toLocaleString() : '—';
</script>

<div class="siglist">
  {#if !$selected}
    <div class="empty dim">select a message to list its signals</div>
  {:else}
    <table class="list">
      <thead>
        <tr>
          <th class="id">ID</th>
          <th>Name</th>
          <th class="val">Value</th>
          <th class="num">Rate</th>
          <th class="num">Last</th>
          <th class="num">Count</th>
        </tr>
      </thead>
      <tbody>
        {#each $messageSignals as r (r.id)}
          <tr
            class:sel={$selectedSignalId === r.id}
            class:derived={r.kind === 'derived'}
            class:flashing={$flashKey === 'sig:' + r.id}
            on:click={() => selectedSignalId.set(r.id)}
          >
            <td class="id mono" class:fn={r.kind === 'derived'}>{r.bitRange}</td>
            <td class="name">
              {r.name}
              {#if r.isMultiplexor}<span class="muxtag">MUX</span>{/if}
              {#if r.kind === 'derived'}<span class="drvtag">derived</span>{/if}
            </td>
            <td class="val mono" class:trunc={r.truncated}>{r.display}</td>
            <td class="num mono dim">{rateStr}</td>
            <td class="num mono dim">{lastStr}</td>
            <td class="num mono dim">{countStr}</td>
          </tr>
        {/each}
        {#if $messageSignals.length === 0}
          <tr><td colspan="6" class="dim empty-row">no signals on this message — add one in the inspector below</td></tr>
        {/if}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .siglist {
    height: 100%;
    overflow: auto;
    background: var(--bg);
  }
  .empty {
    padding: 18px 8px;
    text-align: center;
    font-size: 12px;
  }
  table.list {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--bg-elev);
    color: var(--text-dim);
    font-weight: 600;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    text-align: left;
    padding: 5px 10px;
    border-bottom: 1px solid var(--border);
  }
  th.num,
  td.num {
    text-align: right;
  }
  th.val {
    color: var(--accent);
  }
  tbody td {
    padding: 3px 10px;
    height: 23px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  tbody tr {
    cursor: pointer;
    border-left: 3px solid transparent;
  }
  tbody tr:hover {
    background: var(--bg-elev);
  }
  tbody tr.sel {
    background: var(--accent-dim);
    border-left: 3px solid var(--accent);
  }
  .mono {
    font-family: var(--mono, ui-monospace, monospace);
  }
  .dim {
    color: var(--text-dim);
  }
  td.id {
    color: var(--accent);
  }
  td.val {
    color: var(--text);
  }
  td.val.trunc {
    color: var(--warn, #e0b04a);
  }
  .muxtag,
  .drvtag {
    font-size: 9px;
    color: var(--accent);
    border: 1px solid var(--accent-dim);
    border-radius: 3px;
    padding: 0 3px;
    margin-left: 4px;
    vertical-align: middle;
  }
  .drvtag {
    color: var(--warn);
    border-color: var(--warn);
  }
  td.id.fn {
    color: var(--warn);
    font-style: italic;
  }
  .empty-row {
    padding: 14px 10px;
    font-size: 12px;
    text-align: center;
  }
</style>
