#!/bin/sh
# Advertise the discodb2 backend on the LAN via the OS mDNS responder (Avahi).
#
# Idempotent: regenerates the Avahi service file and pins the mDNS host-name
# from /etc/discodb2/discodb2.env every run. Run by install.sh and re-runnable
# on the Pi (sudo sh .../avahi-setup.sh).
#
# WHY this layer (and not the backend): the backend is a thin, lean CAN box
# (DESIGN §4.3) and must stay light on a Pi 1B+. mDNS discovery is delegated
# entirely to the SYSTEM avahi-daemon — an event-driven responder that answers
# the occasional multicast query and is otherwise idle. ZERO work on the
# backend hot path; the backend process is never touched.
#
# Result: clients reach the box at  http://discodb.local:PORT  and
#         ws://discodb.local:PORT/ws  with no IP typing. The fixed AP IP
#         (AP_ADDR, default 192.168.4.1) remains the always-works fallback.
#
# No wall-clock dependency anywhere (the Pi has no RTC — DESIGN §4.2).
#
# POSIX sh (Pi OS Lite ships dash as /bin/sh). No bashisms.
set -eu

ENV_FILE=/etc/discodb2/discodb2.env
# shellcheck disable=SC1090  # runtime-sourced env file, path is fixed above.
[ -r "$ENV_FILE" ] && . "$ENV_FILE"

# mDNS name the box answers to: <MDNS_HOSTNAME>.local. Default "discodb" so the
# friendly URL is http://discodb.local (overridable via the env file).
MDNS_HOSTNAME="${MDNS_HOSTNAME:-discodb}"
BACKEND_PORT="${BACKEND_PORT:-8765}"

AVAHI_CONF=/etc/avahi/avahi-daemon.conf
SERVICES_DIR=/etc/avahi/services
SERVICE_FILE="$SERVICES_DIR/discodb2.service"
# Template shipped alongside this script (infra/pi-image/avahi/discodb2.service).
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TEMPLATE="$SCRIPT_DIR/../avahi/discodb2.service"

log() { echo "[avahi-setup] $*"; }

if ! command -v avahi-daemon >/dev/null 2>&1; then
    # install.sh installs avahi-daemon via apt; if it is somehow absent we warn
    # but do NOT fail the boot — discovery is a convenience, the fixed IP works.
    log "WARNING: avahi-daemon not installed; skipping mDNS setup."
    log "         The fixed AP IP (${AP_ADDR:-192.168.4.1}:$BACKEND_PORT) still works."
    exit 0
fi

# ── 1. Pin the mDNS host-name so the box is always <MDNS_HOSTNAME>.local ──────
# Avahi publishes an A-record for <host-name>.local on every interface. We set
# host-name explicitly (rather than depending on the system hostname the user
# may or may not have set in Raspberry Pi Imager) so http://discodb.local is
# deterministic. This touches ONLY Avahi's own config — the system hostname,
# /etc/hosts, and the shell prompt are left exactly as the user set them.
mkdir -p "$(dirname "$AVAHI_CONF")"
if [ -f "$AVAHI_CONF" ]; then
    # Match an existing host-name= line whether ACTIVE or COMMENTED. The Pi/
    # Debian default ships it commented ("#host-name=foo"), so the optional '#'
    # here keeps this guard consistent with the sed replacement below — we
    # rewrite that line in place instead of leaving a stale comment behind.
    if grep -Eq '^[[:space:]]*#?[[:space:]]*host-name=' "$AVAHI_CONF"; then
        # Replace the existing host-name= line (commented or not), first match.
        sed -i "0,/^[[:space:]]*#\?[[:space:]]*host-name=.*/s||host-name=$MDNS_HOSTNAME|" "$AVAHI_CONF"
    elif grep -Eq '^\[server\]' "$AVAHI_CONF"; then
        # Insert under the existing [server] section header.
        sed -i "/^\[server\]/a host-name=$MDNS_HOSTNAME" "$AVAHI_CONF"
    else
        printf '[server]\nhost-name=%s\n' "$MDNS_HOSTNAME" >> "$AVAHI_CONF"
    fi
else
    # Minimal config: just enough to pin the host-name; Avahi defaults the rest.
    printf '[server]\nhost-name=%s\n' "$MDNS_HOSTNAME" > "$AVAHI_CONF"
fi
log "mDNS host-name pinned: $MDNS_HOSTNAME (.local)"

# ── 2. Materialise the _http._tcp service advert with the configured port ─────
mkdir -p "$SERVICES_DIR"
if [ -r "$TEMPLATE" ]; then
    # Copy the template, then sync the <port> to BACKEND_PORT (the template
    # ships the §3.1 default 8765; this keeps it correct if the env overrides).
    sed "s|<port>[0-9]\{1,\}</port>|<port>$BACKEND_PORT</port>|" \
        "$TEMPLATE" > "$SERVICE_FILE"
else
    # Template missing (unexpected): write a minimal equivalent inline so the
    # advert still publishes. Keeps the box self-sufficient.
    log "WARNING: template $TEMPLATE missing; writing minimal service file."
    cat > "$SERVICE_FILE" <<EOF
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">discodb2 on %h</name>
  <service>
    <type>_http._tcp</type>
    <port>$BACKEND_PORT</port>
    <txt-record>path=/ws</txt-record>
    <txt-record>app=discodb2</txt-record>
  </service>
</service-group>
EOF
fi
chmod 644 "$SERVICE_FILE"
log "advert written: $SERVICE_FILE (_http._tcp port $BACKEND_PORT)"

# ── 3. (Re)load avahi-daemon so the new host-name + service take effect ───────
# Enable so it persists across reboots. Reload (not restart) when already up so
# we do not drop other adverts; fall back to restart if reload is unsupported.
systemctl enable avahi-daemon.service >/dev/null 2>&1 || true
if systemctl is-active --quiet avahi-daemon.service 2>/dev/null; then
    systemctl reload avahi-daemon.service 2>/dev/null \
        || systemctl restart avahi-daemon.service 2>/dev/null || true
else
    systemctl restart avahi-daemon.service 2>/dev/null || true
fi

log "mDNS ready: http://$MDNS_HOSTNAME.local:$BACKEND_PORT (ws://$MDNS_HOSTNAME.local:$BACKEND_PORT/ws)"
log "fallback (always works): http://${AP_ADDR:-192.168.4.1}:$BACKEND_PORT"
