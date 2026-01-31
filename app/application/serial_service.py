import queue
import threading
import time
from typing import List

try:
    import serial
except Exception:  # pragma: no cover - handled at runtime
    serial = None

try:
    from serial.tools import list_ports
except Exception:  # pragma: no cover - handled at runtime
    list_ports = None


class SerialService:
    def __init__(self, baudrate: int = 115200) -> None:
        self.baudrate = baudrate
        self.serial_connection = None
        self.serial_thread: threading.Thread | None = None
        self.serial_stop = threading.Event()
        self.read_queue: queue.Queue = queue.Queue()

    def list_ports(self) -> List[str]:
        ports = list_ports.comports() if list_ports else []
        return [port.device for port in ports]

    def connect(self, port: str) -> None:
        if serial is None:
            raise RuntimeError("pyserial is not available.")
        if self.is_connected():
            self.disconnect()
        self.serial_connection = serial.Serial(port, self.baudrate, timeout=0.1)
        self.serial_stop.clear()
        self.serial_thread = threading.Thread(target=self._read_loop, daemon=True)
        self.serial_thread.start()

    def disconnect(self) -> None:
        self.serial_stop.set()
        if self.serial_thread:
            self.serial_thread.join(timeout=1.0)
        if self.serial_connection:
            try:
                self.serial_connection.close()
            except Exception:
                pass
        self.serial_connection = None
        self.serial_thread = None

    def is_connected(self) -> bool:
        return self.serial_connection is not None

    def send(self, line: str) -> None:
        if not self.serial_connection:
            raise RuntimeError("Serial not connected.")
        self.serial_connection.write((line + "\n").encode("utf-8"))

    def _read_loop(self) -> None:
        while not self.serial_stop.is_set():
            if not self.serial_connection:
                break
            try:
                line = self.serial_connection.readline()
            except Exception:
                break
            if line:
                try:
                    text = line.decode("utf-8", errors="replace").strip()
                except Exception:
                    text = str(line)
                if text:
                    self.read_queue.put(text)
            time.sleep(0.01)

