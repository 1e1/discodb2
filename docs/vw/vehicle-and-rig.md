# Target vehicle & CAN rig

The concrete car, sniffer hardware, and reverse-engineering objectives for this
project. Bus architecture, where to tap, and candidate frames live in
[re-playbook.md](re-playbook.md); per-signal hunting recipes live in [sharan.md](sharan.md).

> **Goal.** Read and decode key vehicle signals off the Sharan's broadcast CAN for
> personal telemetry, monitoring, and understanding the electronic architecture.

## Vehicle identification

| Field | Value |
|---|---|
| Make / model | Volkswagen Sharan |
| Year / trim | 2018, "Sound" |
| Engine | Petrol TSI |
| Transmission | Manual |
| Platform | **PQ (confirmed)** — i.e. 7N / PQ46, **not** MQB |
| Infotainment firmware | `MST2_EU_VW_PQ_R0604T` |

The `MST2_EU_VW_PQ_…` infotainment string confirms a late **PQ** architecture, not a
pure MQB platform. This is why `vw_pq-en.dbc` is the primary reference and the MQB DBC
is only a fallback (see [README.md](README.md)).

## CAN interface (sniffer)

| | |
|---|---|
| Adapter | **FYSETC UCAN v1.0** |
| Firmware | candleLight (gs_usb) — VID `0x1d50`, PID `0x606f`, USB product name `canable gs_usb` |
| Status | Already flashed with candleLight; no reflash needed. Compatible with candleLight v1/v2. |

The UCAN must be used in **listen-only** mode (passive, never ACKs the bus).

## Workstation

- **Current:** macOS 12.7.6 Monterey. **Blocker:** SavvyCAN v220 on macOS exposes no
  usable gs_usb backend — no `/dev/tty.*` / `/dev/cu.*` port, `python-can` finds no
  backend, and SocketCAN is unavailable on macOS. The hardware is fine; the limitation
  is purely software (macOS).
- **Planned:** an Ubuntu environment (24.04 LTS or newer) where SocketCAN + `can-utils`
  work natively:
  ```bash
  sudo apt update
  sudo apt install can-utils wireshark git python3-pip
  pip install python-can cantools pandas
  ```

## CAN connection options

- **Option A — OBD2 port.** Easy, no disassembly, power available. But the Gateway
  (J533) filters part of the traffic, so some ECUs are not reachable this way.
  Standard OBD2 PIDs are still forwarded — see the PID list below.
- **Option B — Powertrain CAN tap.** To be considered after the first results: lets you
  see native frames and bypass the Gateway filtering.

### Termination

**Do NOT enable the UCAN's termination resistor while connected to the vehicle.** The
car already provides 120 Ω at each end (≈ **60 Ω** total between CAN-H and CAN-L); a
third terminator over-loads the bus. (OBD pinout & wire colours: see
[re-playbook.md §2](re-playbook.md).)

## Reverse-engineering objectives (by priority)

1. **P1:** ignition state (OFF/ON), engine RPM, vehicle speed.
2. **P2:** electronic parking brake, reverse gear, fuel level.
3. **P3:** instantaneous fuel consumption, engaged gear.
4. **P4:** total odometer.

## Methodology

Change **one parameter at a time** and compare captures. Reference sequence:

1. ignition OFF → 2. ignition ON → 3. engine started → 4. throttle blip in neutral →
5. drive 20 km/h → 6. 50 km/h → 7. 80 km/h → 8. parking brake ON/OFF →
9. reverse gear → 10. full tank → 11. low tank.

In discodb2 this maps onto the Hunt panel's **2-point capture** (state A vs state B,
`marks.compare`) for booleans and the **Trend capture** for continuously-varying
quantities — see [sharan.md](sharan.md) for the per-target recipes.

Companion tools: **SavvyCAN** (ID Frequency, Signal Discovery, Bitfield Viewer,
Histogram, Frame Analyzer — once on Linux), **can-utils** (`candump -L can0 > capture.log`,
`canplayer` to replay), **Wireshark** (`can.id == 0x280`).

## OBD2 route — standard PIDs to try first

The Gateway forwards standard OBD2 (request `0x7DF`/`0x7E0`, responses `0x7E8…`).
Decode with [dbc/OBD-v4.3.dbc](dbc/OBD-v4.3.dbc).

| Quantity | PID | Formula | Confidence |
|---|---|---|---|
| Engine RPM | `01 0C` | `((A·256)+B)/4` | 95 % |
| Vehicle speed | `01 0D` | `A` (km/h) | 99 % |
| Fuel level | `01 2F` | `A·100/255` (%) | 70 % |
| Coolant temp | `01 05` | `A−40` (°C) | — |
| MAF (air flow) | `01 10` | `((A·256)+B)/100` (g/s) | — |

### Derived quantities

- **Instantaneous consumption** (petrol, from MAF) — often easier to reconstruct than to
  find directly:
  `FuelFlow(L/h) = (MAF · 3600) / (14.7 · 745)` (AFR 14.7, petrol density ≈ 745 g/L),
  then `L/100km = FuelFlow · 100 / Speed`.
- **Engaged gear** (manual — unlikely to be broadcast explicitly): compute
  `ratio = RPM / Speed` and cluster the values; the gear bands fall out of the data
  quickly. Build a `ratio → gear` table for 1st–6th.

### State bits to hunt (broadcast CAN)

Likely present as single bits — confirm on the wire (see [sharan.md](sharan.md) for
candidate frames):

| State | 0 / 1 | Confidence |
|---|---|---|
| Ignition | OFF / ON | 95 % |
| Electronic parking brake | released / applied | 85 % |
| Reverse gear | disengaged / engaged | 90 % |

### Odometer (hard)

Direct presence on CAN is **~40 % likely** — it is usually computed in the cluster,
stored in EEPROM, and transmitted rarely. Alternatives: integrate speed over time, or
try **UDS `0x22` ReadDataByIdentifier** against the cluster.

## Open questions for the next session

1. Identify the exact Gateway type installed.
2. Map the present CAN networks (Powertrain / Comfort / Infotainment).
3. Determine which CAN pins are actually live on the OBD socket.
4. Verify bitrates: 100 / 125 / 250 / 500 kbps.
5. Check for any CAN-FD presence.
6. Build a Sharan-specific DBC from confirmed signals.
7. Pin down the exact IDs for: RPM, speed, fuel, parking brake, ignition, reverse,
   odometer.
8. Check whether ECUs answer UDS `0x22` (e.g. for the odometer).

---

*This page is the English synthesis of the project's original French working note
(`___doc___.md` at the repo root, kept as the French chat-context exception).*
