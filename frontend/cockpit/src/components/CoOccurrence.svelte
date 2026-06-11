<script lang="ts">
  /**
   * CO-OCCURRENCE OF CHANGES — the cross-byte cousin of the bit-activity heatmap
   * and the byte histogram. For ONE target id (the currently `selected` id), it
   * answers "which BYTES change TOGETHER?":
   *
   *   • a small byte×byte HEATMAP (drawn on a SINGLE canvas, DESIGN §6) where cell
   *     (i, j) is the Jaccard co-change of bytes i and j — bright = they almost
   *     always move together, dim = independent. Two ADJACENT bright bytes ⇒ the
   *     two halves of one multi-byte value (a 16-bit field);
   *   • a short "LIKELY GROUPS" read-out: runs of adjacent high-co-change bytes
   *     (a likely multi-byte signal), and HUB bytes that co-change with many
   *     others (a likely multiplexor or — when the tagger flagged them — checksum).
   *
   * This complements the heatmap (WHICH bits move) and the histogram (HOW a byte's
   * value spreads): co-occurrence shows the COUPLING between bytes, which neither
   * of the others can see because they each look at one byte/bit in isolation.
   *
   * Bytes the Brick-0 tagger flags as counter/checksum get an amber tick on the
   * diagonal and an "(excluded)" note in any group/hub they appear in: a checksum
   * couples with everything and would otherwise masquerade as a rich hub.
   *
   * The id shown is the parent's `selected` id (chains from a heatmap row click).
   * When nothing is selected, we show the brief's hint instead.
   */
  import { onMount } from 'svelte';
  import type { CoOccurrenceScanResult } from '../hunt/coOccurrence';
  import type { Tag } from '@shared/analysis/tagger.ts';

  export let scan: CoOccurrenceScanResult | null = null;
  /** The id to render (the store's `selected` id); null = nothing selected. */
  export let targetId: number | null = null;

  // The per-id profile for the target id, looked up from the scan result.
  $: profile =
    scan && targetId !== null
      ? scan.coOccurrence.ids.find((p) => p.id === targetId) ?? null
      : null;
  $: tags = scan && targetId !== null ? scan.tagsById.get(targetId) ?? [] : [];
  $: excludedSet = profile ? new Set(profile.excludedBytes) : new Set<number>();

  let canvas: HTMLCanvasElement;
  let dpr = 1;
  // Hovered cell (byte i, byte j), for a tooltip; -1 = none.
  let hoverI = -1;
  let hoverJ = -1;
  let hoverText = '';

  const CELL = 22; // px per matrix cell
  const LABEL = 22; // gutter for the byte-index ruler

  $: n = profile ? profile.byteCount : 0;
  $: cssW = LABEL + n * CELL + 2;
  $: cssH = LABEL + n * CELL + 2;

  function idHex(id: number): string {
    return '0x' + id.toString(16).toUpperCase();
  }

  /** Map a Jaccard value 0..1 to a fill colour (dim slate → bright cyan), matching
   *  the bit-activity heatmap's ramp so the Scan views read consistently. */
  function coColor(a: number): string {
    if (a <= 0) return '#161a21';
    const t = Math.min(1, a);
    const r = Math.round(20 + t * 30);
    const g = Math.round(40 + t * 180);
    const b = Math.round(70 + t * 150);
    return `rgb(${r},${g},${b})`;
  }

  function draw() {
    if (!canvas || !profile) return;
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

    const J = profile.jaccard;

    // ── rulers: byte index along the top (columns) and left (rows) ──────────
    ctx.fillStyle = '#8b95a3';
    for (let k = 0; k < n; k++) {
      const c = LABEL + k * CELL + CELL / 2;
      ctx.textAlign = 'center';
      ctx.fillText(String(k), c, LABEL / 2); // top ruler (j)
      ctx.fillText(String(k), LABEL / 2, c); // left ruler (i)
    }

    // ── cells: Jaccard(i, j); the diagonal is the byte's own marker ─────────
    for (let i = 0; i < n; i++) {
      const y = LABEL + i * CELL;
      for (let j = 0; j < n; j++) {
        const x = LABEL + j * CELL;
        if (i === j) {
          // Diagonal: a self cell. Amber when the tagger flagged this byte
          // (counter/checksum), else a neutral slate, so the operator can read
          // the noise bytes off the diagonal at a glance.
          ctx.fillStyle = excludedSet.has(i) ? '#5a4a1e' : '#222834';
        } else {
          ctx.fillStyle = coColor(J[i][j]);
        }
        ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
      }
    }

    // ── hovered-cell outline ─────────────────────────────────────────────────
    if (hoverI >= 0 && hoverJ >= 0) {
      ctx.strokeStyle = '#7fb2ff';
      ctx.lineWidth = 1;
      ctx.strokeRect(LABEL + hoverJ * CELL + 0.5, LABEL + hoverI * CELL + 0.5, CELL - 1, CELL - 1);
    }
  }

  /** Translate a mouse position to a (row i, col j) cell, or (-1,-1) outside. */
  function cellAt(e: MouseEvent): [number, number] {
    if (!canvas) return [-1, -1];
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left - LABEL;
    const y = e.clientY - rect.top - LABEL;
    if (x < 0 || y < 0) return [-1, -1];
    const j = Math.floor(x / CELL);
    const i = Math.floor(y / CELL);
    if (i < 0 || i >= n || j < 0 || j >= n) return [-1, -1];
    return [i, j];
  }

  function onMove(e: MouseEvent) {
    const [i, j] = cellAt(e);
    if (i !== hoverI || j !== hoverJ) {
      hoverI = i;
      hoverJ = j;
      if (profile && i >= 0 && j >= 0) {
        if (i === j) {
          hoverText = `B${i}${excludedSet.has(i) ? ' — flagged counter/checksum' : ''}`;
        } else {
          const jac = profile.jaccard[i][j];
          const cij = profile.conditional[i][j];
          const cji = profile.conditional[j][i];
          hoverText =
            `B${i}↔B${j} · Jaccard ${jac.toFixed(2)} · ` +
            `P(B${j}|B${i}) ${cij.toFixed(2)} · P(B${i}|B${j}) ${cji.toFixed(2)}`;
        }
      } else {
        hoverText = '';
      }
      draw();
    }
  }

  function onLeave() {
    if (hoverI !== -1 || hoverJ !== -1) {
      hoverI = -1;
      hoverJ = -1;
      hoverText = '';
      draw();
    }
  }

  function tagFor(byteIndex: number): Tag | undefined {
    return tags.find((t) => t.byteIndex === byteIndex);
  }

  onMount(() => {
    dpr = window.devicePixelRatio || 1;
    draw();
  });

  // Redraw whenever the profile (target id / scan) changes.
  $: if (canvas && profile) draw();
</script>

<div class="cowrap">
  {#if targetId === null}
    <div class="dim small empty">
      select an id (e.g. click a row in the bit-activity heatmap)
    </div>
  {:else if !profile}
    <div class="dim small empty">
      {idHex(targetId)} — no frames for this id in the scanned window
    </div>
  {:else if profile.byteCount < 2}
    <div class="dim small empty">
      {idHex(profile.id)} — only {profile.byteCount} byte; co-occurrence needs ≥2 bytes
    </div>
  {:else}
    <div class="head">
      <span class="mono id">{idHex(profile.id)}</span>
      <span class="dim small">{profile.frames} frames · {profile.pairs} pairs · DLC {profile.maxByte}</span>
    </div>

    <div class="body">
      <div class="matrix">
        <canvas bind:this={canvas} class="co" on:mousemove={onMove} on:mouseleave={onLeave}></canvas>
        <div class="hovertip dim small mono">{hoverText || ' '}</div>
      </div>

      <!-- LIKELY GROUPS + HUBS read-out -->
      <div class="readout">
        <div class="ro-section">
          <div class="ro-title">Likely groups</div>
          {#if profile.groups.length === 0}
            <div class="dim small">no adjacent bytes move tightly together</div>
          {:else}
            {#each profile.groups as g}
              <div class="ro-row" class:excl={g.excluded}>
                <span class="mono span">B{g.startByte}–B{g.endByte}</span>
                <span class="dim small">{g.length}-byte value · Jaccard ≥ {g.minJaccard.toFixed(2)}</span>
                {#if g.excluded}<span class="badge">excluded</span>{/if}
              </div>
            {/each}
          {/if}
        </div>

        <div class="ro-section">
          <div class="ro-title">Hubs <span class="dim small">(mux / checksum)</span></div>
          {#if profile.hubs.length === 0}
            <div class="dim small">no byte drives many others</div>
          {:else}
            {#each profile.hubs as h}
              <div class="ro-row" class:excl={h.excluded}>
                <span class="mono span">B{h.byteIndex}</span>
                <span class="dim small">
                  driven by {h.degree} byte{h.degree === 1 ? '' : 's'} (B{h.drivenBy.join(', B')})
                </span>
                {#if h.excluded}
                  {@const t = tagFor(h.byteIndex)}
                  <span class="badge">{t && t.kind === 'checksum' ? 'checksum' : 'excluded'}</span>
                {/if}
              </div>
            {/each}
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .cowrap {
    overflow: auto;
    max-height: 60vh;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 6px;
  }
  .id {
    color: var(--accent);
    font-weight: 600;
  }
  .body {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    align-items: flex-start;
  }
  .co {
    display: block;
  }
  .hovertip {
    height: 16px;
    padding: 2px 0;
    font-size: 10px;
    white-space: nowrap;
  }
  .readout {
    min-width: 220px;
    flex: 1;
  }
  .ro-section {
    margin-bottom: 10px;
  }
  .ro-title {
    font-size: 11px;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .ro-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 0;
  }
  .ro-row.excl {
    opacity: 0.7;
  }
  .span {
    color: var(--accent);
    font-size: 11px;
    min-width: 56px;
  }
  .badge {
    font-size: 9px;
    color: #e0a83c;
    border: 1px solid #5a4a1e;
    border-radius: 3px;
    padding: 0 4px;
  }
  .small {
    font-size: 11px;
  }
  .empty {
    padding: 16px 8px;
    text-align: center;
  }
</style>
