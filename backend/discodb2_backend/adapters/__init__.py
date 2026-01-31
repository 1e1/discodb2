"""CAN adapter dispatch (DESIGN.md §5).

Single entry point :func:`open_bus` maps a source name to a concrete adapter,
all sharing the ``recv()/shutdown()`` surface defined in :mod:`.base`.

Sources:
    sim        synthetic, zero hardware
    replay     candump -l file -> stream (same path as live)
    socketcan  Linux/Pi can0, listen-only at the interface (python-can)
    gs_usb     candleLight via libusb, listen-only (macOS/Windows/Linux)
    slcan      serial-line CAN (python-can)

listen-only is ENFORCED server-side for every LIVE source: the adapter
constructors refuse ``listen_only=False``. ``sim`` and ``replay`` never transmit
by construction, so the flag is a no-op for them.
"""

from __future__ import annotations

from typing import Optional

from .base import CanBus, CanMessage

# Sources that physically touch a live bus; listen-only is non-negotiable here.
LIVE_SOURCES = frozenset({"socketcan", "gs_usb", "slcan"})
# Sources that never transmit; listen-only is trivially satisfied.
PASSIVE_SOURCES = frozenset({"sim", "replay"})
ALL_SOURCES = LIVE_SOURCES | PASSIVE_SOURCES


def is_live_source(source: str) -> bool:
    return source in LIVE_SOURCES


def clamp_listen_only(source: str, listen_only: bool) -> bool:
    """Enforce invariant 1: live sources are always listen-only.

    Returns the effective listen-only value. For a live source this is forced
    to True regardless of the request (the request to disable it is *clamped*);
    passive sources pass through unchanged.
    """
    if source in LIVE_SOURCES:
        return True
    return listen_only


def open_bus(
    source: str,
    *,
    bitrate: int = 500000,
    listen_only: bool = True,
    file: Optional[str] = None,
    channel: Optional[str] = None,
    index: int = 0,
    realtime: bool = True,
    sim_seed: Optional[int] = None,
    sim_profile: str = "realistic",
) -> CanBus:
    """Construct the adapter for ``source``.

    ``listen_only`` is clamped to True for live sources before construction, so
    a client can never coax the backend into a transmitting open. ``file`` is
    required for ``replay``; ``channel`` selects the socketcan/slcan device;
    ``index`` selects the gs_usb device.
    """
    source = source.lower()
    effective_listen_only = clamp_listen_only(source, listen_only)

    if source == "sim":
        from .sim import SimulatedBus

        return SimulatedBus(bitrate=bitrate, seed=sim_seed, profile=sim_profile)

    if source == "replay":
        if not file:
            raise ValueError("replay source requires a 'file' path")
        from .replay import ReplayBus

        return ReplayBus(file, realtime=realtime)

    if source == "socketcan":
        from .socketcan import SocketCanBus

        return SocketCanBus(
            channel=channel or "can0",
            bitrate=bitrate,
            listen_only=effective_listen_only,
        )

    if source == "gs_usb":
        from .gs_usb import GsUsbListenOnlyBus

        return GsUsbListenOnlyBus(
            index=index,
            bitrate=bitrate,
            listen_only=effective_listen_only,
        )

    if source == "slcan":
        if not channel:
            raise ValueError("slcan source requires a 'channel' (serial device path)")
        from .slcan import SlcanBus

        return SlcanBus(
            channel=channel,
            bitrate=bitrate,
            listen_only=effective_listen_only,
        )

    raise ValueError(f"unknown source: {source!r} (expected one of {sorted(ALL_SOURCES)})")


__all__ = [
    "CanBus",
    "CanMessage",
    "open_bus",
    "is_live_source",
    "clamp_listen_only",
    "LIVE_SOURCES",
    "PASSIVE_SOURCES",
    "ALL_SOURCES",
]
