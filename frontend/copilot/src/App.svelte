<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { AppStore } from "./lib/store.svelte";
  import { WakeLockController } from "./lib/wakeLock";
  import { registerPwa, applyPwaUpdate } from "./lib/pwa";
  import { DEFAULT_PROJECT } from "./lib/project";
  import {
    makeFrameWatch,
    makeSignalWatch,
    type Watch,
  } from "./lib/watches";
  import ConnectionPill from "./components/ConnectionPill.svelte";
  import ValueTile from "./components/ValueTile.svelte";
  import Gauge from "./components/Gauge.svelte";
  import BitGrid from "./components/BitGrid.svelte";
  import WatchPicker from "./components/WatchPicker.svelte";
  import WizardOverlay from "./components/WizardOverlay.svelte";

  const store = new AppStore();
  const project = DEFAULT_PROJECT;

  let wake: WakeLockController;
  let pickerOpen = $state(false);
  let updateReady = $state(false); // a new PWA build is waiting to take over

  // The Wizard overlay takes over the WHOLE screen during a session (any phase
  // but idle). The copilot is a VIEWER: it appears/updates purely from relayed
  // host state and the only outputs are trialFeedback verdicts.
  let wizardActive = $derived(store.wizard !== null && store.wizard.phase !== "idle");

  // iOS needs a user gesture before any cue beep is audible — AND it re-suspends
  // the AudioContext whenever the page is backgrounded. So we resume on EVERY
  // gesture (H1), not just the first: cheap and idempotent when already running,
  // and the only way to recover audibility after the phone has slept. The big
  // VISUAL cue covers the windows where audio is still muted.
  function resumeAudioOnGesture() {
    store.unlockAudio();
  }

  // Seed a few glanceable default tiles from the project + one raw frame.
  function seedDefaults() {
    const speed = project.frames[0]?.signals[0];
    const rpm = project.frames[1]?.signals[0];
    const temp = project.frames[2]?.signals[0];
    if (speed) store.addWatch(makeSignalWatch(speed));
    if (rpm) store.addWatch(makeSignalWatch(rpm));
    if (temp) store.addWatch(makeSignalWatch(temp));
    store.addWatch(makeFrameWatch(0x100)); // raw frame demo (bit grid)
  }

  onMount(() => {
    wake = new WakeLockController((held) => (store.wakeHeld = held));
    store.wakeSupported = wake.supported;
    seedDefaults();
    store.connect(/* autoStartSim */ true);
    // Best-effort wake lock on first paint; iOS may require a user gesture, in
    // which case the toggle re-requests it.
    void wake.enable();
    // Resume audio on EVERY gesture anywhere (iOS gesture requirement, and it
    // re-suspends across backgrounding). Capture so it runs before any handler;
    // NOT `once` — we want every touch to keep the speaker live (H1).
    window.addEventListener("pointerdown", resumeAudioOnGesture, { capture: true });
    // PWA shell cache + update prompt (prod, secure context only; no-op else).
    registerPwa({ onUpdateReady: () => (updateReady = true) });
  });

  onDestroy(() => {
    window.removeEventListener("pointerdown", resumeAudioOnGesture, { capture: true } as EventListenerOptions);
    store.disconnect();
    wake?.destroy();
  });

  function toggleWake() {
    if (!wake) return;
    resumeAudioOnGesture(); // piggy-back the gesture to keep audio live too
    if (store.wakeHeld) void wake.disable();
    else void wake.enable();
  }

  function onAdd(w: Watch) {
    store.addWatch(w);
  }

  // Gauge subject (a signal/byte watch).
  let gaugeEntry = $derived.by(() => {
    void store.tick;
    return store.gaugeEntry();
  });

  // Frame watches get their own bit-grid section.
  let frameEntries = $derived.by(() => {
    void store.tick;
    return store.watchEntries.filter((e) => e.watch.kind === "frame");
  });
  let valueEntries = $derived.by(() => {
    void store.tick;
    return store.watchEntries.filter((e) => e.watch.kind !== "frame");
  });
</script>

{#if updateReady && !wizardActive}
  <button class="update-banner" onclick={() => applyPwaUpdate()}>
    New version · refresh ↻
  </button>
{/if}

<ConnectionPill
  conn={store.conn}
  fps={store.fps}
  replay={store.replay}
  health={store.health}
  wakeSupported={store.wakeSupported}
  wakeHeld={store.wakeHeld}
  lastError={store.lastError}
  ontoggleWake={toggleWake}
/>

<main>
  {#if gaugeEntry}
    <section class="gauge-wrap">
      <Gauge
        ring={store.gaugeRing}
        tick={store.tick}
        label={gaugeEntry.watch.label}
        unit={gaugeEntry.watch.kind === "signal" ? gaugeEntry.watch.unit : ""}
        value={gaugeEntry.latest.value}
      />
    </section>
  {/if}

  <section class="tiles">
    {#each valueEntries as entry (entry.watch.key)}
      <ValueTile
        {entry}
        tick={store.tick}
        isGauge={entry.watch.key === store.gaugeWatchKey}
        onselect={(k) => store.setGauge(k)}
        onremove={(k) => store.removeWatch(k)}
      />
    {/each}
  </section>

  {#each frameEntries as entry (entry.watch.key)}
    <section class="frame">
      <div class="frame-head">
        <span class="label mono">{entry.watch.label}</span>
        <button
          class="x"
          aria-label="remove"
          onclick={() => store.removeWatch(entry.watch.key)}>✕</button
        >
      </div>
      <BitGrid latest={entry.latest} tick={store.tick} />
    </section>
  {/each}

  {#if store.watchEntries.length === 0}
    <p class="empty muted">No measurements · ＋ to add</p>
  {/if}
</main>

{#if !wizardActive}
  <button class="fab primary" onclick={() => (pickerOpen = true)} aria-label="add a measurement"
    >＋</button
  >
{/if}

<WatchPicker
  {project}
  open={pickerOpen}
  has={(k) => store.hasWatch(k)}
  onadd={onAdd}
  onclose={() => (pickerOpen = false)}
/>

{#if wizardActive && store.wizard}
  <WizardOverlay
    w={store.wizard}
    tick={store.tick}
    cueAudible={store.cueAudible}
    conn={store.conn}
    wakeSupported={store.wakeSupported}
    wakeHeld={store.wakeHeld}
    ontoggleWake={toggleWake}
    onfeedback={(a) => store.sendFeedback(a)}
    ondismiss={() => store.dismissWizard()}
  />
{/if}

{#if store.feedbackUnsent}
  <div class="unsent" role="alert" aria-live="assertive">
    <span class="x">✕</span> Not sent — offline
  </div>
{/if}

<style>
  .unsent {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 14px 12px;
    font-size: 18px;
    font-weight: 800;
    color: #fff;
    background: var(--bad, #b00020);
    box-shadow: 0 2px 14px rgba(0, 0, 0, 0.55);
  }
  .unsent .x {
    font-size: 22px;
    line-height: 1;
  }
  main {
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-bottom: 96px; /* room for the FAB */
  }
  .gauge-wrap {
    background: var(--panel);
    border-radius: 18px;
    padding: 8px;
  }
  .tiles {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .frame {
    background: var(--panel);
    border-radius: 16px;
    padding: 12px 14px;
  }
  .frame-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .frame-head .label {
    font-size: 1rem;
    color: var(--muted);
  }
  .frame-head .x {
    min-width: 36px;
    min-height: 36px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--muted);
  }
  .empty {
    text-align: center;
    padding: 40px 12px;
  }
  .fab {
    position: fixed;
    right: calc(16px + env(safe-area-inset-right));
    bottom: calc(16px + env(safe-area-inset-bottom));
    z-index: 5;
    min-height: 60px;
    padding: 0 24px;
    border-radius: 18px;
    font-size: 1.1rem;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }
  .update-banner {
    width: calc(100% - 24px);
    margin: 12px 12px 0;
    min-height: 48px;
    border-radius: 12px;
    background: var(--warn);
    color: #201500;
    border: none;
    font-weight: 700;
    font-size: 0.95rem;
  }
</style>
