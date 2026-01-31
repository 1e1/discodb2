<script lang="ts">
  // Canvas radial gauge + tiny sparkline for ONE watched value.
  // Drawn on Canvas (never DOM-per-point, §6). Reads the store's fixed-capacity
  // RingBuffer; uses a single reused scratch Float64Array — bounded memory.
  import type { RingBuffer } from "../lib/ring";
  import { GAUGE_RING_CAPACITY } from "../lib/store.svelte";

  interface Props {
    ring: RingBuffer;
    tick: number;
    label: string;
    unit: string;
    value: number; // current value (NaN if none)
    min?: number; // optional fixed scale; else auto from ring extent
    max?: number;
  }
  let { ring, tick, label, unit, value, min, max }: Props = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  const scratch = new Float64Array(GAUGE_RING_CAPACITY);
  let dpr = 1;
  let cssW = 0;
  let cssH = 0;

  function resize() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2); // cap DPR — iOS memory
    cssW = rect.width;
    cssH = rect.height;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
  }

  function draw() {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (canvas.width !== Math.round(cssW * dpr)) resize();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const n = ring.copyInto(scratch);
    const ext = ring.extent();
    const lo = min ?? (n > 0 ? ext.min : 0);
    let hi = max ?? (n > 0 ? ext.max : 1);
    if (hi <= lo) hi = lo + 1; // avoid /0

    // ── radial arc (270°, bottom gap) ──
    const cx = cssW / 2;
    const cy = cssH * 0.56;
    const r = Math.min(cssW, cssH) * 0.36;
    const a0 = Math.PI * 0.75; // start (lower-left)
    const a1 = Math.PI * 2.25; // end (lower-right)

    // track
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(8, r * 0.16);
    ctx.strokeStyle = "#2c2c2c";
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a1);
    ctx.stroke();

    // value arc
    const v = isFinite(value) ? value : lo;
    const frac = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
    const grad = ctx.createLinearGradient(0, 0, cssW, 0);
    grad.addColorStop(0, "#36d399");
    grad.addColorStop(1, "#fbbd23");
    ctx.strokeStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a0 + (a1 - a0) * frac);
    ctx.stroke();

    // ── sparkline (tiny rolling window) along the bottom ──
    if (n > 1) {
      const padX = cssW * 0.1;
      const w = cssW - padX * 2;
      const baseY = cssH * 0.92;
      const h = cssH * 0.22;
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(245,245,245,0.55)";
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = padX + (w * i) / (n - 1);
        const f = (scratch[i] - lo) / (hi - lo);
        const y = baseY - h * Math.max(0, Math.min(1, f));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  // Redraw each tick. (Svelte 5 effect.)
  $effect(() => {
    void tick;
    draw();
  });

  $effect(() => {
    resize();
    draw();
    const ro = new ResizeObserver(() => {
      resize();
      draw();
    });
    if (canvas) ro.observe(canvas);
    return () => ro.disconnect();
  });

  let display = $derived(isFinite(value) ? formatVal(value) : "—");
  function formatVal(v: number): string {
    const a = Math.abs(v);
    if (a >= 1000) return v.toFixed(0);
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    return v.toFixed(2);
  }
</script>

<div class="wrap">
  <canvas bind:this={canvas}></canvas>
  <div class="readout">
    <div class="val mono">{display}</div>
    <div class="unit muted">{unit}</div>
  </div>
  <div class="label muted">{label}</div>
</div>

<style>
  .wrap {
    position: relative;
    width: 100%;
    aspect-ratio: 1 / 0.82;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  .readout {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    transform: translateY(-4%);
  }
  .val {
    font-size: clamp(2.4rem, 14vw, 4.5rem);
    font-weight: 800;
    line-height: 1;
  }
  .unit {
    font-size: 1rem;
    margin-top: 4px;
  }
  .label {
    position: absolute;
    bottom: 2%;
    left: 0;
    right: 0;
    text-align: center;
    font-size: 0.95rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
</style>
