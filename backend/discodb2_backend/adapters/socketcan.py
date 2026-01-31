"""SocketCAN source (Linux / Raspberry Pi ``can0``) -- listen-only at the iface.

On the Pi the candleLight adapter shows up as an in-kernel ``gs_usb`` -> ``can0``
SocketCAN interface. The SAFEST place to enforce listen-only is the interface
itself (``ip link set can0 type can listen-only on``), done by the deployment
layer; here we ALSO request python-can's ``receive_own_messages=False`` and pass
``listen_only`` through so the bus is never opened transmitting.

Depends on ``python-can`` (and a Linux kernel with SocketCAN). It is imported
lazily so the backend -- and ``sim``/``replay`` -- run on macOS / in the Docker
sandbox without it; selecting this source without python-can fails loudly.
"""

from __future__ import annotations

from typing import Optional

from ..clock import now_us
from .base import CanMessage


class SocketCanBus:
    """Wraps ``can.Bus(interface='socketcan')`` in listen-only mode."""

    def __init__(self, channel: str = "can0", bitrate: int = 500000, *, listen_only: bool = True) -> None:
        try:
            import can  # noqa: F401  (presence check)
        except Exception as exc:  # pragma: no cover - exercised only on Linux/CI w/ python-can
            raise RuntimeError(
                "socketcan source requires python-can. Install it with "
                "`pip install python-can` on a Linux host with SocketCAN."
            ) from exc

        if not listen_only:
            # Invariant 1: never open a live bus transmitting for read-only RE.
            raise RuntimeError(
                "listen-only is enforced for socketcan; disabling it is refused."
            )
        self.channel = channel
        self.bitrate = bitrate
        # bitrate is typically configured by `ip link` on the Pi; pass it anyway
        # for backends that honour it. listen_only keeps the controller silent.
        self._bus = can.Bus(
            interface="socketcan",
            channel=channel,
            bitrate=bitrate,
            receive_own_messages=False,
        )

    def recv(self, timeout: float = 0.5) -> Optional[CanMessage]:
        msg = self._bus.recv(timeout=timeout)
        if msg is None:
            return None
        return CanMessage(
            arbitration_id=msg.arbitration_id,
            data=bytes(msg.data),
            dlc=msg.dlc,
            is_extended=bool(msg.is_extended_id),
            is_error=bool(getattr(msg, "is_error_frame", False)),
            is_rtr=bool(getattr(msg, "is_remote_frame", False)),
            timestamp_us=now_us(),
        )

    def shutdown(self) -> None:
        try:
            self._bus.shutdown()
        except Exception:
            pass
