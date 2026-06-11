<script lang="ts">
  // THE WIZARD GLANCE — the copilot's whole screen during an experiment.
  //
  // OVERRIDING CONSTRAINT: the driver is under load, eyes-mostly-on-road, glance
  // <1 s. Every phase is built so the INSTRUCTION reads WITHOUT sound: a full
  // -screen COLOUR wash + ONE huge glyph/word, ICON/COLOUR/NUMBER-first, minimal
  // words. The copilot is a VIEWER: every value comes from relayed host
  // state; the only outputs are trialFeedback verdicts.
  //
  // H1 AUDIO+VISUAL: the cue is audio-led but the `cueing` screen is itself the
  //   instruction — huge GO + maneuver + timing — so a muted speaker never loses
  //   it. When `cueAudible === false` we also show a "follow the screen" hint.
  // H2 GLANCEABLE FEEDBACK: the "act now / report" moment is the MOST readable
  //   screen — a colour wash + one huge prompt glyph; SUCCESS is the big easy
  //   default, FAIL is smaller/separated/deliberate (a11y default = SUCCESS).
  // H3 VISIBLE STOP: a persistent, obvious STOP is rendered in EVERY non-terminal
  //   phase. It sends ABANDON, which the shared FSM accepts in any non-terminal
  //   phase — so the driver always has a visible way out.
  // M1: in the escalation, the destructive ABANDON is de-emphasised vs the
  //   forward SKIP — SKIP is the easy/primary action (big, accent-filled),
  //   ABANDON the smaller/secondary one (outlined, separated, never equal-size).

  import type { WizardRelay, TrialAction } from "../protocol/wizard";
  import { wasGuardRailAbandon } from "../protocol/wizard";
  import type { ConnState } from "../protocol/client";
  import { STR } from "../lib/strings";

  interface Props {
    w: WizardRelay;
    /** Drives flashing/pulse without per-frame reactivity elsewhere. */
    tick: number;
    /**
     * Did the last cue actually SOUND? false ⇒ speaker muted (iOS suspended):
     * the screen is the only channel, so we surface a hint. null before a cue.
     */
    cueAudible: boolean | null;
    /** Connection state — kept VISIBLE during a session (M2), shown as a dot. */
    conn: ConnState;
    /** Wake-lock support/held + toggle — kept VISIBLE and usable here too (M2). */
    wakeSupported: boolean;
    wakeHeld: boolean;
    ontoggleWake: () => void;
    onfeedback: (action: TrialAction) => void;
    /**
     * The driver STOPS the series: send `abandon` to the host AND free the
     * driver locally (H3 — never trapped, even if the host can't respond).
     */
    onstop: () => void;
    /** Whether an exclusion window is currently OPEN (DESIGN §3.3 huntMark). */
    excluding: boolean;
    /** perf.now() ms when the open exclusion window started — for the elapsed read-out. */
    excludeStartMs: number;
    /** Toggle the exclusion window (open → close+emit the huntMark span). */
    onexclude: () => void;
    /** Dismiss a terminal (done/abandoned) result locally — viewer-only. */
    ondismiss: () => void;
  }
  let {
    w,
    tick,
    cueAudible,
    conn,
    wakeSupported,
    wakeHeld,
    ontoggleWake,
    onfeedback,
    onstop,
    excluding,
    excludeStartMs,
    onexclude,
    ondismiss,
  }: Props = $props();

  // Elapsed seconds of the open exclusion window, re-read at display rate (tick).
  let excludeSecs = $derived.by(() => {
    void tick;
    if (!excluding) return 0;
    return Math.max(0, Math.floor((performance.now() - excludeStartMs) / 1000));
  });
  function fmtExcl(s: number): string {
    const m = Math.floor(s / 60);
    return `${m}:${(s % 60).toString().padStart(2, "0")}`;
  }

  // Connection indicator, mirroring ConnectionPill's semantics. A1: convey state
  // by SHAPE + ICON + COLOUR — never hue alone (colour-blind safety). `connDot`
  // picks the shape class; `connGlyph` the redundant icon (✓ live · ⋯ working ·
  // ✕ down). No sentence to read while driving.
  let connDot = $derived(
    conn === "open" ? "ok" : conn === "connecting" || conn === "reconnecting" ? "warn" : "bad",
  );
  let connGlyph = $derived(connDot === "ok" ? "✓" : connDot === "warn" ? "⋯" : "✕");

  // Leading candidate (the host already ranked; we only show the top one — one
  // thing at a time). Bounded: read, never stored.
  let lead = $derived(w.candidates && w.candidates.length > 0 ? w.candidates[0] : undefined);

  let maneuver = $derived(w.maneuver && w.maneuver.trim() ? w.maneuver : STR.maneuver);

  // Progress is driven from STATE (good / repetitions), not the advance effect.
  let target = $derived(Math.max(w.repetitions, 1));
  let testNo = $derived(w.repIndex + 1);

  // Silence budget toward the guard-rail (WIZARD.md "Silence countdown").
  let hasGuard = $derived(w.silenceGuard > 0);
  let silenceLeft = $derived(Math.max(0, w.silenceGuard - w.silence));

  // The cue-timing hint, shown WITH an icon (never a bare sentence).
  let cueHint = $derived(w.cueMode === "during" ? STR.during : STR.after);

  // Respect prefers-reduced-motion for the JS-driven blink (CSS handles the
  // rest). When reduced, the glyph stays steady-on rather than pulsing.
  let reduceMotion = $state(false);
  $effect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduceMotion = mq.matches;
    const on = () => (reduceMotion = mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  });

  // A calm ~2 Hz blink for the "act now" indicator while cueing (tick is bumped
  // per animation frame, ~60 Hz, so /16 toggles roughly twice a second — clearly
  // pulsing without strobing). Steady-on under reduced motion.
  let blinkOn = $derived(reduceMotion ? true : Math.floor(tick / 16) % 2 === 0);

  // Abandon reason from state (WIZARD.md "Abandon reason from state").
  let guardRail = $derived(w.phase === "abandoned" && wasGuardRailAbandon(w));

  // A STOP affordance belongs in every NON-terminal phase (H3). In retryPrompt
  // the ABANDON button already IS the stop, so the standalone top STOP shows
  // only during cueing/feedback to avoid two identical abandons on one screen.
  let showTopStop = $derived(w.phase === "cueing" || w.phase === "feedback");

  // Enter / Space = the SAFE default action only. In `feedback` that is SUCCESS
  // (A11y default = SUCCESS, WIZARD.md); on a terminal screen it just dismisses.
  // It NEVER maps to FAIL / ABANDON / SKIP — those stay deliberate taps.
  function onKey(e: KeyboardEvent) {
    const isEnter = e.key === "Enter" || e.key === " " || e.key === "Spacebar";
    if (!isEnter) return;
    if (w.phase === "feedback") {
      e.preventDefault();
      onfeedback("success");
    } else if (w.phase === "done" || w.phase === "abandoned") {
      e.preventDefault();
      ondismiss();
    }
  }

  // Autofocus the default control whenever we enter feedback (→ SUCCESS) or a
  // terminal phase (→ dismiss) so Enter/Space/single-switch lands on the safe
  // default. FAIL and STOP are never focused.
  let successBtn = $state<HTMLButtonElement | undefined>();
  let dismissBtn = $state<HTMLButtonElement | undefined>();
  $effect(() => {
    if (w.phase === "feedback" && successBtn) successBtn.focus();
    else if ((w.phase === "done" || w.phase === "abandoned") && dismissBtn) {
      dismissBtn.focus();
    }
  });
</script>

<svelte:window on:keydown={onKey} />

<section
  class="overlay phase-{w.phase}"
  class:guard={guardRail}
  class:reduce={reduceMotion}
  role="group"
  aria-label="Assistant — {maneuver}"
>
  <!-- Top band: M2 status (conn dot + wake) · maneuver · progress · STOP (H3).
       All kept VISIBLE even though the overlay covers the normal header. -->
  <div class="band">
    <!-- M2: connection state by colour + wake-lock toggle, both usable here. -->
    <div class="status">
      <span
        class="conn-dot {connDot}"
        class:pulse={connDot === "warn"}
        role="img"
        aria-label="connection: {conn}"
      ><span class="conn-glyph" aria-hidden="true">{connGlyph}</span></span>
      <button
        class="wake"
        class:on={wakeHeld}
        disabled={!wakeSupported}
        onclick={ontoggleWake}
        aria-pressed={wakeHeld}
        aria-label={wakeSupported ? "screen awake" : "wake-lock unavailable"}
      >{wakeHeld ? "☀" : wakeSupported ? "☾" : "⚠"}</button>
      <!-- Exclusion toggle (DESIGN §3.3 huntMark): the driver vetoes a span of
           frames as contamination/baseline. Open → close emits the closed span.
           When active it turns violet + shows the elapsed window so the driver
           never forgets data is being set aside. -->
      <button
        class="excl"
        class:on={excluding}
        class:pulse={excluding && !reduceMotion}
        onclick={() => onexclude()}
        aria-pressed={excluding}
        aria-label={excluding ? "excluding frames — tap to end the window" : "exclude frames from the hunt"}
        title={excluding ? "tap to end the exclusion window" : "set aside the frames during a span"}
      >
        <span class="excl-glyph" aria-hidden="true">⊘</span>
        {#if excluding}<span class="excl-time mono">{fmtExcl(excludeSecs)}</span>{/if}
      </button>
    </div>
    <span class="maneuver" title={maneuver}>{maneuver}</span>
    <span class="progress mono" aria-label="{w.good} / {target}">
      <span class="good">{w.good}</span><span class="sep">/</span><span class="tgt">{target}</span>
    </span>
    {#if showTopStop}
      <!-- H3: always-visible way out during cueing/feedback. Sends ABANDON
           (universal escape in the shared FSM). Outlined + deliberate so it
           reads clearly yet does not compete with the bottom primary action. -->
      <button class="stop" onclick={() => onstop()} aria-label="{STR.stop} — {STR.abandon}">
        <span class="stop-glyph" aria-hidden="true">◼</span>{STR.stop}
      </button>
    {/if}
  </div>

  <!-- The ONE huge thing, by phase. Each is a full-bleed COLOUR + glyph/word. -->
  <div class="stage">
    {#if w.phase === "cueing"}
      <!-- H1 VISUAL CUE: huge GO + maneuver + timing — readable with NO sound. -->
      <div class="big amber" aria-live="assertive">
        <div class="glyph go" class:flash={blinkOn}>{STR.go}</div>
        <div class="cue-hint">
          <span class="cue-ico" aria-hidden="true">{w.cueMode === "during" ? "🔊" : "⏱"}</span>
          {cueHint}
        </div>
        {#if cueAudible === false}
          <div class="muet" aria-live="polite">
            <span aria-hidden="true">🔇</span> {STR.muted}
          </div>
        {/if}
      </div>
    {:else if w.phase === "feedback"}
      <!-- H2 / A4: the MOST readable screen. A cool colour wash + a big ICON
           (the ✓?✕ choice mirrors the two controls below, so it reads as
           shapes, not hue) + the single token "Verdict" + the test number —
           never a bare "?" glyph. Answered by the controls below. -->
      <div class="big prompt" aria-live="assertive">
        <div class="prompt-icon" aria-hidden="true">
          <span class="pi-ok">✓</span><span class="pi-q">?</span><span class="pi-no">✕</span>
        </div>
        <div class="verdict prompt-word">{STR.verdict}</div>
        <div class="test mono">#{testNo}</div>
      </div>
    {:else if w.phase === "retryPrompt"}
      <div class="big amber" aria-live="assertive">
        <div class="glyph">⏱</div>
        {#if hasGuard}
          <div class="silence" aria-label="silence {w.silence} / {w.silenceGuard}">
            <span class="mono big-num" class:warn={silenceLeft <= 1}>{silenceLeft}</span>
          </div>
        {/if}
      </div>
    {:else if w.phase === "done"}
      <!-- A1: the verdict is NOT colour-only. A ✓ in a round filled badge (one
           shape/position) is the success cue; cf. the stop verdict's square ✕
           badge — distinct by SHAPE + ICON, readable ignoring hue. -->
      <div class="big green" aria-live="assertive">
        <div class="verdict-badge ok" aria-hidden="true">✓</div>
        <div class="verdict">{STR.done}</div>
        <div class="test mono">{w.good}/{target}</div>
      </div>
    {:else if w.phase === "abandoned"}
      <!-- A1: a ✕ in a SQUARE badge — a different shape AND icon from the round
           ✓ success badge, so success vs stop never relies on red-vs-green. -->
      <div class="big red" aria-live="assertive">
        <div class="verdict-badge no" aria-hidden="true">✕</div>
        <div class="verdict">{guardRail ? STR.autoStop : STR.stopped}</div>
        <div class="test mono">{w.good}/{target}</div>
      </div>
    {/if}
  </div>

  <!-- Leading candidate caption (top one only; tiny). Shown ONLY in the calm
       `feedback` moment — never during the cue, where the driver is being told
       to ACT and the candidate would just be competing clutter. -->
  {#if lead && w.phase === "feedback"}
    <div class="lead mono" aria-label="{STR.candidate}: {lead.label}">
      <span class="lead-cap muted">{STR.candidate}</span>
      <span class="lead-label">{lead.label}</span>
    </div>
  {/if}

  <!-- Controls, by phase. A11y asymmetry is structural, never inverted. -->
  <div class="controls">
    {#if w.phase === "feedback"}
      <!-- SUCCESS: big, full-width, default-focused, Enter/Space. -->
      <button
        bind:this={successBtn}
        class="verdict-success"
        onclick={() => onfeedback("success")}
      >
        <span class="vg">✓</span><span class="vt">{STR.success}</span>
      </button>
      <!-- FAIL: smaller, deliberate, clearly separated. NEVER default. -->
      <button class="verdict-fail" tabindex="-1" onclick={() => onfeedback("fail")}>
        <span class="vg">✕</span><span class="vt">{STR.fail}</span>
      </button>
    {:else if w.phase === "retryPrompt"}
      <!-- Escalation. M1 / Task C: SKIP (forward, mild) is the big, accent-filled
           PRIMARY; ABANDON (destructive) is the smaller, outlined, separated
           SECONDARY — never equal. ABANDON also serves as this phase's STOP
           (H3). The asymmetry is structural and never inverted. -->
      <button class="retry-skip" onclick={() => onfeedback("skip")}>
        {STR.skip} <span aria-hidden="true">⮕</span>
      </button>
      <button class="retry-abandon" onclick={() => onstop()}>
        <span class="stop-glyph" aria-hidden="true">◼</span>{STR.abandon}
      </button>
    {:else if w.phase === "done" || w.phase === "abandoned"}
      <!-- Terminal: a single full-width dismiss to return to the live view.
           Viewer-only (the host already ended the series). -->
      <button
        bind:this={dismissBtn}
        class="dismiss"
        class:ok={w.phase === "done"}
        onclick={ondismiss}
      >
        OK
      </button>
    {/if}
  </div>
</section>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    flex-direction: column;
    padding: calc(env(safe-area-inset-top) + 12px)
      calc(env(safe-area-inset-right) + 16px)
      calc(env(safe-area-inset-bottom) + 16px)
      calc(env(safe-area-inset-left) + 16px);
    background: var(--bg);
    /* A strong phase wash so the COLOUR reads before any glyph/word does. */
    transition: background 120ms ease;
  }
  /* Each non-terminal phase has its OWN strong full-bleed wash so the phase is
     legible by colour alone in a sub-second glance. */
  .phase-cueing {
    background: radial-gradient(130% 100% at 50% 32%, rgba(251, 189, 35, 0.32), transparent 72%), var(--bg);
  }
  .phase-feedback {
    /* A distinct cool wash so "report now" never looks like the amber cue. */
    background: radial-gradient(130% 100% at 50% 32%, rgba(96, 165, 250, 0.3), transparent 72%), var(--bg);
  }
  .phase-retryPrompt {
    background: radial-gradient(130% 100% at 50% 30%, rgba(251, 189, 35, 0.24), transparent 72%), var(--bg);
  }
  .phase-done {
    background: radial-gradient(130% 100% at 50% 35%, rgba(54, 211, 153, 0.3), transparent 72%), var(--bg);
  }
  .phase-abandoned {
    background: radial-gradient(130% 100% at 50% 35%, rgba(248, 114, 114, 0.28), transparent 72%), var(--bg);
  }

  .band {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: none;
  }
  /* M2 status cluster — connection dot + compact wake toggle. */
  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }
  /* A1: distinct SHAPE per state (disc = live · ring = working · square = down)
     plus a redundant glyph — readable without relying on hue. */
  .conn-dot {
    width: 18px;
    height: 18px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #0a0a0a;
  }
  .conn-glyph {
    font-size: 11px;
    line-height: 1;
    font-weight: 900;
  }
  .conn-dot.ok {
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent);
  }
  .conn-dot.warn {
    border-radius: 50%;
    background: transparent;
    border: 3px solid var(--warn);
    color: var(--warn);
  }
  .conn-dot.warn.pulse {
    animation: connpulse 1s ease-in-out infinite;
  }
  .conn-dot.bad {
    border-radius: 4px;
    background: var(--bad);
  }
  @keyframes connpulse {
    50% {
      opacity: 0.3;
    }
  }
  .wake {
    flex: none;
    min-width: 44px;
    min-height: 44px;
    padding: 0;
    border-radius: 12px;
    font-size: 1.2rem;
    line-height: 1;
  }
  .wake.on {
    background: var(--accent);
    color: #003;
    border-color: transparent;
  }
  .wake:disabled {
    opacity: 0.5;
  }
  /* Exclusion toggle — neutral outlined when idle; filled VIOLET (distinct from
     the green/amber/red traffic-light states) with the elapsed time when active,
     so an eyes-on-road driver always sees that frames are being set aside. */
  .excl {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 44px;
    min-height: 44px;
    padding: 0 10px;
    border-radius: 12px;
    background: transparent;
    border: 1px solid var(--line);
    color: var(--muted);
    font-size: 1.2rem;
    line-height: 1;
  }
  .excl.on {
    background: var(--veto);
    color: #1a1030;
    border-color: transparent;
    font-weight: 800;
  }
  .excl-time {
    font-size: 0.95rem;
    font-weight: 800;
  }
  .excl.on.pulse {
    animation: exclpulse 1.4s ease-in-out infinite;
  }
  @keyframes exclpulse {
    50% {
      opacity: 0.6;
    }
  }
  .maneuver {
    font-size: 1.25rem;
    font-weight: 700;
    letter-spacing: 0.01em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-transform: uppercase;
    flex: 1 1 auto;
    min-width: 0;
  }
  .progress {
    font-size: 1.6rem;
    font-weight: 800;
    flex: none;
  }
  .progress .good {
    color: var(--accent);
  }
  .progress .sep {
    color: var(--muted);
    margin: 0 2px;
  }
  .progress .tgt {
    color: var(--fg);
  }

  /* A3 — the persistent STOP is NEUTRAL-BUT-PRESENT: a solid neutral chip with
     a filled ◼ glyph, distinct from the two RED destructive controls (the small
     FAIL verdict and the de-emphasised ABANDON). It is always reachable in
     the top band yet, being neutral and top-anchored, does not read as the
     alarming "end the series" action nor compete with the bottom primary. */
  .stop {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 48px;
    padding: 0 16px;
    border-radius: 14px;
    background: var(--panel-2);
    color: var(--fg);
    border: 1px solid var(--line);
    font-size: 1.05rem;
    font-weight: 800;
    letter-spacing: 0.04em;
  }
  .stop:active {
    background: #2a2a2a;
  }
  /* The filled square reads as "stop" without colour; tinted so it still hints
     at the destructive nature on a neutral chip. */
  .stop-glyph {
    font-size: 0.9em;
    color: var(--bad);
  }

  /* The huge centre stage — ONE thing, as large as it fits. */
  .stage {
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 0;
  }
  .big {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    text-align: center;
  }
  .glyph {
    font-size: clamp(6rem, 38vw, 12rem);
    line-height: 1;
  }
  /* GO is a WORD, not an emoji — keep it bold and tracked, sized to fill. */
  .glyph.go {
    font-weight: 900;
    letter-spacing: 0.04em;
    color: var(--warn);
    font-size: clamp(5.5rem, 40vw, 13rem);
  }
  .big.amber .glyph {
    filter: drop-shadow(0 0 22px rgba(251, 189, 35, 0.55));
  }

  /* A1 terminal verdict badge — the glyph SHAPE (✓ vs ✕) AND the badge SHAPE
     (round vs square) AND the size/position distinguish success from stop, so
     neither relies on green-vs-red. Large, centred, the dominant element. */
  .verdict-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    width: clamp(7rem, 42vw, 13rem);
    height: clamp(7rem, 42vw, 13rem);
    font-size: clamp(4.5rem, 28vw, 9rem);
    font-weight: 900;
    line-height: 1;
    color: #0a0a0a;
  }
  .verdict-badge.ok {
    border-radius: 50%; /* round = success */
    background: var(--accent);
    box-shadow: 0 0 40px rgba(54, 211, 153, 0.55);
  }
  .verdict-badge.no {
    border-radius: 22px; /* square = stop/abandon — a different shape */
    background: var(--bad);
    box-shadow: 0 0 40px rgba(248, 114, 114, 0.5);
  }
  /* H2 / A4 feedback "act" icon — a big ✓?✕ that reads as SHAPES (mirrors the
     two verdict controls), on the cool wash. The ✓ is green and the ✕ is red so
     the binary choice is unmistakable even ignoring hue. */
  .prompt-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: clamp(0.4rem, 3vw, 1rem);
    font-size: clamp(4rem, 26vw, 8.5rem);
    font-weight: 900;
    line-height: 1;
  }
  .prompt-icon .pi-ok {
    color: var(--accent);
    filter: drop-shadow(0 0 16px rgba(54, 211, 153, 0.5));
  }
  .prompt-icon .pi-q {
    color: #93c5fd;
    filter: drop-shadow(0 0 22px rgba(96, 165, 250, 0.6));
  }
  .prompt-icon .pi-no {
    color: var(--bad);
    filter: drop-shadow(0 0 16px rgba(248, 114, 114, 0.5));
  }
  .prompt-word {
    color: #cfe3ff;
  }
  .glyph.flash {
    opacity: 1;
  }
  .glyph:not(.flash) {
    opacity: 0.5;
  }
  .cue-hint {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--warn);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .cue-ico {
    font-size: 1.2em;
  }
  /* Audio-muted hint — small, calm, under the visual cue (H1 fallback). */
  .muet {
    margin-top: 4px;
    font-size: 1rem;
    font-weight: 600;
    color: var(--fg);
    opacity: 0.85;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .verdict {
    font-size: 2.2rem;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  .test {
    font-size: 1.6rem;
    color: var(--muted);
    font-weight: 700;
  }
  .big-num {
    font-size: clamp(4rem, 26vw, 8rem);
    font-weight: 800;
    line-height: 1;
  }
  .big-num.warn {
    color: var(--bad);
  }
  .silence {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .lead {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 8px 12px;
    margin-bottom: 10px;
    background: var(--panel);
    border-radius: 12px;
    min-height: 44px;
    overflow: hidden;
  }
  .lead-cap {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    flex: none;
  }
  .lead-label {
    font-size: 1.1rem;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .controls {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  /* SUCCESS — the big, easy, full-width default. */
  .verdict-success {
    width: 100%;
    min-height: 112px;
    border-radius: 22px;
    background: var(--accent);
    color: #002;
    border: none;
    font-size: 2rem;
    font-weight: 800;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
    box-shadow: 0 8px 28px rgba(54, 211, 153, 0.35);
  }
  .verdict-success:active {
    filter: brightness(0.92);
  }
  .verdict-success:focus-visible {
    outline: 4px solid #fff;
    outline-offset: 3px;
  }
  .verdict-success .vg {
    font-size: 2.4rem;
  }

  /* FAIL — smaller, deliberate, separated. Pushed to one side, not full-width,
     so it can't be hit by a reflexive thumb aiming for SUCCESS. */
  .verdict-fail {
    align-self: flex-end;
    min-height: 56px;
    width: 52%;
    border-radius: 16px;
    background: transparent;
    color: var(--bad);
    border: 2px solid var(--bad);
    font-size: 1.1rem;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    opacity: 0.92;
  }
  .verdict-fail:active {
    background: rgba(248, 114, 114, 0.14);
  }

  /* Escalation. M1 / Task C: SKIP is the big, dominant, forward PRIMARY —
     accent-filled and full-width so it unmistakably outweighs the small
     outlined ABANDON below; ABANDON (destructive) is smaller, outlined,
     separated. SKIP is the easy default the thumb gravitates to. */
  .retry-skip {
    width: 100%;
    min-height: 112px;
    border-radius: 22px;
    background: var(--accent);
    color: #002;
    border: none;
    font-size: 1.9rem;
    font-weight: 800;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    box-shadow: 0 8px 28px rgba(54, 211, 153, 0.35);
  }
  .retry-skip:active {
    filter: brightness(0.92);
  }
  .retry-skip:focus-visible {
    outline: 4px solid #fff;
    outline-offset: 3px;
  }
  /* A3 / Task C — ABANDON is de-emphasised vs the dominant SKIP: clearly
     narrower, shorter, lighter weight, sentence-case, a THIN soft-red outline
     (no fill). It must never look co-equal to the big accent-filled SKIP above
     it. It also serves as this phase's STOP (H3). */
  .retry-abandon {
    align-self: flex-end;
    width: 44%;
    min-height: 46px;
    border-radius: 14px;
    background: transparent;
    color: var(--bad);
    border: 1px solid var(--bad);
    font-size: 0.9rem;
    font-weight: 600;
    opacity: 0.8;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .retry-abandon .stop-glyph {
    /* on this outlined-red control the glyph follows the text colour */
    color: inherit;
  }
  .retry-abandon:active {
    background: rgba(248, 114, 114, 0.14);
    opacity: 1;
  }

  .dismiss {
    width: 100%;
    min-height: 88px;
    border-radius: 20px;
    background: var(--panel-2);
    color: var(--fg);
    border: 1px solid var(--line);
    font-size: 1.6rem;
    font-weight: 800;
    letter-spacing: 0.06em;
  }
  .dismiss.ok {
    background: var(--accent);
    color: #002;
    border-color: transparent;
  }
  .dismiss:focus-visible {
    outline: 4px solid #fff;
    outline-offset: 3px;
  }

  /* prefers-reduced-motion: kill the background wash transition and any pulse;
     the JS blink is already frozen steady-on via `reduceMotion`. */
  @media (prefers-reduced-motion: reduce) {
    .overlay {
      transition: none;
    }
    .glyph:not(.flash) {
      opacity: 1;
    }
    .conn-dot.warn.pulse {
      animation: none;
    }
    .excl.on.pulse {
      animation: none;
    }
  }
</style>
