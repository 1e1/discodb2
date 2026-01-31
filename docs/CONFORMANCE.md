# discodb2 — Conformance checklist

Maps every **DESIGN.md invariant** to an **enforceable check**. The goal is that
"green CI ⇒ the architecture contract holds". Where an invariant cannot be fully
machine-checked (it needs human review), this is stated honestly and the check
becomes a *regression smell* (catches deleting the concept) rather than a proof.

**How it's enforced**
- `infra/conformance/check.sh` — grep/lint invariant checks (run locally or in CI).
- `.github/workflows/ci.yml` — runs the above + backend tests + shared
  byte-layout test + frontend typecheck/build + Pi-image bundle validation.
- `frontend/shared/protocol.test.ts` — pins the §3.2 binary layout with
  encode→decode + explicit byte-offset assertions.

> **Concurrent build note.** The backend and the two frontends are built by
> separate agents and may be **mid-flight**. Component-scoped checks **SKIP**
> (not fail) when their target dir is absent, so a not-yet-created `backend/`
> never red-lights infra. They flip to real PASS/FAIL the moment the code lands.

Legend: **CI** = enforced automatically · **Review** = needs human eyes ·
**Test** = covered by a unit test.

---

## Backend invariants (DESIGN §4 — NON-NEGOTIABLE)

| # | Invariant (DESIGN) | Enforceable check | How |
|---|---|---|---|
| INV-1 | **Listen-only enforced server-side** for any live source; a request to disable is refused/clamped; guarantee never depends on the network (§4.1). | `check.sh [safety]`: backend source must reference `listen_only` / `GS_CAN_MODE_LISTEN_ONLY`. The Pi link layer ALSO sets `listen-only on` (`can-up.sh`). **The clamp/refusal logic itself is Review.** | CI (smell) + Review |
| INV-2 | **Timestamps are backend monotonic/HW µs**; wall clock never trusted (no RTC); absolute session time assigned by the connecting client (§4.2). | `check.sh [time]`: **fail** if backend calls `time.time()` / `datetime.now()` / `utcnow()`. Pi units/scripts carry **no clock dependency** (no `After=time-sync.target`, no RTC). | CI |
| INV-3 | **Lean deps (ARMv6)**: no numpy/pandas/cantools in the backend; only SocketCAN raw / python-can + a WebSocket lib (§4.3). | `check.sh [deps]` + CI `backend` job + `install.sh` + `Dockerfile.backend`: **fail/refuse** on `^(numpy\|pandas\|cantools)` in any backend `import` or `requirements*.txt`. | CI |
| INV-4 | **`sim` works with zero hardware**; **`replay`** streams a file through the exact same path (§4.4). | `check.sh [sources]`: backend must reference a `sim` and a `replay` source. Sandbox default is `sim`; `entrypoint.sh replay` exercises the replay path. | CI (smell) + Review |

## Transport / contract (DESIGN §3)

| # | Invariant (DESIGN) | Enforceable check | How |
|---|---|---|---|
| INV-5 | **One WebSocket**: binary frames = CAN stream (hot path, **never JSON**); text frames = JSON control; plus `GET /health` (§3.1). | `check.sh [transport]`: backend must show binary framing (`struct`/`bytes`/`to_bytes`/`memoryview`) — **fail** if absent (would imply JSON on the hot path). Cross-checked by the byte-layout test. | CI (smell) + Test |
| INV-6 | **§3.2 binary batch layout**: 12-byte header `<u8 u8 u16 u64>` + N×20-byte record `<u32 u32 u8 u8 u16 u8[8]>`, little-endian; can_id bits 0–28 / bit30 error / bit31 extended; classic CAN only (≤8). | `frontend/shared/protocol.test.ts` asserts **exact byte offsets + endianness**. Verified to round-trip **byte-for-byte against the Python backend** (`backend/discodb2_backend/protocol.py`). | Test |
| INV-7 | **§3.3 control messages** and **§3.4 health shape** match the contract. | `protocol.ts` types + `protocol.test.ts` round-trip every control message and the full `Health` object; `isHealth()` distinguishes a bare health snapshot from tagged `files`/`error`. | Test |
| INV-8 | **§3.5 data model** (`Signal`/`FrameDef`/`Project`): a frame carries multiple signals; DBC maps to/from this. | `check.sh [shared]`: `protocol.ts` must define `interface Signal/FrameDef/Project` + the codec symbols; CI typechecks it under the **strictest** TS config (so both frontends can import it). | CI |

## Frontend invariants (DESIGN §6 / §7)

| # | Invariant (DESIGN) | Enforceable check | How |
|---|---|---|---|
| INV-9 | **Frontend uses relative time only** on the data path; absolute anchor captured once at connect (§4.2 / task). | `check.sh [frontend]`: **fail** if `Date.now()`/`new Date()`/`performance.now()` appears in any worker/decode/batch/frame/stream file used to *timestamp frames*. (Legit uses — ID gen, export filename, one-time session anchor, reconnect timeouts, relative-age display — live elsewhere and are allowed.) | CI |
| INV-10 | **Canonical shared types**: cockpit + copilot share the protocol/data-model, canonical in `frontend/shared` (§6). | `protocol.ts` is the canonical module; `check.sh [shared]` asserts it is **framework-free** (no `svelte`/`vite` import). Builders' per-app `protocol/` dirs **consolidate onto it later** (see audit). | CI + Review |
| INV-11 | **No WebUSB / no File System Access API** (Safari iOS + Firefox); export via Blob download (§6). | Recommended `check.sh` extension (see "Gaps"): grep frontends for `navigator.usb` / `showSaveFilePicker` / `showOpenFilePicker`. *Not yet wired* — flagged below. | Review (today) |
| INV-12 | **Copilot is light**: latest values + tiny gauge window, no large buffer/compute (iOS memory) (§7). | Review — bounded-memory design is not mechanically provable. Copilot uses `performance.now()` relative-age + bounded `watches`/ring structures (observed). | Review |

## Deployment invariants (DESIGN §8)

| # | Invariant (DESIGN) | Enforceable check | How |
|---|---|---|---|
| INV-13 | **Single 32-bit ARMv6 image** (Pi 1B+ → 3B+); per-arch images unnecessary; Pi Zero dropped. | `check.sh [image]` + CI `pi-image` job: **fail** if `infra/pi-image` references `arm64`/`aarch64`. | CI |
| INV-14 | **Listen-only on the bus** at the Pi link layer (candleLight → in-kernel gs_usb → can0). | `check.sh [image]` + `pi-image` job: `can-up.sh` must contain `listen-only`. | CI |
| INV-15 | **Pi = WiFi AP + WPA2** (open WiFi rejected); fixed IP. | `check.sh [image]` + `pi-image` job: `ap-setup.sh` must contain `wpa=2`; it **refuses** a passphrase outside 8..63 chars at runtime. Fixed IP via `AP_ADDR` (default 192.168.4.1). | CI + runtime |
| INV-16 | **Stock image + first-boot provisioning** preferred over a full QEMU bake (§8). | CI `pi-image` job **validates + packages** the provisioning bundle as an artifact and **explicitly states** it does not QEMU-bake (see Honest limits). | CI |
| INV-17 | **No RTC**: no wall-clock dependency in deployment. | `discodb2-*.service` units carry **no** `After=time-sync.target`/`systemd-time-wait-sync`; `can-up.sh` uses a bounded retry loop, not timestamps. | Review (grep-able) |

---

## Honest limits & known gaps

These are deliberately **not** fully enforced today; listed so they are tracked,
not forgotten.

1. **No QEMU image bake in CI (INV-16).** A full ARMv6 Raspberry Pi OS bake is
   slow/flaky on hosted runners and unnecessary given the stock-image +
   provisioning model. CI validates (dash `-n`, shellcheck, invariant greps) and
   **publishes the provisioning bundle artifact** (`discodb2-pi-provisioning.tar.gz`).
   Flashing steps: `infra/pi-image/README.md`.
2. **Listen-only refusal logic (INV-1) is a smell check, not a proof.** CI catches
   *removal* of the concept; that a disable request is actually *clamped* needs
   review of the backend control handler.
3. **WebUSB / File System Access ban (INV-11) is not yet a CI grep.** Easy to add
   (`grep -rn 'navigator.usb\|showSaveFilePicker' frontend/*/src`); left as a
   follow-up so it lands with the frontends rather than guessing their layout.
4. **Bounded-memory copilot (INV-12) and multi-signal decode (INV-8)** are
   design properties verified by review, not by a single assertion.
5. **Backend monotonic check (INV-2) is conservative.** It flags any
   `time.time()`/`datetime.now()`; a legitimate non-timestamp use (none expected
   in a thin backend) would need an inline allow-comment.

## Running the checks

```sh
# All invariant checks (same as CI):
bash infra/conformance/check.sh

# Canonical protocol: typecheck + byte-layout test
cd frontend/shared && npm install && npx tsc --noEmit -p tsconfig.json && node --test --experimental-strip-types

# Backend tests
pip install pytest "python-can>=4.0" pyserial && pytest backend/tests -q

# Pi provisioning bundle (syntax + invariant greps)
for s in infra/pi-image/scripts/*.sh; do dash -n "$s"; done
```
