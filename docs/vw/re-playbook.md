# Sharan 7N (PQ46) CAN reverse-engineering playbook

Working notes for decoding the broadcast CAN frames of a **VW Sharan 7N, 1.5/1.4 TSI
(EA211), mid-2018 facelift, "Sound" trim**, using a **CANable v2** sniffer +
**VCDS (Ross-Tech)** as a ground-truth oracle.

> Status: hypotheses to confirm on the car. **Primary reference is now
> `vw_pq-en.dbc`** (English translation of opendbc's maintained `vw_pq.dbc`), a strict
> superset of the older `vw_golf_mk4-en.dbc`: same 77 classic messages **+ 9 more**
> (TPMS, blind-spot, park assist, extended braking, vehicle ident). The MQB DBC
> redesigned these IDs and is only a fallback for newer features (ACC, etc.).
> Ready-to-load starters: `sharan_7n_antrieb-starter.dbc` (500k) and
> `sharan_7n_komfort-starter.dbc` (100k), both sourced from `vw_pq-en.dbc`.
> All DBC files named in this playbook live in [dbc/](dbc/); see [README.md](README.md)
> for file roles and licensing, and [vehicle-and-rig.md](vehicle-and-rig.md) for the car,
> the sniffer rig (FYSETC UCAN v1.0 / candleLight), and the OBD2-PID route.

## 1. Why the PQ DBC is the primary reference, not MQB

PQ46 (Passat B6/B7 family, 2010–2022) kept the *classic* VAG powertrain CAN layout:
`engine_1@0x280`, `engine_3@0x380`, `brake_1@0x1A0`, `transmission@0x4xx/0x5xx`,
`instrument_cluster_1@0x320`. The MQB platform (Golf 7, 2013+) rebuilt the whole map
(new 11-bit IDs, some 29-bit extended). opendbc's `vw_pq.dbc` carries the full classic
set plus PQ46-era ADAS/chassis messages, so it is the better starting point for the
Sharan on **both** buses.

### 1b. New PQ messages added (vs vw_golf_mk4) — confirm bus on the car

| ID | Message | Content | Starter bus |
|---|---|---|---|
| `0x343` | RDK_status | tire pressure (TPMS) | both (uncertain) |
| `0x3BA` | SWA_1 | blind-spot / lane-change assist | both (uncertain) |
| `0x3D4` `0x497` | PLA_1 / park_assist_01 | park assist | both (uncertain) |
| `0x3A0` `0x5B7` | brake_10 / brake_11 | extended ESP/EPB braking | Antriebs |
| `0x392` | Gate_Komf_2 | comfort gateway | Komfort |
| `0x5D2` `0x5DC` | Ident / target_installation_list_new | vehicle ID + equipment | Komfort |

## 2. Bus architecture & where to tap

The 7N is a star around the **Gateway J533**. Separate physical buses:

| Bus | Bitrate | Carries | On OBD (J1962)? |
|---|---|---|---|
| **Antriebs-CAN** (powertrain) | 500 kbit/s | engine, transmission, ABS/ESP, ACC | **Yes** — pins 6 (H) / 14 (L) |
| **Komfort-CAN** (comfort) | 100 kbit/s | doors, windows, turn signals, ignition (ZAS), wipers, install list | **No** — behind gateway |
| Infotainment-CAN | 500 kbit/s | radio/nav, MMI | No |

OBD pinout (VW): pin 6 = Antriebs CAN-H, pin 14 = Antriebs CAN-L, pin 16 = +12 V,
pins 4/5 = GND. **The comfort frames are NOT on the OBD port** — to sniff `ZAS_1`,
`wiper_1`, doors, etc. you must tap the Komfort-CAN pair at the gateway or a body module.

VAG CAN wire colours (verify against the 7N wiring diagram — convention only):
- Antriebs: CAN-H = orange/black, CAN-L = orange/brown
- Komfort: CAN-H = orange/green, CAN-L = orange/brown
- Infotainment: CAN-H = orange/violet, CAN-L = orange/brown

## 3. CANable v2 setup (SocketCAN, passive & safe)

CANable v2 with **candleLight (gs_usb)** firmware enumerates as a native SocketCAN device.
PQ46 is **classic CAN** (not CAN-FD), so no FD config needed.

**Always sniff in listen-only mode** so the adapter never emits ACK/error frames and cannot
disturb the vehicle bus or go bus-off:

```bash
# Antriebs-CAN, on the OBD port (pins 6/14):
sudo ip link set can0 up type can bitrate 500000 listen-only on
candump -ta can0 | tee antrieb_$(date +%s).log

# Komfort-CAN, tapped at the gateway:
sudo ip link set can0 down
sudo ip link set can0 up type can bitrate 100000 listen-only on
candump -ta can0 | tee komfort_$(date +%s).log
```

- One CANable = **one channel** → sniff one bus at a time (re-`ip link` to switch bitrate).
- **Termination:** the vehicle bus is already terminated (2×120 Ω). Leave the CANable's
  120 Ω terminator **OFF** when tapping a live bus — a third terminator over-loads it.
- slcan firmware alternative: `slcand -o -s6 /dev/ttyACMx can0` (s6 = 500k, s3 = 100k),
  then `ip link set can0 up` — but candleLight + native listen-only is preferred.

## 4. Candidate frames — Antriebs-CAN (500k, via OBD)

Bit positions are **little-endian (Intel, `@1`) start bits** as in the DBC. Confirm
scale/offset against VCDS; typical VAG scalings are noted as hints only.

| ID | Message | Signal | start|len | Notes / typical scale |
|---|---|---|---|---|
| `0x280` | engine_1 | `engine_rpm` | 16|16 | ~0.25 rpm/bit (raw = rpm×4) |
| `0x280` | engine_1 | `accelerator_pedal_value_or_throttle` | 40|8 | 0–100 % |
| `0x288` | engine_2 | `vehicle_speed` | 24|8 | coarse km/h |
| `0x288` | engine_2 | `brake_light_switch` | 16|1 | press brake pedal |
| `0x288` | engine_2 | `GRA_Status` | 22|2 | cruise control state |
| `0x320` | instrument_cluster_1 | `displayed_speed` | 46|10 | dash speed |
| `0x320` | instrument_cluster_1 | `turn_signal_left/right_4_1` | 44/45|1 | |
| `0x320` | instrument_cluster_1 | `fuel_tank_content` | 16|7 | |
| `0x380` | engine_3 | `intake_air_temperature` | 8|8 | ~0.75×raw−48 °C |
| `0x380` | engine_3 | `accelerator_pedal_raw_signal` | 16|8 | |
| `0x1A0` | brake_1 | `speed_new__brake_1_` | 17|15 | ~0.01 km/h/bit (best speed) |
| `0x1A0` | brake_1 | ESP/ASR status bits | 60–63|1 | |
| `0x420` | instrument_cluster_2 | `coolant_temp_4_1_Kombi_2` | 32|8 | ~0.75×raw−48 °C |
| `0x420` | instrument_cluster_2 | `oil_temperature_4_1` | 24|8 | |
| `0x420` | instrument_cluster_2 | `outside_temperature_filtered` | 8|8 | |
| `0x540` | transmission_2 | `engaged_gear` | 60|4 | P/R/N/D + gears |
| `0x588` | engine_7 | `boost_pressure` | 32|8 | **TSI turbo** |
| `0x5A0` | brake_2 | `distance_pulses_front_axle` | 40|11 | odometer pulses |

## 5. Candidate frames — Komfort-CAN (100k, gateway tap)

| ID | Message | Signal | start|len | Manip to trigger |
|---|---|---|---|---|
| `0x572` | ZAS_1 | `terminal_15_ignition_on` | 1|1 | ignition ON |
| `0x572` | ZAS_1 | `terminal_50_starting` | 3|1 | crank |
| `0x572` | ZAS_1 | `S_contact__key_inserted_` | 0|1 | insert key |
| `0x390` | gate_comfort_1 | `GK1_driver_door_contact` | 16|1 | open driver door |
| `0x390` | gate_comfort_1 | `GK1_reverse_light` | 17|1 | engage reverse |
| `0x470` | BSG_cluster | `tailgate_opened` | 13|1 | open tailgate |
| `0x538` | wiper_1 | `windshield_wiper_rear_switched_on` | 8|1 | rear wiper |
| `0x538` | wiper_1 | `control_front_wiper_normal/fast` | 2/3|1 | front wiper |
| `0x570` | BSG_load | `battery_voltage_onboard_supply_battery` | 16|8 | engine on/off |
| `0x570` | BSG_load | `engine_hood_contact` | 15|1 | open hood |
| `0x5E0` | climate_1 | `AC_switch` | 49|1 | toggle A/C |
| `0x5D8` | installation_list_1 | equipment bits | 56–63|1 | static (fingerprint) |
| `0x520` | instrument_cluster_3 | `odometer` | 40|20 | static / increments |

## 6. VCDS-as-oracle correlation loop

Per signal: read the live value in VCDS while logging the bus, vary the physical quantity,
find the byte that tracks it, then solve `phys = raw·factor + offset` from two points.

| Quantity | VCDS source | How to vary | Watch frame/bits |
|---|---|---|---|
| Engine RPM | Engine 01 → meas. block (RPM) | blip throttle | `0x280` 16|16 |
| Vehicle speed | Engine / ABS 03 wheel speeds | drive (or jack + spin wheel) | `0x1A0` 17|15, `0x320` 46|10 |
| Coolant temp | Engine 01 → coolant | warm up from cold | `0x420` 32|8 |
| Pedal / throttle | Engine 01 → throttle angle | press pedal, ignition on, engine off | `0x280` 40|8, `0x380` 16|8 |
| Gear | Transmission 02 | shift P→R→N→D | `0x540` 60|4 |
| Boost | Engine 01 → charge pressure | load engine | `0x588` 32|8 |
| Battery voltage | any module supply voltage | engine off vs running | `0x570` 16|8 |
| Outside temp | Cluster 17 / climate 08 | known ambient | `0x420` 8|8, `0x5E0` |

Two-point solve example (RPM): idle 800 rpm → raw_a; 2000 rpm → raw_b.
`factor = (2000−800)/(raw_b−raw_a)`, `offset = 800 − factor·raw_a`. Expect factor ≈ 0.25.

## 7. discodb workflow

1. **Hunt Scan** both logs → rank active IDs; mark the candidate IDs above as known.
2. **id-profile + bit-level Auto detection** → propose bit fields; overlay the DBC
   hypotheses (start/len from §4–5) as priors.
3. Use the **RE Wizard** correlation step with the VCDS values from §6 to lock
   factor/offset per signal, then promote confirmed signals into a Sharan-specific DBC.
4. Keep VCDS huntMark exclusions in mind (diagnostic request/response IDs are not
   broadcast signals — exclude them from the broadcast decode).

## 8. Safety / etiquette

- Listen-only mode + no extra termination = passive, non-intrusive.
- Do the powertrain captures with the car stationary and supported, or with a helper;
  never operate VCDS adaptations while driving.
- VCDS is used here only as a *value oracle* (read measuring blocks). No need to reverse
  the VCDS binary — its label files are plain text and the diagnostic layer is standard
  UDS/KWP.
