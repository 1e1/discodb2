#!/bin/sh
# discodb2 FIRST-BOOT provisioning for Raspberry Pi OS Lite 32-bit (ARMv6).
#
# Target: a SINGLE 32-bit ARMv6 image covering Pi 1B+ → 3B+ (DESIGN §8). ARMv6
# is the lowest common denominator, so we install the LEAN backend deps only —
# NO numpy/pandas/cantools (DESIGN §4.3). Building numpy on a Pi 1B+ would take
# the better part of an hour and violates the leanness invariant.
#
# Run as root, once, after first boot (or baked via the stock-image firstrun
# hook — see README.md). Idempotent enough to re-run.
#
# Does NOT rely on wall clock anywhere (the Pi has no RTC — DESIGN §4.2).
#
# POSIX sh.
set -eu

REPO_DEFAULT="/opt/discodb2"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Repo root is two levels up from infra/pi-image/scripts.
SRC_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)

log() { echo "[install] $*"; }
die() { echo "[install] ERROR: $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "must run as root (sudo)."

# ── 1. Deploy the repo to /opt/discodb2 ──────────────────────────────────────
DISCODB2_HOME="$REPO_DEFAULT"
if [ "$SRC_ROOT" != "$DISCODB2_HOME" ]; then
    log "deploying repo: $SRC_ROOT -> $DISCODB2_HOME"
    mkdir -p "$DISCODB2_HOME"
    # Copy everything except VCS/venv/build cruft. cp is fine; rsync may be absent.
    (cd "$SRC_ROOT" && tar --exclude='.git' --exclude='node_modules' \
        --exclude='.venv' --exclude='__pycache__' -cf - .) | \
        (cd "$DISCODB2_HOME" && tar -xf -)
else
    log "repo already at $DISCODB2_HOME"
fi

# ── 2. System packages (apt — all have prebuilt ARMv6 wheels/debs) ───────────
log "installing system packages (hostapd dnsmasq can-utils python3 ...)"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
    hostapd \
    dnsmasq \
    can-utils \
    iproute2 \
    rfkill \
    iw \
    avahi-daemon \
    avahi-utils \
    python3 \
    python3-venv \
    python3-pip
# hostapd/dnsmasq ship masked/disabled on Pi OS; we manage them via our units.
systemctl unmask hostapd 2>/dev/null || true

# ── 3. Config: install the env file to /etc/discodb2 ─────────────────────────
mkdir -p /etc/discodb2
if [ ! -f /etc/discodb2/discodb2.env ]; then
    cp "$DISCODB2_HOME/infra/pi-image/config/discodb2.env" /etc/discodb2/discodb2.env
    log "installed /etc/discodb2/discodb2.env (EDIT IT: set AP_PASSPHRASE, CAN_BITRATE)"
else
    log "keeping existing /etc/discodb2/discodb2.env"
fi
chmod 600 /etc/discodb2/discodb2.env
# shellcheck disable=SC1091
. /etc/discodb2/discodb2.env

# ── 4. Service user + recordings dir ─────────────────────────────────────────
if ! id discodb2 >/dev/null 2>&1; then
    useradd --system --home "$DISCODB2_HOME" --shell /usr/sbin/nologin discodb2
fi
mkdir -p "$DISCODB2_HOME/recordings"
chown -R discodb2:discodb2 "$DISCODB2_HOME/recordings"

# ── 5. Backend Python venv with LEAN deps ────────────────────────────────────
# We create the venv even if backend/ is not present yet (builder agents are
# mid-flight). If a backend requirements file exists, install it; otherwise
# install only the lean baseline so the box is ready the moment code lands.
VENV="$DISCODB2_HOME/.venv"
if [ ! -d "$VENV" ]; then
    log "creating backend venv at $VENV"
    python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install --upgrade pip >/dev/null

BACKEND_REQ=""
for cand in \
    "$DISCODB2_HOME/backend/requirements.txt" \
    "$DISCODB2_HOME/backend/requirements-pi.txt"; do
    [ -f "$cand" ] && BACKEND_REQ="$cand" && break
done

if [ -n "$BACKEND_REQ" ]; then
    log "installing backend deps from $BACKEND_REQ"
    # Guard the leanness invariant: refuse to provision a fat backend onto ARMv6.
    if grep -Eiq '^(numpy|pandas|cantools)\b' "$BACKEND_REQ"; then
        die "backend requirements pull in numpy/pandas/cantools — forbidden on ARMv6 (DESIGN §4.3)."
    fi
    "$VENV/bin/pip" install -r "$BACKEND_REQ"
else
    log "no backend/requirements.txt yet (backend agent mid-flight) — installing lean baseline"
    # SocketCAN raw needs nothing extra; python-can + a WS lib are the only
    # runtime deps the contract allows. These all have pure-python/ARMv6 wheels.
    "$VENV/bin/pip" install "python-can==4.4.2" "websockets>=12.0"
fi
chown -R discodb2:discodb2 "$VENV"

# ── 6. systemd units ─────────────────────────────────────────────────────────
log "installing systemd units"
cp "$DISCODB2_HOME"/infra/pi-image/systemd/discodb2-*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable discodb2-can.service discodb2-ap.service discodb2-backend.service
# hostapd/dnsmasq are driven by discodb2-ap.service; enable so they persist.
systemctl enable hostapd.service dnsmasq.service 2>/dev/null || true

# ── 7. LAN service discovery via the OS mDNS responder (Avahi) ────────────────
# Pure DEPLOYMENT layer: the SYSTEM avahi-daemon advertises the backend on the
# LAN so clients reach http://discodb.local:$BACKEND_PORT (and ws on the same
# host) without typing the AP IP. The backend process is NOT touched — this is
# the OS responder, event-driven and idle on the hot path (key on a Pi 1B+).
# The fixed AP IP ($AP_ADDR) stays the always-works fallback.
log "configuring mDNS service discovery (Avahi)"
sh "$DISCODB2_HOME/infra/pi-image/scripts/avahi-setup.sh" || \
    log "WARNING: avahi-setup.sh exited non-zero; mDNS optional, fixed IP still works."
# Enable so the responder persists across reboots (avahi ships its own unit).
systemctl enable avahi-daemon.service 2>/dev/null || true

log "provisioning complete."
log "NEXT: edit /etc/discodb2/discodb2.env (AP_PASSPHRASE!), then reboot."
log "After reboot: join WiFi '$AP_SSID', then either:"
log "  - friendly (mDNS):  http://${MDNS_HOSTNAME:-discodb}.local:$BACKEND_PORT  (ws://${MDNS_HOSTNAME:-discodb}.local:$BACKEND_PORT/ws)"
log "  - fallback (fixed): http://$AP_ADDR:$BACKEND_PORT  (ws://$AP_ADDR:$BACKEND_PORT/ws)"
