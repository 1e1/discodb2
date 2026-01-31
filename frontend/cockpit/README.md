# discodb2 · cockpit (heavy frontend)

The **fat** CAN reverse-engineering client for discodb2 — long buffer, decode,
per-bit analysis, DBC, export, and the Wizard host. Targets **Firefox Desktop +
Chromium** (laptop / in-car desktop). Built per the authoritative contract in
[`../../docs/DESIGN.md`](../../docs/DESIGN.md): WebSocket protocol §3.2/§3.3/§3.4
and data model §3.5 are implemented **directly** here.

> Scope: this app is self-contained. It does **not** depend on
> `frontend/shared/` (built in parallel); the protocol types + data model are
> re-declared here and will be consolidated against the canonical shared
> package later.

## Stack

- **TypeScript + Vite + Svelte**
- Binary frame parsing in a **Web Worker** (`DataView`, little-endian)
- Charts on **Canvas** (per-bit grid + sparklines — never one DOM node per point)

## Prerequisites

- **Node 18+** (developed on Node 24) and **npm**.

## Install & run the dev server

```bash
cd frontend/cockpit
npm install
npm run dev
```

Vite serves the app at **http://localhost:5173**.

### Connect to the backend

The backend exposes one WebSocket at `ws://<host>:8765/ws` plus `GET /health`
(DESIGN §3.1). In the app's top bar:

1. Set the **WS URL** (defaults to `ws://<this-host>:8765/ws`). For a local
   backend that is `ws://localhost:8765/ws`.
2. Click **Connect** — the client sends the `hello` handshake as `cockpit`.
3. Pick a **source** and click **Start**:
   - `sim` — synthetic traffic, **works with zero hardware** (DESIGN §4.4) —
     use this to try the UI immediately.
   - `replay` — click **⟳** to `list_files`, pick one, **Start**.
   - `socketcan` / `gs_usb` / `slcan` — live bus (listen-only, enforced
     server-side — DESIGN §4.1).
4. Set the **bitrate** (default 500000).

The dev server also proxies `/ws` and `/health` to `localhost:8765`, so a
same-origin URL works too if you prefer.

## Other commands

```bash
npm run check     # svelte-check + tsc type checking
npm run build     # type-check then production build to dist/
npm run preview   # serve the production build
```

## What's implemented (mapped to DESIGN)

| Area | Where | Notes |
|---|---|---|
| Binary batch parse (§3.2) | `src/protocol/parseBatch.ts` + `src/worker/parser.worker.ts` | 12-byte header + 20-byte records, `DataView` little-endian, in a worker |
| Control (§3.3) | `src/protocol/client.ts` | `hello/start/stop/record_start/record_stop/list_files` |
| Status/Health (§3.4) | `src/protocol/client.ts`, `src/components/StatusBar.svelte` | text status + `GET /health`, `files`, `error` |
| Data model (§3.5) | `src/protocol/datamodel.ts` | `Signal` / `FrameDef` / `Project`, byte-identical shapes |
| Decode | `src/protocol/decode.ts` | bit range, big/little (Intel/Motorola), factor, offset, unit, optional signed |
| Live frame table | `src/components/FrameTable.svelte` | ID, name, DLC, data hex, rate, last-seen |
| Filter bar | `src/components/FilterBar.svelte` | ID range, byte mask/value, min rate, name substring |
| Inspector | `src/components/Inspector.svelte` + `BitGrid.svelte` | per-bit change grid that **flashes**, payload history, signals, sparkline |
| Ring buffer | `src/state/ringBuffer.ts` | bounded raw-frame history (default 1e6 frames), SoA typed arrays |
| Hunt seam (§9) | `src/hunt/hunt.ts` + `HuntPanel.svelte` | `runExperiment(window) -> RankedCandidate[]` — **stubbed** |
| Export | `src/export/download.ts` | Project JSON, DBC, table CSV via **Blob download** (§6) |
| DBC import/export | `src/dbc/dbc.ts` | **stub** parser/writer; see library note below |
| Session time | `src/protocol/sessionClock.ts` | UI shows **relative** time; absolute start captured from browser clock on connect (§4.2) |

### Timestamps (DESIGN §4.2)

Backend timestamps are **monotonic/HW µs** and never wall-clock. The cockpit
captures the **absolute session start once, from the browser clock, on
connect**, and displays **relative** time (seconds since the first frame)
everywhere.

### Hunt / Wizard seam (DESIGN §9)

The detection Wizard is designed separately. The cockpit only owns the seam:

```ts
function runExperiment(window: ExperimentWindow): RankedCandidate[];
```

It is **pure and synchronous** over a window sliced from the ring buffer. The
current body is a placeholder that ranks ids by byte activity so the panel is
wired end-to-end; replace it with the real detector. See `src/hunt/hunt.ts` for
the full `ExperimentWindow` / `RankedCandidate` shapes.

### DBC library choice

For real DBC **parsing**, wire **[`@montra-connect/dbc-parser`]** (pure-TS, MIT,
browser-friendly, no Node `fs`) into `importDbc()` — its message/signal shape
maps almost 1:1 onto §3.5. The de-facto reference `cantools` is Python and is
the backend's *forbidden* dependency (§4.3), so DBC stays in the frontend. DBC
**writing** is done by a small hand-rolled `BO_`/`SG_` emitter (no mature JS
writer exists). See `src/dbc/dbc.ts`.

[`@montra-connect/dbc-parser`]: https://www.npmjs.com/package/@montra-connect/dbc-parser

## Architecture notes

- **Hot path never touches Svelte per frame.** Binary batches go
  client → worker (transferred `ArrayBuffer`). The worker aggregates per-id
  stats + per-bit change flags and emits a throttled snapshot (~10 Hz) that
  updates the table. The same batch is parsed once on the main thread to fill
  the raw ring buffer (history must be complete and ordered for analysis).
- **Canvas for anything point-dense** (bit grid, sparklines).
- **Listen-only** is never offered as "off" in this client; `start` always
  sends `listen_only: true` and the backend clamps regardless (§4.1).
