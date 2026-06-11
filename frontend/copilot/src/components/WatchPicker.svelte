<script lang="ts">
  // Add a watch: pick a CONFIRMED, named signal (§3.5) to pin as a value tile.
  // Raw frame/byte/bit watching is a COCKPIT concern, not the driver's phone, so
  // this sheet only offers confirmed signals — and only ever opens once a real
  // project carries some. Large targets, portrait bottom-sheet.
  import type { Project } from "../protocol/types";
  import { signalsFromProject, type Watch } from "../lib/watches";

  interface Props {
    project: Project;
    open: boolean;
    has: (key: string) => boolean;
    onadd: (w: Watch) => void;
    onclose: () => void;
  }
  let { project, open, has, onadd, onclose }: Props = $props();

  let sigs = $derived(signalsFromProject(project));
</script>

{#if open}
  <div
    class="scrim"
    role="button"
    tabindex="-1"
    aria-label="close"
    onclick={onclose}
    onkeydown={(e) => e.key === "Escape" && onclose()}
  ></div>
  <div class="sheet" role="dialog" aria-label="Add a confirmed signal">
    <div class="grip"></div>
    <h2 class="title">Confirmed signals</h2>

    <div class="list">
      {#each sigs as s (s.key)}
        <button class="item" disabled={has(s.key)} onclick={() => onadd(s)}>
          <span class="name">{s.label}</span>
          <span class="meta mono muted"
            >0x{s.signal.frameId.toString(16).toUpperCase()} · {s.signal
              .bitStart}+{s.signal.bitLength}{s.unit ? " · " + s.unit : ""}</span
          >
          <span class="add">{has(s.key) ? "✓" : "+"}</span>
        </button>
      {/each}
      {#if sigs.length === 0}
        <p class="empty muted">
          No confirmed signals yet — they appear once the Cockpit's Wizard
          identifies one.
        </p>
      {/if}
    </div>

    <button class="close" onclick={onclose}>Done</button>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 10;
  }
  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 11;
    background: var(--panel);
    border-radius: 22px 22px 0 0;
    padding: 8px 16px calc(16px + env(safe-area-inset-bottom));
    max-height: 82dvh;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 -12px 40px rgba(0, 0, 0, 0.5);
  }
  .grip {
    width: 44px;
    height: 5px;
    border-radius: 3px;
    background: var(--line);
    margin: 6px auto 2px;
  }
  .title {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    color: var(--muted);
    text-transform: uppercase;
  }
  .list {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .item {
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-areas: "name add" "meta add";
    align-items: center;
    text-align: left;
    padding: 12px 16px;
    min-height: 64px;
  }
  .item:disabled {
    opacity: 0.5;
  }
  .name {
    grid-area: name;
    font-size: 1.1rem;
    font-weight: 600;
  }
  .meta {
    grid-area: meta;
    font-size: 0.8rem;
  }
  .add {
    grid-area: add;
    font-size: 1.6rem;
    color: var(--accent);
  }
  .empty {
    padding: 24px 8px;
    text-align: center;
    line-height: 1.5;
  }
  .close {
    min-height: 52px;
  }
</style>
