# discodb2 backend dev sandbox (Docker)

Runs the **thin backend** (DESIGN §2) in `sim`/`replay` and, optionally, the two
frontend dev servers — so you can exercise the full WebSocket contract with zero
hardware.

> This is **not** the legacy analysis shell. `/docker` (repo root) stays as the
> `can-utils` + `cantools` + `pandas` environment for the old Tkinter-era decode
> workflow. **This** sandbox deliberately installs only the **lean** backend
> deps (no numpy/pandas/cantools — DESIGN §4.3) so "works here" ⇒ "works on a
> Pi 1B+ (ARMv6)".

## Run the backend

```bash
# sim (zero hardware) — default
docker compose -f infra/docker/docker-compose.yml up backend

# replay a recording through the exact same path (DESIGN §4.4)
REPLAY_FILE=/app/recordings/drive.canlog \
  docker compose -f infra/docker/docker-compose.yml run --rm backend replay

# vcan0 SocketCAN (Linux host only — see caveat) + cangen traffic
docker compose -f infra/docker/docker-compose.yml run --rm backend socketcan
```

Then connect a browser/ws client to `ws://localhost:8765/ws` and `GET
http://localhost:8765/health`.

## Run the frontend dev servers too

```bash
docker compose -f infra/docker/docker-compose.yml --profile frontends up
# cockpit  -> http://localhost:5173
# copilot  -> http://localhost:5174
```

These mount the repo and run `npm install && vite` inside `node:20`. Point each
app's WebSocket at `ws://localhost:8765/ws`.

## vcan caveat (carried over from `/docker`)

`vcan0` needs the **host kernel's `vcan` module**. On **Docker Desktop for Mac**
it is **absent** (confirmed in this repo's testing) — the `socketcan` command
**falls back to `sim`** so the sandbox stays usable. The full `vcan` + can-utils
workflow (`cangen`/`candump`/`canplayer` on `vcan0`) works on a real Linux host
(the planned Ubuntu box). USB passthrough for the real adapter is **not**
available under Docker Desktop either — use the native `gs_usb` path on macOS.

## Backend mid-flight

The backend (`backend/`) is built by a separate agent. Until it lands, the
sandbox builds fine and the entrypoint prints the exact command it *would* run,
then drops to a shell. The Dockerfile also **refuses to build** if a
`backend/requirements.txt` ever pulls in numpy/pandas/cantools.
