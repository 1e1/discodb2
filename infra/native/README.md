# discodb2 — Native install (backend + cockpit on one machine)

Install and run discodb2 **directly on a laptop/desktop** — no Raspberry Pi, no
Docker. This is the simplest layout for development and for bench RE: the
**backend** and the **cockpit** run on the **same machine**, so everything talks
over `localhost`.

> **Same-device shortcut.** Because the cockpit defaults its WebSocket to the
> host that served the page (`ws://localhost:8765/ws` in dev — see
> `frontend/cockpit/src/state/store.ts`), backend + cockpit on one box need
> **no mDNS / Avahi and no WiFi access point**. Those exist only for the in-car
> Pi (a separate device the phone/laptop joins over WiFi — see
> [`../pi-image/`](../pi-image/)). On a single machine, just open `localhost`.

For the in-car, headless box see [`../pi-image/`](../pi-image/). For a
zero-hardware sim/replay sandbox see [`../docker/`](../docker/).

---

## What runs, and what it needs

discodb2 native install is **two processes**:

| Process | What | Runtime | Default URL |
|---|---|---|---|
| **Backend** | thin CAN→WebSocket relay (`discodb2_backend`) | **Python 3.10+** | `ws://localhost:8765/ws` + `GET /health` |
| **Cockpit** | the web UI (Vite dev server, or a built `dist/`) | **Node 20+** (build only) | `http://localhost:5173` (dev) |

The backend's base deps are **lean** (`websockets` only). A real CAN adapter
needs **per-source** extras — install only the one for your hardware:

| Source (`--source`) | Extra Python deps | System deps | Platforms |
|---|---|---|---|
| `sim` / `replay` | *(none — base install)* | — | macOS, Linux, Windows |
| `gs_usb` | `gs_usb`, `pyusb` | **libusb** | macOS, Linux, Windows† |
| `socketcan` | `python-can` | Linux kernel SocketCAN | **Linux only** |
| `slcan` | `python-can`, `pyserial` | serial/COM port | macOS, Linux, Windows |

† Windows `gs_usb` needs a **WinUSB driver swap** (Zadig) — see [§Windows](#windows-native-install).

> **Safety (all platforms).** The bus is opened **listen-only** — the adapter
> never ACKs or transmits. This is enforced **server-side in the backend**
> regardless of OS or adapter (DESIGN §4.1), so it holds even where the link
> layer can't enforce it.

### Pick your CAN path

- **candleLight / gs_usb firmware** (FYSETC UCAN, CANable v2 in candleLight fw,
  VID `1d50` PID `606f`) → use `--source gs_usb` everywhere **except Linux**,
  where the in-kernel `gs_usb` driver gives you a nicer `--source socketcan can0`.
- **CANable in slcan firmware** (enumerates as a serial/COM port) → `--source slcan`.
- **No hardware** → `--source sim` (or `replay` a recording). Works identically
  on every OS; start here to learn the tools.

---

## macOS (native install)

The easiest platform. Homebrew covers everything.

### 1. Prerequisites

```sh
brew install python node libusb      # libusb only needed for the gs_usb adapter
```

`python` and `node` from Homebrew satisfy Python 3.10+ / Node 20+. Verify:

```sh
python3 --version    # >= 3.10
node --version       # >= 20
```

### 2. Backend

```sh
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt          # lean base (websockets)

# real adapter (candleLight/UCAN over libusb):
pip install "gs_usb>=0.2.1" "pyusb>=1.2.1"

# zero hardware:
python -m discodb2_backend --source sim
# real adapter:
python -m discodb2_backend --source gs_usb --bitrate 500000
```

> macOS has **no SocketCAN** — `gs_usb` (libusb) is the first-class adapter path
> here. No driver install is needed: the device enumerates as a raw libusb
> device and Homebrew's `libusb` is enough.

### 3. Cockpit

```sh
cd frontend/cockpit
npm install
npm run dev          # http://localhost:5173 — auto-connects to ws://localhost:8765/ws
```

Open `http://localhost:5173` and click **Start**. Done — no mDNS, no AP.

---

## Linux (native install)

On Linux the candleLight adapter binds to the **in-kernel `gs_usb` driver** and
shows up as a SocketCAN `can0` interface — the same path the Pi uses, and the
recommended one.

### 1. Prerequisites

Debian/Ubuntu:

```sh
sudo apt update
sudo apt install -y python3 python3-venv python3-pip can-utils iproute2
# Node 20+ (use nodejs.org / nvm / your distro's nodesource repo):
node --version       # >= 20
# libusb only if you prefer the gs_usb (libusb) path instead of SocketCAN:
sudo apt install -y libusb-1.0-0
```

Fedora/Arch: the equivalents are `python3 python-virtualenv can-utils iproute2`
(and `libusb` / `libusbx`).

### 2. Bring up `can0` (SocketCAN, recommended)

Plug in the candleLight adapter, then:

```sh
sudo modprobe gs_usb                 # usually auto-binds on hotplug
dmesg | grep -i gs_usb               # confirm the bind
sudo ip link set can0 type can bitrate 500000 listen-only on
sudo ip link set up can0
ip -details link show can0           # expect: state UP, bitrate 500000, LISTEN-ONLY
candump can0                         # sanity-check live frames (Ctrl-C to stop)
```

> **Listen-only at the link layer too.** Setting `listen-only on` here is
> defence-in-depth; the backend enforces it server-side regardless. The Pi does
> this automatically via `can-up.sh` ([`../pi-image/scripts/can-up.sh`](../pi-image/scripts/can-up.sh)).

### 3. Backend

```sh
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
pip install "python-can>=4.0"        # for the socketcan source

python -m discodb2_backend --source socketcan --bitrate 500000
# zero hardware: python -m discodb2_backend --source sim
```

> **Prefer libusb to SocketCAN?** Install `gs_usb pyusb` instead of `python-can`
> and run `--source gs_usb`. You may need a udev rule for non-root access to the
> raw USB device (`SUBSYSTEM=="usb", ATTR{idVendor}=="1d50", ATTR{idProduct}=="606f", MODE="0660"`).

### 4. Cockpit

```sh
cd frontend/cockpit
npm install
npm run dev          # http://localhost:5173 — auto-connects to ws://localhost:8765/ws
```

---

## Windows (native install)

> Bonne chance. 🙃 Windows has **no SocketCAN**, and the libusb path needs a
> manual driver swap. Two adapter options, in order of pain:

### Option A — slcan (least painful)

If your adapter runs **slcan firmware** (e.g. CANable in slcan mode), it shows
up as a **COM port** and needs no driver surgery — just `pyserial`.

1. **Python 3.10+** and **Node 20+**: install from [python.org](https://www.python.org/downloads/)
   and [nodejs.org](https://nodejs.org/) (tick *"Add to PATH"* for Python).
2. Backend (PowerShell):
   ```powershell
   cd backend
   py -m venv .venv; .\.venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   pip install "python-can>=4.0" "pyserial>=3.5"
   # find the COM port in Device Manager (e.g. COM4), then:
   py -m discodb2_backend --source slcan --bitrate 500000
   ```
   The slcan channel/port is taken from config/env; confirm the COM port the
   adapter enumerated as in **Device Manager → Ports (COM & LPT)**.

### Option B — gs_usb via libusb (candleLight firmware)

candleLight devices enumerate as raw USB, and `pyusb`/`gs_usb` need a
**WinUSB** driver behind them — Windows won't expose the device to libusb out of
the box.

1. Install **[Zadig](https://zadig.akeo.ie/)**. Plug in the adapter, in Zadig
   pick the candleLight device (VID `1D50` / PID `606F`) and **replace its driver
   with WinUSB**. ⚠️ This unbinds any vendor driver — the device then speaks
   libusb only.
2. ```powershell
   cd backend
   py -m venv .venv; .\.venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   pip install "gs_usb>=0.2.1" "pyusb>=1.2.1"
   py -m discodb2_backend --source gs_usb --bitrate 500000
   ```
   If `pyusb` can't find a backend, install a libusb DLL (e.g. via
   [libusb releases](https://github.com/libusb/libusb/releases) — drop
   `libusb-1.0.dll` next to the venv or on `PATH`).

### Cockpit (either option)

```powershell
cd frontend\cockpit
npm install
npm run dev          # http://localhost:5173 — auto-connects to ws://localhost:8765/ws
```

> **No hardware on Windows?** `py -m discodb2_backend --source sim` needs none of
> the driver dance — it works on a clean Python install. Use it to validate the
> UI path first.

---

## Richer demo: the looping "circuit" trace (optional, any OS)

The built-in `sim` source is a procedural fixture. For a *coherent* demo — a car
doing laps, decodable in the cockpit's **Cluster** view — generate a **DBC-true**
trace from a scenario and replay it on a loop. The generator is an offline tool
([`tools/gen_trace.py`](../../tools/gen_trace.py)) that uses `cantools`; the lean
backend only replays the resulting capture.

```sh
# one-time: install the generator's deps (offline tool, not a backend dep)
pip install cantools pyyaml

# generate the 5-min seamless circuit trace from the scenario + DBC
python tools/gen_trace.py infra/sim/scenario.cluster.yaml \
    docs/vw/dbc/vw_pq-en.dbc -o backend/recordings/vw_pq_circuit.canlog --check-loop

# replay it endlessly as a demo bus
cd backend
python -m discodb2_backend --source replay \
    --file recordings/vw_pq_circuit.canlog --loop
```

Open the cockpit, point it at `ws://localhost:8765/ws`, and switch to **Cluster**
mode — speed / rpm / gear / lights / turn signals animate through a believable
*drive*: out of an underground car park, a reverse out of the bay, a stop sign,
a town loop with a hill and a chicane, a motorway stretch to ~120 km/h, then back
to park. Because the trace is generated *from* the DBC, it's also **ground truth**
for testing your own decoding. Edit
[`infra/sim/scenario.cluster.yaml`](../sim/scenario.cluster.yaml) and regenerate
to change the drive. (The generated `.canlog` lands under `recordings/`, which is
git-ignored.)

> In Docker this same trace is built at image-build time and served by the
> `simloop` service — see [`../docker/README.md`](../docker/README.md).

## Production-style serve (optional, any OS)

`npm run dev` runs Vite, which is fine for bench use. To serve a **built**
cockpit instead (closer to the Pi, no live Node process):

```sh
cd frontend/cockpit
npm ci && npm run build              # -> frontend/cockpit/dist/
# serve the static dist with anything; stdlib http.server matches the Pi:
python3 -m http.server 8080 --directory dist
```

Then open `http://localhost:8080`. The page still auto-connects to
`ws://localhost:8765/ws`. (The Pi does exactly this via
[`discodb2-web.service`](../pi-image/systemd/discodb2-web.service).)

---

## Troubleshooting

- **Cockpit loads but won't connect:** the backend isn't up or is on another
  port. Check `curl http://localhost:8765/health` returns JSON; confirm the
  cockpit's WS URL is `ws://localhost:8765/ws`.
- **`gs_usb` source fails to open:** missing libusb (macOS: `brew install
  libusb`; Windows: WinUSB via Zadig + a libusb DLL; Linux: a udev rule for
  non-root). The error is loud and names the missing dependency.
- **Linux `can0` missing:** `dmesg | grep -i gs_usb`, `lsusb` should show
  `1d50:606f`. The adapter must run **candleLight/gs_usb** firmware (not slcan)
  for the in-kernel driver to bind.
- **Wrong bitrate → no frames / errors:** VAG powertrain buses are usually
  500 kbit/s; comfort buses are often 100 kbit/s. Match `--bitrate` to the bus.
- **Want a real adapter inside Docker instead?** That's host-specific and
  Linux-only — see the supplement in [`../docker/README.md`](../docker/README.md).
