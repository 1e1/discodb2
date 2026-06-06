"""Synthetic CAN source -- zero hardware (DESIGN.md §4.4).

Two profiles (``--sim-profile`` / ``DISCODB2_SIM_PROFILE``):

* ``realistic`` (default): a small set of periodic frames carrying *undulating*
  physical signals -- an RPM that idles and revs, a speed that ramps, a coolant
  temperature that warms up, a fuel level that slowly drains *with slosh*, plus
  state flags (ignition, handbrake, reverse, blinker), a rolling counter and a
  checksum byte, a couple of unrelated "chatter" frames, and -- so every cockpit
  badge and the diagnostic lens have live data -- a few EXTENDED (29-bit) and
  RTR frames plus OBD-II (ISO-TP) diagnostic request/response frames. Seed-varied,
  evolving over realistic durations (seconds to minutes). A genuine fixture for
  the decoders and the detection Wizard (the counter/checksum and chatter exist
  precisely so the analysis must learn to reject them).
* ``lite``: minimal CPU -- a cheap byte random-walk over the same IDs. For
  constrained hosts (e.g. a Pi 1) where you only need *some* traffic without
  paying for the physics. (In a real car on a Pi you use ``socketcan``, not sim.)

The simulator never transmits, so listen-only is honoured trivially. The frame
*sequence* is driven by a deterministic virtual schedule (NOT the wall clock):
a given seed reproduces exactly; real-time pacing via ``sleep`` does not affect
which frames are produced, only when.
"""

from __future__ import annotations

import random
import time
from typing import Dict, List, Optional, Tuple

from .base import CanMessage

# Ids reminiscent of a VAG PQ bus (see ___doc___.md high-priority list).
_DEFAULT_IDS = [0x11E, 0x100, 0x120, 0x280, 0x30B, 0x480, 0x5A0]

# Realistic schedule: (arbitration_id, period_seconds). Aggregate ~370 Hz.
_FRAMES: List[Tuple[int, float]] = [
    (0x280, 0.010),  # engine: rpm, load, coolant, counter, checksum
    (0x5A0, 0.020),  # chassis: speed, flags (ignition/handbrake/reverse), counter, checksum
    (0x30B, 0.050),  # body: blinker, coolant echo
    (0x11E, 0.020),  # misc periodic
    (0x100, 0.010),  # unrelated chatter
    (0x120, 0.020),  # unrelated chatter
    (0x480, 1.000),  # fuel level (slow)
    # Extra frames so the cockpit's extended ('x') / RTR ('R') / 'DIAG' badges
    # and the diagnostic lens (point 2 / B2(a)) have live data in sim. Kept slow
    # so they barely change the aggregate rate.
    (0x18FEF100, 0.200),  # EXTENDED (29-bit): rpm + coolant echo + counter
    (0x1A5A0F01, 0.500),  # EXTENDED (29-bit): speed echo + counter
    (0x600, 2.000),       # RTR remote request (no data)
    (0x7DF, 1.000),       # OBD-II functional request: mode 01, PID 0C (rpm)
    (0x7E8, 1.000),       # OBD-II response (ECU 0): mode 01, PID 0C (rpm), live
]
_CHATTER_IDS = {0x100, 0x120}
# Extended (29-bit) ids and the RTR id among the extra frames above.
_EXTENDED_IDS = {0x18FEF100, 0x1A5A0F01}
_RTR_IDS = {0x600}


def _u16_be(value: int) -> Tuple[int, int]:
    value &= 0xFFFF
    return value >> 8, value & 0xFF


def _checksum(data: bytes) -> int:
    x = 0
    for b in data:
        x ^= b
    return x & 0xFF


class _VehicleModel:
    """Deterministic, seed-driven physical state. ``advance(dt)`` is cheap.

    Decoupled from transport so it can be unit-tested instantly (drive it with a
    large dt instead of sleeping through real time).
    """

    __slots__ = (
        "_rng", "rpm", "_rpm_target", "_rpm_hold", "speed", "_spd_target",
        "_spd_hold", "coolant", "fuel", "_fuel_true", "_fuel_slosh",
        "_fuel_slosh_hold", "ignition", "handbrake", "_hb_hold", "reverse",
        "_rev_hold", "blinker", "_blink_active", "_blink_hold", "_blink_phase",
    )

    def __init__(self, rng: random.Random) -> None:
        self._rng = rng
        self.rpm = 800.0
        self._rpm_target = 800.0
        self._rpm_hold = rng.uniform(2.0, 9.0)
        self.speed = 0.0
        self._spd_target = 0.0
        self._spd_hold = rng.uniform(6.0, 18.0)
        self.coolant = 20.0  # cold start, warms toward ~92
        self.fuel = rng.uniform(35.0, 85.0)
        self._fuel_true = self.fuel
        self._fuel_slosh = 0.0
        self._fuel_slosh_hold = rng.uniform(1.0, 3.0)
        self.ignition = True
        self.handbrake = True  # parked initially
        self._hb_hold = rng.uniform(6.0, 25.0)
        self.reverse = False
        self._rev_hold = rng.uniform(12.0, 45.0)
        self.blinker = False
        self._blink_active = False
        self._blink_hold = rng.uniform(8.0, 25.0)
        self._blink_phase = 0.0

    def advance(self, dt: float) -> None:
        if dt <= 0:
            return
        r = self._rng
        # RPM: mean-revert to a target that flips between idle and a rev.
        self._rpm_hold -= dt
        if self._rpm_hold <= 0:
            self._rpm_hold = r.uniform(2.0, 9.0)
            self._rpm_target = 800.0 if r.random() < 0.4 else r.uniform(1400.0, 3600.0)
        self.rpm += (self._rpm_target - self.rpm) * min(1.0, 2.5 * dt)
        self.rpm += r.uniform(-15.0, 15.0)
        self.rpm = max(600.0, min(self.rpm, 6500.0))
        # Speed: independent ramps toward a target.
        self._spd_hold -= dt
        if self._spd_hold <= 0:
            self._spd_hold = r.uniform(6.0, 18.0)
            self._spd_target = 0.0 if r.random() < 0.35 else r.uniform(20.0, 110.0)
        self.speed += (self._spd_target - self.speed) * min(1.0, 0.8 * dt)
        self.speed += r.uniform(-0.3, 0.3)
        self.speed = max(0.0, min(self.speed, 160.0))
        # Coolant: monotonic warmup toward ~92 (no reversal).
        self.coolant += (92.0 - self.coolant) * min(1.0, 0.02 * dt)
        # Fuel: monotonic drain + transient slosh -> the "progressive + noise" case.
        self._fuel_true = max(0.0, self._fuel_true - 0.02 * dt)
        self._fuel_slosh_hold -= dt
        if self._fuel_slosh_hold <= 0:
            self._fuel_slosh_hold = r.uniform(1.0, 3.0)
            self._fuel_slosh = r.uniform(-2.5, 2.5)
        self.fuel = max(0.0, min(self._fuel_true + self._fuel_slosh, 100.0))
        # Handbrake: occasional toggle -> the "event" case.
        self._hb_hold -= dt
        if self._hb_hold <= 0:
            self._hb_hold = r.uniform(6.0, 25.0)
            self.handbrake = not self.handbrake
        # Reverse: brief engagements.
        self._rev_hold -= dt
        if self._rev_hold <= 0:
            self.reverse = not self.reverse
            self._rev_hold = r.uniform(2.0, 6.0) if self.reverse else r.uniform(12.0, 45.0)
        # Blinker: ~1.5 Hz toggle during active windows.
        self._blink_hold -= dt
        if self._blink_hold <= 0:
            self._blink_active = not self._blink_active
            self._blink_hold = r.uniform(2.0, 6.0) if self._blink_active else r.uniform(8.0, 25.0)
            if not self._blink_active:
                self.blinker = False
        if self._blink_active:
            self._blink_phase += dt
            if self._blink_phase >= 1.0 / 3.0:
                self._blink_phase = 0.0
                self.blinker = not self.blinker


class SimulatedBus:
    """Generates classic-CAN traffic at a target rate; never transmits."""

    def __init__(
        self,
        bitrate: int = 500000,
        *,
        rate_hz: float = 200.0,
        seed: Optional[int] = None,
        ids: Optional[List[int]] = None,
        profile: str = "realistic",
    ) -> None:
        self.bitrate = bitrate
        self.profile = profile if profile in ("realistic", "lite") else "realistic"
        self._rng = random.Random(seed)
        self._ids = list(ids) if ids else list(_DEFAULT_IDS)

        if self.profile == "realistic":
            self._model = _VehicleModel(self._rng)
            self._t = 0.0
            self._periods: Dict[int, float] = {fid: p for fid, p in _FRAMES}
            # Stagger first emissions by a seeded sub-period phase.
            self._next_due: Dict[int, float] = {
                fid: p * self._rng.random() for fid, p in _FRAMES
            }
            self._counters: Dict[int, int] = {fid: 0 for fid, _ in _FRAMES}
            self._chatter: Dict[int, bytearray] = {
                fid: bytearray(self._rng.randint(0, 255) for _ in range(8))
                for fid in _CHATTER_IDS
            }
        else:  # lite
            self._gap = 1.0 / rate_hz if rate_hz > 0 else 0.005
            self._last_payloads = {cid: self._random_payload() for cid in self._ids}

    # --- transport ---------------------------------------------------------
    def recv(self, timeout: float = 0.5) -> Optional[CanMessage]:
        if self.profile == "realistic":
            return self._recv_realistic(timeout)
        return self._recv_lite(timeout)

    def shutdown(self) -> None:
        return None

    # --- realistic ---------------------------------------------------------
    def _recv_realistic(self, timeout: float) -> CanMessage:
        fid = min(self._next_due, key=self._next_due.__getitem__)
        due = self._next_due[fid]
        dt = max(0.0, due - self._t)
        sleep = min(dt, max(timeout, 0.0))
        if sleep > 0:
            time.sleep(sleep)
        self._t = due
        self._next_due[fid] = due + self._periods[fid]
        self._model.advance(dt)
        self._counters[fid] = (self._counters[fid] + 1) & 0xFFFF
        is_rtr = fid in _RTR_IDS
        return CanMessage(
            arbitration_id=fid,
            data=self._build(fid, self._model, self._counters[fid]),
            dlc=0 if is_rtr else 8,
            is_extended=fid in _EXTENDED_IDS,
            is_rtr=is_rtr,
        )

    def _build(self, fid: int, m: _VehicleModel, counter: int) -> bytes:
        d = bytearray(8)
        if fid == 0x280:  # engine
            d[0], d[1] = _u16_be(int(m.rpm) * 4)          # rpm * 4 (OBD-style), BE
            d[2] = int(max(0.0, min(255.0, m.rpm / 26.0)))  # crude load 0..~250
            d[3] = int(max(0.0, min(255.0, m.coolant + 40.0)))  # raw coolant
            d[6] = counter & 0x0F                          # rolling counter
            d[7] = _checksum(d[:7])                         # checksum
        elif fid == 0x5A0:  # chassis
            d[0], d[1] = _u16_be(int(m.speed * 100.0))     # 0.01 km/h, BE
            d[2] = (
                (0x01 if m.handbrake else 0)
                | (0x02 if m.reverse else 0)
                | (0x04 if m.ignition else 0)
            )
            d[6] = counter & 0x0F
            d[7] = _checksum(d[:7])
        elif fid == 0x30B:  # body
            d[0] = 0x01 if m.blinker else 0x00
            d[1] = int(max(0.0, min(255.0, m.coolant + 40.0)))
        elif fid == 0x480:  # fuel
            d[0] = int(m.fuel * 255.0 / 100.0)
        elif fid == 0x11E:  # misc periodic
            d[0] = int(m.speed) & 0xFF
            d[1] = (counter * 7) & 0xFF
        elif fid in _RTR_IDS:  # remote request: carries no data
            return b""
        elif fid == 0x18FEF100:  # extended: rpm + coolant echo + counter
            d[0], d[1] = _u16_be(int(m.rpm) * 4)
            d[2] = int(max(0.0, min(255.0, m.coolant + 40.0)))
            d[7] = counter & 0xFF
        elif fid == 0x1A5A0F01:  # extended: speed echo + counter
            d[0], d[1] = _u16_be(int(m.speed * 100.0))
            d[7] = counter & 0xFF
        elif fid == 0x7DF:  # OBD functional request: SF, mode 01, PID 0C (rpm)
            return bytes([0x02, 0x01, 0x0C, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA])
        elif fid == 0x7E8:  # OBD response ECU0: SF, mode 01, PID 0C, live rpm*4
            hi, lo = _u16_be(int(m.rpm) * 4)
            return bytes([0x04, 0x41, 0x0C, hi, lo, 0xAA, 0xAA, 0xAA])
        else:  # 0x100 / 0x120 -- unrelated chatter (random walk)
            buf = self._chatter[fid]
            idx = self._rng.randint(0, 7)
            buf[idx] = (buf[idx] + self._rng.randint(1, 4)) & 0xFF
            return bytes(buf)
        return bytes(d)

    # --- lite --------------------------------------------------------------
    def _recv_lite(self, timeout: float) -> CanMessage:
        sleep = min(self._rng.uniform(0.3, 1.7) * self._gap, max(timeout, 0.0))
        if sleep > 0:
            time.sleep(sleep)
        can_id = self._rng.choice(self._ids)
        payload = bytearray(self._last_payloads[can_id])
        if self._rng.random() < 0.7:
            i = self._rng.randint(0, 7)
            payload[i] = (payload[i] + self._rng.randint(1, 5)) & 0xFF
        else:
            payload = bytearray(self._random_payload())
        self._last_payloads[can_id] = bytes(payload)
        return CanMessage(arbitration_id=can_id, data=bytes(payload), dlc=8, is_extended=False)

    def _random_payload(self) -> bytes:
        return bytes(self._rng.randint(0, 255) for _ in range(8))
