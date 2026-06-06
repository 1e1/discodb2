# VW Sharan — reverse-engineering reference pack

Everything needed to reverse-engineer the broadcast CAN of a **VW Sharan 7N (PQ46),
1.x TSI petrol, manual, 2018 "Sound" trim** lives in this folder. It is the
committed, self-contained companion to the discodb2 project — unlike the
`docs/external/` download cache (CSS Electronics OBD2 pack), which is local-only and
is **not** committed.

## Contents

| File | What it is |
|---|---|
| [vehicle-and-rig.md](vehicle-and-rig.md) | The actual target car, the CAN sniffer rig, bus/wiring facts, RE objectives by priority, and the standard OBD2 PIDs to try first. Start here. |
| [re-playbook.md](re-playbook.md) | The 7N-specific working playbook: why PQ is the primary reference, bus architecture & where to tap, candidate Antriebs/Komfort frames, the VCDS-as-oracle correlation loop, and the discodb workflow. |
| [sharan.md](sharan.md) | Field guide / hypothesis sheet: per-target hunting recipes (what to provoke, which frame/signal to chase, confidence), Part 1 = PQ candidates, Part 2 = MQB cross-checks. |
| [dbc/](dbc/) | The DBC fixtures these hypotheses are lifted from (see below). |

## DBC fixtures (`dbc/`)

These are **priors**, not facts about *this* car. Every ID/signal/scale is a lead to
confirm on the wire against a known physical value (VCDS) before trusting it.

| File | Messages | Platform / role | Source |
|---|---:|---|---|
| `vw_pq-en.dbc` | 86 | **Primary reference.** Classic VAG PQ powertrain+comfort layout, PQ46-era. English translation of opendbc's `vw_pq.dbc`. | opendbc (translated) |
| `sharan_7n_antrieb-starter.dbc` | 16 | Ready-to-load **Antriebs-CAN (500k)** starter, trimmed from `vw_pq-en` to the powertrain frames worth hunting. | local (from `vw_pq-en`) |
| `sharan_7n_komfort-starter.dbc` | 18 | Ready-to-load **Komfort-CAN (100k)** starter (tap at gateway), trimmed from `vw_pq-en`. | local (from `vw_pq-en`) |
| `vw_golf_mk4-en.dbc` | 77 | PQ34-era classic set; the older, narrower reference `vw_pq-en` is a superset of. English translation. | opendbc (translated) |
| `vw_golf_mk4.dbc` | 77 | Same, original German signal names. | opendbc |
| `vw_mqb_2010-en.dbc` | 108 | **Fallback / cross-check only.** MQB renumbered every ID; low prior on a PQ46 Sharan. English translation. | opendbc (translated) |
| `vw_mqb_2010.dbc` | 108 | Same, original German signal names. | opendbc |
| `OBD-v4.3.dbc` | 4 | Standard OBD2 Mode-01 PIDs (responses on `0x7E8–0x7EB`). For the diagnostic/OBD route — the Gateway forwards standard OBD2 even when it filters native broadcast. | CSS Electronics |

**Which to load first:** `sharan_7n_antrieb-starter.dbc` on the 500k powertrain bus
(OBD pins 6/14), `sharan_7n_komfort-starter.dbc` on the 100k comfort bus (gateway tap).
Fall back to the full `vw_pq-en.dbc` when a frame you want isn't in the starter, and to
`vw_mqb_2010-en.dbc` only if PQ IDs come up empty on a late-facelift module.

## Provenance & licensing

The VW DBCs originate from **[opendbc](https://github.com/commaai/opendbc)** (comma.ai),
which is distributed under the **MIT License**. The `-en` files are English
translations of those, and the two `sharan_7n_*-starter` files are local subsets derived
from `vw_pq-en`; all of these inherit opendbc's MIT terms. Retain the upstream MIT
notice if you redistribute them.

`OBD-v4.3.dbc` comes from the **CSS Electronics** OBD2 data pack
(<https://www.csselectronics.com/pages/can-dbc-file-database-intro>) and standardised
SAE J1979 OBD2 PIDs — it is generic, vehicle-agnostic, and reverse-engineered material;
review decoded values before trusting them.

> These DBCs are mostly community reverse-engineering. The whole point of this folder is
> to **confirm** them against the real Sharan, then promote the verified signals into a
> Sharan-specific map. Treat disagreements with the wire as real platform divergence, not
> errors — and trust the wire.
