<script lang="ts">
  // Flashing-bit indicator. Renders DLC bytes as an 8×N grid of bits; a bit
  // pulses briefly when it flips. Bounded memory: holds only the previous
  // 8-byte snapshot + per-bit "last-flip" timestamps (64 numbers).
  import type { LatestValue } from "../lib/watches";

  interface Props {
    latest: LatestValue;
    tick: number; // re-render trigger from the store
  }
  let { latest, tick }: Props = $props();

  const FLASH_MS = 600;

  // Previous bytes + per-bit last-flip time (ms). Plain arrays, fixed size.
  let prev = new Uint8Array(8);
  const flipAt = new Float64Array(64).fill(-Infinity);
  let inited = false;

  // Derived grid: for each used byte/bit, value + whether currently flashing.
  let rows = $derived.by(() => {
    // touch tick so this recomputes each frame
    void tick;
    const now = performance.now();
    const dlc = latest.dlc;
    const bytes = latest.bytes;

    if (inited) {
      for (let i = 0; i < dlc; i++) {
        const changed = bytes[i] ^ prev[i];
        if (changed) {
          for (let b = 0; b < 8; b++) {
            if (changed & (1 << b)) flipAt[i * 8 + b] = now;
          }
        }
      }
    }
    prev.set(bytes);
    inited = true;

    const out: {
      byte: number;
      hex: string;
      bits: { on: boolean; flash: boolean }[];
    }[] = [];
    for (let i = 0; i < dlc; i++) {
      const bits: { on: boolean; flash: boolean }[] = [];
      // MSB→LSB left-to-right reads naturally.
      for (let b = 7; b >= 0; b--) {
        const on = ((bytes[i] >> b) & 1) === 1;
        const flash = now - flipAt[i * 8 + b] < FLASH_MS;
        bits.push({ on, flash });
      }
      out.push({
        byte: i,
        hex: bytes[i].toString(16).toUpperCase().padStart(2, "0"),
        bits,
      });
    }
    return out;
  });
</script>

<div class="grid" role="img" aria-label="bit activity">
  {#each rows as row (row.byte)}
    <div class="row">
      <span class="idx mono muted">B{row.byte}</span>
      <div class="bits">
        {#each row.bits as bit, j (j)}
          <span class="bit" class:on={bit.on} class:flash={bit.flash}></span>
        {/each}
      </div>
      <span class="hex mono">{row.hex}</span>
    </div>
  {/each}
  {#if rows.length === 0}
    <span class="muted">—</span>
  {/if}
</div>

<style>
  .grid {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .idx {
    width: 2.2em;
    font-size: 0.8rem;
  }
  .hex {
    width: 1.6em;
    text-align: right;
    font-size: 0.95rem;
  }
  .bits {
    display: flex;
    gap: 4px;
    flex: 1;
  }
  .bit {
    flex: 1;
    aspect-ratio: 1 / 1;
    max-width: 22px;
    border-radius: 4px;
    background: var(--bit-off);
    transition: background 120ms linear;
  }
  .bit.on {
    background: var(--bit-on);
  }
  /* A flip pulses to white briefly regardless of on/off, so 1→0 also flashes. */
  .bit.flash {
    background: #ffffff;
    box-shadow: 0 0 8px rgba(255, 255, 255, 0.8);
    transition: none;
  }
  /* A2: prefers-reduced-motion — drop the white flash pulse entirely. Bit flips
     still register via the steady on/off colour (and the per-byte hex), so the
     information is preserved; only the flashing/strobe is removed. */
  @media (prefers-reduced-motion: reduce) {
    .bit {
      transition: none;
    }
    .bit.flash {
      background: var(--bit-off);
      box-shadow: none;
    }
    .bit.flash.on {
      background: var(--bit-on);
    }
  }
</style>
