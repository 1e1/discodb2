"""can-utils ``candump -l`` log format (read + write).

The recorder writes this format and the ``replay`` source reads it, so a
record -> replay round-trip is lossless for the fields we carry. Keeping to the
canonical can-utils log_t format means captures interoperate with ``candump``,
``canplayer`` and SavvyCAN.

Line grammar (one frame per line)::

    (<sec>.<usec>) <iface> <ID>#<DATA>

  * ``<sec>.<usec>`` -- timestamp. candump emits wall-clock seconds; we instead
    write a MONOTONIC seconds.microseconds value (DESIGN.md §4.2: the Pi has no
    RTC). On read we only use *relative* offsets, so the absolute base is
    irrelevant and a monotonic base is safe.
  * ``<ID>`` -- hex arbitration id. <= 3 hex digits => standard 11-bit; anything
    longer (or value > 0x7FF) => extended 29-bit, matching can-utils.
  * ``<DATA>`` -- hex payload bytes, or ``R``/``R<dlc>`` for a remote frame.

Examples::

    (1633072800.123456) can0 280#1122334455667788
    (12.500000) can0 1F334455#DEADBEEF        # extended
    (12.500100) can0 200#R8                    # RTR, dlc 8
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Iterator, Optional

# (sec.usec) iface ID#DATA   -- iface may contain letters, digits, '-', '_'.
_LINE_RE = re.compile(
    r"^\((?P<sec>\d+)\.(?P<usec>\d{1,9})\)\s+"
    r"(?P<iface>\S+)\s+"
    r"(?P<id>[0-9A-Fa-f]+)#(?P<data>R?\d*|[0-9A-Fa-f]*)\s*$"
)


@dataclass(slots=True)
class LogEntry:
    """One parsed candump log line, timebase-relative is up to the caller."""

    t_us: int  # absolute µs from the log's (sec.usec) field
    arbitration_id: int
    dlc: int
    data: bytes
    is_extended: bool = False
    is_rtr: bool = False
    iface: str = "can0"


def format_line(
    t_us: int,
    arbitration_id: int,
    data: bytes,
    *,
    dlc: Optional[int] = None,
    is_extended: bool = False,
    is_rtr: bool = False,
    iface: str = "can0",
) -> str:
    """Render one candump ``-l`` line (no trailing newline).

    ``t_us`` is monotonic microseconds; it is split into ``sec.usec``. The id is
    rendered as 3 hex digits when it fits an 11-bit standard id and is not
    flagged extended, otherwise as 8 hex digits (can-utils convention).
    """
    sec, usec = divmod(int(t_us), 1_000_000)
    if dlc is None:
        dlc = len(data)
    if is_extended or arbitration_id > 0x7FF:
        id_str = f"{arbitration_id:08X}"
    else:
        id_str = f"{arbitration_id:03X}"
    if is_rtr:
        payload = "R" if dlc == 0 else f"R{dlc}"
    else:
        payload = data[:dlc].hex().upper()
    return f"({sec}.{usec:06d}) {iface} {id_str}#{payload}"


def parse_line(line: str) -> Optional[LogEntry]:
    """Parse one candump ``-l`` line into a :class:`LogEntry`.

    Returns None for blank/comment lines; raises ``ValueError`` for a line that
    looks like data but is malformed (so corrupt captures fail loudly).
    """
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    m = _LINE_RE.match(stripped)
    if not m:
        raise ValueError(f"unparseable candump line: {line!r}")

    sec = int(m.group("sec"))
    usec_str = m.group("usec")
    # Right-pad/truncate fractional part to exactly microseconds.
    usec = int((usec_str + "000000")[:6])
    t_us = sec * 1_000_000 + usec

    id_hex = m.group("id")
    arbitration_id = int(id_hex, 16)
    # >3 hex chars OR value beyond 11 bits => extended (can-utils rule).
    is_extended = len(id_hex) > 3 or arbitration_id > 0x7FF

    raw = m.group("data")
    is_rtr = raw.startswith("R")
    if is_rtr:
        dlc = int(raw[1:]) if len(raw) > 1 else 0
        data = b""
    else:
        if len(raw) % 2 != 0:
            raise ValueError(f"odd-length data field in line: {line!r}")
        data = bytes.fromhex(raw)
        dlc = len(data)

    if dlc > 8:
        raise ValueError(f"classic CAN dlc {dlc} > 8 in line: {line!r}")

    return LogEntry(
        t_us=t_us,
        arbitration_id=arbitration_id & 0x1FFFFFFF,
        dlc=dlc,
        data=data,
        is_extended=is_extended,
        is_rtr=is_rtr,
        iface=m.group("iface"),
    )


def parse_lines(lines: Iterable[str]) -> Iterator[LogEntry]:
    """Yield :class:`LogEntry` for every data line in ``lines``."""
    for line in lines:
        entry = parse_line(line)
        if entry is not None:
            yield entry
