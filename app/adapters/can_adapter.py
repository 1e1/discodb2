import queue
import random
import threading
import time
from typing import List, Optional

try:
    import can
except Exception:  # pragma: no cover - handled at runtime
    can = None

try:
    from serial.tools import list_ports
except Exception:  # pragma: no cover - handled at runtime
    list_ports = None

from app.config import SIMULATOR_LABEL
from app.domain.models import DeviceChoice, SimpleMessage


class SimulatedBus:
    def __init__(self, bitrate: int) -> None:
        self.bitrate = bitrate
        self._ids = [0x100, 0x120, 0x180, 0x1F0, 0x220, 0x2A0, 0x300]
        self._last_payloads = {can_id: self._random_payload() for can_id in self._ids}

    def recv(self, timeout: float = 0.5) -> Optional[SimpleMessage]:
        time.sleep(random.uniform(0.01, 0.15))
        can_id = random.choice(self._ids)
        payload = bytearray(self._last_payloads[can_id])
        if random.random() < 0.7:
            index = random.randint(0, 7)
            payload[index] = (payload[index] + random.randint(1, 5)) % 256
        else:
            payload = self._random_payload()
        self._last_payloads[can_id] = bytes(payload)
        return SimpleMessage(arbitration_id=can_id, data=bytes(payload), dlc=8)

    def shutdown(self) -> None:
        return None

    @staticmethod
    def _random_payload() -> bytes:
        return bytes(random.randint(0, 255) for _ in range(8))


class CanReaderThread(threading.Thread):
    def __init__(self, bus, output: queue.Queue, stop_event: threading.Event) -> None:
        super().__init__(daemon=True)
        self.bus = bus
        self.output = output
        self.stop_event = stop_event

    def run(self) -> None:
        while not self.stop_event.is_set():
            msg = self.bus.recv(timeout=0.5)
            if msg is None:
                continue
            data = bytes(getattr(msg, "data", b""))
            dlc = getattr(msg, "dlc", len(data))
            self.output.put((msg.arbitration_id, dlc, data, time.time()))


def detect_devices() -> List[DeviceChoice]:
    devices: List[DeviceChoice] = []
    ports = list_ports.comports() if list_ports else []
    for port in ports:
        text = " ".join(
            filter(
                None,
                [
                    port.device,
                    port.description,
                    port.manufacturer,
                    port.product,
                    str(port.vid) if port.vid else "",
                    str(port.pid) if port.pid else "",
                ],
            )
        ).lower()
        is_canable = (
            "canable" in text
            or "candle" in text
            or (port.vid == 0x1D50 and port.pid == 0x606F)
        )
        if is_canable:
            label = f"Canable USB v2 (auto) - {port.device}"
            devices.append(DeviceChoice(label=label, interface="slcan", channel=port.device))

    devices.append(DeviceChoice(label=SIMULATOR_LABEL, interface="sim", channel=None))
    return devices


def open_bus(device: DeviceChoice, bitrate: int):
    if device.interface == "sim":
        return SimulatedBus(bitrate)
    if can is None:
        raise RuntimeError("python-can is not available.")
    return can.Bus(interface="slcan", channel=device.channel, bitrate=bitrate)

