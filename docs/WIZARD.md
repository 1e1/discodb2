# Wizard — detection assistant (design)

The Wizard turns a physical action into a ranked shortlist of candidate
bits/signals. It orchestrates the experiment (audible cues + per-trial feedback)
and scores candidates; it fills the cockpit seam:

```ts
runExperiment(window): RankedCandidate[]
//   window.marks = { events?: {at, quality}[];                  // event mode
//                    trend?:  {startTUs, endTUs, direction} }   // trend / 2-point mode
```

All analysis is pure and client-side; tunable numbers live in
[`frontend/shared/wizard-config.ts`](../frontend/shared/wizard-config.ts); cue
sounds in [`frontend/shared/cue-config.ts`](../frontend/shared/cue-config.ts).

## Distributed execution

One session, computed once, shared:

- **Host** (the most capable device — the cockpit PC): buffers frames, runs the
  analysis (tagger + scorers), drives the cue schedule.
- **Backend**: *relays* small Wizard state/feedback messages between clients
  (control channel) — it never computes. Negligible load, safe on a Pi 1.
- **Viewers** (copilot phone, 2nd screen): display the flow + top 3-5 candidates,
  play the cue locally from the shared state, and can submit feedback.

During a run the UI focuses on the Wizard + the top candidates.

## Modes

- **Event** (`marks.events`): a bit/flag that flips in phase with the action
  (handbrake, reverse, ignition).
- **Trend** (`marks.trend`): a decoded value that rises/falls over a window
  (RPM ramp, speed) — reversible, so rise-then-fall is the strong discriminator.
- **2-point** (a trend sub-case): compare two captured states (tank full vs low)
  for signals you can't ramp.

If both a (non-empty) `events` list and a `trend` window are present, **event mode
is scored** — discrete confirmed instants are the more specific evidence.

**Interaction differs by mode:**
- **Event** uses the cue's `during`/`after` timing, N repetitions, and the per-trial
  feedback FSM below.
- **Trend** and **2-point** are **user-driven captures**: a **start** cue, the
  operator performs the ramp (or holds a state), then **stops when they choose**
  (a **stop** cue). There is **no during/after** and no repeated-trial loop — one
  window per capture (two for 2-point), with a single keep/redo. The feedback FSM
  below applies to **event mode**.

## Scoring

- **Brick 0 — counter/checksum tagger** (foundation; built first). Tags bytes that
  are free-running counters (constant step mod 2^k) or checksums (XOR/sum/CRC over
  the others). Tagged bytes are excluded from candidate lists, so they never
  produce false positives.
- **Event scorer**: per candidate bit, score = fraction of **good** trials where
  the bit differs between the action and rest segments *in the same direction*
  (with a latency guard around the cue). Keep if ≥ `eventConsistency`. Chatter and
  counters self-reject (they also change at rest).
- **Trend scorer**: per candidate field (id × offset × {8,16} × {BE,LE} × signed),
  Spearman ρ(value, time) + Theil–Sen slope sign (robust to slosh). Keep if
  |ρ| ≥ `trendMinSpearman` and the sign matches. A wrapping counter is a sawtooth →
  ρ ≈ 0 over a multi-wrap window → self-rejects; the tagger covers the rest.

Only **good** trials feed the scorer; the UI reports "N good / M total".

## Per-trial feedback (FSM)

For each test (= one repetition) in a series:

1. Play the cue (`during`/`after` preset).
2. Show the feedback request large, for `feedbackTimeoutMs` (7 s):
   - **✓ Success** (easy button + a11y shortcut / Enter-Space) → trial GOOD → next
     test; reset the silence counter.
   - **✗ Fail** (small, deliberate button) → **repeat this test**; reset the
     silence counter (the operator manifested — no guard-rail tick).
   - **No response at 7 s** → switch to **[ Abandon ] [ Skip to next ]**
     for `retryPromptTimeoutMs` (3 s):
       - **Abandon** → end the series.
       - **Skip** → mark this rep not-completed, go to the next test.
       - **still no response** → `silences++` and **replay the current test**
         (lets the driver retry hands-free, better focused).
3. `silences == silenceGuard` (5) consecutive → **auto-abandon** (guard-rail).

Any manifestation (✓ / ✗ / Abandon / Skip) resets `silences` to 0.

SKIP records `recordTrial:skipped` (not-completed), distinct from `recordTrial:failed`
(a ✗ miss), so the results screen can separate them for an honest "N good / M total".

### UI obligations (the FSM is logic-only)

The reducer is pure and total; these are the host's responsibilities the UI phase must honour:

- **Cue watchdog.** The `cueing` phase has no escape but `CUE_DONE`; the host MUST
  synthesize `CUE_DONE` (or `ABANDON`) if the cue overruns `cueTotalMs` by a margin
  (audio stall / lost focus) and keep a visible stop control — never wedge the operator.
- **A11y default = SUCCESS only.** Enter / Space / single-switch / voice "OK" map to
  `SUCCESS`; `FAIL` is a distinct, smaller, deliberate control, never default-focused.
- **Abandon reason from state.** For `abandoned`, `silence === silenceGuard` means the
  guard-rail auto-stopped vs an explicit `ABANDON` — show honest, distinct copy.
- **Silence countdown.** On each silent replay, show progress toward the guard
  (`silence` / `silenceGuard`) so a hands-free operator sees the budget before auto-abandon.
- **Progress from state.** Drive "test N / good G / M total" from `good`, `repetitions`
  and the `recordTrial:*` stream — NOT from the `advance` effect.
- **Re-entry by reinstantiation.** `done` / `abandoned` are terminal; the next signal
  starts a fresh `initialState()`.

## Contract additions (integration backlog)

- Control-channel `wizard` message (host → viewers: state + top candidates).
- Control-channel `trialFeedback` message (any device → host).

## Status

Design locked. Building **Brick 0 — the counter/checksum tagger** first
(`frontend/shared/analysis/`), with synthetic tests + a sim-fixture demo.
