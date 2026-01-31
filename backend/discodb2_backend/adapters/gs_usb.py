"""gs_usb / candleLight source via libusb (macOS / Windows / Linux).

Lifted from ``app/adapters/can_adapter.py::GsUsbListenOnlyBus``. It drives the
``gs_usb`` package DIRECTLY rather than going through python-can's gs_usb
backend, because that backend starts the device in normal mode where the adapter
ACKs (and could transmit) on the bus. Driving gs_usb directly lets us set the
``GS_CAN_MODE_LISTEN_ONLY`` flag so the controller stays silent -- the safe
default for sniffing a live vehicle (DESIGN.md invariant 1).

This is the first-class PC path (no SocketCAN needed): the FYSETC UCAN
(VID 0x1d50 / PID 0x606f, candleLight firmware) enumerates as a raw libusb
device. Requires the ``gs_usb`` package and the libusb system library
(macOS: ``brew install libusb``). Imported lazily; selecting this source without
those deps fails loudly.
"""

from __future__ import annotations

from typing import Optional

from ..clock import now_us
from .base import CanMessage


class GsUsbListenOnlyBus:
    """candleLight / gs_usb adapter opened in listen-only (silent) mode.

    Only the ``recv()/shutdown()`` surface is implemented, matching the adapter
    Protocol (duck-typed, no python-can dependency).
    """

    is_listen_only_enforced = True

    def __init__(self, index: int = 0, bitrate: int = 500000, *, listen_only: bool = True) -> None:
        try:
            from gs_usb.gs_usb import GsUsb
            from gs_usb.gs_usb_frame import GsUsbFrame
            from gs_usb.constants import (
                GS_CAN_MODE_LISTEN_ONLY,
                GS_CAN_MODE_HW_TIMESTAMP,
            )
        except Exception as exc:  # pragma: no cover - dependency/runtime issue
            raise RuntimeError(
                "gs_usb backend unavailable. Install it with `pip install gs_usb` "
                "and the libusb system library (macOS: `brew install libusb`)."
            ) from exc

        if not listen_only:
            # Invariant 1: never open a live bus transmitting for read-only RE.
            raise RuntimeError(
                "listen-only is enforced for gs_usb; disabling it is refused."
            )

        self._frame_cls = GsUsbFrame
        devices = GsUsb.scan()
        if index >= len(devices):
            raise RuntimeError(
                f"gs_usb device #{index} not found (scan found {len(devices)})."
            )
        self._dev = devices[index]
        self.bitrate = bitrate

        # set_bitrate returns False on failure; some builds return None on success.
        if self._dev.set_bitrate(bitrate) is False:
            raise RuntimeError(f"Failed to set gs_usb bitrate to {bitrate} bps.")

        self.listen_only = listen_only
        mode = GS_CAN_MODE_HW_TIMESTAMP
        if listen_only:
            mode |= GS_CAN_MODE_LISTEN_ONLY
        self._dev.start(mode)

    def recv(self, timeout: float = 0.5) -> Optional[CanMessage]:
        frame = self._frame_cls()
        if not self._dev.read(frame, int(timeout * 1000)):
            return None
        dlc = frame.can_dlc
        return CanMessage(
            arbitration_id=frame.arbitration_id,
            data=bytes(frame.data[:dlc]),
            dlc=dlc,
            is_extended=bool(getattr(frame, "is_extended_id", False)),
            is_error=bool(getattr(frame, "is_error_frame", False)),
            # gs_usb carries a HW timestamp, but its epoch differs from our
            # monotonic clock; stamp on arrival to keep one consistent timebase.
            timestamp_us=now_us(),
        )

    def shutdown(self) -> None:
        try:
            self._dev.stop()
        except Exception:
            pass
