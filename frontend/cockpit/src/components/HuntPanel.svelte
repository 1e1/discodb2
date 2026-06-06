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
    maxTUs,
    selected,
    project,
    addSignal,
    sendWizard,
    onTrialFeedback,
    huntScan,
  } from '../state/store';
  import type { RankedCandidate, ExperimentWindow, ExperimentRunInfo } from '../hunt/hunt';
  import type { HuntWindow } from '../worker/analysisApi';
  import { makeSignal, type EditableSignal } from '../protocol/datamodel';
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
  import BitActivityHeatmap from './BitActivityHeatmap.svelte';
  import ByteHistogram from './ByteHistogram.svelte';
  import SignalDiscovery from './SignalDiscovery.svelte';
  import CoOccurrence from './CoOccurrence.svelte';
  import SignalCorrelation from './SignalCorrelation.svelte';
  import type { ScanResult } from '../hunt/bitActivity';
  import type { ByteHistogramScanResult } from '../hunt/byteHistogram';
  import type { SignalDiscoveryScanResult } from '../hunt/signalDiscovery';
  import type { CoOccurrenceScanResult } from '../hunt/coOccurrence';
  import type { SignalCorrelationScanResult } from '../hunt/signalCorrelation';
  import type { SignalCandidate } from '@shared/analysis/signal-discovery.ts';
  import type { CorrelationCandidate } from '@shared/analysis/signal-correlation.ts';

  // Top-level Hunt sub-view: 'guided' = the cue/experiment/candidates flow that
  // has always been here (operator captures windows); 'scan' = the PASSIVE
  // analyzers that read the buffer with no operator action. Default 'guided' so
  // nothing regresses.
  type SubView = 'guided' | 'scan';
  let subView: SubView = 'guided';

  // 'event' = cue + repetitions + feedback FSM; 'trend' = ramp Start/Stop
  // capture; '2pt' = two steady-state captures (FULL vs LOW) for an ANALOG signal
  // you can't ramp (docs/WIZARD.md → "2-point"); 'flag' = the SAME two-window
  // capture, but for a DISCRETE byte that toggles (handbrake on/off, reverse,
  // ignition) or a small flag exchange — ranks the byte(s) that CHANGED A↔B,
  // emphasizing changes confined to ≤2 bytes (docs/WIZARD.md → "Flag").
  type Mode = 'event' | 'trend' | '2pt' | 'flag';

  // The two-window capture flow (Capture A → Capture B → score → keep/redo) is
  // identical for '2pt' and 'flag' — only the labels and the mark we set differ
  // — so both REUSE the cmp* capture state machine below. This predicate keeps
  // the shared branches readable, and these label words specialize the prompts:
  // '2pt' captures FULL/LOW analog levels, 'flag' captures OFF/ON discrete states.
  $: isTwoWindow = mode === '2pt' || mode === 'flag';
  $: cmpLabelA = mode === 'flag' ? 'off' : 'full'; // state A prompt word
  $: cmpLabelB = mode === 'flag' ? 'on' : 'low'; // state B prompt word

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
    // FLAG presets: capture the byte that toggles between two held states.
    { label: 'Handbrake flag', mode: 'flag', cue: 'after', ids: [0x5a0], hint: 'capture A off, then B on (0x5A0)' },
    { label: 'Reverse flag', mode: 'flag', cue: 'after', ids: [0x5a0], hint: 'capture A not-in-reverse, then B in reverse' },
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

  // ── Two-window (user-driven) capture state, SHARED by '2pt' and 'flag'. Same
  // Start/Stop capture UX as trend, but TWO windows: Capture A then Capture B.
  // The operator holds each steady state, captures it, then we score A↔B via
  // runExperiment — with marks.compare for '2pt' (rank the analog LEVEL shift)
  // or marks.flags for 'flag' (rank the DISCRETE byte(s) that changed). Only the
  // labels (FULL/LOW vs OFF/ON) and the mark differ; the state machine is one
  // (docs/WIZARD.md → user-driven capture, one window per capture, two here).
  //   idleA      → ready to capture A (full / OFF)
  //   capturingA → A window open, holding state A
  //   idleB      → A captured, ready to capture B (low / ON)
  //   capturingB → B window open, holding state B
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

  /** Switch experiment mode; reset any in-flight trend / two-window capture so the
   *  mode interactions never leave a phantom state behind. */
  function setMode(m: Mode) {
    if (m === mode) return;
    const wasTwoWindow = mode === '2pt' || mode === 'flag';
    const nowTwoWindow = m === '2pt' || m === 'flag';
    mode = m;
    // Tear down whichever capture(s) belong to the mode(s) we just left. The
    // cmp* capture is shared by '2pt'/'flag', so only reset it when leaving the
    // two-window family entirely (switching 2pt↔flag keeps any captured windows,
    // letting the operator re-score the same A/B under the other question).
    if (m !== 'trend') resetTrendCapture();
    if (wasTwoWindow && !nowTwoWindow) resetCmpCapture();
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

  async function runAnalysis() {
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
    } else if (isTwoWindow && cmpA && cmpB) {
      // 2-point / flag: the analysis window must ENCLOSE both captures so
      // ring.window returns the frames of state A and state B; the scorer slices
      // them back out by tUs. '2pt' sets marks.compare (rank the analog level
      // shift); 'flag' sets marks.flags (rank the discrete byte(s) that changed).
      startTUs = Math.min(cmpA.startTUs, cmpB.startTUs);
      endTUs = Math.max(cmpA.endTUs, cmpB.endTUs);
      if (mode === 'flag') marks.flags = { a: cmpA, b: cmpB };
      else marks.compare = { a: cmpA, b: cmpB };
    } else {
      // trend: prefer explicit marks; else last `windowSeconds`.
      const s = trendStart ?? $maxTUs - windowSeconds * 1e6;
      const e = trendEnd ?? $maxTUs;
      startTUs = Math.min(s, e);
      endTUs = Math.max(s, e);
      marks.trend = { startTUs, endTUs, direction };
    }

    // The experiment runs in the analysis worker over its own ring (DESIGN
    // §6.1.2); we await the ranked candidates.
    const r = await huntScan({ kind: 'experiment', startTUs, endTUs, marks, candidateIds: ids.length ? ids : undefined });
    if (r.kind !== 'experiment') return;
    // 2-point: rank the shortlist by the magnitude of the level shift |Δ| (the
    // biggest mover between FULL and LOW is the likeliest signal). Other modes
    // keep the scorer's own ordering. Sort a COPY so the slice below is stable.
    const ranked =
      r.info.mode === 'compare'
        ? [...r.candidates].sort((a, b) => absDelta(b) - absDelta(a))
        : r.candidates;
    results = ranked.slice(0, 5);
    promoted = new Set();
    lastRunInfo = describeRun(r.frameCount, r.info, r.candidates.length);
  }

  /** |Δ| for a compare candidate (0 when the delta is absent / not compare). */
  function absDelta(c: RankedCandidate): number {
    return Math.abs(c.evidence?.compareDelta ?? 0);
  }

  function describeRun(frameCount: number, info: ExperimentRunInfo, total: number): string {
    const parts = [`${frameCount} frames`, `${total} candidate${total === 1 ? '' : 's'}`];
    if (info.mode === 'event') parts.push(`${info.goodEvents ?? 0} good / ${info.totalEvents ?? 0} total`);
    if (info.mode === 'trend') parts.push(`${info.idsInWindow ?? 0} ids · ${info.framesInWindow ?? 0} frames in window`);
    if (info.mode === 'compare' || info.mode === 'flag') parts.push(`A ${info.framesA ?? 0} · B ${info.framesB ?? 0} frames`);
    parts.push(`${info.excludedCount} byte slot${info.excludedCount === 1 ? '' : 's'} excluded (counters/checksums)`);
    return parts.join(' · ');
  }

  // ── SCAN: passive bit-activity heatmap ────────────────────────────────────────
  // No operator action: scan a window of the ring buffer and surface, per id ×
  // bit, how often that bit CHANGED (toggle frequency). Reuses the SAME ring
  // window helpers and the SAME id parser as the guided path; the analyzer +
  // tagger live in the pure shared package via the src/hunt/bitActivity seam.
  // Which passive analyzer the Scan view shows. 'bits' = the bit-activity
  // heatmap (which bits MOVE); 'hist' = the per-byte VALUE histogram (how a
  // byte's value is distributed: few values ⇒ enum/flag, wide spread ⇒ analog);
  // 'sweep' = the SIGNAL-DISCOVERY SWEEP (read candidate bit-ranges as numbers
  // under multiple conventions and rank the physically-plausible/smooth ones);
  // 'cooc' = the CO-OCCURRENCE OF CHANGES matrix (which BYTES change TOGETHER —
  // adjacent co-changing bytes ⇒ a multi-byte value; a byte driven by many ⇒ a
  // multiplexor/checksum); 'corr' = CORRELATION AGAINST A KNOWN SIGNAL (rank loci
  // by Spearman correlation with a reference §3.5 signal the operator already
  // decoded — the "find the gear by correlating against rpm/speed" tool). Default
  // 'bits' so the existing heatmap stays the landing analyzer.
  type Analyzer = 'bits' | 'hist' | 'sweep' | 'cooc' | 'corr';
  let analyzer: Analyzer = 'bits';

  let scanWindowMode: 'recent' | 'all' = 'recent';
  let scanSeconds = 30; // window for the 'recent' mode
  let scanIdStr = ''; // optional id allow-list (hex/dec), empty = all ids
  let scanResult: ScanResult | null = null;
  let histResult: ByteHistogramScanResult | null = null;
  let sweepResult: SignalDiscoveryScanResult | null = null;
  let coocResult: CoOccurrenceScanResult | null = null;
  let corrResult: SignalCorrelationScanResult | null = null;
  // Candidate keys already promoted from the sweep (so the row shows ✓ added).
  let sweepPromoted = new Set<string>();
  // Candidate keys already promoted from the correlation analyzer.
  let corrPromoted = new Set<string>();
  // The chosen reference signal (EditableSignal.id) for the correlation analyzer.
  let corrReferenceId = '';
  let scanInfo = '';
  // id → isExtended over the last scan window, posted by the worker — lets
  // scanIsExtended() stay a synchronous lookup (the heatmap's isExtendedFor prop)
  // with no ring on the main thread.
  let scanIsExtMap: Record<number, boolean> = {};

  // The §3.5 signals the operator can pick as a correlation reference: every signal
  // across the project's frames (a known, decoded signal — rpm/speed/etc). Reactive
  // so a freshly-promoted signal becomes available as a reference immediately.
  $: referenceSignals = ($project.frames ?? []).flatMap(
    (fr) => (fr.signals as EditableSignal[]) ?? [],
  );
  $: corrReference = referenceSignals.find((s) => s.id === corrReferenceId) ?? null;

  /** The ring window the scans run over (mirrors the window control). */
  function huntWindowReq(): HuntWindow {
    return scanWindowMode === 'recent' ? { mode: 'recent', seconds: scanSeconds } : { mode: 'all' };
  }

  async function runScan() {
    if (!canRun()) return;
    const ids = parseIds(scanIdStr);
    const allow = ids.length ? ids : undefined;
    // The five passive analyzers run off ONE window in the analysis worker (DESIGN
    // §6.1.2) so the analyzer toggle is instant (no re-scan) and the views agree.
    // The sweep narrows to the `selected` id when set (chains off a heatmap click);
    // else it honours the same allow-list. Correlation runs only with a reference.
    const sweepAllow = selectedId !== null ? [selectedId] : allow;
    const r = await huntScan({ kind: 'scanAll', window: huntWindowReq(), allow, sweepAllow, corrReference });
    if (r.kind !== 'scanAll') return;
    scanResult = r.scan;
    histResult = r.hist;
    sweepResult = r.sweep;
    coocResult = r.cooc;
    corrResult = r.corr;
    scanIsExtMap = r.isExtended; // id→isExtended for the synchronous heatmap lookup
    sweepPromoted = new Set();
    corrPromoted = new Set();
    const a = r.scan.activity;
    const span = scanWindowMode === 'recent' ? `last ${scanSeconds}s` : 'whole buffer';
    scanInfo = `${span} · ${a.framesAnalyzed} frames analyzed · ${a.idCount} ids`;
  }

  // The byte histogram targets the currently `selected` id (clicking a heatmap
  // row sets it via pickScanId, so the two analyzers chain naturally). Null when
  // nothing is selected → the histogram shows its "select an id" hint.
  $: selectedId = $selected ? $selected.id : null;

  /** A clicked heatmap row jumps the operator to that id in the Inspector. */
  function pickScanId(id: number, isExtended: boolean) {
    selected.set({ id, isExtended });
  }

  /** isExtended for an id, from the map the worker posted with the last scan
   *  (scan keys on numeric id only). Synchronous lookup — no ring on this thread. */
  function scanIsExtended(id: number): boolean {
    return scanIsExtMap[id] ?? false;
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

  /**
   * Promote a SIGNAL-DISCOVERY SWEEP candidate to a §3.5 signal, reusing the SAME
   * addSignal/makeSignal path as promote() above. The sweep candidate already
   * carries the full locus (bitStart in decode.ts numbering, width, byteOrder,
   * signed, factor), so makeSignal maps 1:1 and the promoted signal decodes
   * identically to what the sweep scored.
   */
  function promoteSweep(c: SignalCandidate) {
    const name = `${idHex(c.id)}_b${c.bitStart}_w${c.width}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const sig = makeSignal(c.id, sweepIsExtended(c.id), {
      name,
      bitStart: c.bitStart,
      bitLength: c.width,
      byteOrder: c.byteOrder,
      signed: c.signed,
      factor: c.factor,
    });
    addSignal(c.id, sweepIsExtended(c.id), sig);
    selected.set({ id: c.id, isExtended: sweepIsExtended(c.id) });
    sweepPromoted = new Set([...sweepPromoted, c.key]);
  }

  /** isExtended for a sweep id (reuses the same window lookup as the heatmap). */
  function sweepIsExtended(id: number): boolean {
    return scanIsExtended(id);
  }

  /** Operator picked (or changed) the correlation reference: re-run ONLY the
   *  correlation analyzer in the worker over the current window with the new
   *  reference (no full re-scan). Honours the same id allow-list. */
  async function pickCorrReference(refId: string) {
    corrReferenceId = refId;
    const ref = referenceSignals.find((s) => s.id === refId) ?? null;
    if (!ref || !canRun()) {
      corrResult = null;
      return;
    }
    const ids = parseIds(scanIdStr);
    const allow = ids.length ? ids : undefined;
    const r = await huntScan({ kind: 'correlation', window: huntWindowReq(), allow, reference: ref });
    if (r.kind === 'correlation') corrResult = r.corr;
    corrPromoted = new Set();
  }

  /**
   * Promote a CORRELATION candidate to a §3.5 signal, reusing the SAME
   * addSignal/makeSignal path as promoteSweep(). The candidate carries the full
   * locus (bitStart in decode.ts numbering, width, byteOrder, signed), so makeSignal
   * maps 1:1 and the promoted signal decodes identically to what was correlated.
   */
  function promoteCorr(c: CorrelationCandidate) {
    const name = `${idHex(c.id)}_b${c.bitStart}_w${c.width}_corr`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const ext = sweepIsExtended(c.id);
    const sig = makeSignal(c.id, ext, {
      name,
      bitStart: c.bitStart,
      bitLength: c.width,
      byteOrder: c.byteOrder,
      signed: c.signed,
    });
    addSignal(c.id, ext, sig);
    selected.set({ id: c.id, isExtended: ext });
    corrPromoted = new Set([...corrPromoted, c.key]);
  }

  function idHex(id: number): string {
    return '0x' + id.toString(16).toUpperCase();
  }
  function locus(c: RankedCandidate): string {
    if (c.bitLength === 1) return `byte${c.bitStart >> 3} bit${c.bitStart & 7}`;
    return `byte${c.bitStart >> 3} +${c.bitLength}b ${c.byteOrder === 'little' ? 'LE' : 'BE'}`;
  }
  /** Flag-mode A→B transition badge ("00→01" or a single bit "0→1"). */
  function flagAB(c: RankedCandidate): string {
    const a = c.evidence?.flagValueA ?? 0;
    const b = c.evidence?.flagValueB ?? 0;
    // A single-bit locus shows the bit's 0/1; a whole-byte change shows the hex bytes.
    if (c.bitLength === 1) {
      const bit = c.bitStart & 7;
      return `${(a >> bit) & 1}→${(b >> bit) & 1}`;
    }
    const hex = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
    return `${hex(a)}→${hex(b)}`;
  }

  $: showOverlay = hostState && hostState.active && hostState.fsm.phase !== 'idle';
</script>

<div class="hunt">
  <!-- SUB-NAV: Guided (operator-driven experiments) vs Scan (passive analyzers).
       Default Guided so the existing flow is unchanged. -->
  <div class="subnav seg">
    <button class:on={subView === 'guided'} on:click={() => (subView = 'guided')}>Guided</button>
    <button class:on={subView === 'scan'} on:click={() => (subView = 'scan')}>Scan</button>
  </div>

  {#if subView === 'guided'}
  <div class="banner">
    HUNT — the Wizard. Pick a target, then for an <strong>event</strong> run a
    guided experiment (cue + per-trial feedback), for a <strong>trend</strong>
    do a Start/Stop capture while you ramp the value, for a
    <strong>2-point</strong> signal you can't ramp capture two steady states
    (full vs low), or for a <strong>flag</strong> capture two states (off vs on)
    to find the byte(s) that toggle; promote the top candidate to a §3.5 signal.
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
        <button class:on={mode === 'flag'} on:click={() => setMode('flag')}>flag</button>
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
      {:else if mode === '2pt'}
        <!-- 2-POINT interaction: two user-driven captures (FULL then LOW). No
             direction, cue, repetitions or feedback FSM — just hold each steady
             state and capture it (docs/WIZARD.md → "2-point"). -->
        <span class="dim small">capture two steady states, then compare their levels</span>
      {:else}
        <!-- FLAG interaction: two user-driven captures (state OFF then ON),
             same as 2-point but ranking the DISCRETE byte(s) that changed,
             ≤2-byte-confined (docs/WIZARD.md → "Flag"). -->
        <span class="dim small">capture two states (off/on), then find the byte(s) that changed</span>
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
      <!-- 2-POINT / FLAG user-driven capture (shared): Capture A → Capture B →
           score A↔B → keep/redo. Mirrors the TREND Start/Stop UX, but with two
           windows in sequence. The state words come from cmpLabelA/cmpLabelB
           (full/low for 2-point, off/on for flag); the scorer is chosen by mode
           in runAnalysis. -->
      <div class="controls run">
        {#if cmpCapture === 'idleA'}
          <button class="primary" on:click={startCaptureA} disabled={!canRun()}>
            ▶ Capture A ({cmpLabelA})
          </button>
          <span class="dim small or">hold the {cmpLabelA.toUpperCase()} state, then Stop</span>
        {:else if cmpCapture === 'capturingA'}
          <button class="stop primary" on:click={stopCaptureA}>■ Stop A</button>
          <span class="capturing small">● capturing A… hold the {cmpLabelA} state</span>
        {:else if cmpCapture === 'idleB'}
          <button class="primary" on:click={startCaptureB} disabled={!canRun()}>
            ▶ Capture B ({cmpLabelB})
          </button>
          <span class="dim small or">now hold the {cmpLabelB.toUpperCase()} state, then Stop</span>
        {:else if cmpCapture === 'capturingB'}
          <button class="stop primary" on:click={stopCaptureB}>■ Stop B</button>
          <span class="capturing small">● capturing B… hold the {cmpLabelB} state</span>
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
          {:else if c.evidence?.flagValueA !== undefined}
            <span class="mono score" title="dominant byte value held in state A → state B">{flagAB(c)}</span>
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
  {:else}
  <!-- SCAN: PASSIVE analyzers (no operator action). First analyzer = the
       BIT-ACTIVITY HEATMAP: per id × bit, how often the bit toggled over a
       window. Bright = busy, dim = constant; amber underline = a byte the
       tagger flagged as a counter/checksum (busy but not real signal). -->
  <div class="banner">
    SCAN — passive structure finder. No cue, no capture: pick a window, then read
    structure four ways. The <strong>bit-activity heatmap</strong> shows which
    bits MOVE (toggle frequency); the <strong>byte histogram</strong> shows HOW
    each byte's value is distributed for the selected id — few discrete values ⇒
    enum/flag, a wide spread ⇒ analog; the <strong>signal discovery</strong> sweep
    reads candidate bit-ranges as numbers under multiple conventions (width,
    endian, signed, scale) and ranks the physically-plausible (smoothly-varying)
    ones, with one-click promote to a §3.5 signal; <strong>co-occurrence</strong>
    shows which BYTES change TOGETHER for the selected id — adjacent co-changing
    bytes ⇒ a multi-byte value, a byte driven by many ⇒ a multiplexor/checksum;
    <strong>correlation</strong> ranks loci by how tightly they co-vary (Spearman ρ)
    with a known §3.5 signal you pick as a reference — e.g. find the GEAR by
    correlating against RPM or SPEED. Bytes the tagger marks as counters/checksums
    are flagged (and excluded from the sweep/correlation) so you can ignore that
    noise. Click a heatmap id row to select it, then switch analyzers to study that
    id.
  </div>

  <section>
    <div class="row">
      <h4>Passive analyzers</h4>
      <div class="spacer"></div>
      <label class="seg">
        <button class:on={analyzer === 'bits'} on:click={() => (analyzer = 'bits')}>Bit activity</button>
        <button class:on={analyzer === 'hist'} on:click={() => (analyzer = 'hist')}>Byte histogram</button>
        <button class:on={analyzer === 'sweep'} on:click={() => (analyzer = 'sweep')}>Signal discovery</button>
        <button class:on={analyzer === 'cooc'} on:click={() => (analyzer = 'cooc')}>Co-occurrence</button>
        <button class:on={analyzer === 'corr'} on:click={() => (analyzer = 'corr')}>Correlation</button>
      </label>
    </div>
    <div class="controls">
      <label class="seg">
        <button class:on={scanWindowMode === 'recent'} on:click={() => (scanWindowMode = 'recent')}>recent</button>
        <button class:on={scanWindowMode === 'all'} on:click={() => (scanWindowMode = 'all')}>whole buffer</button>
      </label>
      {#if scanWindowMode === 'recent'}
        <label>window<input class="num" type="number" bind:value={scanSeconds} min="1" step="1" />s</label>
      {/if}
      <label>ids<input class="ids mono" bind:value={scanIdStr} placeholder="all" spellcheck="false" title="optional id allow-list (hex/dec, space/comma)" /></label>
      <button class="primary" on:click={runScan} disabled={!canRun()}>↻ Scan</button>
      {#if scanInfo}<span class="dim small">{scanInfo}</span>{/if}
    </div>

    {#if analyzer === 'bits'}
      {#if scanResult}
        <BitActivityHeatmap scan={scanResult} onPickId={pickScanId} isExtendedFor={scanIsExtended} />
      {:else}
        <div class="dim small empty">
          no scan yet — connect to the sim, buffer some traffic, then press Scan
        </div>
      {/if}
    {:else if analyzer === 'hist'}
      {#if histResult}
        <ByteHistogram scan={histResult} targetId={selectedId} />
      {:else}
        <div class="dim small empty">
          no scan yet — connect to the sim, buffer some traffic, then press Scan
        </div>
      {/if}
    {:else if analyzer === 'sweep'}
      <SignalDiscovery scan={sweepResult} promoted={sweepPromoted} onPromote={promoteSweep} />
    {:else if analyzer === 'cooc'}
      {#if coocResult}
        <CoOccurrence scan={coocResult} targetId={selectedId} />
      {:else}
        <div class="dim small empty">
          no scan yet — connect to the sim, buffer some traffic, then press Scan
        </div>
      {/if}
    {:else}
      <SignalCorrelation
        scan={corrResult}
        references={referenceSignals}
        referenceId={corrReferenceId}
        promoted={corrPromoted}
        onPromote={promoteCorr}
        onPickReference={pickCorrReference}
      />
    {/if}
  </section>
  {/if}
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
  .subnav {
    margin-bottom: 10px;
  }
  .subnav button {
    padding: 5px 16px;
    font-size: 12px;
    font-weight: 600;
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
