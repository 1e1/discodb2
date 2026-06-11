# Developer guide

## Architecture in one paragraph

A **thin Python backend** owns the CAN hardware (listen-only), and streams frames
as **binary, batched messages over a WebSocket**, plus JSON control and a `GET
/health`. Two **TypeScript web frontends** consume that stream: a heavy *cockpit*
(buffering, decoding, analysis, export) and a light *copilot* (glanceable phone
view). All analysis lives client-side; the backend stays a fast pass-through so it
can run on a small in-car device. The wire format and data model are the contract
in [`DESIGN.md`](DESIGN.md) — read it first; everything is built against it.

## Repository layout

```
backend/            Python backend: adapters, stream/record/replay, WS server, health
frontend/
  shared/           Canonical protocol + data-model types (TS), with codec tests
  cockpit/          Heavy client (Vite + Svelte): table, filters, inspector, decode, hunt
  copilot/          Light client (Vite + Svelte): phone glance view
infra/
  native/           Native install (macOS/Linux/Windows): backend + cockpit on one box
  pi-image/         Raspberry Pi provisioning (can0 listen-only, WPA2 AP, systemd)
  docker/           Dev sandbox (sim/replay; vcan caveats + Linux real-CAN supplement)
.github/workflows/  CI: backend tests, frontend typecheck/build, Pi image bundle
docs/               DESIGN (contract), CONFORMANCE, USERS, DEVELOPERS
```

## The contract (DESIGN.md §3)

- **Frame stream** — binary, little-endian, batched ~20–50 ms: a 12-byte batch
  header (`version`, `flags`, `count`, `base_t_us`) then fixed 20-byte records
  (`dt_us`, `can_id` with ext/error bits, `dlc`, flags, `data[8]`). Never JSON on
  the hot path.
- **Control** — JSON text on the same socket (`hello`, `start`, `stop`,
  `record_start/stop`, `list_files`).
- **Health** — `{"type":"status", ...}` pushed on the socket and returned by
  `GET /health`.
- **Data model** — `Project → FrameDef[] → Signal[]` (a frame carries many signals).

## Backend

Python 3.10+ (3.11+ on target). Single runtime dependency: `websockets`. CAN
sources behind one `open_bus()` dispatch (`adapters/`): `sim`, `replay`,
`socketcan`, `gs_usb`, `slcan`. Live sources are clamped to listen-only on
construction.

```bash
cd backend
pip install -r requirements.txt
python -m discodb2_backend --source sim            # run
PYTHONPATH=. python -m pytest -q                   # tests (needs pytest, pytest-asyncio)
```

Invariants (see [`CONFORMANCE.md`](CONFORMANCE.md)): listen-only enforced
server-side; **monotonic timestamps only** (no wall clock); **lean deps** — no
numpy/pandas/cantools in the backend (it must fit an ARMv6 Pi).

### The simulator

`adapters/sim.py` decouples physics (`_VehicleModel.advance(dt)`, unit-tested with
large dt — no sleeping) from transport. `realistic` emits undulating, seed-varied
signals plus counters/checksums/chatter (a genuine fixture for the decoders and the
Wizard); `lite` is a cheap random-walk for constrained hosts. The frame sequence is
driven by a deterministic virtual schedule, so a seed reproduces exactly.

## Frontends

TypeScript + Vite + Svelte; heavy compute in Web Workers; charts on Canvas. Each
app currently implements the protocol itself (self-contained); `frontend/shared`
holds the canonical types to consolidate onto.

```bash
cd frontend/cockpit   # or frontend/copilot, or frontend/shared
npm install
npm run check          # typecheck (+ tests)
npm run build
npm run dev            # cockpit :5173, copilot :5174
```

The cockpit exposes the analysis seam `runExperiment(window): RankedCandidate[]` —
the detection Wizard fills this in (`window.marks` distinguishes event vs trend
experiments).

## End-to-end locally

```bash
# terminal 1
cd backend && python -m discodb2_backend --source sim
# terminal 2
cd frontend/cockpit && npm run dev      # open :5173, connect to ws://localhost:8765/ws
```

For a no-display loop, the `backend/` test suite plus the `frontend/shared` codec
tests verify the contract end-to-end (the Python encoder and the TS decoder agree
byte-for-byte).

## Testing & CI

`.github/workflows/` runs backend tests, frontend typecheck/build, the shared codec
test, and assembles the Pi provisioning bundle. `infra/conformance/check.sh` greps
the invariants in `CONFORMANCE.md`. CI does not bake a full Pi `.img` (slow/flaky);
it publishes a provisioning bundle with flashing steps instead.

## Conventions

- Keep the backend a thin pass-through; analysis belongs in the frontend.
- Never trust the wall clock; relative time only (the client anchors absolute time).
- Don't break the contract silently — amend `DESIGN.md` and `frontend/shared` together.
- New CAN source? Add an adapter implementing `recv()/shutdown()` and register it in
  `adapters/open_bus()`; clamp listen-only if it's a live source.
