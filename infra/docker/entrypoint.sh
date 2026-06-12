#!/usr/bin/env bash
# Entrypoint for the discodb2 backend dev sandbox.
#
# Usage (via docker compose): the first arg is the CAN source
#   sim      -> run backend with the synthetic source (zero hardware) [default]
#   replay   -> run backend replaying $REPLAY_FILE through the same path
#   simloop  -> replay the generated VW PQ "circuit" trace endlessly (demo bus)
#   socketcan-> bring up vcan0 (Linux host only) then run backend on it
#   shell    -> drop to bash for poking around
#
# Honors DESIGN §4.4: sim and replay work with zero hardware.
set -euo pipefail

SRC="${1:-sim}"
PORT="${BACKEND_PORT:-8765}"
BITRATE="${CAN_BITRATE:-500000}"

log() { echo "[sandbox] $*"; }

run_backend() {
    # Launch the backend package (discodb2_backend, under /app/backend).
    # listen-only is enforced server-side -> there is NO --listen-only flag.
    if [ ! -d /app/backend/discodb2_backend ]; then
        log "backend/discodb2_backend not found in the repo yet."
        log "  cd /app/backend && python -m discodb2_backend --source $1 --bitrate $BITRATE --port $PORT ${2:-}"
        log "Dropping to a shell so you can explore."
        exec bash
    fi
    log "starting backend: source=$1 bitrate=$BITRATE port=$PORT (listen-only enforced server-side)"
    cd /app/backend
    # shellcheck disable=SC2086  # ${2:-} may be empty or carry "--file <path>"
    exec python -m discodb2_backend --source "$1" --bitrate "$BITRATE" --port "$PORT" --host 0.0.0.0 ${2:-}
}

case "$SRC" in
    sim)
        run_backend sim
        ;;
    replay)
        : "${REPLAY_FILE:?set REPLAY_FILE=/app/recordings/your.canlog for replay}"
        run_backend replay "--file $REPLAY_FILE"
        ;;
    socketcan)
        # vcan0 needs the HOST kernel's vcan module (Linux only). On Docker
        # Desktop for Mac the module is absent — see README.md. We fall back
        # gracefully to sim so the sandbox is still usable on a Mac.
        if modprobe vcan 2>/dev/null && ip link add dev vcan0 type vcan 2>/dev/null; then
            ip link set up vcan0
            log "vcan0 is up. Generate traffic with: cangen vcan0 -g 10 &"
            run_backend socketcan
        else
            log "WARNING: could not create vcan0 (host kernel lacks 'vcan'?)."
            log "         Common on Docker Desktop/Mac. Falling back to sim."
            run_backend sim
        fi
        ;;
    simloop)
        # Replay the generated "circuit" trace endlessly — a DBC-true demo bus
        # (cluster + chassis/body + noise) with zero hardware. The trace is built
        # at image-build time by the throwaway tracegen stage (see Dockerfile);
        # cantools never lands in this runtime image.
        TRACE="${SIM_TRACE:-/opt/discodb2-sim/vw_pq_circuit.canlog}"
        if [ -f "$TRACE" ]; then
            log "looping circuit trace $TRACE (source=replay --loop)"
            run_backend replay "--file $TRACE --loop"
        else
            log "WARNING: sim trace $TRACE not found (rebuild the image). Falling back to sim."
            run_backend sim
        fi
        ;;
    shell)
        exec bash
        ;;
    *)
        # Anything else: treat as a raw command.
        exec "$@"
        ;;
esac
