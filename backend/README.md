# discodb2 backend

Thin, host-agnostic CAN backend for the discodb2 reverse-engineering toolkit.
It owns the hardware, **enforces listen-only**, and serves a **batched binary CAN
frame stream + a JSON control/status channel over one WebSocket**, plus
`GET /health`. It can record to disk and replay a capture through the exact same
stream path. `sim` needs **zero hardware**.

This implements the contract in [`../docs/DESIGN.md`](../docs/DESIGN.md):
§3 (transport/protocol), §4 (invariants), §5 (adapter abstraction).

> Status: **first runnable skeleton**. The integration surface (protocol, control,
> health, sim/replay, record) is complete and tested. Hardware sources
> (socketcan/gs_usb/slcan) are wired and listen-only-enforced but exercised only
> on a host with the relevant libraries + adapter.

---

## Quick start (sim mode, zero hardware)

```bash
cd backend
python3 -m pip install -r requirements.txt        # just `websockets`
python3 -m discodb2_backend --source sim
```

You now have:

- `ws://0.0.0.0:8765/ws` — binary frame stream + JSON control on one socket
- `http://0.0.0.0:8765/health` — JSON health snapshot

Without `--source`, the backend boots idle and waits for a `start` control
message from a client.

A periodic health line prints to **stdout** (structured `key=value` when stdout
is not a TTY, e.g. under Docker/systemd; a compact human line on a terminal).

### Replay a capture (same stream path as live)

```bash
# Stream a candump -l log at the recorded rate:
python3 -m discodb2_backend --source replay --file recordings/capture.log
# …or as fast as possible (handy for tests):
python3 -m discodb2_backend --source replay --file recordings/capture.log --replay-fast
```

### Run the tests (no hardware)

```bash
cd backend
python3 -m pip install pytest pytest-asyncio
PYTHONPATH=. python3 -m pytest -q
```

---

## Requirements

- **Python 3.11+** recommended (the pure protocol/replay parts run on 3.10; this
  repo's CI host is 3.10 and the suite passes there).
- Runtime dep: **`websockets`** only. Lean by design (ARMv6 Pi target):
  **no numpy / pandas / cantools**.
- Hardware sources need extra libs, installed *only* for the source you use:
  | source | install | notes |
  |---|---|---|
  | `socketcan` | `pip install "python-can>=4.0"` | Linux/Pi `can0` |
  | `slcan` | `pip install "python-can>=4.0" "pyserial>=3.5"` | serial-line CAN |
  | `gs_usb` | `pip install "gs_usb>=0.2.1" "pyusb>=1.2.1"` + system libusb (macOS: `brew install libusb`) | candleLight via libusb |
  | richer `/health` `cpu`/`rss` | `pip install "psutil>=5.9"` | optional; degrades gracefully without it |

Selecting a hardware source without its library fails **loudly** with an
actionable message; it never silently falls back.

---

## Configuration (CLI flags / env)

Every flag has a `DISCODB2_*` env equivalent; **CLI wins over env over default**.

| flag | env | default | meaning |
|---|---|---|---|
| `--host` | `DISCODB2_HOST` | `0.0.0.0` | bind address |
| `--port` | `DISCODB2_PORT` | `8765` | bind port |
| `--ws-path` | `DISCODB2_WS_PATH` | `/ws` | WebSocket route |
| `--record-dir` | `DISCODB2_RECORD_DIR` | `./recordings` | where `.log` captures live |
| `--batch-ms` | `DISCODB2_BATCH_MS` | `25` | binary batch coalescing window (§3.2 ~20–50 ms) |
| `--health-interval` | `DISCODB2_HEALTH_INTERVAL` | `2.0` | seconds between stdout health lines |
| `--source` | `DISCODB2_SOURCE` | *(empty)* | autostart a source on boot; empty = wait for `start` |
| `--file` | `DISCODB2_FILE` | *(empty)* | replay file for `--source replay` |
| `--bitrate` | `DISCODB2_BITRATE` | `500000` | bus bitrate |
| `--replay-fast` | — | off | replay as fast as possible instead of at recorded rate |
| `--sim-seed` | `DISCODB2_SIM_SEED` | *(none)* | deterministic seed for `sim` |

Logging goes to **stderr**; the periodic **health lines go to stdout** so they can
be redirected/parsed independently.

---

## Protocol (exactly as implemented)

One WebSocket: **binary** messages = CAN stream (server→client, hot path, never
JSON); **text** messages = JSON control (client→server) / status (server→client).
Plus `GET /health` (JSON). All multi-byte integers are **little-endian**.

### Binary frame stream (§3.2)

Frames are coalesced into batches every `--batch-ms` and sent as one binary
WebSocket message:

**Batch header — 12 bytes**

| off | field | type | notes |
|----|-------|------|-------|
| 0 | `version` | u8 | `1` |
| 1 | `flags` | u8 | bit0 `1`=replay batch, else live |
| 2 | `count` | u16 | number of records following |
| 4 | `base_t_us` | u64 | monotonic µs, batch time base |

**Then `count` × 20-byte record**

| off | field | type | notes |
|----|-------|------|-------|
| 0 | `dt_us` | u32 | offset from `base_t_us` (this frame's monotonic µs) |
| 4 | `can_id` | u32 | bits 0–28 id · bit30 error · bit31 extended (29-bit) |
| 8 | `dlc` | u8 | 0..8 (classic CAN only) |
| 9 | `rec_flags` | u8 | bit0 RTR (other bits reserved, 0) |
| 10 | `reserved` | u16 | 0 |
| 12 | `data` | u8[8] | bytes with index ≥ `dlc` are 0 |

Fixed-size records → trivial `DataView` parsing in a Web Worker. CAN-FD is a
future v2. The canonical pack/unpack (and a reference decoder) live in
[`discodb2_backend/protocol.py`](discodb2_backend/protocol.py); the
byte-for-byte test is `tests/test_protocol.py`.

`base_t_us` for each batch is the **first frame's** timestamp, so the first
record always has `dt_us == 0`.

### Control — client → server (JSON text)

```jsonc
{"type":"hello","client":"cockpit"}                 // or "copilot"
{"type":"start","source":"sim","bitrate":500000,"listen_only":true}
{"type":"start","source":"replay","file":"recordings/capture.log"}
{"type":"start","source":"socketcan","channel":"can0"}   // channel optional (default can0)
{"type":"start","source":"slcan","channel":"/dev/ttyACM0"}
{"type":"start","source":"gs_usb","index":0}
{"type":"stop"}
{"type":"record_start","name":"contact_on"}         // name optional → timestamped name
{"type":"record_stop"}
{"type":"list_files"}
```

`start` accepts these optional fields beyond the contract's: `channel`
(socketcan/slcan device) and `index` (gs_usb device number). `bitrate` defaults
to the backend's `--bitrate`.

### Status / Health — server → client (JSON text) and `GET /health`

The server pushes a `status` frame (the health object + `"type":"status"`) on
connect, after every control action, and every `--health-interval`. `GET /health`
returns the same object **without** the `type` field:

```json
{ "uptime_s": 0, "source": "sim", "listen_only": true, "recording": null,
  "bus": {"bitrate":500000,"state":"LIVE","fps":0,"fps_avg":0,"total":0,
          "unique_ids":0,"errors":0,"last_frame_ms":0,"bus_load":0.0},
  "stream": {"clients":0,"out_bps":0,"dropped":0},
  "record": {"active":false,"file":null,"size":0,"disk_free":0},
  "proc": {"cpu":0.0,"rss":0,"reader_q":0,"ws_q":0} }
```

`bus.state` is one of `IDLE` (no source), `LIVE`, `REPLAY`, `ERROR`.

Other server→client text frames:

```jsonc
{"type":"files","files":[{"name":"capture.log","size":1234,"mtime":1700000000}]}
{"type":"error","message":"…"}
```

---

## Invariants enforced (§4)

1. **listen-only is enforced server-side** for every *live* source
   (`socketcan`, `gs_usb`, `slcan`): the dispatch *clamps* `listen_only` to
   `true`, and each adapter constructor additionally refuses `listen_only=False`
   (defence in depth). A client request to disable it is honoured-as-clamped and
   the server replies with an `error` explaining the clamp. `sim`/`replay` never
   transmit, so the flag is a no-op for them. The guarantee never depends on the
   network.
2. **Timestamps are backend monotonic µs** (`time.monotonic_ns()//1000`), never
   wall clock (the Pi has no RTC). Recorded logs use a monotonic timebase too.
   Absolute session time is the connecting client's job.
3. **Lean deps** — `websockets` for the core; hardware libs are optional extras.
4. **`sim` works with zero hardware; `replay` streams a file through the exact
   same path** as a live source (same reader→batcher→broadcast chain, same
   recorder).

---

## Record & replay

- **Record**: frames are appended live to a candump `-l` log
  (`(<sec>.<usec>) <iface> <ID>#<DATA>`) in `--record-dir`, with **monotonic**
  timestamps. The file stays valid if the process is killed mid-session (no
  unflushed batching). Captures interoperate with `candump`/`canplayer`/SavvyCAN.
- **Replay**: the `replay` source reads such a log back, preserving relative
  inter-frame timing, re-anchored to the backend monotonic clock, and emits it
  through the identical stream path. Replay batches set the header **replay flag
  (bit0)**.

Format read/write lives in
[`discodb2_backend/candump_log.py`](discodb2_backend/candump_log.py); the
record→replay round-trip test is `tests/test_record_replay.py`.

---

## Architecture (where things live)

```
discodb2_backend/
  protocol.py      §3.2 binary wire format — pack/unpack + reference decoder
  clock.py         §4.2 monotonic µs timebase
  candump_log.py   candump -l read/write (record + replay)
  adapters/
    base.py        CanMessage + CanBus duck-typed surface (§5)
    __init__.py    open_bus() dispatch + listen-only clamp
    sim.py         synthetic source (zero hardware)
    replay.py      file → stream (same path as live)
    socketcan.py   Linux/Pi can0 (python-can, listen-only)
    gs_usb.py      candleLight via libusb (listen-only)  [lifted from app/]
    slcan.py       serial-line CAN (python-can)
  recorder.py      lossless record-to-disk (candump -l)
  stats.py         rolling bus/stream counters for /health
  engine.py        source → reader thread → batcher task → clients (+ recorder)
  server.py        WebSocket (binary stream + JSON control) + GET /health
  healthlog.py     plain-text stdout health (TTY vs structured)
  config.py        CLI flags / env
  __main__.py      python -m discodb2_backend
```

The blocking adapter `recv()` runs in a dedicated daemon thread feeding a
queue; an asyncio batcher drains it every `--batch-ms`, encodes one binary
batch, records it, and fans it out to clients. Per-client send queues are
bounded — a slow client drops whole batches (counted in `stream.dropped`)
rather than back up the pipeline (binary stream is the hot path; head-of-line
blocking is not acceptable).
