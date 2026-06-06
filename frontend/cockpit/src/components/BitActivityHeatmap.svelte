<script lang="ts">
  /**
   * BIT-ACTIVITY HEATMAP — the AGGREGATE, time-summarized cousin of the per-frame
   * live BitGrid (BitGrid.svelte). Rows = ids, columns = bit index (0..maxBits-1,
   * up to 8 bytes = 64 bits). Each cell's BRIGHTNESS = that bit's toggle frequency
   * over the window (transitions / comparable-pairs, 0..1): constant bits dim,
   * frequently-toggling bits bright.
   *
   * Rendered on a SINGLE canvas (DESIGN §6: never one DOM node per point), so it
   * stays smooth for ~100-200 ids × 64 bits. Columns flagged by the Brick-0
   * tagger as counter/checksum get a thin amber underline so the operator can
   * tell noise bits (a free-running counter is very "active" but meaningless)
   * from real ones.
   *
   * Bit numbering matches the analysis stack: global bit = byteIndex*8 + bitInByte
   * (bit0 = the byte's LSB). To match the live BitGrid's human reading we draw the
   * MSB on the LEFT within each byte, i.e. column = byteIndex*8 + (7 - bitInByte).
   *
   * Clicking a row selects that id via the store (the parent wires the handler),
   * so the operator can jump straight to the Inspector.
   */
  import { onMount } from 'svelte';
  import type { ScanResult } from '../hunt/bitActivity';

  export let scan: ScanResult | null = null;
  /** Called with (id, isExtended) when the operator clicks a row. */
  export let onPickId: (id: number, isExtended: boolean) => void = () => {};
  /** isExtended lookup for an id (the scan result keys on numeric id only). */
  export let isExtendedFor: (id: number) => boolean = () => false;

  let canvas: HTMLCanvasElement;
  let dpr = 1;
  // Hovered row index (into the sorted ids), for a subtle highlight + tooltip.
  let hoverRow = -1;
  let hoverText = '';

  const ROW_H = 14; // px per id row
  const LABEL_W = 64; // id gutter (e.g. "0x5A0")
  const HEADER_H = 26; // byte ruler + bit numbers
  const BYTE_GAP = 3; // visual gap between byte groups

  $: ids = scan ? scan.activity.ids : [];
  $: maxBits = scan ? scan.activity.maxBits : 64;
  $: cols = maxBits;
  // A cell is sized so 64 columns + 7 byte-gaps fit a comfortable width.
  $: cellW = 9;
  $: gridW = cols * cellW + (Math.ceil(cols / 8) - 1) * BYTE_GAP;
  $: cssW = LABEL_W + gridW + 4;
  $: cssH = HEADER_H + ids.length * ROW_H + 4;

  /** X pixel of column c's left edge (byte groups separated by BYTE_GAP). */
  function colX(c: number): number {
    return LABEL_W + c * cellW + Math.floor(c / 8) * BYTE_GAP;
  }

  /** Which byte index a column belongs to (for tagger annotation lookup). */
  function colByte(c: number): number {
    return c >> 3;
  }

  /** Map an activity value 0..1 to a fill colour (dim slate → bright cyan). */
  function activityColor(a: number): string {
    if (a <= 0) return '#161a21'; // constant / never-moved: very dim
    // Interpolate from a dim blue to a bright cyan as activity rises.
    const t = Math.min(1, a);
    const r = Math.round(20 + t * 30);
    const g = Math.round(40 + t * 180);
    const b = Math.round(70 + t * 150);
    return `rgb(${r},${g},${b})`;
  }

  function idHex(id: number): string {
    return '0x' + id.toString(16).toUpperCase();
  }

  function draw() {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = Math.ceil(cssW * dpr);
    canvas.height = Math.ceil(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.font = '9px var(--mono, monospace)';
    ctx.textBaseline = 'middle';

    // ── header: byte index ruler + per-bit numbers (7..0 within each byte) ──
    ctx.fillStyle = '#8b95a3';
    const byteCount = Math.ceil(cols / 8);
    for (let by = 0; by < byteCount; by++) {
      const x0 = colX(by * 8);
      ctx.textAlign = 'left';
      ctx.fillText(`B${by}`, x0, 7);
    }
    for (let c = 0; c < cols; c++) {
      const bitInByte = 7 - (c % 8); // MSB on the left, matching BitGrid
      const x = colX(c) + cellW / 2;
      ctx.textAlign = 'center';
      ctx.fillText(String(bitInByte), x, HEADER_H - 8);
    }

    // ── rows: one id each, cells coloured by toggle frequency ───────────────
    for (let row = 0; row < ids.length; row++) {
      const p = ids[row];
      const y = HEADER_H + row * ROW_H;

      // hovered-row backdrop
      if (row === hoverRow) {
        ctx.fillStyle = '#1f2530';
        ctx.fillRect(0, y, cssW, ROW_H);
      }

      // id gutter
      ctx.fillStyle = '#7fb2ff';
      ctx.textAlign = 'right';
      ctx.fillText(idHex(p.id), LABEL_W - 6, y + ROW_H / 2);

      const tags = scan?.tagsById.get(p.id) ?? [];
      const taggedBytes = new Set(tags.map((t) => t.byteIndex));

      for (let c = 0; c < cols; c++) {
        // Column c shows byte = c>>3, MSB-left bit = 7 - (c%8); the analyzer's
        // global bit index is byteIndex*8 + bitInByte.
        const bitInByte = 7 - (c % 8);
        const globalBit = colByte(c) * 8 + bitInByte;
        const x = colX(c);

        // Greyed-out if this id never carries this byte (short DLC for this id).
        const present = colByte(c) < p.maxByte;
        const a = p.activity[globalBit] ?? 0;
        ctx.fillStyle = present ? activityColor(a) : '#0d0f14';
        ctx.fillRect(x, y + 1, cellW - 1, ROW_H - 2);
      }

      // counter/checksum annotation: an amber underline under each tagged byte.
      if (taggedBytes.size) {
        ctx.fillStyle = '#e0a83c';
        for (const bi of taggedBytes) {
          const c0 = bi * 8; // first column of this byte (MSB-left bit7)
          if (c0 >= cols) continue;
          const xs = colX(c0);
          const xe = colX(Math.min(bi * 8 + 7, cols - 1)) + cellW - 1;
          ctx.fillRect(xs, y + ROW_H - 2, xe - xs, 1.5);
        }
      }
    }
  }

  /** Translate a mouse position to a row index (or -1 outside the grid). */
  function rowAt(clientY: number): number {
    if (!canvas) return -1;
    const rect = canvas.getBoundingClientRect();
    const y = clientY - rect.top - HEADER_H;
    if (y < 0) return -1;
    const row = Math.floor(y / ROW_H);
    return row >= 0 && row < ids.length ? row : -1;
  }

  function onMove(e: MouseEvent) {
    const row = rowAt(e.clientY);
    if (row !== hoverRow) {
      hoverRow = row;
      if (row >= 0) {
        const p = ids[row];
        const tags = scan?.tagsById.get(p.id) ?? [];
        const note = tags.length
          ? ` · ${tags.map((t) => `B${t.byteIndex} ${t.kind}`).join(', ')}`
          : '';
        hoverText = `${idHex(p.id)} · ${p.frames} frames${note} — click to inspect`;
      } else {
        hoverText = '';
      }
      draw();
    }
  }

  function onLeave() {
    if (hoverRow !== -1) {
      hoverRow = -1;
      hoverText = '';
      draw();
    }
  }

  function onClick(e: MouseEvent) {
    const row = rowAt(e.clientY);
    if (row < 0) return;
    const id = ids[row].id;
    onPickId(id, isExtendedFor(id));
  }

  onMount(() => {
    dpr = window.devicePixelRatio || 1;
    draw();
  });

  // Redraw whenever the scan result changes.
  $: if (canvas && scan) draw();
</script>

<div class="heatwrap">
  {#if ids.length === 0}
    <div class="dim small empty">no ids with enough frames in this window yet</div>
  {:else}
    <canvas
      bind:this={canvas}
      class="heatmap"
      on:mousemove={onMove}
      on:mouseleave={onLeave}
      on:click={onClick}
    ></canvas>
    <div class="hovertip dim small">{hoverText || ' '}</div>
  {/if}
</div>

<style>
  .heatwrap {
    overflow: auto;
    max-height: 60vh;
  }
  .heatmap {
    display: block;
    cursor: pointer;
  }
  .small {
    font-size: 11px;
  }
  .empty {
    padding: 16px 8px;
    text-align: center;
  }
  .hovertip {
    height: 16px;
    padding: 2px 4px;
    font-size: 11px;
    white-space: nowrap;
  }
</style>
