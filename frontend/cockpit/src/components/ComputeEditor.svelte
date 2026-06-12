<script lang="ts">
  /**
   * Formula editor — shared by the "Custom" (per-frame) and "Tab" (per-tab)
   * right-pane tabs. You write a small math expression over the frame's raw
   * bytes (A..H = data[0..7], plus helpers — see protocol/formula.ts); the
   * result shows live in the matching table column.
   *
   *   mode="custom" → edits the SELECTED frame's formula  → "Custom" column
   *   mode="tab"    → edits the ACTIVE tab's formula       → "Tab" column
   *
   * Click a preset to fill the expression. The preview evaluates against a live
   * sample frame so you see the number before committing.
   */
  import {
    selected,
    project,
    activeView,
    frameRows,
    filteredRows,
    setFrameFormula,
    setViewFormula,
  } from '../state/store';
  import { frameKey } from '../protocol/datamodel';
  import {
    evalFormula,
    checkFormula,
    FORMULA_PRESETS,
    FORMULA_HELP,
    type FormulaPreset,
  } from '../protocol/formula';
  import type { FrameRow } from '../worker/workerApi';

  export let mode: 'custom' | 'tab';

  let expr = '';
  let unit = '';

  function idHex(id: number, isExtended: boolean): string {
    return '0x' + id.toString(16).toUpperCase().padStart(isExtended ? 8 : 3, '0');
  }

  // ── target: which formula are we editing? ───────────────────────────────────
  // custom → keyed by the selected frame; tab → the active view's id.
  $: target =
    mode === 'custom'
      ? $selected
        ? frameKey($selected.id, $selected.isExtended)
        : null
      : $activeView.id;

  $: curDef =
    mode === 'custom'
      ? target
        ? ($project.frameFormulas ?? {})[target]
        : undefined
      : $activeView.formula;

  // Hydrate inputs when the target changes (selecting another frame / tab).
  let hydratedFor: string | null = null;
  $: if (target !== hydratedFor) {
    expr = curDef?.expr ?? '';
    unit = curDef?.unit ?? '';
    hydratedFor = target;
  }

  // Write inputs through to the store, once the current target is hydrated.
  $: if (target !== null && hydratedFor === target) {
    writeFormula(expr, unit);
  }

  function writeFormula(e: string, u: string) {
    const def = e.trim() ? { expr: e, unit: u.trim() || undefined } : null;
    if (mode === 'custom') {
      if ($selected) setFrameFormula($selected.id, $selected.isExtended, def);
    } else {
      setViewFormula($activeView.id, def);
    }
  }

  function clearFormula() {
    expr = '';
    unit = '';
  }

  function applyPreset(p: FormulaPreset) {
    expr = p.expr;
    unit = p.unit ?? '';
  }

  // ── live preview against a sample frame ─────────────────────────────────────
  function rowFor(sel: { id: number; isExtended: boolean } | null): FrameRow | undefined {
    if (!sel) return undefined;
    return $frameRows.find((r) => r.id === sel.id && r.isExtended === sel.isExtended);
  }
  // custom → the selected frame; tab → selected if shown here, else first row.
  $: sampleRow =
    mode === 'custom' ? rowFor($selected) : rowFor($selected) ?? $filteredRows[0];
  $: sampleData = sampleRow?.data ?? new Uint8Array();
  $: parseErr = checkFormula(expr);
  $: preview = expr.trim() && sampleRow ? evalFormula(expr, sampleData, unit) : null;

  // Presets grouped for display.
  $: groups = (() => {
    const m = new Map<string, FormulaPreset[]>();
    for (const p of FORMULA_PRESETS) (m.get(p.group) ?? m.set(p.group, []).get(p.group)!).push(p);
    return [...m.entries()];
  })();

  $: scopeLabel =
    mode === 'custom'
      ? $selected
        ? `frame ${idHex($selected.id, $selected.isExtended)}`
        : null
      : `tab "${$activeView.name}"`;
</script>

<div class="compute">
  {#if mode === 'custom' && !$selected}
    <p class="dim hint">Select a frame in the list to give it a formula.</p>
  {:else}
    <div class="scope">
      <span class="label">{mode === 'custom' ? 'CUSTOM' : 'TAB'}</span>
      <span class="dim">{scopeLabel}</span>
      {#if expr.trim()}<button class="clear" on:click={clearFormula} title="clear the formula">clear</button>{/if}
    </div>

    <textarea
      class="expr mono"
      bind:value={expr}
      spellcheck="false"
      rows="2"
      placeholder="e.g. (256*A + B)/4"
    ></textarea>

    <div class="row">
      <label class="unit">
        <span class="dim">unit</span>
        <input bind:value={unit} placeholder="rpm, °C…" spellcheck="false" />
      </label>
      <div class="result">
        {#if parseErr}
          <span class="err" title={parseErr}>⚠ {parseErr}</span>
        {:else if !sampleRow && expr.trim()}
          <span class="dim">no sample frame (start a source)</span>
        {:else if preview && preview.ok}
          <span class="dim">=</span> <span class="val mono">{preview.display}</span>
          {#if sampleRow}<span class="dim small">on {idHex(sampleRow.id, sampleRow.isExtended)}</span>{/if}
        {:else if preview && preview.error}
          <span class="err" title={preview.error}>⚠ {preview.error}</span>
        {/if}
      </div>
    </div>

    <div class="presets">
      {#each groups as [group, items] (group)}
        <div class="grp">{group}</div>
        <div class="chips">
          {#each items as p (p.label)}
            <button
              class="chip"
              title={`${p.expr}${p.unit ? ' → ' + p.unit : ''}${p.hint ? ' · ' + p.hint : ''}`}
              on:click={() => applyPreset(p)}
            >{p.label}</button>
          {/each}
        </div>
      {/each}
    </div>

    <div class="cheats dim">
      <div><strong>Variables</strong> · {FORMULA_HELP.vars}</div>
      <div><strong>Functions</strong> · {FORMULA_HELP.fns}</div>
    </div>
  {/if}
</div>

<style>
  .compute {
    height: 100%;
    overflow: auto;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .hint {
    font-size: 12px;
  }
  .scope {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .label {
    font-size: 10px;
    letter-spacing: 0.1em;
    color: var(--text-dim);
  }
  .clear {
    margin-left: auto;
    font-size: 11px;
    padding: 2px 8px;
  }
  .expr {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    font-size: 13px;
    padding: 6px 8px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .unit {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
  }
  .unit input {
    width: 80px;
  }
  .result {
    flex: 1;
    min-width: 0;
    font-size: 13px;
  }
  .result .val {
    color: var(--accent);
    font-weight: 600;
  }
  .small {
    font-size: 11px;
    margin-left: 4px;
  }
  .err {
    color: var(--warn);
    font-size: 12px;
  }
  .presets {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .grp {
    font-size: 10px;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    margin-top: 4px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .chip {
    font-size: 11px;
    padding: 3px 8px;
    border-radius: var(--radius-lg);
  }
  .cheats {
    font-size: 11px;
    line-height: 1.5;
    border-top: 1px solid var(--border);
    padding-top: 8px;
  }
  .cheats strong {
    color: var(--text);
  }
</style>
