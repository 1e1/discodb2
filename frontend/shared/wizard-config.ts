// Tunable Wizard parameters. Everything the operator might want to change lives
// here (no magic numbers buried in the UI). See docs/WIZARD.md.

export interface WizardConfig {
  /** Target number of GOOD (confirmed ✓) trials per signal. */
  repetitions: number;
  /** Window to confirm success/fail before escalating, in ms. */
  feedbackTimeoutMs: number;
  /** Abandon/Skip prompt window; no action here replays the current test, in ms. */
  retryPromptTimeoutMs: number;
  /** Consecutive silences (no manifestation) before auto-abandon. */
  silenceGuard: number;
  /** Latency guard around each cue, in ms (human + CAN reaction). */
  cueGuardMs: number;
  /** Event mode: min fraction of good trials a bit must match (0..1). */
  eventConsistency: number;
  /** Trend mode: min |Spearman rho| for a candidate to be kept (0..1). */
  trendMinSpearman: number;
}

export const WIZARD_DEFAULTS: WizardConfig = {
  repetitions: 3,
  feedbackTimeoutMs: 7000,
  retryPromptTimeoutMs: 3000,
  silenceGuard: 5,
  cueGuardMs: 300,
  eventConsistency: 0.8,
  trendMinSpearman: 0.6,
};
