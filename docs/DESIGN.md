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
OTHER connected client and never interprets them** (zero compute — safe on a Pi 1):
- `{"type":"wizard", ...}` — host (cockpit) → viewers: current Wizard state (phase,
  rep/good/target, silence, top candidates, cue mode). Payload opaque to the backend.
- `{"type":"trialFeedback","action":"success|fail|abandon|skip","at":<µs>}` — any
  device → host: the operator's per-trial verdict, fed into the host's feedback FSM.

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

## 7. Client profiles
- **Cockpit (heavy)**: laptop / in-car desktop / Firefox. Long buffer, analysis, export, the Wizard.
- **Copilot (light)**: driver phone (iOS Safari). Only latest values + a tiny gauge window; **no large buffer/compute** (iOS memory limits); Screen Wake Lock; robust reconnect across backgrounding.

## 8. Deployment
- **PC (incl. macOS)**: backend + browser locally; CAN via `gs_usb` libusb. No Pi needed — first-class.
- **Raspberry Pi (in-car box)**: single **32-bit ARMv6 RPi OS Lite** image covers **Pi 1B+ → 3B+** (per-arch images unnecessary; Pi Zero dropped — USB ports). Candlelight → in-kernel gs_usb → `can0` listen-only. **Pi = WiFi AP + WPA2** (open WiFi rejected). CI image via **stock image + first-boot provisioning** (arch-agnostic) preferred over a full QEMU bake.
- Dev box: Pi 1 B+ (4 USB) + TP-Link dongle (verify chipset does AP/master mode).

## 9. Open questions (v2)
CAN-FD; UDS/ISO-TP (0x22 for odometer); codegen of shared types Py↔TS; dual-mode WiFi (STA-then-AP fallback). The **detection Wizard** (event-with-repetitions; robust monotone-trend) is being designed separately — the cockpit must expose a clean seam: `runExperiment(window) -> rankedCandidates`.
