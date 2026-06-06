<script lang="ts">
  /**
   * ONE byte's 256-bin value histogram, drawn on a single small canvas (DESIGN
   * §6: never one DOM node per point). The x axis is the byte VALUE 0..255; each
   * column's height is that value's occurrence count, normalized to the tallest
   * bin so the shape is always readable regardless of frame count.
   *
   * Shape reading: a few isolated tall spikes ⇒ enum/flag; a broad hump or a
   * smear across the range ⇒ analog. A thin tick marks the occupied [min..max]
   * span along the baseline so a narrow analog range is still visible.
   *
   * Hovering reads out the value + count under the cursor (a light affordance;
   * the parent owns the per-byte stats line).
   */
  import { onMount } from 'svelte';
  import { BYTE_VALUE_BINS } from '@shared/analysis/byte-histogram.ts';

  /** Length-256 occurrence counts (counts[v] = how often value v appeared). */
  export let counts: number[] = [];
  /** Occupied value range for the baseline span tick (−1 when no samples). */
  export let min = -1;
  export let max = -1;

  let canvas: HTMLCanvasElement;
  let dpr = 1;
  let hover = '';

  // 256 value bins at 1px each = a compact 256px-wide sparkline.
  const W = BYTE_VALUE_BINS; // 1 px per value bin
  const H = 40; // bar area height
  const BASE = 4; // baseline strip for the min..max span tick

  $: peak = counts.reduce((m, c) => (c > m ? c : m), 0);

  function draw() {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cssW = W;
    const cssH = H + BASE;
    canvas.width = Math.ceil(cssW * dpr);
    canvas.height = Math.ceil(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // Backdrop for the bar area so empty histograms still read as a panel.
    ctx.fillStyle = '#0d0f14';
    ctx.fillRect(0, 0, cssW, H);

    if (peak > 0) {
      // Columns: height ∝ count / peak. Cyan to echo the heatmap's "active" hue.
      ctx.fillStyle = '#3cc7e0';
      for (let v = 0; v < BYTE_VALUE_BINS; v++) {
        const c = counts[v] ?? 0;
        if (c <= 0) continue;
        const h = Math.max(1, Math.round((c / peak) * (H - 2)));
        ctx.fillRect(v, H - h, 1, h);
      }
    }

    // Baseline span tick: the occupied [min..max] range (amber), so a narrow
    // analog spread or a 2-value flag's reach is visible at a glance.
    if (min >= 0 && max >= 0) {
      ctx.fillStyle = '#e0a83c';
      ctx.fillRect(min, H + 1, Math.max(1, max - min + 1), 2);
    }
  }

  function onMove(e: MouseEvent) {
    if (!canvas || peak <= 0) {
      hover = '';
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const v = Math.max(0, Math.min(255, Math.round(e.clientX - rect.left)));
    const c = counts[v] ?? 0;
    hover = c > 0 ? `${v} (0x${v.toString(16).toUpperCase().padStart(2, '0')}) ×${c}` : '';
  }

  function onLeave() {
    hover = '';
  }

  onMount(() => {
    dpr = window.devicePixelRatio || 1;
    draw();
  });

  // Redraw whenever the inputs change.
  $: if (canvas && counts) draw();
</script>

<div class="bar">
  <canvas bind:this={canvas} on:mousemove={onMove} on:mouseleave={onLeave}></canvas>
  <div class="tip dim mono">{hover || ' '}</div>
</div>

<style>
  .bar canvas {
    display: block;
  }
  .tip {
    height: 12px;
    font-size: 9px;
    white-space: nowrap;
    overflow: hidden;
  }
</style>
