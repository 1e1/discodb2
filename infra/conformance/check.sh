#!/usr/bin/env bash
# discodb2 — architecture-conformance checks (DESIGN invariants → enforceable).
#
# Run locally or in CI. Each check maps to a row in docs/CONFORMANCE.md. Checks
# SKIP (not fail) when the component they target does not exist yet, because the
# three builder agents run concurrently and may be mid-flight — a missing
# backend/ must not red-CI the infra. Checks FAIL only on an actual violation.
#
# Exit non-zero if any invariant is violated.
set -uo pipefail

# Repo root = two levels up from infra/conformance.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"

PASS=0
FAIL=0
SKIP=0
FAILED_CHECKS=""

ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); FAILED_CHECKS="$FAILED_CHECKS\n    - $1"; }
skip() { printf '  \033[33mSKIP\033[0m  %s (%s)\n' "$1" "$2"; SKIP=$((SKIP+1)); }

have_backend() { [ -d backend ]; }
# Only consider real backend source (not the legacy app/ or this infra dir).
backend_py() { [ -d backend ] && find backend -name '*.py' -not -path '*/.venv/*' 2>/dev/null; }

echo "discodb2 conformance checks (root: $ROOT)"
echo

# ── INV-3: Lean deps (ARMv6) — no numpy/pandas/cantools in the backend ───────
echo "[deps] Lean backend (DESIGN §4.3)"
if have_backend; then
    # 3a. No forbidden imports anywhere under backend/.
    files=$(backend_py)
    if [ -n "$files" ] && echo "$files" | xargs grep -lnE '^\s*(import|from)\s+(numpy|pandas|cantools)\b' 2>/dev/null; then
        bad "backend imports numpy/pandas/cantools (forbidden on ARMv6)"
    else
        ok "no numpy/pandas/cantools imports in backend/*.py"
    fi
    # 3b. No forbidden deps declared in a backend requirements file.
    req=""
    for c in backend/requirements.txt backend/requirements-pi.txt; do
        [ -f "$c" ] && req="$c" && break
    done
    if [ -n "$req" ]; then
        if grep -Eiqn '^(numpy|pandas|cantools)\b' "$req"; then
            bad "backend requirements ($req) declare numpy/pandas/cantools"
        else
            ok "backend requirements ($req) are lean"
        fi
    else
        skip "backend requirements file" "none yet"
    fi
else
    skip "lean backend deps" "backend/ not created yet"
fi
echo

# ── INV-1: listen-only enforced server-side ──────────────────────────────────
echo "[safety] Listen-only enforced server-side (DESIGN §4.1)"
if have_backend; then
    files=$(backend_py)
    # Heuristic: backend must MENTION listen_only / listen-only somewhere
    # (enforcement code). Absence is a strong smell. Presence is necessary, not
    # sufficient — the real guarantee is reviewed, but this catches regressions
    # that delete the concept entirely.
    if [ -n "$files" ] && echo "$files" | xargs grep -lniE 'listen[_-]?only|GS_CAN_MODE_LISTEN_ONLY' 2>/dev/null >/dev/null; then
        ok "backend references listen-only enforcement"
    else
        bad "backend has no listen-only reference — enforcement may be missing"
    fi
else
    skip "listen-only enforcement" "backend/ not created yet"
fi
echo

# ── INV-2: No wall clock — backend uses monotonic/HW µs ──────────────────────
echo "[time] No wall clock; monotonic only (DESIGN §4.2)"
if have_backend; then
    files=$(backend_py)
    # time.time() / datetime.now() / utcnow() on the hot path mean wall clock.
    # Flag them; monotonic / perf_counter / monotonic_ns are the correct calls.
    hits=$(echo "$files" | xargs grep -nE 'time\.time\s*\(|datetime\.(now|utcnow)\s*\(' 2>/dev/null)
    if [ -n "$hits" ]; then
        printf '%s\n' "$hits" | sed 's/^/      /'
        bad "backend uses wall-clock time (time.time/datetime.now) — use time.monotonic*"
    else
        ok "no wall-clock calls in backend/*.py"
    fi
else
    skip "monotonic-only timestamps" "backend/ not created yet"
fi
echo

# ── INV (hot path): binary, not JSON, for the CAN stream ─────────────────────
echo "[transport] Binary (not JSON) on the hot path (DESIGN §3.1/§3.2)"
if have_backend; then
    files=$(backend_py)
    # The stream must be sent as bytes. Look for evidence of binary framing
    # (bytes/bytearray/struct/DataView-equivalent) AND ensure we're not
    # json.dumps-ing per-frame on a send path. This is a smell check, not proof.
    if [ -n "$files" ] && echo "$files" | xargs grep -lnE 'struct\.(pack|Struct)|bytearray|to_bytes|memoryview' 2>/dev/null >/dev/null; then
        ok "backend builds binary frames (struct/bytes present)"
    else
        bad "backend shows no binary framing — CAN stream must be binary, never JSON"
    fi
else
    skip "binary hot path" "backend/ not created yet"
fi
echo

# ── INV: sim works with zero hardware ────────────────────────────────────────
echo "[sources] sim + replay present (DESIGN §4.4 / §5)"
if have_backend; then
    files=$(backend_py)
    have_sim=$(echo "$files" | xargs grep -lniE '\bsim\b|simulat' 2>/dev/null | head -1)
    have_replay=$(echo "$files" | xargs grep -lniE 'replay' 2>/dev/null | head -1)
    if [ -n "$have_sim" ]; then ok "backend references a sim source"; else bad "backend has no sim source (must work with zero hardware)"; fi
    if [ -n "$have_replay" ]; then ok "backend references a replay source"; else bad "backend has no replay source"; fi
else
    skip "sim/replay sources" "backend/ not created yet"
fi
echo

# ── INV: frontend uses relative time only (no Date.now on the data path) ─────
echo "[frontend] Relative time only on the data path (DESIGN §4.2)"
check_frontend_time() {
    app="$1"
    [ -d "frontend/$app/src" ] || { skip "$app relative-time" "frontend/$app/src not created yet"; return; }
    # The CONTRACT carries monotonic µs; the connecting client assigns absolute
    # session time ONCE. Flag Date.now()/new Date() inside Web Workers or any
    # file that touches the batch decode (the per-frame data path), where wall
    # clock must never be used to TIMESTAMP frames.
    hits=$(grep -rnE 'Date\.now\s*\(|new Date\s*\(|performance\.now\s*\(' "frontend/$app/src" 2>/dev/null \
            | grep -iE 'worker|decode|batch|frame|stream' )
    if [ -n "$hits" ]; then
        printf '%s\n' "$hits" | sed 's/^/      /'
        bad "$app: wall/perf clock near the frame data path — frames carry relative µs only"
    else
        ok "$app: no wall clock on the frame data path"
    fi
}
check_frontend_time cockpit
check_frontend_time copilot
echo

# ── INV: shared protocol is the canonical contract & self-tests ──────────────
echo "[shared] Canonical protocol present + typed (DESIGN §3.5 / §6)"
if [ -f frontend/shared/protocol.ts ]; then
    ok "frontend/shared/protocol.ts exists"
    # It must define the §3.5 data-model types and the §3.2 codec.
    miss=""
    for sym in 'encodeBatch' 'decodeBatch' 'interface Signal' 'interface FrameDef' 'interface Project' 'BATCH_HEADER_BYTES' 'RECORD_BYTES'; do
        grep -qF "$sym" frontend/shared/protocol.ts || miss="$miss $sym"
    done
    if [ -n "$miss" ]; then bad "protocol.ts missing symbols:$miss"; else ok "protocol.ts defines the §3.2 codec + §3.5 data model"; fi
    # It must be framework-free (no svelte/vite imports).
    if grep -nE "from\s+['\"](svelte|vite)" frontend/shared/protocol.ts >/dev/null 2>&1; then
        bad "protocol.ts imports a framework — it must be framework-free"
    else
        ok "protocol.ts is framework-free"
    fi
else
    bad "frontend/shared/protocol.ts missing (canonical contract)"
fi
echo

# ── INV: single 32-bit ARMv6 image (no per-arch / arm64 image) ───────────────
echo "[image] Single 32-bit ARMv6 image; stock-image + provisioning (DESIGN §8)"
if [ -d infra/pi-image ]; then
    ok "infra/pi-image provisioning bundle present"
    # No accidental arm64/aarch64 baking in the Pi image layer.
    if grep -rniE 'arm64|aarch64' infra/pi-image >/dev/null 2>&1; then
        grep -rniE 'arm64|aarch64' infra/pi-image | sed 's/^/      /'
        bad "infra/pi-image references arm64/aarch64 — must be a single ARMv6 image"
    else
        ok "no arm64/aarch64 in infra/pi-image"
    fi
    # can-up must request listen-only.
    if grep -q 'listen-only' infra/pi-image/scripts/can-up.sh 2>/dev/null; then
        ok "can-up.sh brings up the bus listen-only"
    else
        bad "can-up.sh does not set listen-only"
    fi
    # AP must be WPA2 (open WiFi rejected).
    if grep -q 'wpa=2' infra/pi-image/scripts/ap-setup.sh 2>/dev/null; then
        ok "ap-setup.sh enforces WPA2 (open WiFi rejected)"
    else
        bad "ap-setup.sh does not enforce WPA2"
    fi
else
    bad "infra/pi-image missing"
fi
echo

# ── Summary ──────────────────────────────────────────────────────────────────
echo "──────────────────────────────────────────"
printf 'conformance: \033[32m%d pass\033[0m, \033[31m%d fail\033[0m, \033[33m%d skip\033[0m\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -gt 0 ]; then
    printf 'FAILED:%b\n' "$FAILED_CHECKS"
    exit 1
fi
echo "All present invariants hold. (Skips are components not yet built.)"
