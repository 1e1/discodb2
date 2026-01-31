<script lang="ts">
  /**
   * HUNT panel (DESIGN §9) — the cockpit's Wizard front-end, now BACKED by the
   * shared analysis + FSM (frontend/shared) via src/hunt/*.
   *
   * Flow (docs/WIZARD.md):
   *   1. Choose a TARGET (component palette of sim-known signals, or free text +
   *      optional id allow-list).
   *   2. Run a GUIDED experiment: the Wizard host plays the cue and runs the
   *      per-trial feedback FSM with real timers. Event mode collects one
   *      confirmed cue-instant per GOOD trial; trend mode brackets a sweep.
   *   3. On completion we feed the collected marks into the shared runExperiment
   *      (via the cockpit seam adapter) and show the TOP 3–5 ranked candidates.
   *   4. One click PROMOTES a candidate into the §3.5 Project as a named Signal.
   *
   * A manual path (mark/Run without the cue) is kept so the tool works even with
   * no audio, but the guided path is the headline.
   */
  import { onDestroy } from 'svelte';
  import {
    ring,
    maxTUs,
    selected,
    addSignal,
    sendWizard,
    onTrialFeedback,
  } from '../state/store';
  import {
    runExperimentDetailed,
    type RankedCandidate,
    type ExperimentWindow,
    type ExperimentRunInfo,
  } from '../hunt/hunt';
  import { makeSignal } from '../protocol/datamodel';
  import { WizardHost, type WizardHostState } from '../hunt/wizardHost';
  import { WIZARD_DEFAULTS } from '@shared/wizard-config.ts';
  import type { WizardState } from '@shared/wizard-fsm.ts';
  import {
    CUE_PRESETS,
    ensureAudioReady,
    playStartBeep,
    playStopBeep,
    type CueMode,
  } from '../hunt/cuePlayer';
  import FeedbackOverlay from './FeedbackOverlay.svelte';

  // 'event' = cue + repetitions + feedback FSM; 'trend' = ramp Start/Stop
  // capture; '2pt' = two steady-state captures (FULL vs LOW) for a signal you
  // can't ramp (docs/WIZARD.md → "2-point").
  type Mode = 'event' | 'trend' | '2pt';

  // ── target presets (sim-aware; see backend/.../adapters/sim.py) ─────────────
  interface TargetPreset {
    label: string;
    mode: Mode;
    cue: CueMode;
    ids: number[];
    direction?: 'up' | 'down';
    hint: string;
  }
  const PRESETS: TargetPreset[] = [
    { label: 'Handbrake', mode: 'event', cue: 'during', ids: [0x5a0], hint: 'pull/release on each cue (0x5A0)' },
    { label: 'Reverse gear', mode: 'event', cue: 'during', ids: [0x5a0], hint: 'engage reverse on each cue (0x5A0)' },
    { label: 'Ignition', mode: 'event', cue: 'during', ids: [0x5a0], hint: 'key on/off on each cue' },
    { label: 'Blinker', mode: 'event', cue: 'during', ids: [0x30b], hint: 'indicator on each cue (0x30B)' },
    { label: 'Fuel level', mode: 'trend', cue: 'after', ids: [0x480], direction: 'down', hint: 'let it drain across the window (0x480)' },
    { label: 'Fuel full vs low', mode: '2pt', cue: 'after', ids: [0x480], hint: 'capture A full, then B low (0x480)' },
    { label: 'RPM ramp', mode: 'trend', cue: 'after', ids: [0x280], direction: 'up', hint: 'rev up across the window (0x280)' },
    { label: 'Speed', mode: 'trend', cue: 'after', ids: [0x5a0], direction: 'up', hint: 'accelerate across the window' },
  ];

  // ── operator inputs ──────────────────────────────────────────────────────────
  let target = '';
  let mode: Mode = 'event';
  let cueMode: CueMode = 'during';
  let idAllowStr = ''; // comma/space ids, hex or dec; empty = all
  let direction: 'up' | 'down' = 'up';
  let windowSeconds = 12;
  let repetitions = WIZARD_DEFAULTS.repetitions;

  // ── manual marks (used by the manual path; guided fills these automatically) ──
  let eventMarks: number[] = []; // backend µs
  let trendStart: number | null = null;
  let trendEnd: number | null = null;
  // 2-point: the two captured steady-state windows (A = full, B = low), backend µs.
  let cmpA: { startTUs: number; endTUs: number } | null = null;
  let cmpB: { startTUs: number; endTUs: number } | null = null;

  // ── results ─────────────────────────────────────────────────────────────────
  let results: RankedCandidate[] = [];
  let lastRunInfo = '';
  let promoted = new Set<string>();

  // ── the Wizard host (drives the cue + per-trial FSM with real timers) ─────────
  const host = new WizardHost({
    onRelay: (payload) => sendWizard({ ...payload }),
  });
  let hostState: WizardHostState;
  const unsub = host.subscribe((s) => (hostState = s));

  // Collected event marks DURING a guided run: one action-instant pushed when
  // the feedback request appears; confirmed on SUCCESS. For a "during" cue the
  // instant is stamped INSIDE the low tone (see onHostPhase); for "after" it is
  // the cue end.
  let guidedMarks: { repIndex: number; at: number }[] = [];
  let pendingCueAt: number | null = null;
  let prevPhase: WizardState['phase'] | null = null;
  let guidedActive = false;
  // Backend-µs instant the current test's cue STARTED (set on entering `cueing`),
  // so a "during" action instant = cueStart + offset into the low tone.
  let cueStartTUs: number | null = null;

  // ── trend (user-driven) capture state (docs/WIZARD.md "Interaction differs
  // by mode"): trend / 2-point is NOT the event repetition loop — it is a
  // START-cue → operator ramps → STOP-cue capture, then a single keep/redo.
  type TrendCapture = 'idle' | 'capturing' | 'review';
  let trendCapture: TrendCapture = 'idle';
  let trendCaptureStart: number | null = null;
  let trendCaptureEnd: number | null = null;

  // ── 2-point (user-driven) capture state. Same Start/Stop capture UX as trend,
  // but TWO windows: Capture A (the FULL state) then Capture B (the LOW state).
  // The operator holds each steady state, captures it, then we score the level
  // shift between them via runExperiment with marks.compare (docs/WIZARD.md →
  // "2-point" is a user-driven capture, one window per capture, two for 2-point).
  //   idleA      → ready to capture A (full)
  //   capturingA → A window open, holding the full state
  //   idleB      → A captured, ready to capture B (low)
  //   capturingB → B window open, holding the low state
  //   review     → both captured + scored; keep or redo
  type CmpCapture = 'idleA' | 'capturingA' | 'idleB' | 'capturingB' | 'review';
  let cmpCapture: CmpCapture = 'idleA';
  // Start edge of the window currently being captured (for the live status line;
  // the finalized windows live in cmpA / cmpB once stopped).
  let cmpCaptureStart: number | null = null;

  // React to host phase transitions to harvest marks (event mode).
  $: if (hostState) onHostPhase(hostState);

  function onHostPhase(s: WizardHostState) {
    const phase = s.fsm.phase;
    if (phase === prevPhase) return;
    const wasPhase = prevPhase;
    prevPhase = phase;
    if (!guidedActive) return;

    // Entering `cueing` (START / advance / replay) → remember when this test's
    // cue STARTED on the backend clock, so a "during" action instant can be
    // projected into the low tone.
    if (phase === 'cueing') {
      cueStartTUs = currentTUs();
    }
    // Entering `feedback`: the cue just finished → stamp the action instant for
    // this test. For a "during" cue the operator acted WHILE the low tone was
    // playing, so the instant is cue-start + the middle of the low beep (NOT
    // the cue end) — this aligns event scoring with how the operator acts. For
    // an "after" cue the operator acts at the cue end, which is now.
    if (phase === 'feedback') {
      pendingCueAt =
        cueMode === 'during' && cueStartTUs !== null
          ? cueStartTUs + duringActionOffsetUs()
          : currentTUs();
    }
    // Leaving `feedback` toward `cueing`/`done`: classify the just-finished test
    // by what the ledger recorded for this repIndex (good keeps the mark).
    if (wasPhase === 'feedback' && pendingCueAt !== null) {
      const last = s.ledger[s.ledger.length - 1];
      if (last && last.outcome === 'good') {
        guidedMarks = [...guidedMarks, { repIndex: last.repIndex, at: pendingCueAt }];
      }
      pendingCueAt = null;
    }

    // Series finished → run the analysis with what we gathered.
    if (phase === 'done' || phase === 'abandoned') {
      finishGuided(phase);
    }
  }

  /**
   * Offset (in backend µs) from cue START to the action instant for a "during"
   * cue: the MIDDLE of the low tone, where the operator is asked to act
   * while it plays. Derived from the shared cue preset so it tracks the config.
   */
  function duringActionOffsetUs(): number {
    const p = CUE_PRESETS[cueMode];
    const lowStartMs = p.high.count * (p.high.durationMs + p.gapMs);
    const lowMidMs = lowStartMs + p.low.durationMs / 2;
    return lowMidMs * 1000;
  }

  function currentTUs(): number {
    // The newest backend timestamp is our "now" on the backend monotonic clock.
    return $maxTUs;
  }

  // A viewer (copilot) can submit the verdict; route it into the host FSM.
  const unsubFeedback = onTrialFeedback((m) => {
    switch (m.action) {
      case 'success': host.success(); break;
      case 'fail': host.fail(); break;
      case 'abandon': host.abandon(); break;
      case 'skip': host.skip(); break;
    }
  });

  onDestroy(() => {
    unsub();
    unsubFeedback();
    host.destroy();
  });

  // ── target selection ──────────────────────────────────────────────────────────
  function applyPreset(p: TargetPreset) {
    target = p.label;
    setMode(p.mode); // resets any stale trend / 2-point capture when the mode flips
    cueMode = p.cue;
    idAllowStr = p.ids.map((id) => '0x' + id.toString(16).toUpperCase()).join(' ');
    if (p.direction) direction = p.direction;
  }

  function parseIds(s: string): number[] {
    return s
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => (t.toLowerCase().startsWith('0x') ? parseInt(t, 16) : parseInt(t, 10)))
      .filter((n) => Number.isFinite(n));
  }

  // ── guided experiment lifecycle (EVENT mode only) ─────────────────────────────
  // The cue during/after timing + N repetitions + per-trial feedback FSM are the
  // EVENT-mode interaction (docs/WIZARD.md). Trend uses the start/stop capture
  // below instead, so this guided loop is reached only with mode === 'event'.
  function startGuided() {
    if (!canRun()) return;
    guidedMarks = [];
    pendingCueAt = null;
    prevPhase = null;
    cueStartTUs = null;
    guidedActive = true;
    const cfg = { ...WIZARD_DEFAULTS, repetitions: Math.max(1, Math.floor(repetitions)) };
    host.start(target || '(unnamed)', cueMode, cfg);
  }

  function finishGuided(phase: 'done' | 'abandoned') {
    guidedActive = false;
    // Use the confirmed action instants (good trials) as event marks.
    eventMarks = guidedMarks.map((m) => m.at);
    if (eventMarks.length > 0) {
      runAnalysis();
    } else {
      lastRunInfo =
        phase === 'abandoned'
          ? 'series abandoned — no good trials to score'
          : 'no good trials captured';
    }
  }

  // ── trend (user-driven) capture lifecycle ─────────────────────────────────────
  // START plays the start cue and opens the window; the operator performs the
  // ramp (or holds a state); STOP plays the stop cue and closes the window, then
  // we score the captured start..stop span via runExperiment with a trend mark
  // and present a single keep/redo. No during/after, no repetition loop.
  function startTrendCapture() {
    if (!canRun()) return;
    void ensureAudioReady(); // resume audio under this user gesture
    playStartBeep();
    trendCaptureStart = currentTUs();
    trendCaptureEnd = null;
    trendCapture = 'capturing';
  }

  function stopTrendCapture() {
    if (trendCapture !== 'capturing') return;
    playStopBeep();
    trendCaptureEnd = currentTUs();
    // Feed the captured window into the analysis (trend mark over start..stop).
    trendStart = trendCaptureStart;
    trendEnd = trendCaptureEnd;
    runAnalysis();
    trendCapture = 'review';
  }

  /** Keep the captured run + its results; reset to idle for the next capture. */
  function keepTrend() {
    trendCapture = 'idle';
    trendCaptureStart = null;
    trendCaptureEnd = null;
  }

  /** Discard this capture and its results; start over. */
  function redoTrend() {
    trendCapture = 'idle';
    trendCaptureStart = null;
    trendCaptureEnd = null;
    trendStart = null;
    trendEnd = null;
    results = [];
    lastRunInfo = '';
    promoted = new Set();
  }

  // ── 2-point (user-driven) capture lifecycle ───────────────────────────────────
  // Mirrors the trend Start/Stop capture, but captures TWO windows in sequence:
  // Capture A (FULL) then Capture B (LOW). On stopping B we score the level shift
  // between the two via runExperiment with a compare mark, then offer keep/redo.

  /** Start capturing state A (the FULL state): start beep, open the A window. */
  function startCaptureA() {
    if (!canRun()) return;
    void ensureAudioReady(); // resume audio under this user gesture
    playStartBeep();
    cmpCaptureStart = currentTUs();
    cmpCapture = 'capturingA';
  }

  /** Stop capturing A: stop beep, record the A window, wait to capture B. */
  function stopCaptureA() {
    if (cmpCapture !== 'capturingA' || cmpCaptureStart === null) return;
    playStopBeep();
    const end = currentTUs();
    cmpA = { startTUs: Math.min(cmpCaptureStart, end), endTUs: Math.max(cmpCaptureStart, end) };
    cmpCaptureStart = null;
    cmpCapture = 'idleB';
  }

  /** Start capturing state B (the LOW state): start beep, open the B window. */
  function startCaptureB() {
    if (!canRun()) return;
    void ensureAudioReady();
    playStartBeep();
    cmpCaptureStart = currentTUs();
    cmpCapture = 'capturingB';
  }

  /** Stop capturing B: stop beep, record the B window, then score A↔B. */
  function stopCaptureB() {
    if (cmpCapture !== 'capturingB' || cmpCaptureStart === null) return;
    playStopBeep();
    const end = currentTUs();
    cmpB = { startTUs: Math.min(cmpCaptureStart, end), endTUs: Math.max(cmpCaptureStart, end) };
    cmpCaptureStart = null;
    runAnalysis();
    cmpCapture = 'review';
  }

  /** Keep the captured run + its results; reset to idle for the next capture. */
  function keepCmp() {
    cmpCapture = 'idleA';
  }

  /** Discard both captures and the results; start over from capture A. */
  function redoCmp() {
    cmpCapture = 'idleA';
    cmpCaptureStart = null;
    cmpA = null;
    cmpB = null;
    results = [];
    lastRunInfo = '';
    promoted = new Set();
  }

  function resetCmpCapture() {
    cmpCapture = 'idleA';
    cmpCaptureStart = null;
    cmpA = null;
    cmpB = null;
  }

  function resetTrendCapture() {
    trendCapture = 'idle';
    trendCaptureStart = null;
    trendCaptureEnd = null;
  }

  /** Switch experiment mode; reset any in-flight trend / 2-point capture so the
   *  mode interactions never leave a phantom state behind. */
  function setMode(m: Mode) {
    if (m === mode) return;
    mode = m;
    // Tear down whichever capture(s) belong to the mode(s) we just left.
    if (m !== 'trend') resetTrendCapture();
    if (m !== '2pt') resetCmpCapture();
  }

  // ── manual EVENT marks (no cue) ─────────────────────────────────────────────────
  function markEventNow() {
    eventMarks = [...eventMarks, currentTUs()];
  }
  function clearEventMarks() {
    eventMarks = [];
  }

  // ── analysis ────────────────────────────────────────────────────────────────
  function canRun(): boolean {
    return $maxTUs > 0;
  }

  function runAnalysis() {
    const ids = parseIds(idAllowStr);
    let startTUs: number;
    let endTUs: number;
    const marks: ExperimentWindow['marks'] = {};

    if (mode === 'event') {
      endTUs = $maxTUs;
      startTUs = endTUs - windowSeconds * 1e6;
      // If we have marks outside the default window, widen to include them all.
      if (eventMarks.length > 0) {
        const minMark = Math.min(...eventMarks);
        const maxMark = Math.max(...eventMarks);
        startTUs = Math.min(startTUs, minMark - 1e6); // 1s pad before first mark
        endTUs = Math.max(endTUs, maxMark + 1e6);
        marks.events = eventMarks;
      }
    } else if (mode === '2pt' && cmpA && cmpB) {
      // 2-point: the analysis window must ENCLOSE both captures so ring.window
      // returns the frames of state A and state B; the scorer slices them back
      // out by tUs from marks.compare.{a,b}.
      startTUs = Math.min(cmpA.startTUs, cmpB.startTUs);
      endTUs = Math.max(cmpA.endTUs, cmpB.endTUs);
      marks.compare = { a: cmpA, b: cmpB };
    } else {
      // trend: prefer explicit marks; else last `windowSeconds`.
      const s = trendStart ?? $maxTUs - windowSeconds * 1e6;
      const e = trendEnd ?? $maxTUs;
      startTUs = Math.min(s, e);
      endTUs = Math.max(s, e);
      marks.trend = { startTUs, endTUs, direction };
    }

    const frames = ring.window(startTUs, endTUs);
    const win: ExperimentWindow = {
      frames,
      startTUs,
      endTUs,
      marks,
      candidateIds: ids.length ? ids : undefined,
    };
    const detailed = runExperimentDetailed(win);
    // 2-point: rank the shortlist by the magnitude of the level shift |Δ| (the
    // biggest mover between FULL and LOW is the likeliest signal). Other modes
    // keep the scorer's own ordering. Sort a COPY so the slice below is stable.
    const ranked =
      detailed.info.mode === 'compare'
        ? [...detailed.candidates].sort((a, b) => absDelta(b) - absDelta(a))
        : detailed.candidates;
    results = ranked.slice(0, 5);
    promoted = new Set();
    lastRunInfo = describeRun(frames.length, detailed.info, detailed.candidates.length);
  }

  /** |Δ| for a compare candidate (0 when the delta is absent / not compare). */
  function absDelta(c: RankedCandidate): number {
    return Math.abs(c.evidence?.compareDelta ?? 0);
  }

  function describeRun(frameCount: number, info: ExperimentRunInfo, total: number): string {
    const parts = [`${frameCount} frames`, `${total} candidate${total === 1 ? '' : 's'}`];
    if (info.mode === 'event') parts.push(`${info.goodEvents ?? 0} good / ${info.totalEvents ?? 0} total`);
    if (info.mode === 'trend') parts.push(`${info.idsInWindow ?? 0} ids · ${info.framesInWindow ?? 0} frames in window`);
    if (info.mode === 'compare') parts.push(`A ${info.framesA ?? 0} · B ${info.framesB ?? 0} frames`);
    parts.push(`${info.excludedCount} byte slot${info.excludedCount === 1 ? '' : 's'} excluded (counters/checksums)`);
    return parts.join(' · ');
  }

  // ── promote a candidate to a §3.5 signal ──────────────────────────────────────
  function promote(c: RankedCandidate) {
    const base = (target || 'hunt').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const name = `${base || 'hunt'}_${idHex(c.frameId)}_b${c.bitStart}`;
    const sig = makeSignal(c.frameId, c.isExtended, {
      name,
      bitStart: c.bitStart,
      bitLength: c.bitLength,
      byteOrder: c.byteOrder,
    });
    addSignal(c.frameId, c.isExtended, sig);
    selected.set({ id: c.frameId, isExtended: c.isExtended });
    promoted = new Set([...promoted, c.id]);
  }

  function idHex(id: number): string {
    return '0x' + id.toString(16).toUpperCase();
  }
  function locus(c: RankedCandidate): string {
    if (c.bitLength === 1) return `byte${c.bitStart >> 3} bit${c.bitStart & 7}`;
    return `byte${c.bitStart >> 3} +${c.bitLength}b ${c.byteOrder === 'little' ? 'LE' : 'BE'}`;
  }

  $: showOverlay = hostState && hostState.active && hostState.fsm.phase !== 'idle';
</script>

<div class="hunt">
  <div class="banner">
    HUNT — the Wizard. Pick a target, then for an <strong>event</strong> run a
    guided experiment (cue + per-trial feedback), for a <strong>trend</strong>
    do a Start/Stop capture while you ramp the value, or for a
    <strong>2-point</strong> signal you can't ramp capture two steady states
    (full vs low); promote the top candidate to a §3.5 signal.
  </div>

  <!-- TARGET --------------------------------------------------------------- -->
  <section>
    <h4>1 · Target</h4>
    <div class="palette">
      {#each PRESETS as p}
        <button class="chip" class:sel={target === p.label} on:click={() => applyPreset(p)} title={p.hint}>
          {p.label}<span class="chipmode">{p.mode}</span>
        </button>
      {/each}
    </div>
    <div class="controls">
      <input class="target" bind:value={target} placeholder="target name (free text)" spellcheck="false" />
      <label>ids<input class="ids mono" bind:value={idAllowStr} placeholder="all" spellcheck="false" title="optional id allow-list (hex/dec, space/comma)" /></label>
    </div>
  </section>

  <!-- EXPERIMENT ----------------------------------------------------------- -->
  <section>
    <h4>2 · Experiment</h4>
    <div class="controls">
      <label class="seg">
        <button class:on={mode === 'event'} on:click={() => setMode('event')}>event</button>
        <button class:on={mode === 'trend'} on:click={() => setMode('trend')}>trend</button>
        <button class:on={mode === '2pt'} on:click={() => setMode('2pt')}>2-point</button>
      </label>
      {#if mode === 'event'}
        <!-- EVENT interaction: cue during/after timing + N repetitions + the
             per-trial feedback FSM (docs/WIZARD.md). -->
        <label>cue
          <select bind:value={cueMode}>
            <option value="during">during</option>
            <option value="after">after</option>
          </select>
        </label>
        <label>reps<input class="num" type="number" bind:value={repetitions} min="1" step="1" /></label>
        <label>window<input class="num" type="number" bind:value={windowSeconds} min="1" step="1" />s</label>
      {:else if mode === 'trend'}
        <!-- TREND interaction: a user-driven START/STOP capture. No during/after
             selector, no repetitions, no feedback FSM (docs/WIZARD.md). -->
        <label>dir
          <select bind:value={direction}>
            <option value="up">up</option>
            <option value="down">down</option>
          </select>
        </label>
      {:else}
        <!-- 2-POINT interaction: two user-driven captures (FULL then LOW). No
             direction, cue, repetitions or feedback FSM — just hold each steady
             state and capture it (docs/WIZARD.md → "2-point"). -->
        <span class="dim small">capture two steady states, then compare their levels</span>
      {/if}
    </div>

    {#if mode === 'event'}
      <div class="controls run">
        <button class="primary" on:click={startGuided} disabled={!canRun() || guidedActive}>
          ▶ Guided run
        </button>
        <span class="dim small or">or manual:</span>
        <button on:click={markEventNow} disabled={!canRun()}>Mark ({eventMarks.length})</button>
        <button on:click={clearEventMarks} disabled={eventMarks.length === 0}>Clear</button>
        <button on:click={runAnalysis} disabled={!canRun()}>Run analysis</button>
      </div>

      {#if eventMarks.length}
        <div class="marks dim small">marks: {eventMarks.length} · spanning {((Math.max(...eventMarks) - Math.min(...eventMarks)) / 1e6).toFixed(1)}s</div>
      {/if}
    {:else if mode === 'trend'}
      <!-- TREND user-driven capture: Start → ramp → Stop → keep/redo. -->
      <div class="controls run">
        {#if trendCapture === 'idle'}
          <button class="primary" on:click={startTrendCapture} disabled={!canRun()}>
            ▶ Start capture
          </button>
          <span class="dim small or">plays a start beep; ramp the value, then Stop</span>
        {:else if trendCapture === 'capturing'}
          <button class="stop primary" on:click={stopTrendCapture}>■ Stop capture</button>
          <span class="capturing small">● capturing… perform the {direction === 'up' ? 'rise' : 'fall'}</span>
        {:else}
          <span class="dim small or">captured — keep these candidates or redo the capture</span>
          <button class="primary" on:click={keepTrend}>✓ Keep</button>
          <button on:click={redoTrend}>↻ Redo</button>
        {/if}
      </div>

      {#if trendCaptureStart !== null}
        <div class="marks dim small">
          window: start set{#if trendCaptureEnd !== null} · {((trendCaptureEnd - trendCaptureStart) / 1e6).toFixed(1)}s captured{:else} · capturing…{/if}
        </div>
      {/if}
    {:else}
      <!-- 2-POINT user-driven capture: Capture A (full) → Capture B (low) →
           score the level shift → keep/redo. Mirrors the TREND Start/Stop UX,
           but with two windows in sequence. -->
      <div class="controls run">
        {#if cmpCapture === 'idleA'}
          <button class="primary" on:click={startCaptureA} disabled={!canRun()}>
            ▶ Capture A (full)
          </button>
          <span class="dim small or">hold the FULL state, then Stop</span>
        {:else if cmpCapture === 'capturingA'}
          <button class="stop primary" on:click={stopCaptureA}>■ Stop A</button>
          <span class="capturing small">● capturing A… hold the full state</span>
        {:else if cmpCapture === 'idleB'}
          <button class="primary" on:click={startCaptureB} disabled={!canRun()}>
            ▶ Capture B (low)
          </button>
          <span class="dim small or">now hold the LOW state, then Stop</span>
        {:else if cmpCapture === 'capturingB'}
          <button class="stop primary" on:click={stopCaptureB}>■ Stop B</button>
          <span class="capturing small">● capturing B… hold the low state</span>
        {:else}
          <span class="dim small or">captured — keep these candidates or redo both captures</span>
          <button class="primary" on:click={keepCmp}>✓ Keep</button>
          <button on:click={redoCmp}>↻ Redo</button>
        {/if}
      </div>

      {#if cmpA || cmpB || cmpCaptureStart !== null}
        <div class="marks dim small">
          A: {#if cmpA}{((cmpA.endTUs - cmpA.startTUs) / 1e6).toFixed(1)}s{:else if cmpCapture === 'capturingA'}capturing…{:else}—{/if}
          · B: {#if cmpB}{((cmpB.endTUs - cmpB.startTUs) / 1e6).toFixed(1)}s{:else if cmpCapture === 'capturingB'}capturing…{:else}—{/if}
        </div>
      {/if}
    {/if}
  </section>

  <!-- RESULTS -------------------------------------------------------------- -->
  <section>
    <div class="row">
      <h4>3 · Candidates <span class="dim">(top {results.length})</span></h4>
      <div class="spacer"></div>
      {#if lastRunInfo}<span class="dim small">{lastRunInfo}</span>{/if}
    </div>

    <div class="results">
      {#each results as c, i (c.id)}
        <div class="cand">
          <span class="rank">#{i + 1}</span>
          <span class="mono id">{idHex(c.frameId)}</span>
          <span class="mono bits">{locus(c)}</span>
          <div class="bar"><div class="fill" style="width:{Math.min(100, c.score * 100).toFixed(0)}%"></div></div>
          {#if c.evidence?.compareDelta !== undefined}
            <span class="mono score" title="signed level change between states (median A − median B)">Δ{c.evidence.compareDelta >= 0 ? '+' : ''}{c.evidence.compareDelta}</span>
          {:else}
            <span class="mono score">{c.score.toFixed(3)}</span>
          {/if}
          <span class="rationale dim" title={c.rationale}>{c.rationale}</span>
          <button class="promote" class:done={promoted.has(c.id)} on:click={() => promote(c)}>
            {promoted.has(c.id) ? '✓ added' : '→ signal'}
          </button>
        </div>
      {/each}
      {#if results.length === 0}
        <div class="dim small empty">
          no candidates yet — connect to the sim, buffer some traffic, then run a guided experiment
        </div>
      {/if}
    </div>
  </section>
</div>

{#if showOverlay}
  <FeedbackOverlay
    state={hostState}
    on:success={() => host.success()}
    on:fail={() => host.fail()}
    on:abandon={() => host.abandon()}
    on:skip={() => host.skip()}
    on:close={() => host.reset()}
  />
{/if}

<style>
  .hunt {
    height: 100%;
    overflow: auto;
    padding: 8px 10px;
  }
  .banner {
    font-size: 11px;
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 6px 8px;
    margin-bottom: 10px;
    color: var(--text-dim);
  }
  section {
    margin-bottom: 14px;
  }
  h4 {
    margin: 0 0 6px;
    font-size: 12px;
    font-weight: 600;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .palette {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-bottom: 6px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    font-size: 12px;
  }
  .chip.sel {
    border-color: var(--accent);
    color: var(--accent);
  }
  .chipmode {
    font-size: 9px;
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0 3px;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 4px;
  }
  .controls.run {
    margin-top: 4px;
  }
  label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--text-dim);
  }
  .target {
    flex: 1;
    min-width: 120px;
  }
  .ids {
    width: 110px;
  }
  .num {
    width: 54px;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 5px;
    overflow: hidden;
  }
  .seg button {
    border: none;
    border-radius: 0;
    background: transparent;
    padding: 4px 10px;
  }
  .seg button.on {
    background: var(--accent-dim);
    color: var(--accent);
  }
  .or {
    margin: 0 2px;
  }
  .small {
    font-size: 11px;
  }
  .stop:hover {
    border-color: var(--err);
    color: var(--err);
  }
  .capturing {
    color: var(--warn);
    font-weight: 600;
    animation: capblink 1s steps(2, start) infinite;
  }
  @keyframes capblink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }
  .marks {
    margin-top: 2px;
  }
  .cand {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 5px;
    margin-bottom: 4px;
    background: var(--bg-elev);
  }
  .rank {
    width: 22px;
    font-size: 11px;
    color: var(--text-dim);
    text-align: right;
  }
  .id {
    width: 64px;
    color: var(--accent);
  }
  .bits {
    width: 110px;
    font-size: 11px;
  }
  .bar {
    width: 90px;
    height: 8px;
    background: var(--bg);
    border-radius: 4px;
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
  }
  .score {
    width: 46px;
    text-align: right;
  }
  .rationale {
    flex: 1;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .promote.done {
    color: var(--ok);
    border-color: var(--accent-dim);
  }
  .empty {
    padding: 16px 8px;
    text-align: center;
  }
</style>
