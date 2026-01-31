import queue
import threading
from typing import List

from app.adapters.can_adapter import CanReaderThread, detect_devices, open_bus
from app.domain.models import DeviceChoice


class CanService:
    def __init__(self) -> None:
        self.reader_queue: queue.Queue = queue.Queue()
        self.reader_stop = threading.Event()
        self.reader_thread: CanReaderThread | None = None
        self.bus = None

    def list_devices(self) -> List[DeviceChoice]:
        return detect_devices()

    def start(self, device: DeviceChoice, bitrate: int) -> None:
        self.stop()
        self.bus = open_bus(device, bitrate)
        self.reader_stop.clear()
        self.reader_thread = CanReaderThread(self.bus, self.reader_queue, self.reader_stop)
        self.reader_thread.start()

    def stop(self) -> None:
        self.reader_stop.set()
        if self.reader_thread:
            self.reader_thread.join(timeout=1.0)
        if self.bus:
            try:
                self.bus.shutdown()
            except Exception:
                pass
        self.bus = None
        self.reader_thread = None

    def is_running(self) -> bool:
        return self.reader_thread is not None and self.reader_thread.is_alive()

