"""Binary frame-stream wire protocol (DESIGN.md §3.2).

This module is the single source of truth for the on-the-wire byte layout of the
batched CAN frame stream. It deliberately depends on nothing but ``struct`` so it
can be imported by tests and by frontends' reference implementations alike, and
so it stays trivially portable to the ARMv6 Pi target (no numpy).

Wire layout (little-endian, batched ~20-50 ms):

    Batch header (12 bytes):
        off 0  version    u8   (== PROTOCOL_VERSION, currently 1)
        off 1  flags      u8   bit0: 1 = replay batch (else live)
        off 2  count      u16  number of records that follow
        off 4  base_t_us  u64  monotonic microseconds, batch time base

    Then ``count`` x 20-byte record:
        off 0  dt_us      u32  offset from base_t_us (this frame's monotonic us)
        off 4  can_id     u32  bits 0-28 id, bit30 error, bit31 extended (29-bit)
        off 8  dlc        u8   0..8 (classic CAN only)
        off 9  rec_flags  u8   bit0 RTR (other bits reserved, 0)
        off 10 reserved   u16  0
        off 12 data       u8[8] bytes with index >= dlc are 0

Classic CAN only (dlc <= 8). CAN-FD is a future v2.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

PROTOCOL_VERSION = 1

# --- batch header ---------------------------------------------------------
HEADER_FORMAT = "<BBHQ"  # version u8, flags u8, count u16, base_t_us u64
HEADER_SIZE = struct.calcsize(HEADER_FORMAT)
assert HEADER_SIZE == 12, HEADER_SIZE

# --- per-frame record -----------------------------------------------------
RECORD_FORMAT = "<IIBBH8s"  # dt_us u32, can_id u32, dlc u8, rec_flags u8, reserved u16, data 8s
RECORD_SIZE = struct.calcsize(RECORD_FORMAT)
assert RECORD_SIZE == 20, RECORD_SIZE

# --- batch flags ----------------------------------------------------------
BATCH_FLAG_REPLAY = 0x01  # bit0 of header flags

# --- can_id bitfield (per §3.2) ------------------------------------------
CAN_ID_MASK = 0x1FFFFFFF  # bits 0-28
CAN_EFF_FLAG = 0x80000000  # bit31: extended (29-bit) id
CAN_ERR_FLAG = 0x40000000  # bit30: error frame
# (bit29 is reserved; intentionally not used. This mirrors Linux SocketCAN's
#  CAN_EFF_FLAG/CAN_ERR_FLAG bit positions, with RTR carried in rec_flags.)

# --- rec_flags bitfield ---------------------------------------------------
REC_FLAG_RTR = 0x01  # bit0: remote transmission request

_HEADER_STRUCT = struct.Struct(HEADER_FORMAT)
_RECORD_STRUCT = struct.Struct(RECORD_FORMAT)


@dataclass(slots=True)
class Frame:
    """A single decoded CAN frame, monotonic-µs timestamped.

    ``can_id`` is the *raw* arbitration id (bits 0-28 only); ``is_extended``,
    ``is_error`` and ``is_rtr`` carry the flag bits separately so callers never
    have to mask. ``t_us`` is the absolute monotonic microsecond timestamp; the
    batcher converts it to a per-batch ``dt_us`` offset on the wire.
    """

    t_us: int
    can_id: int
    dlc: int
    data: bytes = b""
    is_extended: bool = False
    is_error: bool = False
    is_rtr: bool = False

    def __post_init__(self) -> None:
        # Normalise data to exactly the dlc-relevant bytes; the wire format
        # zero-pads to 8. Guard classic-CAN dlc bounds.
        if self.dlc < 0 or self.dlc > 8:
            raise ValueError(f"classic CAN dlc must be 0..8, got {self.dlc}")
        if len(self.data) > 8:
            raise ValueError(f"data longer than 8 bytes: {len(self.data)}")

    def encoded_can_id(self) -> int:
        """The 32-bit can_id field exactly as it goes on the wire."""
        value = self.can_id & CAN_ID_MASK
        if self.is_extended:
            value |= CAN_EFF_FLAG
        if self.is_error:
            value |= CAN_ERR_FLAG
        return value


def encode_record(frame: Frame, base_t_us: int) -> bytes:
    """Pack one :class:`Frame` into its 20-byte wire record."""
    dt_us = frame.t_us - base_t_us
    if dt_us < 0:
        raise ValueError(f"frame t_us {frame.t_us} precedes base {base_t_us}")
    if dt_us > 0xFFFFFFFF:
        raise ValueError(f"dt_us {dt_us} overflows u32; rebatch with a closer base")
    rec_flags = REC_FLAG_RTR if frame.is_rtr else 0
    # Zero-pad data to 8 bytes (struct '8s' truncates/pads, but we pad here so
    # bytes >= dlc are explicitly 0 even if the caller over-supplied).
    data = frame.data[: frame.dlc].ljust(8, b"\x00")
    return _RECORD_STRUCT.pack(
        dt_us,
        frame.encoded_can_id(),
        frame.dlc,
        rec_flags,
        0,  # reserved
        data,
    )


def encode_batch(frames: list[Frame], base_t_us: int, *, replay: bool = False) -> bytes:
    """Pack a list of frames into a single binary batch (header + records).

    ``base_t_us`` is the batch time base; each record stores ``t_us - base_t_us``.
    Pick a base <= the earliest frame's ``t_us`` (the batcher uses the first
    frame's timestamp).
    """
    if len(frames) > 0xFFFF:
        raise ValueError(f"batch of {len(frames)} exceeds u16 count")
    flags = BATCH_FLAG_REPLAY if replay else 0
    header = _HEADER_STRUCT.pack(PROTOCOL_VERSION, flags, len(frames), base_t_us)
    parts = [header]
    parts.extend(encode_record(f, base_t_us) for f in frames)
    return b"".join(parts)


@dataclass(slots=True)
class BatchHeader:
    version: int
    flags: int
    count: int
    base_t_us: int

    @property
    def is_replay(self) -> bool:
        return bool(self.flags & BATCH_FLAG_REPLAY)


@dataclass(slots=True)
class DecodedBatch:
    header: BatchHeader
    frames: list[Frame] = field(default_factory=list)


def decode_record(buf: bytes, base_t_us: int, offset: int = 0) -> Frame:
    """Decode one 20-byte record located at ``offset`` within ``buf``."""
    dt_us, raw_id, dlc, rec_flags, _reserved, data = _RECORD_STRUCT.unpack_from(buf, offset)
    return Frame(
        t_us=base_t_us + dt_us,
        can_id=raw_id & CAN_ID_MASK,
        dlc=dlc,
        data=bytes(data[:dlc]),
        is_extended=bool(raw_id & CAN_EFF_FLAG),
        is_error=bool(raw_id & CAN_ERR_FLAG),
        is_rtr=bool(rec_flags & REC_FLAG_RTR),
    )


def decode_batch(buf: bytes) -> DecodedBatch:
    """Decode a full binary batch back into a :class:`DecodedBatch`.

    The inverse of :func:`encode_batch`; used by tests and reference clients.
    """
    if len(buf) < HEADER_SIZE:
        raise ValueError(f"buffer too short for header: {len(buf)} < {HEADER_SIZE}")
    version, flags, count, base_t_us = _HEADER_STRUCT.unpack_from(buf, 0)
    if version != PROTOCOL_VERSION:
        raise ValueError(f"unsupported protocol version {version}")
    expected = HEADER_SIZE + count * RECORD_SIZE
    if len(buf) != expected:
        raise ValueError(
            f"batch length {len(buf)} != header({HEADER_SIZE}) + "
            f"{count} x record({RECORD_SIZE}) = {expected}"
        )
    header = BatchHeader(version=version, flags=flags, count=count, base_t_us=base_t_us)
    frames = [
        decode_record(buf, base_t_us, HEADER_SIZE + i * RECORD_SIZE) for i in range(count)
    ]
    return DecodedBatch(header=header, frames=frames)
