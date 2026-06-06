// discodb2 protocol + data-model types — COPILOT side.
//
// CONSOLIDATED on the canonical, framework-free `@shared/protocol.ts` (the
// version both apps share). The §3.5 data model (Signal / FrameDef / Project),
// §3.4 health (Health + sub-shapes), and §3.3 control messages live there ONCE;
// this module re-exports them so the rest of the copilot keeps importing from a
// single local path, and adds only the COPILOT-SPECIFIC bits the shared module
// deliberately omits:
//
//   • a DECODED hot-path `CanRecord` (absolute µs + masked id) — distinct from
//     the shared wire-shaped record (dtUs offset + raw canId word), because the
//     copilot's parser resolves each record synchronously into watches;
//   • the client→server message UNION including `trialFeedback` (a VIEWER may
//     send verdicts; the shared `ClientMessage` is the backend's command set and
//     does not carry the Wizard relay, which the backend fans out verbatim).

import type {
  ErrorMsg,
  FilesMsg,
  Health,
  HelloMsg,
  ListFilesMsg,
  RecordStartMsg,
  RecordStopMsg,
  StartMsg,
  StopMsg,
} from "@shared/protocol.ts";
import type { LogbookCmdClientMsg } from "./logbook";

// ─── §3.5 data model · §3.4 health · §3.3 control — re-exported from shared ───
export type {
  // §3.5 data model
  ByteOrder,
  Signal,
  FrameDef,
  Project,
  // §3.4 health
  Health,
  BusHealth,
  StreamHealth,
  RecordHealth,
  ProcHealth,
  // §3.3 control
  CanSource,
  ClientKind,
  HelloMsg,
  StartMsg,
  StopMsg,
  RecordStartMsg,
  RecordStopMsg,
  ListFilesMsg,
  // §3.4 server text
  FilesMsg,
  ErrorMsg,
} from "@shared/protocol.ts";

// ─── §3.2 Frame stream (DECODED record) — copilot-specific hot-path shape ─────

/**
 * A single decoded CAN record from a binary batch.
 *
 * NOTE: this is the copilot's resolved, consume-immediately shape (absolute
 * backend µs, identifier already masked to bits 0–28, flags split out) — NOT
 * the shared wire record (`dtUs` offset + raw `canId` word). The light client
 * never buffers history; the parser fills ONE reused instance of this and the
 * sink reads it synchronously.
 */
export interface CanRecord {
  /** Absolute timestamp in backend monotonic µs: batch base_t_us + dt_us. */
  tUs: number;
  /** Arbitration id, bits 0–28 (already masked). */
  id: number;
  /** bit30 of the raw can_id field. */
  isError: boolean;
  /** bit31 of the raw can_id field (29-bit extended). */
  isExtended: boolean;
  dlc: number;
  /** bit0 of rec_flags. */
  isRtr: boolean;
  /**
   * The 8 payload data bytes. NOTE: this is a view backed by a single shared
   * scratch buffer that the parser reuses across records to avoid per-frame
   * allocation (bounded-memory posture). Consumers must read what they need
   * synchronously inside the per-record callback and must NOT retain the array.
   */
  data: Uint8Array;
}

// ─── §3.3 Control (client→server) — copilot union (adds trialFeedback) ────────

/**
 * §3.3 Wizard relay — control channel, any device → host. The backend fans this
 * out verbatim to the cockpit (host); it never interprets it. The copilot SENDS
 * these (the operator's per-trial verdict) but is otherwise a viewer. This is
 * NOT part of the shared `ClientMessage` command union (which is the backend's
 * command set); the copilot carries it as a local extension.
 */
export interface TrialFeedbackClientMsg {
  type: "trialFeedback";
  action: "success" | "fail" | "abandon" | "skip";
  at: number;
}

/**
 * §3.3 huntMark — control channel, any device → host. The operator marks a CLOSED
 * time span `[from,to]` (backend-monotonic µs, §4.2) as contamination to EXCLUDE
 * from the active hunt's evidence. The copilot SENDS this once, when the operator
 * closes the exclusion window; the backend fans it out verbatim and the host owns
 * the exclusion strategy (drop vs negative-baseline — DESIGN §3.3). Like
 * `trialFeedback`, a local sender extension, not part of the backend command set.
 */
export interface HuntMarkClientMsg {
  type: "huntMark";
  kind: "exclude";
  from: number;
  to: number;
}

/**
 * Everything the copilot may send: the shared backend command set plus the
 * Wizard `trialFeedback` / `huntMark` relays. Spelled out so it stays a closed
 * discriminated union the client can exhaustively serialize.
 */
export type ClientMsg =
  | HelloMsg
  | StartMsg
  | StopMsg
  | RecordStartMsg
  | RecordStopMsg
  | ListFilesMsg
  | TrialFeedbackClientMsg
  | HuntMarkClientMsg
  | LogbookCmdClientMsg;

// ─── server→client text (§3.4) ────────────────────────────────────────────────

/**
 * Status frames (§3.4) arrive as JSON text too. The contract shows the Health
 * shape but does not pin a `type` discriminator on it, so we treat any text
 * frame that is not `files`/`error` and that carries a `bus` field as a Health
 * status push.
 */
export type ServerTextMsg = FilesMsg | ErrorMsg | Health;
