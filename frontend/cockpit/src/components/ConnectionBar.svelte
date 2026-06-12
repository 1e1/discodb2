<script lang="ts">
  import {
    connect,
    disconnect,
    connectionState,
    wsUrl,
    getClient,
    isReplay,
    serverFiles,
  } from '../state/store';
  import type { CanSource } from '../protocol/types';

  let source: CanSource = 'sim';
  let replayFile = '';
  let recordName = '';

  // Usual CAN bitrates, fastest first. Notes name the typical bus the speed is
  // found on — generic, not vehicle-specific. Last entry is a free-form value.
  const BITRATES = [
    { value: 1000000, label: '1 Mbit/s', note: 'high-speed CAN' },
    { value: 500000, label: '500 kbit/s', note: 'powertrain / OBD diag' },
    { value: 250000, label: '250 kbit/s', note: 'commercial / J1939' },
    { value: 125000, label: '125 kbit/s', note: 'comfort / body' },
    { value: 100000, label: '100 kbit/s', note: 'low-speed body / comfort' },
    { value: 83333, label: '83.333 kbit/s', note: 'single-wire / GMLAN' },
    { value: 50000, label: '50 kbit/s', note: 'low-speed body' },
    { value: 33333, label: '33.333 kbit/s', note: 'single-wire CAN' },
  ];

  // The select binds to a string ('custom' or the numeric value). The actual
  // bitrate sent to the backend is derived, falling back to the custom field.
  let bitrateChoice = '500000';
  let customBitrate = 500000;
  $: bitrate =
    bitrateChoice === 'custom' ? customBitrate : Number(bitrateChoice);

  $: connected = $connectionState === 'open';

  function doConnect() {
    connect($wsUrl);
  }
  function doStart() {
    // listen_only is intentionally NOT exposed as "off" — it defaults true and
    // the backend clamps it (DESIGN §4.1). Heavy client never asks to transmit.
    getClient().start({
      source,
      bitrate,
      listenOnly: true,
      file: source === 'replay' ? replayFile : undefined,
    });
  }
  function doStop() {
    getClient().stop();
  }
  function doListFiles() {
    getClient().listFiles();
  }
  function doRecordStart() {
    getClient().recordStart(recordName || undefined);
  }
  function doRecordStop() {
    getClient().recordStop();
  }
</script>

<div class="bar">
  <div class="row">
    <strong>discodb2</strong><span class="dim">· cockpit</span>
  </div>

  <input
    class="mono url"
    bind:value={$wsUrl}
    placeholder="ws://host:8765/ws"
    spellcheck="false"
  />
  {#if connected}
    <button on:click={disconnect}>Disconnect</button>
  {:else}
    <button class="primary" on:click={doConnect}>Connect</button>
  {/if}

  <span class="sep"></span>

  <label class="dim" for="src-select">source</label>
  <select id="src-select" bind:value={source} disabled={!connected}>
    <option value="sim">sim</option>
    <option value="socketcan">socketcan</option>
    <option value="gs_usb">gs_usb</option>
    <option value="slcan">slcan</option>
    <option value="replay">replay</option>
  </select>

  {#if source === 'replay'}
    <select bind:value={replayFile} disabled={!connected} class="mono">
      <option value="">(pick file)</option>
      {#each $serverFiles as f}
        <option value={f}>{f}</option>
      {/each}
    </select>
    <button on:click={doListFiles} disabled={!connected} title="list_files">⟳</button>
  {:else}
    <label class="dim" for="bitrate-select">bitrate</label>
    <select
      id="bitrate-select"
      class="mono"
      bind:value={bitrateChoice}
      disabled={!connected}
    >
      {#each BITRATES as b}
        <option value={String(b.value)}>{b.label} — {b.note}</option>
      {/each}
      <option value="custom">custom…</option>
    </select>
    {#if bitrateChoice === 'custom'}
      <input
        class="mono num"
        type="number"
        bind:value={customBitrate}
        disabled={!connected}
        step="1000"
        title="custom bitrate in bit/s"
        aria-label="custom bitrate"
      />
    {/if}
  {/if}

  <button class="primary" on:click={doStart} disabled={!connected}>Start</button>
  <button on:click={doStop} disabled={!connected}>Stop</button>

  <span class="sep"></span>

  <input
    class="mono name"
    bind:value={recordName}
    placeholder="record name"
    disabled={!connected}
  />
  <button on:click={doRecordStart} disabled={!connected}>● Rec</button>
  <button on:click={doRecordStop} disabled={!connected}>■</button>

  <div class="spacer"></div>

  {#if $isReplay}
    <span class="pill replay"><span class="dot"></span>REPLAY</span>
  {/if}
  <span class="pill listen" title="Listen-only is enforced in the backend — the adapter never acknowledges or transmits on the bus, so you can't disturb a live car.">

    listen-only
  </span>
</div>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: var(--bg-elev);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .url {
    width: 230px;
  }
  .num {
    width: 90px;
  }
  .name {
    width: 120px;
  }
  .sep {
    width: 1px;
    align-self: stretch;
    background: var(--border);
    margin: 0 4px;
  }
  label {
    font-size: 11px;
  }
  .pill.listen {
    border-color: var(--accent-dim);
    color: var(--accent);
  }
</style>
