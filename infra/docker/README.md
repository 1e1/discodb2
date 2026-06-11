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

## The "circuit" demo bus (`simloop`) — richer than `sim`

`sim` is a procedural fixture (good for the detection Wizard). For a *coherent*
demo — a car doing laps, decodable in the cockpit's **Cluster** view — use
`simloop`, which replays a **DBC-true generated trace** endlessly:

```bash
docker compose -f infra/docker/docker-compose.yml --profile sim up simloop
# ws://localhost:8765/ws — point the cockpit at it and open Cluster mode
```

How it's built (and why it stays lean): the trace is generated **at image-build
time** by a throwaway multi-stage (`tracegen`) that runs
[`tools/gen_trace.py`](../../tools/gen_trace.py) over
[`infra/sim/scenario.cluster.yaml`](../sim/scenario.cluster.yaml) +
[`docs/vw/dbc/vw_pq-en.dbc`](../../docs/vw/dbc/vw_pq-en.dbc). **cantools lives
only in that stage** — the runtime image copies just the resulting `.canlog`, so
the leanness invariant (DESIGN §4.3) holds. The scenario is a 5-minute seamless
loop (state at 5:00 == state at 0:00), so the replay never jumps at the seam.

`simloop` is on its own `--profile sim` because it shares port 8765 with
`backend` (run one or the other). Because the trace is generated from the DBC,
it doubles as **ground truth** for testing decode. To regenerate or edit it,
change the scenario and rebuild (or run the generator natively — see
[`../native/README.md`](../native/README.md)).

> **Two gotchas when iterating:**
> - **`up` reuses the existing image.** `docker compose ... up simloop` will NOT
>   pick up a changed scenario on its own — use `up --build simloop` (or `build`
>   first). Plain `up` only rebakes the trace if the image doesn't exist yet.
> - **Layer cache.** The `tracegen` stage re-runs only when its inputs change
>   (`tools/gen_trace.py`, `infra/sim/scenario.cluster.yaml`, the DBC). If you
>   edit something it doesn't track, or want a guaranteed fresh trace, force it:
>   `docker compose ... build --no-cache simloop`.
> - **Baked ≠ played.** Every build of the `discodb2-backend-sandbox` image
>   bakes the trace in (the runtime stage `COPY`s it from `tracegen`), but only
>   the `simloop` command *plays* it — `up backend` still runs the procedural `sim`.

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

## Real CAN into the container (Linux host only — supplement to native install)

This sandbox is for **sim/replay** (zero hardware). Getting a **real**
candleLight/CANable board to feed the container is **host-specific** and only
works on a **native Linux host** — it is *not* possible under Docker Desktop for
Mac/Windows (no USB passthrough, no `vcan`/SocketCAN). If you have real hardware
on a Mac/Windows box, use the **native** path instead:
[`../native/README.md`](../native/README.md).

On a **Linux host**, prefer bringing the adapter up **on the host** as SocketCAN
and sharing the host network namespace with the container — `can0` is a kernel
network interface, so `network_mode: host` exposes it directly (no per-device
mapping):

```bash
# 1. On the HOST: bring up can0 listen-only (in-kernel gs_usb driver)
sudo modprobe gs_usb
sudo ip link set can0 type can bitrate 500000 listen-only on
sudo ip link set up can0

# 2. Run the backend container in the host network namespace so it sees can0.
#    (network_mode: host also means localhost:8765 is the host's port directly.)
docker run --rm -it --network host \
  -v "$PWD":/app -w /app/backend \
  discodb2-backend-sandbox \
  python -m discodb2_backend --source socketcan --bitrate 500000 --port 8765 --host 0.0.0.0
```

Notes / gotchas:
- **`--device` is not enough** for SocketCAN — `can0` is a *network* interface,
  not a `/dev` node. Use `--network host` (Linux) so the container shares it.
  Passing the raw USB device (`--device /dev/bus/usb/...`) only helps the
  **libusb `gs_usb`** path, and even then needs the host kernel module unbound —
  the SocketCAN route above is simpler.
- **Listen-only** is enforced server-side regardless; the host `ip link ...
  listen-only on` is defence-in-depth.
- The compose `backend` service already sets `privileged: true`; add
  `network_mode: host` to it if you want this via `docker compose` rather than
  `docker run`.

## Backend mid-flight

The backend (`backend/`) is built by a separate agent. Until it lands, the
sandbox builds fine and the entrypoint prints the exact command it *would* run,
then drops to a shell. The Dockerfile also **refuses to build** if a
`backend/requirements.txt` ever pulls in numpy/pandas/cantools.
