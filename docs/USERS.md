# User guide

discodb2 helps you discover and decode signals on a vehicle CAN bus. This guide
covers what you need, how to run it (on a PC or a Raspberry Pi in the car), and
how to use the two clients.

## What you need

- **A CAN adapter** — a candleLight/gs_usb device (e.g. FYSETC UCAN). Or nothing:
  use the built-in **simulator** to learn the tools first.
- **Bus access** — typically the car's OBD-II port. Confirm the bitrate (500 kbit/s
  is common on VAG powertrain buses).
- **A computer** — macOS, Linux or Windows; or a Raspberry Pi (1 B+ to 3 B+) to
  leave in the car.

## Safety

discodb2 opens the bus **listen-only** (silent): the adapter does not acknowledge
or transmit. This is **enforced in the backend** and does not depend on your
network or UI — a request to disable it on a live source is refused. You cannot
accidentally inject traffic onto a moving car.

Two hardware notes:
- **Termination:** if the vehicle already has its 120 Ω terminators (≈60 Ω across
  CAN-H/CAN-L), do **not** enable the adapter's terminator.
- Start at the **OBD-II port**; only consider tapping a powertrain bus later, and
  only if you understand the wiring.

## Run on a PC

```bash
# Backend
cd backend
pip install -r requirements.txt
python -m discodb2_backend --source sim            # try it with no hardware
# with a real adapter:
python -m discodb2_backend --source gs_usb         # candleLight/UCAN via libusb
#   (macOS: `brew install libusb` first)

# Cockpit (full client)
cd frontend/cockpit && npm install && npm run dev   # http://localhost:5173
#   set the WebSocket to ws://localhost:8765/ws and click Start

# Copilot (phone view, optional)
cd frontend/copilot && npm install && npm run dev   # open the Network URL on a phone
#   point it at the backend with ?ws=ws://<backend-host>:8765/ws
```

The simulator has two profiles: `--sim-profile realistic` (default; undulating
signals, good for exercising the tools) and `--sim-profile lite` (minimal CPU, for
constrained hosts).

## Run on a Raspberry Pi (in the car)

The Pi becomes a self-contained WiFi access point; your laptop/phone connect to it.

1. Flash Raspberry Pi OS Lite (32-bit) and apply the provisioning in
   [`infra/pi-image/`](../infra/pi-image/) (see its README). It brings up `can0`
   listen-only, starts the backend on boot, and runs a **WPA2 access point**.
2. Plug in the adapter (and a WiFi dongle on models without onboard WiFi — check it
   supports AP/master mode).
3. Join the Pi's WiFi and open the cockpit/copilot at its address (e.g.
   `http://192.168.4.1`).

Note: the Pi has no real-time clock. Timestamps are **relative** (what matters for
analysis); the connecting client stamps the absolute session time.

## Using the cockpit (laptop / desktop)

- **Live table** — every arbitration ID with name, DLC, data, rate and last-seen.
- **Filter bar** — narrow by ID range, byte mask/value, minimum rate, or name.
- **Inspector** — a per-bit change grid that flashes when a bit flips, plus payload
  history. Great for spotting flags and counters.
- **Signals** — name a frame and define signals over it (bit range, endianness,
  factor/offset, unit) with a live-decoded value. Export to JSON/DBC/CSV.
- **Hunt** — the home of the guided detection workflow (in active design).

## Using the copilot (phone)

A light, glanceable view for the driver: large value tiles, a gauge, and a
flashing-bit indicator. It keeps the screen awake, reconnects across phone
sleep/backgrounding, and deliberately holds **no** large history (kind to phone
memory). Pick what to watch by signal name or raw ID/byte.

## A basic discovery workflow

1. **Baseline** — capture with everything at rest.
2. **One action at a time** — perform a single change (ignition on, handbrake,
   reverse, a speed ramp) and watch which bytes/bits react.
3. **Compare** — the byte/bit that moved with your action, and stayed put
   otherwise, is your candidate. Name it, give it a scale, and confirm against a
   known value (the dashboard, or an OBD-II reading).

See the [design doc](DESIGN.md) for the data model behind named signals.
