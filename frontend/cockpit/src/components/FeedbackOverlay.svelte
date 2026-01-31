<script lang="ts">
  /**
   * Per-trial FEEDBACK request overlay — the UI side of docs/WIZARD.md
   * "Per-trial feedback (FSM)" + "UI obligations". The shared reducer is logic
   * only; this component honours the obligations that are the UI's:
   *
   *   • Big feedback request: the ✓ SUCCESS action dominates the `feedback`
   *     phase, shown large.
   *   • A11y default = SUCCESS only: Enter / Space (single-switch / voice "OK")
   *     map to SUCCESS; the ✓ button is autofocused. FAIL is a distinct, SMALLER,
   *     deliberate control that is NEVER default-focused and has NO key shortcut.
   *   • Retry prompt: in `retryPrompt`, [ ABANDON ] [ SKIP / NEXT ]; no key
   *     default (both are deliberate).
   *   • Silence countdown: on each silent replay, show silence / silenceGuard so
   *     a hands-free operator sees the budget before auto-abandon.
   *   • Abandon reason from state: distinct copy for the guard-rail vs explicit.
   *   • Progress from state: "test N · good G / M" from good / repIndex / ledger,
   *     NOT from the `advance` effect.
   *   • Cue watchdog / never wedge: a STOP control is ALWAYS visible (it maps to
   *     ABANDON); the host force-fires CUE_DONE if audio stalls.
   *
   * Labels are English (expert tool, no i18n) and track the spec's FSM semantics
   * (Success, Fail, Abandon, Skip/Next).
   */
  import { createEventDispatcher, tick } from 'svelte';
  import type { WizardHostState } from '../hunt/wizardHost';

  export let state: WizardHostState;

  const dispatch = createEventDispatcher<{
    success: void;
    fail: void;
    abandon: void;
    skip: void;
    close: void;
  }>();

  $: phase = state.fsm.phase;
  $: good = state.good;
  $: target = state.target_reps;
  // Progress from state: the test NUMBER is the 1-based current rep; good/target
  // and failed/skipped come from the ledger-backed counts (NOT the advance fx).
  $: testNo = state.fsm.repIndex + 1;
  $: silence = state.fsm.silence;
  $: silenceGuard = state.config.silenceGuard;
  // Silence BUDGET (UI obligation): show the budget toward the guard-rail. The
  // raw `silence` is 0 at the FIRST retryPrompt, so showing it directly reads
  // "0/5" with no sense of the budget. Show what REMAINS before auto-abandon —
  // silenceGuard - silence — so the first prompt shows the FULL budget and it
  // counts DOWN on each silent replay.
  $: silenceRemaining = Math.max(0, silenceGuard - silence);
  // Non-terminal = a series is running and a visible Stop/Abandon is shown.
  $: terminal = phase === 'done' || phase === 'abandoned';

  let okBtn: HTMLButtonElement | null = null;
  let card: HTMLDivElement | null = null;
  // Autofocus the SUCCESS button when the feedback request appears so the a11y
  // default lands on SUCCESS (Enter/Space activate the focused button).
  $: if (phase === 'feedback' && okBtn) okBtn.focus();
  // Modal focus management: when the phase changes and we are NOT on the
  // feedback request (which focuses ✓ itself), pull focus into the card so Tab
  // is trapped and Escape is heard even if focus was outside the dialog.
  $: focusOnPhase(phase);
  async function focusOnPhase(_p: string) {
    await tick();
    if (phase !== 'feedback' && card && !card.contains(document.activeElement)) {
      card.focus();
    }
  }

  /** Escape maps to the SAME action as the visible Stop/Abandon control: */
  function escape() {
    if (terminal) dispatch('close');
    else dispatch('abandon');
  }

  /** Keep Tab focus inside the card (proper modal). */
  function trapTab(e: KeyboardEvent) {
    if (e.key !== 'Tab' || !card) return;
    const focusables = card.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) {
      e.preventDefault();
      card.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || active === card)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onKey(e: KeyboardEvent) {
    // Escape = the visible Stop/Abandon (or Close once terminal) — always heard.
    if (e.key === 'Escape') {
      e.preventDefault();
      escape();
      return;
    }
    // Trap Tab within the modal.
    if (e.key === 'Tab') {
      trapTab(e);
      return;
    }
    // A11y default = SUCCESS only, and ONLY while the feedback request is up.
    // Space/Enter on the focused ✓ button would already fire it; we also map
    // them at the overlay level so a single-switch / voice "OK" works even if
    // focus drifted. FAIL is deliberately excluded.
    if (phase !== 'feedback') return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      dispatch('success');
    }
  }
</script>

<svelte:window on:keydown={onKey} />

<div class="scrim" role="dialog" aria-modal="true" aria-label="Wizard trial feedback">
  <!-- svelte-ignore a11y-no-noninteractive-tabindex -->
  <div class="card" bind:this={card} tabindex="-1">
    <!-- header: target + progress from state -->
    <div class="head">
      <span class="target">{state.target || 'experiment'}</span>
      <span class="dim mono prog">test {testNo} · good {good}/{target}{#if state.failed || state.skipped} · {state.failed} miss · {state.skipped} skip{/if}</span>
    </div>

    {#if phase === 'cueing'}
      <div class="big cue">
        <div class="pulse"></div>
        <div class="label">Listen for the cue…</div>
        <div class="dim small">{state.cueMode === 'during' ? 'act WHILE the low tone plays' : 'act when the cue ends'}</div>
      </div>
      <div class="actions">
        <button class="stop" on:click={() => dispatch('abandon')}>■ Stop</button>
      </div>

    {:else if phase === 'feedback'}
      <div class="prompt">Did the action register?</div>
      <div class="actions feedback">
        <button class="ok" bind:this={okBtn} on:click={() => dispatch('success')}>
          ✓ Success
          <span class="hint">Enter / Space</span>
        </button>
        <button class="fail" on:click={() => dispatch('fail')} title="repeat this test">✗ Fail</button>
      </div>
      <div class="dim small foot">no response in {Math.round(state.config.feedbackTimeoutMs / 1000)}s → abandon / skip prompt</div>
      <!-- Always-visible Stop (never wedge the operator): like the cueing phase,
           it maps to ABANDON. Kept deliberately small/dim so it does not compete
           with the a11y-default ✓ Success button. -->
      <div class="actions">
        <button class="stop" on:click={() => dispatch('abandon')}>■ Stop</button>
      </div>

    {:else if phase === 'retryPrompt'}
      <div class="prompt">No response. What now?</div>
      <div class="actions retry">
        <button class="abandon" on:click={() => dispatch('abandon')}>Abandon</button>
        <button class="skip" on:click={() => dispatch('skip')}>Skip / Next</button>
      </div>
      <!-- Silence countdown: budget REMAINING toward the guard-rail auto-abandon.
           The first prompt shows the full budget (silence is 0 there); each
           silent replay extinguishes one dot. -->
      <div class="silence">
        <div class="dim small">{silenceRemaining} silent {silenceRemaining === 1 ? 'replay' : 'replays'} left before auto-abandon · no response in {Math.round(state.config.retryPromptTimeoutMs / 1000)}s replays this test</div>
        <div class="dots">
          {#each Array(silenceGuard) as _, i}
            <span class="dot" class:lit={i < silenceRemaining}></span>
          {/each}
        </div>
      </div>

    {:else if phase === 'done'}
      <div class="big done">
        <div class="label ok">✓ Series complete</div>
        <div class="dim">{good}/{target} good trials{#if state.skipped || state.failed} · {state.failed} miss · {state.skipped} skip{/if}</div>
      </div>
      <div class="actions">
        <button class="primary" on:click={() => dispatch('close')}>Done</button>
      </div>

    {:else if phase === 'abandoned'}
      <div class="big abandoned">
        <div class="label warn">■ Series abandoned</div>
        <!-- Abandon reason from state: distinct, honest copy. -->
        {#if state.abandonReason === 'guard'}
          <div class="dim">auto-stopped after {silenceGuard} silent replays (guard-rail)</div>
        {:else}
          <div class="dim">stopped by operator</div>
        {/if}
        <div class="dim small">{good}/{target} good · {state.failed} miss · {state.skipped} skip</div>
      </div>
      <div class="actions">
        <button class="primary" on:click={() => dispatch('close')}>Close</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(8, 10, 14, 0.78);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .card {
    width: min(440px, 92vw);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 18px 20px 16px;
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 14px;
  }
  .target {
    font-size: 14px;
    font-weight: 700;
    color: var(--accent);
  }
  .prog {
    font-size: 11px;
  }
  .small {
    font-size: 11px;
  }
  .big {
    text-align: center;
    padding: 22px 0;
  }
  .big .label {
    font-size: 20px;
    font-weight: 700;
    margin-bottom: 4px;
  }
  .label.ok {
    color: var(--ok);
  }
  .label.warn {
    color: var(--warn);
  }
  .cue .pulse {
    width: 54px;
    height: 54px;
    margin: 0 auto 12px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { transform: scale(0.8); opacity: 0.55; }
    50% { transform: scale(1.15); opacity: 1; }
  }
  .prompt {
    text-align: center;
    font-size: 15px;
    margin-bottom: 16px;
  }
  .actions {
    display: flex;
    gap: 12px;
    justify-content: center;
    align-items: center;
  }
  /* SUCCESS dominates: large, full-width-ish, primary. */
  .actions.feedback .ok {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    font-size: 22px;
    font-weight: 700;
    padding: 22px 16px;
    background: var(--accent-dim);
    border-color: var(--accent);
    color: var(--text);
  }
  .actions.feedback .ok .hint {
    font-size: 10px;
    font-weight: 400;
    color: var(--text-dim);
  }
  /* FAIL: distinct, SMALLER, deliberate, never default-focused. */
  .actions.feedback .fail {
    font-size: 13px;
    padding: 10px 14px;
    color: var(--text-dim);
  }
  .actions.feedback .fail:hover {
    border-color: var(--err);
    color: var(--err);
  }
  .actions.retry .abandon {
    padding: 12px 20px;
  }
  .actions.retry .abandon:hover {
    border-color: var(--err);
    color: var(--err);
  }
  .actions.retry .skip {
    padding: 12px 20px;
  }
  .foot {
    text-align: center;
    margin-top: 12px;
  }
  .stop {
    color: var(--text-dim);
  }
  .stop:hover {
    border-color: var(--err);
    color: var(--err);
  }
  .silence {
    margin-top: 16px;
    text-align: center;
  }
  .dots {
    display: flex;
    gap: 6px;
    justify-content: center;
    margin-top: 8px;
  }
  .dots .dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 1px solid var(--border);
    background: var(--bg);
  }
  /* Lit = budget REMAINING (accent). As silences accrue, dots extinguish toward
     the guard-rail; the warn cue lives in the countdown text. */
  .dots .dot.lit {
    background: var(--accent);
    border-color: var(--accent);
  }
</style>
