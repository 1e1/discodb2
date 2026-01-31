#!/bin/sh
# Bring up can0 in LISTEN-ONLY at the configured bitrate, via the in-kernel
# gs_usb driver (candleLight/FYSETC UCAN, VID 0x1d50 PID 0x606f).
#
# POSIX sh (Pi OS Lite has dash as /bin/sh). No bashisms.
#
# DESIGN §4.1: listen-only is enforced. We also set it at the LINK layer here as
# defence-in-depth; the backend enforces it again. DESIGN §8: candleLight ->
# in-kernel gs_usb -> can0.
set -eu

ENV_FILE=/etc/discodb2/discodb2.env
[ -r "$ENV_FILE" ] && . "$ENV_FILE"

CAN_IFACE="${CAN_IFACE:-can0}"
CAN_BITRATE="${CAN_BITRATE:-500000}"
CAN_LISTEN_ONLY="${CAN_LISTEN_ONLY:-1}"

log() { echo "[can-up] $*"; }

# The gs_usb module is in-tree on Raspberry Pi OS; load it if a device is
# present. It binds automatically on hotplug, so this is belt-and-suspenders.
modprobe gs_usb 2>/dev/null || true

# Wait briefly for can0 to appear (USB enumeration can lag the boot of the
# service). We do NOT trust wall clock anywhere; this is a bounded retry loop.
i=0
while [ "$i" -lt 20 ]; do
    if ip link show "$CAN_IFACE" >/dev/null 2>&1; then
        break
    fi
    i=$((i + 1))
    sleep 0.5
done

if ! ip link show "$CAN_IFACE" >/dev/null 2>&1; then
    log "ERROR: $CAN_IFACE not present. Is the candleLight/UCAN adapter plugged in?"
    log "       Check: dmesg | grep -i gs_usb   and   lsusb (expect 1d50:606f)."
    exit 1
fi

# Down first so we can (re)configure; ignore if already down.
ip link set "$CAN_IFACE" down 2>/dev/null || true

LO_ARG=""
if [ "$CAN_LISTEN_ONLY" = "1" ]; then
    LO_ARG="listen-only on"
    log "configuring $CAN_IFACE: bitrate=$CAN_BITRATE listen-only=ON"
else
    # Loud warning: this means the adapter can ACK/transmit on a live bus.
    log "WARNING: CAN_LISTEN_ONLY=0 — adapter may ACK/transmit on the bus!"
    log "configuring $CAN_IFACE: bitrate=$CAN_BITRATE listen-only=OFF"
fi

# shellcheck disable=SC2086  # LO_ARG is an intentional multi-token arg
ip link set "$CAN_IFACE" type can bitrate "$CAN_BITRATE" $LO_ARG restart-ms 100
ip link set "$CAN_IFACE" up

log "$CAN_IFACE is up:"
ip -details link show "$CAN_IFACE" || true
