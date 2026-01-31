from dataclasses import dataclass, field
from collections import deque
from typing import Deque, List


@dataclass
class DeviceChoice:
    label: str
    interface: str
    channel: str | None


@dataclass
class FrameStats:
    arbitration_id: int
    dlc: int
    last_data: bytes
    count: int
    first_time: float
    last_time: float
    per_byte_changes: List[int] = field(default_factory=lambda: [0] * 8)
    history: Deque[str] = field(default_factory=lambda: deque(maxlen=20))

    def update(self, data: bytes, dlc: int, timestamp: float, formatter) -> None:
        for i in range(min(len(data), len(self.last_data), 8)):
            if data[i] != self.last_data[i]:
                self.per_byte_changes[i] += 1
        self.last_data = data
        self.dlc = dlc
        self.count += 1
        self.last_time = timestamp
        self.history.appendleft(formatter(data))


@dataclass
class SimpleMessage:
    arbitration_id: int
    data: bytes
    dlc: int

