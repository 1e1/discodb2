// discodb2 — DIAGNOSTIC decode: ISO-TP (ISO 15765-2) + OBD-II / UDS (B2 · point 2).
//
// SOURCE OF TRUTH: the STANDARDIZED diagnostic layer of a passenger-car CAN bus.
// Unlike the proprietary broadcast frames (which need a DBC to decode), the
// DIAGNOSTIC frames on the standard id ranges have a PUBLIC, decomposable
// structure — this is the "standard frame structure / readable data part" the
// project notes asked about:
//   • the ID selects request vs response: 0x7DF (functional request),
//     0x7E0..0x7E7 (physical request to ECU n), 0x7E8..0x7EF (response of ECU n);
//   • byte 0 is the ISO-TP PCI (frame type in the high nibble + length / seq);
//   • then the Service Id (SID) and, for OBD/UDS, a PID / DID identifier.
// This module decodes that structure so the Inspector can show it readably and
// the frame table can badge diagnostic frames.
//
// Pure & framework-free (like protocol.ts): no Svelte/Vite/DOM deps; runs in the
// cockpit, a Web Worker, or a plain Node test runner. Mutates nothing.
//
// Scope: classic 11-bit OBD/UDS ids. Per-frame decode reads each frame's PCI and,
// for a SINGLE frame, its full service payload (which already covers the common
// OBD-II current-data responses). Multi-frame messages (a First Frame followed by
// Consecutive Frames) are now also REASSEMBLED — see `reassembleIsoTp` /
// `decodeDiagnosticReassembled` below — so the full UDS service payload of a
// multi-frame response can be decoded. 29-bit diagnostics (0x18DAxxxx / 0x18DBxxxx,
// ISO 15765-4 extended addressing) remain out of scope here; a generic 29-bit /
// J1939 id decomposition lives in `j1939.ts`.

/* ────────────────────────────────────────────────────────────────────────
 * Addressing — what the ID itself tells us
 * ──────────────────────────────────────────────────────────────────────── */

export type DiagRole = "request-functional" | "request-physical" | "response";

export interface DiagAddressing {
  role: DiagRole;
  /** ECU index for a physical request (0x7E0+n) or a response (0x7E8+n). */
  ecu?: number;
}

/**
 * Classify an 11-bit id into the OBD/UDS diagnostic ranges, or null if the id is
 * not a (v1, 11-bit) diagnostic id. Extended (29-bit) ids return null for now.
 */
export function classifyDiagId(id: number, isExtended: boolean): DiagAddressing | null {
  if (isExtended) return null; // 29-bit diagnostics not handled in v1
  if (id === 0x7df) return { role: "request-functional" };
  if (id >= 0x7e0 && id <= 0x7e7) return { role: "request-physical", ecu: id - 0x7e0 };
  if (id >= 0x7e8 && id <= 0x7ef) return { role: "response", ecu: id - 0x7e8 };
  return null;
}

/* ────────────────────────────────────────────────────────────────────────
 * ISO-TP (ISO 15765-2) PCI — the first byte(s)
 * ──────────────────────────────────────────────────────────────────────── */

export type IsoTpKind = "single" | "first" | "consecutive" | "flow-control" | "unknown";

export interface IsoTpFrame {
  kind: IsoTpKind;
  /** SF: payload length (1..7). FF: total message length (12-bit). */
  length?: number;
  /** CF: sequence number 0..15. */
  seq?: number;
  /** FC: flow status (0 = ContinueToSend, 1 = Wait, 2 = Overflow). */
  flowStatus?: number;
  /** Byte offset where the SERVICE data begins (after the PCI bytes). */
  dataStart: number;
}

/**
 * Decode the ISO-TP PCI from the frame's first byte(s). The PCI type is the high
 * nibble of byte 0: 0 = Single, 1 = First, 2 = Consecutive, 3 = Flow-control.
 * (CAN-FD's "escape" single frame with length 0 + a length byte is out of scope.)
 */
export function decodeIsoTp(data: ReadonlyArray<number>): IsoTpFrame {
  if (data.length === 0) return { kind: "unknown", dataStart: 0 };
  const b0 = data[0] & 0xff;
  const type = b0 >> 4;
  const low = b0 & 0x0f;
  switch (type) {
    case 0x0:
      // Single frame: low nibble = number of payload bytes that follow.
      return { kind: "single", length: low, dataStart: 1 };
    case 0x1:
      // First frame: 12-bit total length = low nibble << 8 | byte 1.
      return { kind: "first", length: (low << 8) | (data[1] ?? 0), dataStart: 2 };
    case 0x2:
      // Consecutive frame: low nibble = sequence number.
      return { kind: "consecutive", seq: low, dataStart: 1 };
    case 0x3:
      // Flow control: low nibble = flow status; no service data here.
      return { kind: "flow-control", flowStatus: low, dataStart: data.length };
    default:
      return { kind: "unknown", dataStart: 0 };
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Service / PID / DID dictionaries (small, common subset)
 * ──────────────────────────────────────────────────────────────────────── */

/** REQUEST service ids → human name. A response SID is the request SID + 0x40. */
const SERVICES: Readonly<Record<number, string>> = {
  0x01: "OBD current data",
  0x02: "OBD freeze frame",
  0x03: "OBD stored DTCs",
  0x04: "OBD clear DTCs",
  0x07: "OBD pending DTCs",
  0x09: "OBD vehicle info",
  0x10: "DiagnosticSessionControl",
  0x11: "ECUReset",
  0x14: "ClearDiagnosticInformation",
  0x19: "ReadDTCInformation",
  0x22: "ReadDataByIdentifier",
  0x23: "ReadMemoryByAddress",
  0x27: "SecurityAccess",
  0x28: "CommunicationControl",
  0x2e: "WriteDataByIdentifier",
  0x2f: "InputOutputControl",
  0x31: "RoutineControl",
  0x34: "RequestDownload",
  0x36: "TransferData",
  0x3e: "TesterPresent",
};

/** A few common OBD-II mode 01/02 PIDs (the project's priority signals). */
const OBD_PIDS: Readonly<Record<number, string>> = {
  0x04: "Engine load",
  0x05: "Coolant temp",
  0x0a: "Fuel pressure",
  0x0b: "Intake MAP",
  0x0c: "Engine RPM",
  0x0d: "Vehicle speed",
  0x0e: "Timing advance",
  0x0f: "Intake air temp",
  0x10: "MAF rate",
  0x11: "Throttle position",
  0x1f: "Run time since start",
  0x21: "Distance with MIL on",
  0x2f: "Fuel level",
  0x31: "Distance since DTC clear",
  0x42: "Control module voltage",
  0x5e: "Fuel rate",
};

/** A few common UDS negative-response codes (NRC). */
const NRC: Readonly<Record<number, string>> = {
  0x10: "generalReject",
  0x11: "serviceNotSupported",
  0x12: "subFunctionNotSupported",
  0x13: "incorrectMessageLengthOrInvalidFormat",
  0x22: "conditionsNotCorrect",
  0x31: "requestOutOfRange",
  0x33: "securityAccessDenied",
  0x35: "invalidKey",
  0x78: "responsePending",
  0x7e: "subFunctionNotSupportedInActiveSession",
  0x7f: "serviceNotSupportedInActiveSession",
};

/* ────────────────────────────────────────────────────────────────────────
 * Full decode
 * ──────────────────────────────────────────────────────────────────────── */

export interface DiagService {
  /** The raw service byte as seen on the wire. */
  raw: number;
  /** The REQUEST sid (raw − 0x40 for a response, else raw). */
  reqSid: number;
  /** Human name of the request service, if known. */
  name?: string;
  /** True when the service byte is a positive response (raw ≥ 0x40, < 0x7F). */
  isResponse: boolean;
}

export interface DiagNegative {
  /** The service the ECU rejected. */
  rejectedSid: number;
  rejectedName?: string;
  /** Negative response code. */
  nrc: number;
  nrcName?: string;
}

export interface DiagIdentifier {
  /** "PID" (1-byte OBD) or "DID" (2-byte UDS) or "InfoType". */
  kind: "PID" | "DID" | "InfoType";
  value: number;
  name?: string;
}

export interface DiagDecode {
  addressing: DiagAddressing;
  isotp: IsoTpFrame;
  /** Present for single/first frames that carry a service byte. */
  service?: DiagService;
  /** Present when the service byte is 0x7F (negative response). */
  negative?: DiagNegative;
  /** OBD PID / UDS DID following the SID, when the service implies one. */
  identifier?: DiagIdentifier;
  /** Hex of the bytes AFTER the PCI (the service payload), space-separated. */
  serviceDataHex: string;
}

/**
 * Decode a frame on a diagnostic id, or null if `id` is not a diagnostic id.
 *
 * For a SINGLE frame we read the service byte and (when the service implies it)
 * the following PID/DID. A negative response (service byte 0x7F) is reported via
 * `negative`. FIRST / CONSECUTIVE / FLOW-CONTROL frames return their PCI but no
 * reassembled service (multi-frame reassembly is a later enhancement).
 */
export function decodeDiagnostic(
  id: number,
  isExtended: boolean,
  data: ReadonlyArray<number>,
): DiagDecode | null {
  const addressing = classifyDiagId(id, isExtended);
  if (!addressing) return null;

  const isotp = decodeIsoTp(data);
  const out: DiagDecode = {
    addressing,
    isotp,
    serviceDataHex: toHex(data.slice(isotp.dataStart)),
  };

  // Only single & first frames carry a service byte at a known offset; for a
  // consecutive / flow-control / unknown frame there is nothing more to read.
  if (isotp.kind !== "single" && isotp.kind !== "first") return out;

  // Decode the service payload starting at the PCI's dataStart, reusing the same
  // helper the reassembler uses (so single-frame and reassembled decodes match).
  decodeServicePayload(data, isotp.dataStart, out);
  return out;
}

/**
 * Decode a service payload (SID + optional PID/DID) from `data` starting at byte
 * index `start`, writing `service` / `negative` / `identifier` onto `out`. This is
 * the shared core used both by single/first per-frame decode and by the
 * multi-frame reassembler, so a reassembled message decodes exactly like a single
 * frame carrying the same bytes.
 */
function decodeServicePayload(
  data: ReadonlyArray<number>,
  start: number,
  out: { service?: DiagService; negative?: DiagNegative; identifier?: DiagIdentifier },
): void {
  const si = start; // index of the service byte
  if (si >= data.length) return;
  const sb = data[si] & 0xff;

  // Negative response: 0x7F, rejectedSID, NRC.
  if (sb === 0x7f) {
    const rejectedSid = data[si + 1] ?? 0;
    const nrc = data[si + 2] ?? 0;
    out.negative = {
      rejectedSid,
      rejectedName: SERVICES[rejectedSid],
      nrc,
      nrcName: NRC[nrc],
    };
    return;
  }

  const isResponse = sb >= 0x40 && sb < 0x7f;
  const reqSid = isResponse ? sb - 0x40 : sb;
  out.service = { raw: sb, reqSid, name: SERVICES[reqSid], isResponse };

  // Identifier following the SID, by service family.
  if (reqSid === 0x01 || reqSid === 0x02) {
    // OBD current data / freeze frame → 1-byte PID.
    if (si + 1 < data.length) {
      const pid = data[si + 1] & 0xff;
      out.identifier = { kind: "PID", value: pid, name: OBD_PIDS[pid] };
    }
  } else if (reqSid === 0x09) {
    // OBD vehicle info → 1-byte InfoType.
    if (si + 1 < data.length) {
      out.identifier = { kind: "InfoType", value: data[si + 1] & 0xff };
    }
  } else if (reqSid === 0x22 || reqSid === 0x2e) {
    // UDS Read/Write DataByIdentifier → 2-byte DID.
    if (si + 2 < data.length) {
      const did = ((data[si + 1] & 0xff) << 8) | (data[si + 2] & 0xff);
      out.identifier = { kind: "DID", value: did };
    }
  }
}

/** Space-separated uppercase hex of a byte slice. */
function toHex(bytes: ReadonlyArray<number>): string {
  return bytes.map((b) => (b & 0xff).toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

/* ────────────────────────────────────────────────────────────────────────
 * ISO-TP multi-frame REASSEMBLY (ISO 15765-2)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Result of reassembling an ISO-TP transfer from a sequence of frames.
 *
 * `complete` is true once we have collected at least `totalLength` payload bytes.
 * When incomplete, `expected` says how many more bytes are still needed (best
 * effort — it is the count beyond what we managed to gather, given the FF length).
 */
export interface IsoTpReassembly {
  /** Was the transfer a multi-frame one (FF + CF), or a plain single frame? */
  kind: "single" | "multi";
  /** Total message length declared by the SF length / FF 12-bit length. */
  totalLength: number;
  /** The reassembled message payload (service bytes), truncated to totalLength. */
  data: number[];
  /** True once `data` holds the full `totalLength` bytes in correct order. */
  complete: boolean;
  /** Bytes still expected (0 when complete); a best-effort count when incomplete. */
  expected: number;
  /** Human-readable note on why a transfer is incomplete (out-of-order, gap…). */
  note?: string;
}

/**
 * Reassemble one ISO-TP message from the ORDERED frames of a single diagnostic id.
 *
 * Input `frames` is the recent history of ONE id (oldest → newest), each frame's
 * raw CAN data bytes. We locate the most recent transfer start (a Single Frame or
 * a First Frame), then:
 *   • SINGLE frame  → the message is the SF payload (length = low nibble); done.
 *   • FIRST frame   → take the FF payload bytes (after the 2 PCI bytes), then walk
 *     the following CONSECUTIVE frames in order, checking the 4-bit sequence
 *     number (which starts at 1 after the FF and wraps 0..15: 1,2,…,15,0,1,…),
 *     appending each CF's payload until we have the FF's declared 12-bit length.
 *
 * Edge cases (all best-effort, never throws):
 *   • only-FF-present → `complete:false`, `expected` = remaining bytes;
 *   • a CF whose sequence number is not the expected next one (gap / reorder /
 *     duplicate) → stop appending, report incomplete with a note;
 *   • a plain single frame → `kind:"single"`, complete immediately.
 *
 * Frames before the latest transfer start, and FC frames, are ignored. Anything
 * that is not part of a recognisable transfer yields an empty incomplete result.
 */
export function reassembleIsoTp(frames: ReadonlyArray<ReadonlyArray<number>>): IsoTpReassembly {
  // Find the most recent transfer START (single or first frame). Reassembling the
  // newest transfer is what the UI wants; earlier frames are stale.
  let startIdx = -1;
  for (let i = frames.length - 1; i >= 0; i--) {
    const k = decodeIsoTp(frames[i]).kind;
    if (k === "single" || k === "first") {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) {
    return { kind: "multi", totalLength: 0, data: [], complete: false, expected: 0, note: "no transfer start (FF/SF) found" };
  }

  const start = frames[startIdx];
  const startPci = decodeIsoTp(start);

  // Single frame: the whole message is the SF payload; delegate to its length.
  if (startPci.kind === "single") {
    const len = startPci.length ?? 0;
    const data = start.slice(startPci.dataStart, startPci.dataStart + len).map((b) => b & 0xff);
    return { kind: "single", totalLength: len, data, complete: data.length >= len, expected: Math.max(0, len - data.length) };
  }

  // First frame: collect its payload, then walk the consecutive frames.
  const total = startPci.length ?? 0;
  const data: number[] = start.slice(startPci.dataStart).map((b) => b & 0xff);

  // The CF sequence number expected next; FF is conceptually seq 0, so the first
  // CF is seq 1, then 2..15, wrapping back to 0, then 1, and so on.
  let expectedSeq = 1;
  let note: string | undefined;

  for (let i = startIdx + 1; i < frames.length && data.length < total; i++) {
    const pci = decodeIsoTp(frames[i]);
    if (pci.kind !== "consecutive") {
      // A non-CF (e.g. a new SF/FF, FC, or unknown) interrupts this transfer.
      note = `transfer interrupted by ${pci.kind} frame`;
      break;
    }
    if (pci.seq !== expectedSeq) {
      // Out-of-order, gap, or duplicate sequence number — stop, best effort.
      note = `out-of-order CF: expected seq ${expectedSeq}, saw ${pci.seq}`;
      break;
    }
    // Append this CF's payload (bytes after its 1-byte PCI).
    for (let j = pci.dataStart; j < frames[i].length; j++) data.push(frames[i][j] & 0xff);
    expectedSeq = (expectedSeq + 1) & 0x0f; // wrap 0..15
  }

  // Trim any trailing padding past the declared total length.
  if (data.length > total) data.length = total;
  const complete = data.length >= total;
  if (!complete && note === undefined) note = "incomplete — more consecutive frames expected";

  return {
    kind: "multi",
    totalLength: total,
    data,
    complete,
    expected: Math.max(0, total - data.length),
    note: complete ? undefined : note,
  };
}

/**
 * Decode the FULL service payload of a (possibly multi-frame) diagnostic transfer.
 *
 * `id` / `isExtended` classify the addressing; `frames` is the ordered recent
 * history of that one id (oldest → newest). We reassemble with `reassembleIsoTp`,
 * then decode the reassembled bytes with the SAME service/identifier helper used
 * for single frames. Returns null if `id` is not a diagnostic id.
 *
 * The returned `DiagDecode` mirrors `decodeDiagnostic`, plus a `reassembly` field
 * carrying the transfer status (complete? bytes expected?). When the transfer is
 * incomplete we still report whatever service/identifier the gathered prefix
 * reveals (the SID/PID/DID live at the very start, so they are usually available
 * even from just the First Frame).
 */
export interface DiagDecodeReassembled extends DiagDecode {
  reassembly: IsoTpReassembly;
}

export function decodeDiagnosticReassembled(
  id: number,
  isExtended: boolean,
  frames: ReadonlyArray<ReadonlyArray<number>>,
): DiagDecodeReassembled | null {
  const addressing = classifyDiagId(id, isExtended);
  if (!addressing) return null;

  const reassembly = reassembleIsoTp(frames);
  // Re-decode the transfer-start frame's PCI for the `isotp` field, so the result
  // shows the message-level PCI (SF or FF) rather than a trailing CF.
  let isotp: IsoTpFrame = { kind: "unknown", dataStart: 0 };
  for (let i = frames.length - 1; i >= 0; i--) {
    const k = decodeIsoTp(frames[i]);
    if (k.kind === "single" || k.kind === "first") {
      isotp = k;
      break;
    }
  }

  const out: DiagDecodeReassembled = {
    addressing,
    isotp,
    serviceDataHex: toHex(reassembly.data),
    reassembly,
  };
  // Decode the SID/PID/DID from the reassembled service bytes (offset 0).
  decodeServicePayload(reassembly.data, 0, out);
  return out;
}
