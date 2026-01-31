// The few UNAVOIDABLE driver-facing WORDS, in ENGLISH (the project's official
// language — driver-facing words included).
//
// This is the central UI-string module, kept intentionally tiny: a STRICT,
// frozen string set, NOT (yet) an i18n framework. The copilot is audio-led and
// icon/colour/number-first; words appear only where a glyph would be ambiguous
// (the verdict controls, GO, the maneuver fallback, the terminal verdicts). The
// whole UI vocabulary lives here so a future i18n can re-key this map into
// locales cleanly without re-hunting hardcoded strings across components.

export const STR = {
  // The single huge ACTION word on the cue screen — the instruction the driver
  // reads in one glance WHEN audio is unavailable (the visual half of H1's
  // audio+visual guarantee). Short, all-caps, readable at arm's length.
  go: "GO", //            act NOW (on the low "go" beep)

  // Verdict controls (the per-trial feedback request).
  success: "Success", // ✓ success — the big, easy, default control
  fail: "Fail", //       ✗ fail — the small, deliberate, separated control
  abandon: "Abandon", // end the series
  skip: "Skip", //        skip this rep, go to the next

  // The feedback "act now" screen — the single token over the big icon
  // (the colour wash + ✓?✕ icon carry the rest; never a bare "?" glyph). A4.
  verdict: "Verdict", // "report now: did it work?"

  // The always-visible STOP affordance during a session (H3) — sends ABANDON,
  // which the shared FSM accepts in any non-terminal phase.
  stop: "STOP",

  // Action timing of the cue — SINGLE tokens, shown WITH the 🔊/⏱ icon that
  // carries the "…the beep" sense, so the glance surface stays one word (A4).
  during: "During", // act WHILE the low beep plays
  after: "After", //    act once the cue ends

  // Terminal verdicts (shown on a parked screen, under a big ✓ / ✕ glyph).
  done: "Done", //       series complete (target reached)
  stopped: "Stopped", // explicit abandon
  autoStop: "Auto", //   guard-rail auto-stop (single token; ✕ + colour wash carry "abandon")

  // Generic fallback maneuver label (when the host sends none).
  maneuver: "Maneuver",

  // Tiny status words.
  beep: "Beep…", //        the cue is playing
  candidate: "Candidate", // leading candidate caption

  // Audio-muted hint — a SINGLE token shown small under the visual cue when the
  // local speaker cannot sound (iOS context still suspended). The 🔇 icon + the
  // big visual cue carry "follow the screen"; one word keeps the glance surface
  // readable (A4).
  muted: "Muted", // "sound off"

  // Down/offline connection token (single word — the dot SHAPE + red carry it).
  offline: "Offline",
} as const;
