<script lang="ts">
  /**
   * Edit one signal of the §3.5 data model: bit range, endianness, factor,
   * offset, unit, name (+ a signed extension). Shows the LIVE decoded value
   * computed from the currently-selected frame's latest payload.
   */
  import type { EditableSignal } from '../protocol/datamodel';
  import { decodeSignal, formatValue } from '../protocol/decode';
  import { updateSignal, removeSignal, setMultiplexor } from '../state/store';
  import { createEventDispatcher } from 'svelte';

  export let signal: EditableSignal;
  export let liveData: Uint8Array = new Uint8Array(0);
  /** Whether this signal's frame has a multiplexor signal (B2 · point 2). */
  export let hasMux = false;
  /** Live value of the frame's multiplexor signal, or null. */
  export let currentMux: number | null = null;

  const dispatch = createEventDispatcher<{ change: void }>();

  // Local editable copy; commit on change.
  let draft: EditableSignal = { ...signal };
  $: draft = { ...signal };

  function commit() {
    // clamp
    draft.bitStart = Math.max(0, Math.floor(draft.bitStart));
    draft.bitLength = Math.min(64, Math.max(1, Math.floor(draft.bitLength)));
    updateSignal({ ...draft });
    dispatch('change');
  }

  function del() {
    removeSignal(draft.frameId, draft.isExtended, draft.id);
    dispatch('change');
  }

  $: decoded = decodeSignal(liveData, draft);

  // Enum label for the current raw value (DBC VAL_), e.g. raw 2 → "Reverse".
  // Keyed by the unscaled integer raw value (Number-narrowed from the BigInt).
  $: rawLabel = (() => {
    const labels = draft.valueLabels;
    if (!labels) return undefined;
    const n = Number(decoded.raw);
    return Number.isSafeInteger(n) ? labels[n] : undefined;
  })();

  // ── multiplexing (B2 · point 2) ───────────────────────────────────────────────
  $: isMux = !!draft.isMultiplexor;
  $: modeDependent =
    !isMux && draft.multiplexValue !== undefined && draft.multiplexValue !== null;
  // A mode-dependent signal is INACTIVE when the live multiplexor value is known
  // and differs from this signal's multiplex value (right now its bytes encode a
  // different sub-message, so the decoded value is not meaningful).
  $: inactive = modeDependent && currentMux !== null && draft.multiplexValue !== currentMux;

  function toggleMux(e: Event) {
    const on = (e.target as HTMLInputElement).checked;
    setMultiplexor(draft.frameId, draft.isExtended, on ? draft.id : null);
  }
</script>

<div class="sig">
  <div class="row top">
    <input
      class="name"
      bind:value={draft.name}
      on:change={commit}
      placeholder="signal name"
      title={draft.comment ?? ''}
    />
    {#if draft.comment}
      <span class="info" title={draft.comment}>ⓘ</span>
    {/if}
    <span class="value mono" class:trunc={decoded.truncated} class:inactive={inactive}>
      {formatValue(decoded.value)}{draft.unit ? ' ' + draft.unit : ''}
    </span>
    <button class="del" title="remove signal" on:click={del}>✕</button>
  </div>

  <div class="row fields">
    <label>start<input class="num" type="number" bind:value={draft.bitStart} on:change={commit} min="0" /></label>
    <label>len<input class="num" type="number" bind:value={draft.bitLength} on:change={commit} min="1" max="64" /></label>
    <label>
      order
      <select bind:value={draft.byteOrder} on:change={commit}>
        <option value="little">little</option>
        <option value="big">big</option>
      </select>
    </label>
    <label class="chk">
      <input type="checkbox" bind:checked={draft.signed} on:change={commit} />signed
    </label>
  </div>
  <div class="row fields">
    <label>factor<input class="num" type="number" bind:value={draft.factor} on:change={commit} step="any" /></label>
    <label>offset<input class="num" type="number" bind:value={draft.offset} on:change={commit} step="any" /></label>
    <label>unit<input class="unit" bind:value={draft.unit} on:change={commit} /></label>
    <span class="raw dim mono">raw {decoded.raw.toString()}{#if rawLabel} <span class="vallabel" title="DBC value label">({rawLabel})</span>{/if}</span>
  </div>

  <div class="row fields mux">
    <label class="chk" title="this signal selects which sub-message the rest of the payload encodes">
      <input type="checkbox" checked={isMux} on:change={toggleMux} />multiplexor
    </label>
    {#if hasMux && !isMux}
      <label title="active only when the multiplexor equals this value (blank = always)">
        mux=<input class="num" type="number" bind:value={draft.multiplexValue} on:change={commit} placeholder="any" />
      </label>
    {/if}
    {#if isMux}
      <span class="muxtag sel">MUX selector</span>
    {:else if inactive}
      <span class="muxtag off">inactive · mux {draft.multiplexValue}</span>
    {:else if modeDependent}
      <span class="muxtag on">active · mux {draft.multiplexValue}</span>
    {/if}
  </div>
</div>

<style>
  .sig {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 6px 8px;
    margin-bottom: 6px;
    background: var(--bg-elev);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 3px 0;
    flex-wrap: wrap;
  }
  .top .name {
    flex: 1;
    min-width: 100px;
  }
  .info {
    cursor: help;
    color: var(--text-dim);
    font-size: 12px;
  }
  .value {
    font-weight: 600;
    color: var(--accent);
  }
  .value.trunc {
    color: var(--warn);
  }
  .value.inactive {
    color: var(--text-dim);
    opacity: 0.6;
  }
  .muxtag {
    font-size: 10px;
    padding: 0 5px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }
  .muxtag.sel {
    color: var(--accent);
    border-color: var(--accent-dim);
  }
  .muxtag.on {
    color: var(--ok);
  }
  .muxtag.off {
    color: var(--text-dim);
  }
  label {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 11px;
    color: var(--text-dim);
  }
  label.chk {
    cursor: pointer;
  }
  .num {
    width: 56px;
  }
  .unit {
    width: 46px;
  }
  .raw {
    font-size: 10px;
  }
  .vallabel {
    color: var(--accent);
  }
  .del {
    padding: 2px 6px;
  }
</style>
