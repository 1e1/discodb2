<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { AppStore } from "./lib/store.svelte";
  import { WakeLockController } from "./lib/wakeLock";
  import { registerPwa, applyPwaUpdate } from "./lib/pwa";
  import { EMPTY_PROJECT } from "./lib/project";
  import { STR } from "./lib/strings";
  import type { Watch } from "./lib/watches";
  import ConnectionPill from "./components/ConnectionPill.svelte";
  import ValueTile from "./components/ValueTile.svelte";
  import Gauge from "./components/Gauge.svelte";
  import WatchPicker from "./components/WatchPicker.svelte";
  import WizardOverlay from "./components/WizardOverlay.svelte";
  import LogbookView from "./components/LogbookView.svelte";

  const store = new AppStore();
  // The copilot is a Wizard COMPANION, not a telemetry dashboard: it ships with
  // NO confirmed signals, so the named-value telemetry view stays dormant until
  // a real project arrives. Until then the default face is the idle companion
  // screen, and (during a session) the full-screen Wizard glance.
  const project = EMPTY_PROJECT;

  let wake: WakeLockController;
  let pickerOpen = $state(false);
  let updateReady = $state(false); // a new PWA build is waiting to take over

  // The Wizard overlay takes over the WHOLE screen during a session (any phase
  // but idle). The copilot is a VIEWER: it appears/updates purely from relayed
  // host state and the only outputs are trialFeedback verdicts.
  let wizardActive = $derived(store.wizard !== null && store.wizard.phase !== "idle");

  // The Logbook viewer takes over the screen whenever the cockpit is in Logbook
  // mode (a relay arrived and the session is not `off`). The Wizard wins if both
  // are somehow live (the cockpit is only ever in one mode at a time).
  let logbookActive = $derived(store.logbook !== null && !wizardActive);

  // iOS needs a user gesture before any cue beep is audible — AND it re-suspends
  // the AudioContext whenever the page is backgrounded. So we resume on EVERY
  // gesture (H1), not just the first: cheap and idempotent when already running,
  // and the only way to recover audibility after the phone has slept. The big
  // VISUAL cue covers the windows where audio is still muted.
  function resumeAudioOnGesture() {
    store.unlockAudio();
  }

  onMount(() => {
    wake = new WakeLockController((held) => (store.wakeHeld = held));
    store.wakeSupported = wake.supported;
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

  let valueEntries = $derived.by(() => {
    void store.tick;
    return store.watchEntries;
  });

  // Telemetry tiles are dormant until a real project carries confirmed signals;
  // with none, the ＋ has nothing to pin, so it's hidden.
  let hasSignals = $derived(project.frames.length > 0);

  // The companion idle screen's one status line, derived from the link state
  // (the pill carries the technical detail; this is the plain-language role).
  let idleStatus = $derived(
    store.conn === "open"
      ? STR.idleWaiting
      : store.conn === "connecting"
        ? STR.idleConnecting
        : STR.idleReconnecting,
  );
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
  {#if valueEntries.length > 0}
    {#if gaugeEntry}
      <section class="gauge-wrap">
        <Gauge
          ring={store.gaugeRing}
          tick={store.tick}
          label={gaugeEntry.watch.label}
          unit={gaugeEntry.watch.unit}
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
  {:else}
    <!-- Companion idle face (no Wizard session, no confirmed signals): the
         copilot's honest resting state — it waits for the Cockpit to start a
         hunt rather than faking a telemetry dashboard. -->
    <section class="idle">
      <span class="idle-glyph" aria-hidden="true">⌖</span>
      <h1 class="idle-title">{STR.companion}</h1>
      <p class="idle-status">{idleStatus}</p>
    </section>
  {/if}
</main>

{#if !wizardActive && hasSignals}
  <button class="fab primary" onclick={() => (pickerOpen = true)} aria-label="add a confirmed signal"
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
    onstop={() => store.requestStop()}
    excluding={store.excluding}
    excludeStartMs={store.excludeStartMs}
    onexclude={() => store.toggleExclude()}
    ondismiss={() => store.dismissWizard()}
  />
{/if}

{#if logbookActive && store.logbook}
  <LogbookView
    lb={store.logbook}
    onstart={(id) => store.startScenario(id)}
    onstop={() => store.stopRun()}
    onnext={() => store.nextStep()}
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
  .idle {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 14px;
    min-height: 60dvh;
    padding: 24px 20px;
    color: var(--muted);
  }
  .idle-glyph {
    font-size: clamp(4rem, 22vw, 7rem);
    line-height: 1;
    color: var(--accent);
    opacity: 0.85;
  }
  .idle-title {
    margin: 0;
    font-size: 1.4rem;
    font-weight: 800;
    letter-spacing: 0.02em;
    color: var(--fg, #fff);
  }
  .idle-status {
    margin: 0;
    font-size: 1.05rem;
    line-height: 1.5;
    max-width: 28ch;
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
