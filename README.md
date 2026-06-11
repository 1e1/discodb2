# discodb2


[![GitHub release](https://img.shields.io/github/v/release/1e1/discodb2?style=flat-square)](https://github.com/1e1/discodb2/releases)
[![GitHub commit activity](https://img.shields.io/github/commit-activity/m/1e1/discodb2?style=flat-square&color=brightgreen)](https://github.com/1e1/discodb2/commits/main)
[![License](https://img.shields.io/github/license/1e1/discodb2?style=flat-square)](https://github.com/1e1/discodb2/blob/main/LICENSE)

![cover](./docs/img/cover.png "DiscOBD")

**A toolkit for reverse-engineering a vehicle's CAN bus — safely, from a laptop or your phone.**

Plug a USB CAN adapter into a car, and discodb2 turns the raw torrent of frames
into something you can actually read: which IDs are alive, which bytes move when
you pull the handbrake, what the rev counter looks like as a number. It listens —
it never talks back to the bus.

> Status: **early but working.** The backend streams and records, the two web
> clients connect and decode, and a built-in simulator lets you try the whole
> thing with **zero hardware**. The guided "detection Wizard" is in design.
> No fake demos here — what's described below runs today.

## Why it's built this way

- **Read-only by design.** The bus is opened in listen-only/silent mode, enforced
  in the backend regardless of the network. You can't accidentally transmit onto a
  live car. ([why this matters](docs/USERS.md#safety))
- **Phone *and* laptop.** A heavy "cockpit" client (laptop / in-car desktop) does
  the buffering and analysis; a light "copilot" client runs on the driver's phone
  for a glance while the car moves. Same stream, two views.
- **Runs on a Pi *or* your PC.** Leave a Raspberry Pi in the car as a self-contained
  WiFi access point, or just run everything on your Mac with the adapter plugged in.
- **Zero-hardware mode.** The simulator emits a realistic, *undulating* VAG-style
  bus (idling/revving RPM, ramping speed, draining fuel, toggling flags, plus
  counters and checksums to trip up naive analysis). Try the UI before you ever
  touch a car.

## Quick start (no car, no adapter)

```bash
# 1. Backend — stream a realistic simulated bus
cd backend && pip install -r requirements.txt
python -m discodb2_backend --source sim          # ws://localhost:8765/ws + /health

# 2. Cockpit — the full client, in another terminal
cd frontend/cockpit && npm install && npm run dev # http://localhost:5173
#    open it, set WS to ws://localhost:8765/ws, click Start "sim"

# 3. (optional) Copilot — the phone view
cd frontend/copilot && npm install && npm run dev # open the printed Network URL on a phone
```

With a real adapter, swap `--source sim` for `--source gs_usb` (candleLight/UCAN
over libusb) or `--source socketcan` (Linux/Pi). See the [user guide](docs/USERS.md).

## Architecture

```
  Vehicle CAN ──► adapter (USB / SocketCAN)
                       │
              ┌────────┴────────┐   thin Python backend: own the bus (listen-only),
              │     backend     │   stream binary frames + record + replay
              └────────┬────────┘
            WebSocket (binary stream + JSON control) + GET /health
              ┌────────┴────────┐
              ▼                 ▼
        cockpit (web)     copilot (web)
        heavy: buffer,    light: glanceable
        analysis, decode  live view, phone
```

The backend is a thin, fast pass-through; the clients use the host's resources for
buffering, decoding and analysis. The wire format and data model are pinned in
[`docs/DESIGN.md`](docs/DESIGN.md) — the contract every component is built against.

## Hardware

A candleLight/gs_usb adapter (e.g. **FYSETC UCAN**, VID `0x1d50` / PID `0x606f`)
works on macOS, Windows and Linux. On a Raspberry Pi the same adapter binds the
in-kernel `gs_usb` driver and appears as SocketCAN `can0`. Connect via the OBD-II
port to start. **Do not** enable the adapter's termination resistor on a vehicle
that already has its own.

## Documentation

- [User guide](docs/USERS.md) — install, run on PC or Pi, use the clients, safety.
- [Developer guide](docs/DEVELOPERS.md) — architecture, layout, build, test, extend.
- [Design & contract](docs/DESIGN.md) — the wire protocol and data model.
- [Conformance](docs/CONFORMANCE.md) — the invariants and how CI enforces them.

## Example DBC files

Need real CAN databases to test decoding or to seed your own reverse-engineering?
[**opendbc**](https://github.com/commaai/opendbc) (comma.ai) is the canonical open
collection of `.dbc` files for many makes — including VW/VAG (`vw_pq.dbc`, `vw_mqb.dbc`),
Toyota, Honda, Hyundai and more. Good starting hypotheses for a platform, to confirm
against your own car.

## License

MIT. See [LICENSE](LICENSE).
