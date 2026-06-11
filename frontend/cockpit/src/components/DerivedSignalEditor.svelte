<script lang="ts">
  /**
   * Editor for ONE derived ("computed") signal — the Signal column's 2nd formula
   * flavour. Unlike a Custom formula (over raw bytes), a derived signal is an
   * expr over the frame's DECODED signal VALUES, referenced by name (e.g.
   * `engine_rpm / 1000` or `wheel_speed_FL + wheel_speed_FR`). The live preview
   * evaluates against the focused message's current decoded values.
   */
  import {
    messageSignals,
    selectedSignalId,
    updateDerivedSignal,
    removeDerivedSignal,
  } from '../state/store';
  import { evalNamedFormula } from '../protocol/formula';
  import type { DerivedSignalDef } from '../protocol/datamodel';

  export let derived: DerivedSignalDef;
  export let frame: { id: number; isExtended: boolean };

  // The decoded values in scope (the sibling SIGNAL rows) — the variables this
  // expression can reference, plus a live preview of the current result.
  $: vars = Object.fromEntries(
    $messageSignals.filter((r) => r.kind === 'signal').map((r) => [r.name, r.value]),
  ) as Record<string, number>;
  $: names = Object.keys(vars);
  $: preview = derived.expr.trim() ? evalNamedFormula(derived.expr, vars, derived.unit) : null;

  const patch = (p: Partial<Omit<DerivedSignalDef, 'id'>>) =>
    updateDerivedSignal(frame.id, frame.isExtended, derived.id, p);
  const val = (e: Event) => (e.target as HTMLInputElement).value;

  const onName = (e: Event) => patch({ name: val(e) });
  const onUnit = (e: Event) => patch({ unit: val(e) });
  const onExpr = (e: Event) => patch({ expr: val(e) });
  const insert = (n: string) => patch({ expr: derived.expr + (derived.expr.trim() ? ' ' : '') + n });

  function remove() {
    removeDerivedSignal(frame.id, frame.isExtended, derived.id);
    selectedSignalId.set(null);
  }
</script>

<div class="drv">
  <div class="row">
    <input class="name" value={derived.name} on:input={onName} placeholder="derived name" />
    <input class="unit" value={derived.unit ?? ''} on:input={onUnit} placeholder="unit" />
    <button class="del" on:click={remove} title="delete this derived signal">✕</button>
  </div>

  <input
    class="expr mono"
    value={derived.expr}
    on:input={onExpr}
    placeholder="expression over signal names, e.g. engine_rpm / 1000"
    spellcheck="false"
  />

  {#if preview}
    {#if preview.ok}
      <div class="readout"><span class="lbl">=</span><span class="phys mono">{preview.display}</span></div>
    {:else}
      <div class="readout err mono">⚠ {preview.error ?? 'references an unknown signal'}</div>
    {/if}
  {/if}

  <div class="vars">
    <span class="dim">signals in scope:</span>
    {#each names as n}
      <button class="chip mono" on:click={() => insert(n)}>{n}</button>
    {/each}
    {#if names.length === 0}<span class="dim">none decoded yet</span>{/if}
  </div>
</div>

<style>
  .drv {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 7px 8px;
    background: var(--bg);
  }
  .row {
    display: flex;
    gap: 6px;
    margin-bottom: 6px;
  }
  .name {
    flex: 1;
    min-width: 60px;
  }
  .unit {
    width: 64px;
  }
  .del {
    flex: none;
    color: var(--warn);
  }
  .expr {
    width: 100%;
    box-sizing: border-box;
  }
  .readout {
    margin-top: 6px;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    background: var(--accent-dim);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .readout.err {
    background: transparent;
    color: var(--warn);
    font-size: 12px;
  }
  .readout .lbl {
    color: var(--accent);
    font-weight: 700;
  }
  .readout .phys {
    color: var(--text);
    font-weight: 600;
  }
  .vars {
    margin-top: 7px;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
    font-size: 11px;
  }
  .chip {
    font-size: 10px;
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    background: var(--bg-elev);
    color: var(--accent);
  }
  .chip:hover {
    border-color: var(--accent);
  }
  .dim {
    color: var(--text-dim);
  }
</style>
