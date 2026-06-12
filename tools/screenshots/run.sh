#!/usr/bin/env bash
# Orchestrate a full screenshot run:
#   1. start the backend (idle; the frontends drive --source sim over the WS)
#   2. start the cockpit (5173) and copilot (5174) dev servers
#   3. wait for all three to answer
#   4. run the Playwright capture → web/img/*.png
#   5. tear everything down (even on error)
#
# Prereqs (one-time):
#   - backend deps:   cd backend && pip install -r requirements.txt
#   - frontend deps:  (cd frontend/cockpit && npm i) && (cd frontend/copilot && npm i)
#   - capture deps:   cd tools/screenshots && npm i   (pulls Playwright + Chromium)
#
# Env overrides: PYTHON (default: python3). Pass a custom manifest to capture a
# different set:  ./run.sh path/to/shots.txt   (default: ./shots.txt)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PYTHON="${PYTHON:-python3}"

pids=()
cleanup() {
  echo "→ tearing down…"
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait_for() { # wait_for <url> <label>
  local url="$1" label="$2" tries=0
  printf '  waiting for %s' "$label"
  until curl -sf -o /dev/null "$url"; do
    tries=$((tries + 1))
    if [ "$tries" -gt 60 ]; then echo " — TIMEOUT"; exit 1; fi
    printf '.'; sleep 1
  done
  echo " ok"
}

if curl -sf -o /dev/null -m 2 http://localhost:8765/health; then
  echo "→ reusing the backend already listening on :8765 (the frontends will send --source sim)"
else
  echo "→ starting backend (idle; frontends send --source sim)…"
  ( cd "$ROOT/backend" && exec "$PYTHON" -m discodb2_backend ) &
  pids+=($!)
fi

echo "→ starting cockpit dev server (5173)…"
( cd "$ROOT/frontend/cockpit" && exec npm run dev -- --port 5173 --strictPort ) &
pids+=($!)

echo "→ starting copilot dev server (5174)…"
( cd "$ROOT/frontend/copilot" && exec npm run dev -- --port 5174 --strictPort ) &
pids+=($!)

wait_for "http://localhost:8765/health" "backend"
wait_for "http://localhost:5173/"       "cockpit"
wait_for "http://localhost:5174/"       "copilot"

echo "→ capturing…"
# Resolve a manifest arg against the caller's cwd before we cd into $HERE.
MANIFEST_ARG=()
if [ "${1:-}" ]; then
  case "$1" in
    /*) MANIFEST_ARG=("$1") ;;
    *)  MANIFEST_ARG=("$(pwd)/$1") ;;
  esac
fi
( cd "$HERE" && node capture.mjs "${MANIFEST_ARG[@]}" )

echo "✓ screenshots written to web/img/"
