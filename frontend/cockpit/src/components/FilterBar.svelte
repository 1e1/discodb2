<script lang="ts">
  import { filter, emptyFilter, filteredRows, frameRows, activeViewId, activeView } from '../state/store';
  import type { FrameFilter } from '../state/store';

  // Hex-friendly id inputs. Parse "0x..." or decimal; empty → null.
  function parseId(v: string): number | null {
    const s = v.trim();
    if (s === '') return null;
    const n = s.toLowerCase().startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10);
    return Number.isFinite(n) ? n : null;
  }
  function parseByte(v: string, fallback: number): number {
    const s = v.trim();
    if (s === '') return fallback;
    const n = s.toLowerCase().startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10);
    return Number.isFinite(n) ? n & 0xff : fallback;
  }
  const hexId = (n: number | null): string => (n === null ? '' : '0x' + n.toString(16).toUpperCase());
  const hexByte = (n: number): string => n.toString(16).toUpperCase().padStart(2, '0');

  let idMinStr = '';
  let idMaxStr = '';
  let byteIndexStr = '';
  let maskStr = 'FF';
  let valueStr = '00';
  let minRateStr = '';
  let maxRateStr = '';

  // The filter is now PER-TAB. When the active view changes, HYDRATE the local
  // inputs from that view's filter (and mark it hydrated) — otherwise the push
  // block below would write this tab's stale inputs over the newly-opened tab.
  let hydratedFor: string | null = null;
  $: if ($activeViewId !== hydratedFor) {
    const f = $activeView.filter;
    idMinStr = hexId(f.idMin);
    idMaxStr = hexId(f.idMax);
    byteIndexStr = f.byteIndex === null ? '' : String(f.byteIndex);
    maskStr = hexByte(f.byteMask);
    valueStr = hexByte(f.byteValue);
    minRateStr = f.minRate === null ? '' : String(f.minRate);
    maxRateStr = f.maxRate === null ? '' : String(f.maxRate);
    hydratedFor = $activeViewId;
  }

  // Push local input state into the active view's filter — but only once the
  // current view is hydrated, so a tab switch never clobbers the target tab.
  $: if (hydratedFor === $activeViewId) {
    filter.update((f: FrameFilter) => ({
      ...f,
      idMin: parseId(idMinStr),
      idMax: parseId(idMaxStr),
      byteIndex: byteIndexStr.trim() === '' ? null : Math.max(0, parseInt(byteIndexStr, 10) || 0),
      byteMask: parseByte(maskStr, 0xff),
      byteValue: parseByte(valueStr, 0x00),
      minRate: minRateStr.trim() === '' ? null : Number(minRateStr) || 0,
      maxRate: maxRateStr.trim() === '' ? null : Number(maxRateStr) || 0,
    }));
  }

  function reset() {
    const e = emptyFilter();
    filter.set(e);
    idMinStr = '';
    idMaxStr = '';
    byteIndexStr = '';
    maskStr = 'FF';
    valueStr = '00';
    minRateStr = '';
    maxRateStr = '';
  }

  /** Isolate one-shot / rare frames: clear min, cap max at a low fps. */
  function rareOnly() {
    minRateStr = '';
    maxRateStr = '2';
  }
</script>

<div class="filterbar">
  <span class="label">FILTER</span>

  <span class="group" title="inclusive arbitration-id range (hex 0x.. or dec)">
    <span class="dim">ID</span>
    <input class="mono id" bind:value={idMinStr} placeholder="min" spellcheck="false" />
    <span class="dim">–</span>
    <input class="mono id" bind:value={idMaxStr} placeholder="max" spellcheck="false" />
  </span>

  <span class="group" title="(data[byte] & mask) == value">
    <span class="dim">byte</span>
    <input class="mono tiny" bind:value={byteIndexStr} placeholder="#" />
    <span class="dim">&</span>
    <input class="mono tiny" bind:value={maskStr} placeholder="FF" />
    <span class="dim">==</span>
    <input class="mono tiny" bind:value={valueStr} placeholder="00" />
  </span>

  <span class="group" title="frame-rate band (fps): ≥min isolates frequent frames, ≤max isolates rare/one-shot frames">
    <span class="dim">rate</span>
    <input class="mono tiny" bind:value={minRateStr} placeholder="≥" title="min fps" />
    <span class="dim">–</span>
    <input class="mono tiny" bind:value={maxRateStr} placeholder="≤" title="max fps (low ⇒ rare/one-shot frames)" />
    <button class="rare" on:click={rareOnly} title="isolate one-shot / rare frames (≤2 fps)">rare</button>
  </span>

  <span class="group" title="case-insensitive substring of the frame name">
    <span class="dim">name</span>
    <input class="name" bind:value={$filter.nameSubstr} placeholder="substring" spellcheck="false" />
  </span>

  <label class="group chk">
    <input type="checkbox" bind:checked={$filter.hideErrors} />
    <span class="dim">hide errors</span>
  </label>
  <button on:click={reset}>Reset</button>

  <div class="spacer"></div>
  <span class="count dim">{$filteredRows.length}/{$frameRows.length} ids</span>
</div>

<style>
  .filterbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 5px 10px;
    background: var(--bg-elev2);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .label {
    font-size: 10px;
    letter-spacing: 0.1em;
    color: var(--text-dim);
  }
  .group {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .chk {
    cursor: pointer;
  }
  .id {
    width: 64px;
  }
  .tiny {
    width: 40px;
    text-align: center;
  }
  .rare {
    padding: 2px 7px;
    font-size: 11px;
  }
  .name {
    width: 120px;
  }
  .count {
    font-size: 11px;
  }
</style>
