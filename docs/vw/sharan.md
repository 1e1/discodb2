# VW Sharan — CAN reverse-engineering field guide

A hypothesis sheet and hunting checklist for the discodb2 Sharan project. It tells
you **what to provoke**, **which frames/signals to chase**, and **how confident**
each hypothesis is.

> **Source of the hypotheses.** None of this comes from a Sharan. It is lifted from
> neighbouring VW DBCs kept in [dbc/](dbc/): primarily `dbc/vw_pq-en.dbc` (PQ46), with
> `dbc/vw_golf_mk4-en.dbc` (PQ34 era) and `dbc/vw_mqb_2010-en.dbc` (MQB era) as the
> narrower reference and the cross-check. Treat every ID/signal below as a **lead to
> confirm on the wire**, not a fact. Always validate decoded values against reality
> before trusting them. See [README.md](README.md) for file roles and licensing.

## Platform reality check (read this first)

The Sharan exists in two CAN-relevant generations, and which one you have decides
which half of this doc is the strong bet:

| Generation | Years | Platform | CAN family | Strong reference |
|---|---|---|---|---|
| **Mk1 (7M)** | 1995–2010 | 7M (shared w/ Ford Galaxy) | early VAG drive-CAN (PQ-style msg IDs), comfort-CAN added later | **Part 1 (PQ / Golf Mk4)** |
| **Mk2 (7N)** | 2010–2022 | **PQ46** (B6 Passat platform) | classic VAG **drive-CAN @ 500 kbit/s** + **comfort-CAN @ 100 kbit/s** | **Part 1 (PQ)** primary, **Part 2 (MQB)** secondary |

Key insight that drives this whole guide: **the PQ powertrain-CAN message IDs
(`0x280`, `0x1A0`, `0x320`, …) are remarkably stable across PQ34 → PQ35 → PQ46.**
A Golf Mk4 DBC is therefore a *better* first guess for a Sharan — even a 2015 7N —
than the MQB DBC, because the Sharan 7N is PQ46, **not** MQB. MQB renumbered
everything (`0x0FD`, `0x101`, …) and only arrived ~2012 on MQB cars. So:

- **Start with Part 1.** Highest hit rate.
- **Use Part 2 as a fallback / cross-check**, especially for late facelift 7N
  modules that may have been modernised, or if Part 1 IDs come up empty.

If you don't yet know which bus you tapped (drive vs comfort), the bus speed tells
you: ~500 kbit/s = powertrain (engine/ABS/steering), ~100 kbit/s = comfort
(doors/lights/wipers). The Sharan 7N has both; most "what does this car do"
signals live on **drive-CAN**, body/comfort signals on **comfort-CAN**.

---

# Part 1 — What to hunt, and the PQ hypotheses to confirm

Each block below is a **target** (a thing about the car you want to read off the
bus). For each: how to make it move (the A/B you capture), the candidate
frame(s)/signal(s) to look at first, and notes.

## How to hunt it in discodb2 (method)

The Hunt panel's **2-point capture** is the right tool for almost everything here:

1. Put the car in **state A** (e.g. engine off / pedal released / wheels straight).
   Capture mark **A**.
2. Move to **state B** (engine running / pedal floored / wheel turned). Capture **B**.
3. `marks.compare` ranks every signal/byte by **delta A→B**. The frame whose bytes
   move the most, in the direction you expect, is your candidate.
4. Confirm it: repeat the A→B toggle 2–3 times. A real signal moves **every** time
   and is **monotonic** with the physical input. A coincidence won't survive repeats.

For continuously-varying targets (RPM, speed, steering) use **Trend capture**
(Start/Stop) and sweep the input slowly while watching which bytes track it.

Tips:
- The candidate IDs below are **hex**. Filter the frame list to that ID first; if it
  exists on your bus, decode the byte range; if it doesn't, fall back to `compare`.
- These DBCs are **little-endian** (Intel, `@1+`). Multi-byte values are LSB-first.
- Many PQ frames carry a **rolling counter** (`Zaehler_*`, low nibble of a byte) and
  a **checksum** (`Checksumme_*`, usually byte 0 or last byte). Counters increment
  every frame regardless of state — don't mistake them for your signal. They're also
  a great way to confirm you've found the right frame and its byte layout.

---

### 1. Engine RPM
- **Provoke:** idle → rev to ~3000 rpm (Trend capture, slow sweep).
- **PQ candidate:** `0x280` **Motor_1** → `Motordrehzahl`, **bytes 2–3** (16-bit LE),
  factor **0.25 rpm**. Idle ≈ 800 → raw ≈ 3200.
- **Notes:** the single most reliable PQ frame. Sent fast (~10 ms). Byte 5
  (`Fahrpedalwert_oder_Drosselklappe`, 0.4 %/bit) is **accelerator pedal / throttle**
  on the same frame — two targets for the price of one.

### 2. Accelerator pedal / throttle position
- **Provoke:** pedal released → floored, engine off (ignition on) to avoid RPM noise.
- **PQ candidates:** `0x280` **Motor_1** byte 5 (`Fahrpedalwert…`, 0.4 %);
  `0x380` **Motor_3** → `Fahrpedal_Rohsignal` (byte 2, 0.4 %) and
  `Drosselklappenpoti` (byte 7, 0.4 %). 0 % → 100 %.

### 3. Vehicle speed
- **Provoke:** stationary → drive (or jack-up + spin a wheel for wheel-speed frames).
- **PQ candidates (in priority order):**
  - `0x1A0` **Bremse_1** → `Geschwindigkeit_neu` (15-bit from bit 17, **0.01 km/h**).
  - `0x320` **Kombi_1** → `Geschwindigkeit` (15-bit from bit 25, 0.01 km/h) and
    `Angezeigte_Geschwindigkeit` (the *displayed* speed, 0.32 km/h) — note the
    instrument cluster usually reads a few % optimistic vs the ABS value.
- **Notes:** speed appears on **multiple** frames; that redundancy is itself a good
  confirmation (they should agree within a few %).

### 4. Individual wheel speeds (4×)
- **Provoke:** jack up one corner, spin that wheel; only one of four values moves.
- **PQ candidate:** `0x4A0` **Bremse_3** → `Radgeschw_VL/VR/HL/HR`, four 15-bit LE
  values at bits 1 / 17 / 33 / 49, factor **0.01 km/h**. VL=front-left, VR=front-right,
  HL=rear-left, HR=rear-right.
- **Why it matters:** the cleanest "isolate one signal" target — only the spun
  wheel's field changes. Excellent for validating your bit-extraction math.

### 5. Brake pedal / brake pressure
- **Provoke:** press/release brake pedal (engine running for vacuum/booster).
- **PQ candidates:** `0x4A8` **Bremse_5** → `Bremsdruck` (12-bit from bit 16, 0.1 bar);
  `0x1A0` **Bremse_1** → `Fahrer_bremst…` (1-bit, brake-applied flag) and
  `Bremslichtschalter` equivalents. Also `0x320` **Kombi_1** `Bremsinfo` (2-bit).
- **Notes:** the **boolean brake-light switch** moves first and cleanest; pressure is
  the analogue follow-up. Hunt the boolean with 2-point compare, then refine to pressure.

### 6. Steering wheel angle
- **Provoke:** wheels straight → full lock left, then full lock right (Trend capture).
- **PQ candidate:** `0x0C2` **Lenkwinkel_1** → `Lenkradwinkel` (15-bit from bit 0,
  **0.04375°/bit**) + `Lenkradwinkel_Sign` (bit 15, direction) +
  `Lenkradwinkel_Geschwindigkeit` (steering rate).
- **Notes:** sign bit flips left/right — watch for a separate 1-bit field that toggles
  at centre. Range is wheel angle (±~540°), not road-wheel angle.

### 7. Gear / selector position (auto) & clutch (manual)
- **Provoke (auto):** move selector P → R → N → D.
- **PQ candidate:** `0x440` **Getriebe_1** → `Waehlhebelposition` (4-bit from bit 12)
  and `Zielgang_oder_eingelegter_Gang` (4-bit from bit 8). Each lever position is a
  distinct nibble value — map them by stepping through positions.
- **Manual clutch:** `0x280` **Motor_1** `Kupplungsschalter` (1-bit) — press clutch.

### 8. Ignition / key state (clamps)
- **Provoke:** key OUT → IN → ignition ON (clamp 15) → crank (clamp 50).
- **PQ candidate:** `0x572` **ZAS_1** (only 2 bytes) → `S_Kontakt` (key inserted),
  `Klemme_15` (ignition on), `Klemme_X`, `Klemme_50` (cranking),
  `Klemme_P` (parking light). These are adjacent single bits in byte 0.
- **Notes:** a textbook 2-point capture — each clamp is one bit that flips with a
  clear physical action. Great first target to validate your whole pipeline.

### 9. Turn signals / hazards / exterior lights
- **Provoke:** left indicator on/off, then right, then hazards; then low/high beam.
- **PQ candidate:** `0x390` **Gate_Komf_1** (comfort gateway, very rich):
  `GK1_Blinker_li` / `GK1_Blinker_re` (indicators), `GK1_Warnblk_Status` (hazard),
  `GK1_Abblendlicht` (low beam), `GK1_Fernlicht` (high beam), `GK1_Bremslicht`,
  `GK1_Nebel_ein` (fog), `GK1_BrLi_*` (brake-light bulbs). Also `0x320` **Kombi_1**
  `Blinker_links/rechts`.
- **Notes:** `0x390` is a goldmine of body booleans — capture A/B on each switch and
  the moving bit is your answer. Lives on **comfort-CAN**.

### 10. Doors / belts / wipers
- **Provoke:** open/close each door; buckle/unbuckle belt; wiper stalk through stages.
- **PQ candidates:**
  - Driver door: `0x320` **Kombi_1** `Fahrertuer` (1-bit). Door contacts also on
    `0x390` (`GK1_*Tuerkont`).
  - Seatbelts: `0x050` **Airbag_1** → `Gurtschalter_Fahrer` / `Gurtschalter_Beifahrer`
    (+ the matching `Gurtwarnung_*` warning bits).
  - Wipers: `0x538` **Wischer_1** → `Frontwischer_eingeschaltet`,
    `Ansteuerung_Frontwischer_Normal/Schnell`, rear-wiper bits.

### 11. Fuel level
- **Provoke:** hard to provoke quickly — read static value, confirm over a long drive
  as it drops, or compare full vs near-empty sessions.
- **PQ candidate:** `0x320` **Kombi_1** → `Tankinhalt` (7-bit from bit 16, **1 litre/bit**)
  + `Tankwarnung` (low-fuel bit). Slow-moving; use Trend over a long capture.

### 12. Coolant temperature
- **Provoke:** cold start → warm up to ~90 °C (very slow Trend, or compare cold vs warm).
- **PQ candidate:** `0x288` **Motor_2** → `Kuehlmitteltemperatur` (byte 1, **0.75 °C,
  offset −48**). Cold ≈ ambient, warm ≈ 90 °C → raw ≈ 184.

### Part 1 quick reference

| Target | Frame (hex) | DBC name | Signal | Scale | Bus |
|---|---|---|---|---|---|
| RPM | `0x280` | Motor_1 | Motordrehzahl (b2–3) | 0.25 rpm | drive |
| Pedal/throttle | `0x280`/`0x380` | Motor_1/Motor_3 | Fahrpedalwert / Fahrpedal_Rohsignal | 0.4 % | drive |
| Speed | `0x1A0` | Bremse_1 | Geschwindigkeit_neu | 0.01 km/h | drive |
| Wheel speeds | `0x4A0` | Bremse_3 | Radgeschw_VL/VR/HL/HR | 0.01 km/h | drive |
| Brake pressure | `0x4A8` | Bremse_5 | Bremsdruck | 0.1 bar | drive |
| Steering angle | `0x0C2` | Lenkwinkel_1 | Lenkradwinkel | 0.04375° | drive |
| Gear/selector | `0x440` | Getriebe_1 | Waehlhebelposition | enum | drive |
| Ignition clamps | `0x572` | ZAS_1 | Klemme_15/X/50/S | bits | drive/comf |
| Lights/blinkers | `0x390` | Gate_Komf_1 | GK1_Blinker_*, GK1_*licht | bits | comfort |
| Driver door | `0x320` | Kombi_1 | Fahrertuer | bit | comfort |
| Seatbelt | `0x050` | Airbag_1 | Gurtschalter_Fahrer | bit | drive |
| Wipers | `0x538` | Wischer_1 | Frontwischer_eingeschaltet | bit | comfort |
| Fuel level | `0x320` | Kombi_1 | Tankinhalt | 1 L | comfort |
| Coolant temp | `0x288` | Motor_2 | Kuehlmitteltemperatur | 0.75 °C, −48 | drive |

---

# Part 2 — MQB candidates to verify on PQ46

If the Sharan is a late 7N and Part 1 misses, or you want a cross-check, the MQB DBC
gives a **renumbered** alternative set. **Lower prior probability on PQ46** — verify
each one on the wire before trusting it. Where MQB and PQ disagree on the ID, that
disagreement is itself the test: whichever ID actually exists on your bus tells you
which family the Sharan's modules belong to.

> **Confidence model.** "Frame exists at this ID **and** the byte decodes to a sane,
> physically-tracking value" = confirmed. Anything less = unconfirmed lead. The MQB
> frames carry an explicit `CHECKSUM` (byte 0) + `COUNTER` (low nibble of byte 1) —
> use them to confirm framing exactly as in Part 1.

### MQB target → candidate map

| Target | Frame (hex / dec) | DBC name | Signal & layout | Scale |
|---|---|---|---|---|
| **Vehicle speed** | `0x0FD` / 253 | ESP_21 | `ESP_v_Signal`, 16-bit @ bit 32 | 0.01 km/h |
| **Wheel speeds** | `0x0B2` / 178 | ESP_19 | `ESP_HL/HR/VL/VR_Radgeschw_02`, 4×16-bit @ 0/16/32/48 | 0.0075 km/h |
| **Yaw / accel** | `0x101` / 257 | ESP_02 | `ESP_Gierrate` (b40, 14-bit, 0.01°/s), `ESP_Laengsbeschl`, `ESP_Querbeschleunigung` | see DBC |
| **Brake pressure** | `0x106` / 262 | ESP_05 | `ESP_Bremsdruck`, 10-bit @ bit 16 (0.3, −30) + `ESP_Fahrer_bremst` (bit 26) | bar |
| **Steering angle** | `0x086` / 134 | LWI_01 | `LWI_Lenkradwinkel`, 13-bit @ bit 16 (0.1°) + `LWI_VZ_*` sign | 0.1° |
| **Steering (EPS)** | `0x09F` / 159 | LH_EPS_03 | `EPS_Berechneter_LW` (0.15°), `EPS_Lenkmoment` (torque) | 0.15° |
| **RPM (displayed)** | `0x107` / 263 | Motor_04 | `MO_Anzeigedrehz`, 12-bit @ bit 24 (3 rpm); also `MO_Istgang` gear (b8) | 3 rpm |
| **Ignition clamps** | `0x3C0` / 960 | Klemmen_Status_01 | `ZAS_Kl_15` (b17), `ZAS_Kl_X` (b18), `ZAS_Kl_50` (b19), `ZAS_Kl_S` (b16) | bits |
| **Displayed speed / cluster** | `0x30B` / 779 | Kombi_01 | `KBI_angez_Geschw` (10-bit @ b48, 0.32) + `KBI_Handbremse`, `KBI_Tankwarnung` | 0.32 km/h |
| **Gear selector** | `0x0AF` / 175 | Waehlhebel_03 | `WH_SensorPos_roh` (4-bit @ b4), `WH_Status` | enum |
| **Fuel sender (raw)** | `0x65E` / 1630 | OBD_Tankgeber_01 | `OBD_TG_Sens_Rohwert_1..4`, 12-bit each | 0.5 Ω |
| **Parking brake** | `0x104` / 260 | EPB_01 | `EPB_Schalterposition` (2-bit @ b52), `EPB_Status` (b61) | enum |
| **Turn signals** | `0x366` / 870 | Blinkmodi_02 | `Left/Right_Turn_Exterior_Bulb_1/2`, `Comfort_Signal_Left/Right`, `Hazard_Switch` | bits |

### What's worth verifying first (highest payoff)

1. **`0x3C0` Klemmen_Status_01 vs `0x572` ZAS_1.** Toggle the ignition and see which
   ID carries the clamp bits. This single test classifies the car as MQB-ish vs
   PQ-ish for the rest of the modules.
2. **Speed: `0x0FD` (MQB) vs `0x1A0` (PQ).** Drive and see which ID's 16-bit field
   tracks speed. On a 7N PQ46 the PQ `0x1A0` should win, but confirm.
3. **Wheel speeds: `0x0B2` (MQB) vs `0x4A0` (PQ).** Same spin-one-wheel test; note the
   different scale (MQB 0.0075 vs PQ 0.01 km/h) — the scale that yields a sane km/h
   confirms the family.
4. **Steering: `0x086` LWI_01 (MQB) vs `0x0C2` Lenkwinkel_1 (PQ).** Note MQB
   `LWI_Lenkradwinkel` is 0.1°/bit while PQ is 0.04375°/bit — the correct scale is the
   one that reads ~0° centred and ±~540° at the locks.

### Known caveats for MQB→PQ46

- **IDs almost certainly differ.** MQB's compact low IDs (`0x0FD`, `0x101`, `0x0B2`,
  `0x086`) are an MQB-generation convention; a PQ46 Sharan is more likely to use the
  Part 1 IDs. Expect Part 2 IDs to mostly **not be present** on a true 7N drive-CAN.
- **Scales/offsets are NOT portable.** Even if a signal name matches, MQB and PQ use
  different factor/offset (see wheel-speed and steering examples above). Never reuse a
  scale across families without re-deriving it from a known physical value.
- **Hybrid/EV frames are noise here.** The MQB DBC carries `Motor_Hybrid_*`, `BMS_*`,
  `EV_Gearshift`, `KN_*`/`NMH_*` (29-bit) frames that won't exist on a diesel/petrol
  Sharan. Ignore them.
- **`VehicleSpeed` (`0x11E`/286) in the MQB DBC is a partial/reverse-engineered stub**
  (only `Speed` at bit 52, scale looks wrong). Prefer `ESP_21`/`ESP_19` for speed.

---

## Working notes

- These DBCs ([dbc/](dbc/)) are opendbc-derived **priors**, not Sharan facts. Don't
  trust any decoded scale you copy verbatim — re-derive and document your own Sharan
  values as you confirm them. (The raw CSS Electronics download cache in
  `docs/external/` stays local-only and uncommitted.)
- As you confirm signals, record them in the project (FrameDef/Signal) so the Hunt
  Wizard and DBC export carry *your* verified Sharan map, not these borrowed guesses.
- When a confirmed signal disagrees with the borrowed scale, **trust the wire** and
  update the note — that disagreement is real platform divergence, not an error.
