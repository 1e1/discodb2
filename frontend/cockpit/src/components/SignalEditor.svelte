<script lang="ts">
  /**
   * Edit one signal of the §3.5 data model: bit range, endianness, factor,
   * offset, unit, name (+ a signed extension). Shows the LIVE decoded value
   * computed from the currently-selected frame's latest payload.
   */
  import type { EditableSignal } from '../protocol/datamodel';
  import { decodeSignal, formatValue } from '../protocol/decode';
  import { updateSignal, removeSignal } from '../state/store';
  import { createEventDispatcher } from 'svelte';

  export let signal: EditableSignal;
  export let liveData: Uint8Array = new Uint8Array(0);

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
</script>

<div class="sig">
  <div class="row top">
    <input class="name" bind:value={draft.name} on:change={commit} placeholder="signal name" />
    <span class="value mono" class:trunc={decoded.truncated}>
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
    <span class="raw dim mono">raw {decoded.raw.toString()}</span>
  </div>
</div>

<style>
  .sig {
    border: 1px solid var(--border);
    border-radius: 5px;
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
  .value {
    font-weight: 600;
    color: var(--accent);
  }
  .value.trunc {
    color: var(--warn);
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
  .del {
    padding: 2px 6px;
  }
</style>
