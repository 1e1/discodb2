<script lang="ts">
  /**
   * Canvas line chart for a decoded signal / byte value over the analysis
   * window (DESIGN §6: charts on Canvas, never DOM-per-point). Takes a plain
   * numeric series + matching relative-time array; draws axes-light.
   */
  import { onMount } from 'svelte';

  export let values: number[] = [];
  export let times: number[] = []; // relative seconds, same length as values
  export let width = 360;
  export let height = 90;
  export let color = '#4fa3ff';

  let canvas: HTMLCanvasElement;
  let dpr = 1;

  function draw() {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = Math.ceil(width * dpr);
    canvas.height = Math.ceil(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // frame
    ctx.strokeStyle = '#2a313c';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, width - 1, height - 1);

    if (values.length === 0) {
      ctx.fillStyle = '#5b6675';
      ctx.font = '11px var(--mono, monospace)';
      ctx.textAlign = 'center';
      ctx.fillText('no data in window', width / 2, height / 2);
      return;
    }

    let vMin = Infinity;
    let vMax = -Infinity;
    for (const v of values) {
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
    if (vMin === vMax) {
      vMin -= 1;
      vMax += 1;
    }
    const tMin = times.length ? times[0] : 0;
    const tMax = times.length ? times[times.length - 1] : values.length - 1;
    const tSpan = tMax - tMin || 1;
    const vSpan = vMax - vMin;

    const pad = 4;
    const xOf = (i: number) => {
      const t = times.length ? times[i] : i;
      return pad + ((t - tMin) / tSpan) * (width - 2 * pad);
    };
    const yOf = (v: number) => height - pad - ((v - vMin) / vSpan) * (height - 2 * pad);

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < values.length; i++) {
      const x = xOf(i);
      const y = yOf(values[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // min/max labels
    ctx.fillStyle = '#8b95a3';
    ctx.font = '10px var(--mono, monospace)';
    ctx.textAlign = 'left';
    ctx.fillText(String(round(vMax)), 4, 10);
    ctx.fillText(String(round(vMin)), 4, height - 5);
  }

  function round(v: number): number {
    return Math.round(v * 1000) / 1000;
  }

  onMount(() => {
    dpr = window.devicePixelRatio || 1;
    draw();
  });

  $: if (canvas && (values || times)) draw();
</script>

<canvas bind:this={canvas} class="spark"></canvas>

<style>
  .spark {
    display: block;
  }
</style>
