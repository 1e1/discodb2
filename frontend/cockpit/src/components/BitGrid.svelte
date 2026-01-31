<script lang="ts">
  /**
   * Per-BIT change grid, rendered on a single Canvas (DESIGN §6: never one DOM
   * node per point). Each cell is one bit of the payload; it lights up when the
   * bit is currently 1 and FLASHES (bright outline) when it changed recently
   * (the worker's decaying changedBits mask drives the flash).
   *
   * Layout: rows = bytes (0..dlc-1), columns = bits 7..0 within the byte (MSB
   * left, matching how humans read a hex byte).
   */
  import { onMount } from 'svelte';

  export let data: Uint8Array = new Uint8Array(0);
  export let changedBits: Uint8Array = new Uint8Array(0);
  export let dlc = 0;

  let canvas: HTMLCanvasElement;
  let dpr = 1;

  const CELL = 22;
  const GAP = 2;
  const LABEL_W = 28; // byte index gutter
  const HEADER_H = 16; // bit-number header

  $: cols = 8;
  $: rows = Math.max(dlc, 0);
  $: cssW = LABEL_W + cols * CELL + (cols - 1) * GAP + 4;
  $: cssH = HEADER_H + rows * CELL + Math.max(rows - 1, 0) * GAP + 4;

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
    ctx.font = '10px var(--mono, monospace)';
    ctx.textBaseline = 'middle';

    // bit-number header (7..0 per byte position)
    ctx.fillStyle = '#8b95a3';
    for (let c = 0; c < cols; c++) {
      const bitLabel = 7 - c;
      const x = LABEL_W + c * (CELL + GAP) + CELL / 2;
      ctx.textAlign = 'center';
      ctx.fillText(String(bitLabel), x, HEADER_H / 2);
    }

    for (let r = 0; r < rows; r++) {
      const byteVal = r < data.length ? data[r] : 0;
      // byte index gutter
      ctx.fillStyle = '#8b95a3';
      ctx.textAlign = 'right';
      const yMid = HEADER_H + r * (CELL + GAP) + CELL / 2;
      ctx.fillText(String(r), LABEL_W - 6, yMid);

      for (let c = 0; c < cols; c++) {
        const bitInByte = 7 - c; // MSB on the left
        const globalBit = r * 8 + bitInByte;
        const on = (byteVal >> bitInByte) & 1;
        const changed = globalBit < changedBits.length && changedBits[globalBit] === 1;

        const x = LABEL_W + c * (CELL + GAP);
        const y = HEADER_H + r * (CELL + GAP);

        // cell fill: bright if bit is 1, dim if 0
        ctx.fillStyle = on ? '#2f6db5' : '#1b1f27';
        ctx.fillRect(x, y, CELL, CELL);

        // flash: bright outline + glow when recently changed
        if (changed) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#ffd24a';
          ctx.strokeRect(x + 1, y + 1, CELL - 2, CELL - 2);
        } else {
          ctx.lineWidth = 1;
          ctx.strokeStyle = '#2a313c';
          ctx.strokeRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1);
        }

        // bit value glyph
        ctx.fillStyle = on ? '#eaf2fb' : '#5b6675';
        ctx.textAlign = 'center';
        ctx.fillText(on ? '1' : '0', x + CELL / 2, y + CELL / 2);
      }
    }
  }

  onMount(() => {
    dpr = window.devicePixelRatio || 1;
    draw();
  });

  // redraw whenever inputs change
  $: if (canvas && (data || changedBits || dlc)) draw();
</script>

<canvas bind:this={canvas} class="bitgrid"></canvas>

<style>
  .bitgrid {
    display: block;
    image-rendering: pixelated;
  }
</style>
