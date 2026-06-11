# discodb2 — Design & Contract (v1, amendable)

CAN reverse-engineering toolkit for a VW Sharan (PQ platform). This document is
the **authoritative contract**: all components are built against the interfaces
defined here so they integrate. Amend deliberately; note breaking changes.

## 1. Architecture

```
  Vehicle CAN ──► [ candlelight/UCAN | OBD dongle ]
                          │ USB / SocketCAN
                          ▼
                ┌───────────────────────┐
                │   THIN BACKEND (Py)    │  owns hardware, listen-only,
                │  stream · record · replay │  binary batched WebSocket
                └───────────┬───────────┘
                            │ WebSocket (binary stream + JSON control) + GET /health
            ┌───────────────┼────────────────┐
            ▼                                 ▼
   FRONTEND "cockpit" (TS)          FRONTEND "copilot" (TS)
   heavy: buffer, analysis,         light: glanceable live view,
   decode, DBC, export, Wizard      driver phone, no big buffer
   (laptop / in-car desktop)        (iOS Safari first)
```

The backend is **host-agnostic**: same code on a Raspberry Pi (SocketCAN `can0`)
or a PC (gs_usb via libusb on macOS/Windows, or SocketCAN on Linux). WiFi/AP and
the Pi image are a **deployment layer**, never backend code.

## 2. Components & ownership (parallel build)

| Component | Dir | Responsibility |
|---|---|---|
| Backend | `backend/` | hardware, stream, record, replay, control, health, **listen-only enforcement** |
| Cockpit frontend | `frontend/cockpit/` | buffering, analysis, decode, charts, DBC, export, Wizard host |
| Copilot frontend | `frontend/copilot/` | light live view, driver phone, wake-lock, bounded memory |
| Infra & conformance | `infra/`, `.github/`, `frontend/shared/`, `docs/CONFORMANCE.md` | canonical types, CI, Pi image, conformance checklist |
| Legacy | `app/` | old Tkinter app — kept for reference, not part of the product |

## 3. THE CONTRACT

### 3.1 Transport
One **WebSocket** (default `ws://<host>:8765/ws`). **Binary** frames = CAN stream
(hot path — never JSON). **Text** frames = JSON control/status. Plus **`GET /health`** (JSON).

### 3.2 Frame stream (binary, little-endian, batched ~20–50 ms)

Batch header (12 bytes): `version:u8(=1)` · `flags:u8` (bit0 1=replay) · `count:u16` · `base_t_us:u64` (monotonic µs).
Then `count` × **20-byte record**:

| off | field | type | notes |
|----|-------|------|-------|
| 0  | dt_us | u32 | offset from `base_t_us` |
| 4  | can_id | u32 | bits0–28 id · bit30 error · bit31 extended(29-bit) |
| 8  | dlc | u8 | 0..8 |
| 9  | rec_flags | u8 | bit0 RTR (reserved else) |
| 10 | reserved | u16 | 0 |
| 12 | data | u8[8] | bytes ≥ dlc are 0 |

Fixed-size records → trivial `DataView` parsing in a Web Worker. Classic CAN only (≤8). CAN-FD is a future v2.

### 3.3 Control (client→server, JSON text)
- `{"type":"hello","client":"cockpit"|"copilot"}` — the backend records `client` per
  connection. The Wizard **host** is a `cockpit` (it holds the buffer + analysis); a
  `copilot` is always a viewer.
- `{"type":"start","source":"sim|socketcan|gs_usb|slcan|replay","bitrate":500000,"listen_only":true,"file":"<replay only>"}`
- `{"type":"stop"}` · `{"type":"record_start","name":"?"}` · `{"type":"record_stop"}` · `{"type":"list_files"}`

**Wizard relay** (multi-device sync). The backend **fans these out verbatim to every
OTHER connected client and never interprets them** (zero compute — safe on a Pi 1).
The relay set is a server-side **whitelist** (`wizard`, `trialFeedback`, `huntMark`);
any other control `type` is rejected, so adding a relay message is a one-line backend
change plus this contract entry.
- `{"type":"wizard", ...}` — host (cockpit) → viewers: current Wizard state (phase,
  rep/good/target, silence, top candidates, cue mode). Payload opaque to the backend.
- `{"type":"trialFeedback","action":"success|fail|abandon|skip","at":<µs>}` — any
  device → host: the operator's per-trial verdict, fed into the host's feedback FSM.
- `{"type":"huntMark","kind":"exclude","from":<µs>,"to":<µs>}` — any device → host:
  the operator marks the **closed** time span `[from,to]` (backend-monotonic µs, §4.2)
  as **contamination to exclude** from the active hunt's evidence. Sent **once**, when
  the operator closes the window — the device holds the open `from` edge locally
  (bounded memory; an unclosed window is simply never sent). The host correlates the
  span to whichever hunt was active over `[from,to]` (**time is the key — no hunt id on
  the wire**) and applies its exclusion **strategy**: drop those frames as candidates,
  *or* use them as a **negative baseline** that prunes candidates (e.g. "driven without
  ever touching the target ⇒ whatever changed in this span is not the signal"). Which
  strategy is a **host-side analysis detail** (WIZARD.md / cockpit), NOT a wire field —
  the message only declares "this span is not evidence", so the driver UX stays a single
  control. `kind` is an enum for forward room (only `"exclude"` today). Zero/inverted/
  out-of-session timestamps ⇒ the host ignores the mark (a viewer must never wedge the host).

### 3.4 Status/Health (server→client text, and `GET /health` JSON)
```json
{ "uptime_s": 0, "source": "sim", "listen_only": true, "recording": null,
  "bus": {"bitrate":500000,"state":"LIVE","fps":0,"fps_avg":0,"total":0,
          "unique_ids":0,"errors":0,"last_frame_ms":0,"bus_load":0.0},
  "stream": {"clients":0,"out_bps":0,"dropped":0},
  "record": {"active":false,"file":null,"size":0,"disk_free":0},
  "proc": {"cpu":0.0,"rss":0,"reader_q":0,"ws_q":0} }
```
Other server→client: `{"type":"files","files":[...]}`, `{"type":"error","message":"..."}`.

### 3.5 Data model (frontend / `frontend/shared`)
```ts
interface Signal { id: string; frameId: number; isExtended: boolean;
  bitStart: number; bitLength: number; byteOrder: "big"|"little";
  factor: number; offset: number; unit: string; name: string; }
interface FrameDef { id: number; isExtended: boolean; name: string; signals: Signal[]; }
interface Project { name: string; frames: FrameDef[]; }
```
A frame carries **multiple signals** (bit ranges). DBC import/export maps to/from this.

## 4. Backend invariants (NON-NEGOTIABLE)
1. **listen-only enforced server-side** for any live source — the bus is never opened in a transmitting mode for read-only RE; a request to disable it is refused/clamped. The guarantee never depends on the network.
2. **Timestamps are backend monotonic/HW µs.** Wall clock is never trusted (Pi has no RTC). Absolute session time is assigned by the connecting client.
3. **Lean deps** (ARMv6 target): no numpy/pandas/cantools in the backend. SocketCAN raw or python-can; a WebSocket lib. That's it.
4. **`sim` works with zero hardware**; **`replay`** streams a recorded file through the exact same path.

## 5. CAN adapter abstraction
Single dispatch (cf. existing `app/adapters/can_adapter.py::open_bus`):
`sim` (synthetic) · `replay` (file→stream) · `socketcan` (Linux/Pi `can0`, listen-only at interface) · `gs_usb` (libusb, macOS/Windows — reuse `GsUsbListenOnlyBus`) · `slcan`. All expose the same `recv()/shutdown()` duck-typed surface.

## 6. Tech stack
- **Backend**: Python 3.11+ (3.10 ok for pure parts), asyncio, a WebSocket lib (`websockets` or `aiohttp`), SocketCAN raw / `python-can`. Plain-text health log (TTY → periodic lines; no TUI). Minimal deps.
- **Frontend**: TypeScript + Vite + Svelte. Heavy compute in **Web Workers**. Charts on **Canvas/WebGL** (never DOM-per-point). Two apps share the protocol/data-model (canonical in `frontend/shared`).
- **Min browsers**: Safari mobile (iOS) + Firefox Desktop ⇒ **no WebUSB, no File System Access API** (export via Blob download).

### 6.1 Heavy compute in Web Workers — the responsiveness/throughput design

> **Status: steps 1 + 2 + 3 + 4 IMPLEMENTED (through 2026-06-11).** This
> sub-section expands the one-line "Heavy compute in Web Workers" bullet above into
> a worked architecture. The trigger was a reported **hitch on a weak Pi-served
> client**. Step 1 (incrementalize: dependence-null cap + zero-copy boxing + tagger
> cap), step 2 (the dedicated analysis worker — §6.1.2, all 4 migration sub-steps),
> step 3 (packed representation — §6.1.4, both phase 3a zero-copy ring views and
> phase 3b columnar `PackedFrames`, every analyzer migrated behind an equivalence
> test), and step 4 (the WASM co-occurrence tally kernel — §6.1.5, **WASM-ready**:
> injected behind the pure-JS packed seam with a JS fallback, three tiers
> simd→scalar→JS, no threads) are done and green; the migration spine (§6.1.4)
> records per-step status. The measurement (§6.1.3) was a documented, non-blocking
> first step — confirmed the O(N) re-detect and guided the caps.

**Two orthogonal axes.** It is essential not to conflate them, because the
reported pain points at exactly one of them:

- **Worker offload = RESPONSIVENESS.** Moving work off the main thread un-janks
  the UI: the render loop, input handling, and Svelte reactivity stop competing
  with analysis for the one main thread. This is the axis that fixes a *hitch*.
- **WASM/SIMD = THROUGHPUT.** A faster kernel finishes the same work in fewer
  milliseconds. It does **not**, by itself, stop the main thread from blocking —
  a 3× faster kernel that still runs on the main thread still janks, just for a
  third as long.

The reported symptom — a hitch — is **jank**, so the **worker axis** is the fix.
WASM is a throughput lever and is addressed last, gated, in §6.1.5. Treating the
hitch as "we need a faster kernel" would be solving the wrong axis.

#### 6.1.1 Current state

One worker exists: `frontend/cockpit/src/worker/parser.worker.ts`. It does
**parse + per-id aggregate ONLY** — it maintains the live frame-table rows
(latest payload, count, decaying rate, per-bit change flash) and emits a
throttled `SnapshotMsg` (~100 ms; `workerApi.ts`). Its memory is bounded by the
**id count**, never by history depth. That is the right shape and stays.

Everything else runs on the **main thread**:

- the **raw analysis ring** (`state/ringBuffer.ts`), fed by a SECOND parse of
  every batch in `state/store.ts::onBatch` (the batch is parsed once for the
  ring on the main thread, then a *copy* is transferred to the worker — so the
  main thread already pays a full parse per batch, in addition to the worker's);
- **Message-ID detection** + the per-message model (`protocol/messageModel.ts`,
  driven from `MessageList.svelte` on every `$maxTUs` ~10 Hz tick);
- every **Hunt scan** (`hunt/*.ts` → `shared/analysis/*.ts`), run synchronously
  on the ring window.

**Concrete cost evidence — the per-tick re-detect.** The Auto Message-ID detector
`detectMessageIdByte` (`protocol/messages.ts:156`) is NOT irreducible arithmetic;
its cost is dominated by **allocation + redundant re-walks**, not numeric work:

1. it **re-folds the entire id-profile from raw frames every call**
   (`messages.ts:166`, `idProfile(profileFrames, [id])`), even though
   `shared/analysis/id-profile.ts` documents itself as *designed* to be
   incremental O(1)/frame and explicitly defers that ("An incremental
   O(1)/frame cache is a later cockpit-seam optimization") — so today every
   re-detect is O(N frames);
2. it does **`Array.from(f.data)` per frame** (`messages.ts:164`), converting
   each `Uint8Array` → `number[]` of boxed doubles — the worst representation
   for both the JS JIT and for any future WASM;
3. `idProfile` then makes **three full passes** over those frames — `byteHistogram`
   + `bitActivity` + `tagger` (`id-profile.ts:185–195`) — and the tagger
   re-groups/re-copies again (`tagger.ts:109–117`, `.map(b => b & 0xff)`);
   the tagger's own grouping copies again (`tagger.ts:116`); co-occurrence
   repeats the same `.map(b => b & 0xff)` churn (`co-occurrence.ts:239`).

The memoization in `protocol/messageIdCache.ts` / `messageModel.ts` already hides
most of this from the steady state (it re-detects only on selection/def change, a
growth factor, or a 5 s backstop), so the residual per-tick cost is the
*grouping* re-scan, not detection. The unmemoized cost — paid on every selection
change and growth re-detect — is what is felt as a hitch on a weak client. The
remedy in §6.1.4 step 1 is to make the profile **incremental**, collapsing a
re-detect from O(N frames) to O(profile size ≈ 64 bytes·bits).

> **Measured (2026-06-10, throwaway `tsx` micro-bench; Mac/Node 24, UNTHROTTLED).**
> One re-detect over a deep single-id history, broken into its three components:
>
> | N (frames/id) | boxing | idProfile fold | payloadDependence (perm. null) | TOTAL |
> |---|---|---|---|---|
> | 10 000 | 5.4 ms | 32.3 ms | 37.9 ms | **75.5 ms** |
> | 50 000 | 26.2 ms | 108.1 ms | **187.5 ms** | **321.8 ms** |
>
> Confirmed: the cost is **linear in N** (~6.4–8.6 µs/frame) — i.e. genuinely
> O(N frames), exactly the scaling an incremental profile removes. The previously
> cited "~68 ms" matches a ~10 k-frame ring. On a 4–6× throttled (weak-client)
> CPU a 50 k re-detect is **~1.3–1.9 s** — a very visible hitch, paid on each
> selection-change / growth / 5 s-backstop re-detect (not per tick — memoized).
>
> **Reorientation this revealed:** the dominant component is NOT the profile fold
> but the **`payloadDependence` permutation null** (≈58 % at 50 k), ahead of the
> fold (≈34 %); boxing (≈8 %) is pure waste. So incrementalizing the *profile*
> alone removes only ~42 % of the cost — see §6.1.4 step 1, reframed accordingly.

#### 6.1.2 Target architecture — a dedicated ANALYSIS worker

Add a **second worker** that **OWNS the analysis ring**. The split becomes:

```
                       ┌──────────────────────────────────────┐
 WS binary batch ──┬──►│ parser.worker (UNCHANGED)            │──► SnapshotMsg (rows)
 (ArrayBuffer)     │   │  parse + per-id aggregate (id-bound) │    ~100 ms, render-ready
                   │   └──────────────────────────────────────┘
                   │   ┌──────────────────────────────────────┐
                   └──►│ analysis.worker (NEW)                │──► MessagesMsg / ScanMsg /
                       │  OWNS the raw ring (history-bound)    │    DetectMsg / RingStatsMsg
                       │  parse → ring → detection + msg model │
                       │  + Hunt scans on request              │
                       └──────────────────────────────────────┘
   main thread: thin async CONSUMER of both — no parse, no ring, no analysis.
```

Both workers are fed the **same batches**. The main thread stops parsing for the
ring and stops owning the ring entirely; `onBatch` becomes a fan-out of the raw
`ArrayBuffer` to both workers (one copy each, transferred — the hot path stays
zero-copy on each side). The main thread becomes a **thin async consumer**:
it holds only the latest snapshot/messages/scan *results* in Svelte stores and
renders them.

**Worker protocol sketch** (the analysis worker; mirrors `workerApi.ts` style —
plain structured-clone-friendly messages, `ArrayBuffer` transfers):

```ts
// main → analysis.worker
type ToAnalysis =
  | { type: 'ingest'; buffer: ArrayBuffer }            // raw batch, transferred
  | { type: 'reset' }                                  // reconnect / new session
  | { type: 'select'; sel: { id: number; isExtended: boolean } | null;
      def: FrameDef | undefined; windowSeconds: number } // drives the message model
  | { type: 'huntScan'; kind: 'coOccurrence' | 'signalDiscovery' | 'bitActivity'
        | 'byteHistogram' | 'signalCorrelation' | 'autoSegment';
      window: { startTUs: number; endTUs: number }; allowIds?: number[];
      reqId: number };                                  // on-demand, correlated by reqId
// analysis.worker → main
type FromAnalysis =
  | { type: 'messages'; rows: MessageRow[]; eff: EffectiveMessageId }
  | { type: 'detect';  auto: AutoDetect }              // Inspector read-out
  | { type: 'scan';    reqId: number; result: /* per-kind */ unknown }
  | { type: 'ringStats'; stats: RingStats }
  | { type: 'error';   message: string };
```

**Ring relocation.** `RawFrameRing` is already a pure SoA-over-typed-arrays class
with no DOM/Svelte deps, so it moves into the analysis worker **as-is**. Its
incremental `since(cursor, id)` / `generation` API is exactly what the in-worker
message model needs; nothing about the ring's logic changes — only its owner.

**Async reactivity implications.** Today `MessageList.svelte` calls
`msgModel.sync(ring, …)` *synchronously* on the `$maxTUs` tick (`MessageList.svelte:99`)
and reads the ring directly. After the move there is **no ring on the main
thread**, so:

- selection becomes a **command** (`select`) posted to the worker; the worker
  owns the `MessageModel` instance and posts `MessagesMsg` back. The component
  binds to a `messages` store instead of computing them.
- the model's per-tick recompute moves *inside* the worker, driven by ingest +
  the current selection — the main thread no longer ticks it.
- one-shot reads (the Inspector's "auto: byte N · K values") arrive as `detect`
  messages rather than a synchronous return value.
- this introduces **eventual consistency**: a result reflects the worker's ring
  as of the last processed batch, a few ms stale. For a passive RE tool this is
  invisible and correct (timestamps are backend-µs, §4.2 — staleness is just a
  slightly older "now").

**Call-site migration plan** (incremental, each step shippable):

1. Stand up `analysis.worker` parsing into a worker-owned ring; have `onBatch`
   fan out to it; emit `ringStats` from the worker (today's `ring.stats()` call
   in `store.ts:186` becomes a store update). The main-thread ring still exists
   in parallel — **no behavior change yet** (pure scaffolding + a second parse,
   temporarily three parses total; acceptable for one transition step).
2. Move the message model: `MessageList` posts `select`, binds a `messages`
   store. Delete the synchronous `msgModel.sync` call and the main-thread
   `createMessageModel` once the worker path is green (locked by the existing
   `messageModel.test.ts` equivalence test, which stays a pure Node test).
3. Move each Hunt scan behind a `huntScan` request/`scan` response (one kind at a
   time; `HuntPanel.svelte` already calls each `scan*` adapter at a single seam,
   so each becomes an `await`-with-spinner). The `hunt/*.ts` adapters and the
   pure `shared/analysis/*.ts` are unchanged — they just run in the worker.
4. Delete the main-thread ring. `onBatch` now fans the raw buffer to the two
   workers and does nothing else.

**Invariant preserved:** the `shared/analysis/*` modules stay pure and
framework-free, runnable in "the cockpit, a Web Worker, or a plain Node test
runner" — the property the file headers explicitly value. We are moving the
*caller*, not the kernels.

#### 6.1.3 Measurement — step 0, documented but NON-BLOCKING

We write the whole design now (above + below); measurement **confirms and
prioritizes**, it does not gate. How to measure the hitch as a proxy for a weak
Pi-served client:

- **Throttle the client, not the backend.** Run the normal dev stack
  (`backend/` `sim` or a `replay` file → `frontend/cockpit` `npm run dev`), open
  the cockpit, and apply **CPU throttling in DevTools** (Performance →
  4×/6× slowdown) — a faithful stand-in for a Pi-served weak client doing all
  analysis locally (the Pi only streams; the *client* CPU is the constraint).
  The backend itself is irrelevant to this jank (it does zero analysis, §3.3).
- **Isolate two scenarios:** (a) the **per-tick re-detect** — select an id with
  a deep ring so a growth/backstop re-detect fires; (b) a **Hunt scan** —
  trigger `scanCoOccurrence` / `scanSignalDiscovery` over a full window.
- **Capture the hitch:** record a Performance profile and read the longest main-
  thread task per scenario (long-task duration = the visible hitch). Note the
  ring depth, fps, and id count so the numbers are reproducible.
- **Before/after:** re-run the same two scenarios after §6.1.4 step 1
  (incremental profile) and step 2 (worker offload) to quantify each lever. The
  acceptance bar is qualitative-first (no perceptible hitch on a 4–6× throttled
  client), with the captured long-task numbers as the regression guard.

#### 6.1.4 Migration spine (leverage-per-cost ordering)

1. **Incrementalize the re-detect** so it is O(profile), not O(N frames). Pure TS,
   no architecture change. The §6.1.1 bench splits this into TWO levers, because
   the permutation null — not the profile fold — is the dominant O(N) cost:
   - **a. Drop the `Array.from` boxing + incrementalize the id-profile** (~42 % at
     50 k). *Boxing: DONE 2026-06-10.* The frame `data` type was widened to
     `ArrayLike<number>`, so `detectMessageIdByte` passes the ring's `Uint8Array`
     payloads straight to `idProfile`/`payloadDependence` (no per-frame
     `Array.from`), and the three analyzers (byte-histogram, bit-activity, tagger)
     keep a `Uint8Array` as-is (zero-copy — already byte-clamped) instead of the
     defensive `.map(b => b & 0xff)` copy; plain `number[]` still copies. Measured:
     the profile fold dropped **~2.2× at 50 k (≈230 → 118 ms)** plus the eliminated
     ~26 ms boxing pass; an equivalence test pins `Uint8Array ≡ number[]` results.
     *Tagger cap: DONE 2026-06-10.* Splitting the post-boxing fold (≈116 ms at 50 k)
     showed the **tagger is ~87 %** of it (≈102 ms) — its checksum detection is
     O(frames × width² × schemes) — while byte-histogram (≈6 ms) + bit-activity
     (≈13 ms) are cheap. A counter/checksum is a stable structural property, so the
     tagger now walks only the most-recent `maxFrames` (default 8192, **contiguous**
     window — preserves the consecutive-pair basis counter detection needs);
     histogram + bit-activity still run over the FULL history (required for the
     cumulative constant-exclusion / cardinality, and cheap). Measured: tagger
     **3.8× (≈85 → 22 ms)**, fold **≈116 → 35 ms** at 50 k. Combined with 1b, a
     re-detect at 50 k is now **≈322 → ≈71 ms (~4.5×)**, and its two superlinear
     O(N) costs (dependence null, tagger checksum) are bounded constant vs ring
     depth. *Remaining O(N): histogram + bit-activity (~19 ms at 50 k, cheap).*
     *Full incremental O(1)/frame profile (the deferred `id-profile.ts` optimization)
     is now deferred to step 2 — it pays off when the worker maintains an all-id
     profile continuously, not for an on-demand re-detect the cap already bounds.*
   - **b. Cap the `payloadDependence` sample** (≈58 % at 50 k). DONE 2026-06-10.
     We chose **capping the paired sample** over caching the verdict: the cap also
     fixes the most-visible hitch (the selection-change one-shot, which a cache —
     first sight of the id — cannot help) and has no staleness subtlety. An NMI +
     permutation null is a statistical estimate that converges in a few thousand
     samples (Miller-Madow already corrects finite-N bias), so above
     `sampleCap` (default 8192) we deterministically down-sample (fixed-seed
     partial Fisher-Yates over positions — uniform, no mux aliasing). Measured: the
     dependence test drops from O(N) to O(cap) — **5.0× at 50 k (182 → 36 ms),
     verdict bit-identical**, and now constant regardless of ring depth. This was
     the bigger single win and was not obvious before measuring.
   Together these largely eliminate the per-detect cost behind the hitch; neither
   alone does. Note that step 2 (worker) also dissolves the *felt* hitch even if
   the dependence test stays O(N), since it can run async behind a spinner.
2. **Offload to the dedicated analysis worker** (§6.1.2) — **DONE 2026-06-10.**
   Worker owns the ring, runs detection + message model + Hunt; main thread is a
   thin async consumer (no parse, no ring). Landed in 4 green sub-steps: (1)
   scaffold worker + parallel ring + `ringStats`; (2) message model → worker,
   MessageList binds `messages`; (2b) Inspector → worker (`inspectorData`), with
   detection UNIFIED (one `model.effective()` shared by the rows + the read-out);
   (3) the 5 Hunt scans + guided experiment behind `huntScan` request/response
   (async; an id→isExtended map keeps the heatmap's lookup synchronous); (4)
   deleted the main-thread ring — `onBatch` just fans the raw buffer to both
   workers. This is what actually **fixes responsiveness** on a weak client.
3. **Packed representation — IMPLEMENTED (2026-06-10).** The `Uint8Array → number[]`
   churn was already killed by step 1a-boxing; the residual per-frame allocation was
   the ring's window materialization (`at()` slices a `Uint8Array` + builds a
   `FrameView` per frame). **Phase 3a (done):** `RawFrameRing` gained
   `atView`/`windowView`/`lastSecondsView` — a `subarray` VIEW (no copy), wired into
   the worker's synchronous Hunt scans; a shared private `collect()` body keeps the
   copy and view flavors from drifting. Safe because per-frame payloads are
   contiguous (8-byte stride, never spans the wrap) and the scans don't retain — the
   message model / Inspector keep the copying `window`/`lastSeconds`/`at` because
   they retain payloads across ticks. **Phase 3b (done):** a flat columnar
   `PackedFrames` substrate (`frontend/shared/analysis/packed.ts`) +
   `RawFrameRing.windowPacked`/`lastSecondsPacked` (one bulk allocation, safe to
   retain — also the layout WASM would consume); every analyzer has a packed twin
   (`*Packed`) pinned by an equivalence test (`*.packed.test.ts`), and the worker
   scans run on packed. Green: shared 186 node · cockpit 89 vitest · svelte-check
   0/0 · build OK.
4. **WASM/SIMD — IMPLEMENTED (2026-06-11), measure-first, WASM-READY.** Spec:
   `docs/step4-wasm-spec.md`. Phase 0 selected the **co-occurrence tally** as the
   single kernel X (the only candidate whose cost scales with input → the
   batch-regime win; the permutation null is sample-capped, so WASM there has no
   batch payoff — see §6.1.5 for the bench + rationale). Toolchain: **Rust →
   `wasm32-unknown-unknown`, no wasm-bindgen** (plain `extern "C"` over a shared
   `WebAssembly.Memory`, SIMD via `core::arch::wasm32`); committed prebuilt
   `.wasm` (scalar + simd) so the cockpit/CI build is toolchain-free. The hot
   `O(pairs·bytes²)` tally in `co-occurrence.ts` gained an **injectable kernel
   seam** (`setCoOccurrenceTallyKernel`); the cockpit `analysis.worker` loads the
   `.wasm` (feature-detect simd→scalar, MIME-independent fetch) and injects it,
   falling back silently to pure JS on the browser floor or any load failure.
   `shared/analysis` imports nothing WASM and stays Node-testable. Bit-identity
   (JS ≡ scalar ≡ simd, pure integer) pinned by `cooc.wasm.equiv.test.ts`. Source +
   loader + tests under `frontend/cockpit/src/worker/wasm/`. **Batch mode itself is
   NOT built** (DESIGN §9 v2); the kernel is benched on a large synthetic packed
   buffer that stands in for it.

The ordering is deliberate: 1 is cheap and high-leverage; 2 is the actual fix
for the reported symptom; 3 both speeds JS and prepares the WASM seam; 4 is a
future option, not a planned step.

#### 6.1.4.1 Live Hunt vs a-posteriori batch discovery

These are different execution regimes and must be designed separately:

- **Live frame/message display** (per-tick): bounded by **id count**, latency-
  light. → **worker yes** (it already is), **WASM no** (nothing to accelerate).
- **Live Hunt (on-demand scan)**: warmer. The **superlinear kernels** live here —
  co-occurrence is O(N · bytes²) (`co-occurrence.ts` double byte-loop per pair),
  and discriminator-dependence runs a Fisher-Yates **permutation null** ×
  mutual-info per target byte (`discriminator-dependence.ts:239–260`). But a Hunt
  scan is **on-demand** (a spinner is acceptable UX) and **ring-bounded** (the
  deliberately ~8-min live ring, `ringBuffer.ts` header). So the worker
  (don't-freeze-the-UI) matters far more than raw kernel speed. The *only*
  genuine live-WASM candidate is the permutation null, and even it is gated.
- **A-posteriori discovery over a stored recording — the real WASM home, and a
  DIFFERENT REGIME.** Here the constraints **invert**:
  - a recording is **arbitrarily large** (vs the bounded live ring);
  - it is **BATCH** — throughput-bound, not latency-bound (no 10 Hz tick), so you
    can afford algorithms you'd never run live: full pairwise MI across all
    id × byte, long permutation nulls, candidate field-geometry search, cross-id
    correlation;
  - its input is **naturally a packed buffer** (you load a file) — WASM's ideal
    input.
  - **Caveats to honor:** (a) a **cheaper lever comes first** — offline batch is
    *embarrassingly parallel by id*, so **multi-worker sharding** (one worker per
    id-/time-shard) likely beats WASM on a multi-core laptop, in pure TS; the
    order is **packed repr → multi-worker shard → then WASM/SIMD per kernel** if
    still insufficient. (b) The measurement gate (§6.1.5) still applies. (c)
    **Architectural fork to call out:** today `replay` flows through the **same
    WebSocket protocol as live** — a recording is replayed *as-if-live* into the
    same ring + pipeline (§3.2 `flags` bit0, §4 invariant 4). "A-posteriori
    discovery" — analyze the **whole recording at once** — is a **NEW capability,
    a distinct BATCH MODE**, not the live path. It is precisely that batch mode
    (large input, no tick, packed file) — not the live path — that would justify
    WASM at all.

#### 6.1.5 WebAssembly: a gated future option

WASM is **step 4 only**, and the architecture is to be made **WASM-READY, not
WASM-dependent**. The reasoning:

- **The gain is modest for this code style.** WASM vs *good typed-array* JS for
  histogram/bit-walk/MI-style kernels is ~**1.5–3×** (≈4–8× only with SIMD on the
  right kernel, e.g. the permutation null), **not 10×**. And WASM *requires* a
  packed typed-array input anyway — once §6.1.4 step 3 has repacked, **plain JS
  over the packed buffer already captures most of the win**, and the laptop-class
  cockpit (where the heavy profile runs) is exactly where the JS↔WASM gap is
  narrowest. The light "glance" copilot profile does **no** heavy compute by
  design (§7), so it is never a WASM client.
- **The cost is large and permanent.** Project ethos is **zero-dependency /
  hand-rolled** (hand-rolled DBC parser, no parser libs). A WASM toolchain
  (Rust + wasm-pack / Emscripten / AssemblyScript) is a second language, a build
  step, manual linear-memory management, and harder debugging — and it would
  break the property that `shared/analysis/*` runs as **plain Node tests** (a
  property the code headers explicitly value). Building the worker-owned ring +
  packed memory + kernels-behind-a-pure-interface in TS first gets ~80% of the
  win, preserves the ethos and the Node tests, and leaves a **clean swappable
  seam** for WASM later.
- **Browser floor.** WASM MVP is fine on the floor (Safari mobile + Firefox
  Desktop); **WASM SIMD** needs **Safari 16.4+**. SIMD-only kernels must degrade
  to scalar WASM / JS on the floor.

**Explicit trigger criteria — adopt WASM for a kernel X only when ALL hold:**

1. After §6.1.4 steps 1–3 (incremental + worker + packed JS), kernel X is still
   measured **> ~50 ms** on the **throttled cockpit client class** (§6.1.3) for a
   live Hunt, **or** minutes-painful in BATCH mode;
2. the workload is **iterated** (the operator re-runs the analysis repeatedly, so
   the latency compounds) **or** the recording is **large** (well beyond the live
   ring, so multi-worker sharding alone — the cheaper lever — has already been
   tried and is insufficient);
3. kernel X is **isolated behind the pure interface** (a packed-buffer in,
   results out), so the WASM version is a drop-in swap that keeps a JS fallback
   for the browser floor and the Node tests.

Absent all three, the answer is **packed JS in a worker (sharded for batch)** —
which is the design above — not WASM.

**Implementation & measured results (2026-06-11).** The decision to adopt WASM
was made; measurement selected the kernel and proved the (modest, as predicted)
win. Bench: synthetic bus, 80 ids, dlc 8, node v24, median of 5; `×5` ≈ the
documented weak-client throttle (§6.1.3).

*Phase 0 — kernel selection (pre-WASM, original packed JS):*

| frames | co-occurrence | permutation-null |
|---|---|---|
| 1e6 (live whole-buffer) | 617 ms (×5 ≈ 3.1 s) | 5.3 s for all 80 ids (≈67 ms/id; sample-capped) |
| 1e7 (batch stand-in) | 7.5 s (×5 ≈ 38 s) | 9.7 s (capped — barely grows) |

Co-occurrence is **X**: it is the only candidate whose cost **scales with input**
(linear in N → the batch-regime kernel, the real WASM home), it is **pure integer**
(bit-identical SIMD, no PRNG/log-reduction determinism risk), and it runs over all
ids each `scanAll`. The permutation null is **sample-capped to 8192/id** (step 1b),
so its cost is constant in recording length and it runs for one id per re-detect
behind a spinner — WASM there is a bounded, live-only win with **no batch payoff**
(fails trigger #2 for the regime that justifies WASM).

*After — co-occurrence WASM vs the (refactored) JS reference:*

| frames | JS reference | scalar WASM | simd WASM |
|---|---|---|---|
| 1e6 | 185 ms (×5 ≈ 0.9 s) | 119 ms — **1.56×** | 119 ms — 1.56× |
| 1e7 | 3.0 s (×5 ≈ 15 s) | 2.3 s — **1.34×** | 2.4 s — 1.28× |

Two honest findings: **(1) the bigger win came from the seam refactor, in pure JS.**
Extracting the tally into a flat `Int32Array` + change-bitmask kernel (`jsCoocTally`,
no per-pair `boolean[]`/`number[][]`) dropped the **JS** path 617 → 185 ms (~3.3×)
— captured in the fallback, so it helps every client incl. the SIMD-less floor.
This is precisely "packed JS gets ~80% of the win." **(2) SIMD ≈ scalar here.** The
16-byte compare SIMD accelerates is no longer the bottleneck after the flat-array
refactor; the data-dependent co-change **scatter-accumulation** dominates and does
not vectorize, so the hoped 4–8× SIMD payoff did not materialize and the marginal
WASM win lands at the **bottom of the predicted 1.5–3× scalar band**. The SIMD tier
is **retained** (bit-identical, ~600 B, and the feature-detect/loader/`setXKernel`
seam infra is the reusable template for the next kernel). Net vs the original packed
JS: **~5.2× at 1e6** (refactor 3.3× × WASM 1.56×).

**Future kernels — where SIMD will actually pay (design orientation).** This step
deliberately shipped *one kernel done well*; the seam (a `setXKernel` injector + a
committed `.wasm` + a loader entry) is built to be reused. Two candidates, in
likely order, *if a measured need appears* (re-run the §2 measure-first discipline
first — do not port speculatively):

1. **Co-occurrence v2 — SIMD outer-product accumulation.** To make SIMD beat scalar
   on the *current* kernel, attack the accumulation, not the compare. For each pair
   the co-change update is the **outer product `m ⊗ m`** of the 8-bit change mask
   (entry (i,j)=1 iff bits i∧j set) — a symmetric dense 8×8. Replace the
   data-dependent scatter (≤28 conditional scalar increments) with a **dense vector
   accumulation**: for each set bit i, add the mask-as-{0,1}-lane vector to row i of
   the matrix (a row is 8×i32 = 2× `v128`). Accumulate in narrow lanes (`i8x16`/
   `i16x8`, 16/8 lanes) with a periodic flush to i32 to dodge overflow. Off-diagonal
   counts stay bit-identical to the scalar/JS path (the outer product is symmetric),
   so the same equivalence test applies. Pays off most in the **batch regime** (large
   N, where the accumulation is the whole cost). Expected: pushes past the 1.5× wall
   toward the predicted SIMD band.
2. **Permutation-null kernel — the original §6.1.4.1 SIMD candidate, for BATCH only.**
   It was *not* chosen now because step 1b sample-caps it (no batch scaling today),
   but **batch mode (§9 v2) inverts that**: long permutation nulls over a whole
   recording, latency-free. To WASM-ify it: (a) replace the Map-based joint histogram
   with a **dense integer 2D histogram** (field-cardinality × 256 bins) in linear
   memory — SIMD-accumulable, unlike JS Maps; (b) **re-implement the fixed-seed
   Fisher-Yates PRNG bit-identically** (the determinism obligation, §6 — pin the first
   N draws against JS); (c) accept that the **log-based entropy reduction vectorizes
   poorly** — vectorize the O(N) histogram fill, leave the small O(bins) entropy
   sum scalar. This is a larger port (RNG determinism + integer-histogram rewrite),
   justified only once batch mode exists and the §6.1.5 gate is re-cleared on it.

## 7. Client profiles
- **Cockpit (heavy)**: laptop / in-car desktop / Firefox. Long buffer, analysis, export, the Wizard.
- **Copilot (light)**: driver phone (iOS Safari). Only latest values + a tiny gauge window; **no large buffer/compute** (iOS memory limits); Screen Wake Lock; robust reconnect across backgrounding.

## 8. Deployment
- **PC (incl. macOS)**: backend + browser locally; CAN via `gs_usb` libusb. No Pi needed — first-class.
- **Raspberry Pi (in-car box)**: single **32-bit ARMv6 RPi OS Lite** image covers **Pi 1B+ → 3B+** (per-arch images unnecessary; Pi Zero dropped — USB ports). Candlelight → in-kernel gs_usb → `can0` listen-only. **Pi = WiFi AP + WPA2** (open WiFi rejected). CI image via **stock image + first-boot provisioning** (arch-agnostic) preferred over a full QEMU bake.
- Dev box: Pi 1 B+ (4 USB) + TP-Link dongle (verify chipset does AP/master mode).

## 9. Open questions (v2)
CAN-FD; UDS/ISO-TP (0x22 for odometer); codegen of shared types Py↔TS; dual-mode WiFi (STA-then-AP fallback). The **detection Wizard** (event-with-repetitions; robust monotone-trend) is being designed separately — the cockpit must expose a clean seam: `runExperiment(window) -> rankedCandidates`.

**A-posteriori batch discovery over a stored recording** (decided 2026-06-10 to scope HERE, not in the live-worker effort of §6.1). Today `replay` reuses the live WebSocket pipeline (streamed as-if-live into the bounded ring); analyzing a *whole* recording at once is a NEW capability and a DIFFERENT execution regime (arbitrarily large input, batch/latency-free, packed-file input). Its own conception is owed: execution mode, UI, and *where* it runs (in-page multi-worker shard, or possibly off-browser). It is also the only regime that would justify WebAssembly — see the regime split and the WASM trigger criteria already written in §6.1.4.1 / §6.1.5. Keep the §6.1.4.1 fork as the entry point; design the batch mode separately.
