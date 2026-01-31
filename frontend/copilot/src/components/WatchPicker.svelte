<script lang="ts">
  // Add a watch: by NAMED signal (from the Project, §3.5), by RAW frame id, or
  // by RAW byte of a frame. Large targets, portrait bottom-sheet.
  import type { Project } from "../protocol/types";
  import {
    makeByteWatch,
    makeFrameWatch,
    signalsFromProject,
    type Watch,
  } from "../lib/watches";

  interface Props {
    project: Project;
    open: boolean;
    has: (key: string) => boolean;
    onadd: (w: Watch) => void;
    onclose: () => void;
  }
  let { project, open, has, onadd, onclose }: Props = $props();

  type Mode = "signal" | "frame" | "byte";
  let mode = $state<Mode>("signal");

  let sigs = $derived(signalsFromProject(project));

  // Raw inputs.
  let rawIdHex = $state("100");
  let rawByte = $state(0);
  let rawExtended = $state(false);

  function parseId(): number | null {
    const t = rawIdHex.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]+$/.test(t)) return null;
    const n = parseInt(t, 16);
    if (!isFinite(n) || n < 0) return null;
    const max = rawExtended ? 0x1fffffff : 0x7ff;
    return n > max ? max : n;
  }

  function addFrame() {
    const id = parseId();
    if (id === null) return;
    onadd(makeFrameWatch(id, rawExtended));
  }
  function addByte() {
    const id = parseId();
    if (id === null) return;
    onadd(makeByteWatch(id, rawByte, rawExtended));
  }
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
  <div class="sheet" role="dialog" aria-label="Add reading">
    <div class="grip"></div>
    <div class="tabs">
      <button class:active={mode === "signal"} onclick={() => (mode = "signal")}
        >Signal</button
      >
      <button class:active={mode === "frame"} onclick={() => (mode = "frame")}
        >Frame</button
      >
      <button class:active={mode === "byte"} onclick={() => (mode = "byte")}
        >Byte</button
      >
    </div>

    {#if mode === "signal"}
      <div class="list">
        {#each sigs as s (s.key)}
          <button
            class="item"
            disabled={has(s.key)}
            onclick={() => onadd(s)}
          >
            <span class="name">{s.label}</span>
            <span class="meta mono muted"
              >0x{s.signal.frameId.toString(16).toUpperCase()} · {s.signal
                .bitStart}+{s.signal.bitLength}{s.unit ? " · " + s.unit : ""}</span
            >
            <span class="add">{has(s.key) ? "✓" : "+"}</span>
          </button>
        {/each}
        {#if sigs.length === 0}
          <p class="muted">No signals in project.</p>
        {/if}
      </div>
    {:else}
      <div class="raw">
        <label class="row">
          <span>Frame ID (hex)</span>
          <input
            type="text"
            class="mono"
            autocapitalize="characters"
            autocomplete="off"
            spellcheck="false"
            bind:value={rawIdHex}
            placeholder="100"
          />
        </label>
        <label class="row chk">
          <input type="checkbox" bind:checked={rawExtended} />
          <span>29-bit extended</span>
        </label>
        {#if mode === "byte"}
          <label class="row">
            <span>Byte index</span>
            <select bind:value={rawByte}>
              {#each [0, 1, 2, 3, 4, 5, 6, 7] as b (b)}
                <option value={b}>B{b}</option>
              {/each}
            </select>
          </label>
          <button class="primary big" onclick={addByte}>Add byte</button>
        {:else}
          <button class="primary big" onclick={addFrame}
            >Add raw frame</button
          >
        {/if}
      </div>
    {/if}

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
  .tabs {
    display: flex;
    gap: 8px;
  }
  .tabs button {
    flex: 1;
    min-height: 48px;
    border-radius: 12px;
  }
  .tabs button.active {
    background: var(--accent);
    color: #003;
    border-color: transparent;
    font-weight: 700;
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
  .raw {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .row > span {
    font-size: 1rem;
  }
  .row input[type="text"],
  .row select {
    flex: 1;
    max-width: 60%;
  }
  .row.chk {
    justify-content: flex-start;
  }
  .row.chk input {
    width: 28px;
    height: 28px;
  }
  .big {
    min-height: 56px;
    font-size: 1.1rem;
  }
  .close {
    min-height: 52px;
  }
</style>
