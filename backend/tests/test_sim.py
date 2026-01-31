"""Credible simulator: undulating signals, seed-variation, determinism, profiles."""

from __future__ import annotations

import random

from discodb2_backend.adapters import open_bus
from discodb2_backend.adapters.sim import SimulatedBus, _VehicleModel


def test_realistic_signals_undulate_over_time():
    # Drive the physics directly (no sleeping): 60 s at dt=0.1.
    m = _VehicleModel(random.Random(1))
    rpms, fuels, cools = [], [], []
    for _ in range(600):
        m.advance(0.1)
        rpms.append(m.rpm)
        fuels.append(m.fuel)
        cools.append(m.coolant)

    assert all(600.0 <= x <= 6500.0 for x in rpms)        # bounded
    assert max(rpms) - min(rpms) > 200.0                  # it actually revs
    assert all(0.0 <= f <= 100.0 for f in fuels)          # bounded
    # Net drain despite slosh (compare windowed means, robust to noise).
    assert sum(fuels[-100:]) / 100 < sum(fuels[:100]) / 100
    assert cools[-1] > cools[0] + 20.0                    # warms up


def test_realistic_varies_by_seed():
    m1, m2 = _VehicleModel(random.Random(1)), _VehicleModel(random.Random(2))
    a, b = [], []
    for _ in range(300):
        m1.advance(0.1)
        m2.advance(0.1)
        a.append(round(m1.rpm))
        b.append(round(m2.rpm))
    assert a != b  # different seeds -> different traces


def test_realistic_payloads_deterministic_with_seed():
    a = open_bus("sim", sim_seed=9)
    b = open_bus("sim", sim_seed=9)
    da = [(lambda msg: (msg.arbitration_id, msg.data))(a.recv(0.5)) for _ in range(60)]
    db = [(lambda msg: (msg.arbitration_id, msg.data))(b.recv(0.5)) for _ in range(60)]
    a.shutdown()
    b.shutdown()
    assert da == db  # same seed -> identical id+payload sequence


def test_counter_increments_and_checksum_is_valid():
    bus = open_bus("sim", sim_seed=3)  # realistic default
    counters, checked, total = set(), 0, 0
    for _ in range(400):
        msg = bus.recv(0.5)
        if msg.arbitration_id == 0x5A0:  # carries counter (byte6) + checksum (byte7)
            counters.add(msg.data[6] & 0x0F)
            x = 0
            for byte in msg.data[:7]:
                x ^= byte
            checked += int(x == msg.data[7])
            total += 1
    bus.shutdown()
    assert total > 0
    assert checked == total           # checksum always valid
    assert len(counters) >= 8         # rolling counter cycles


def test_realistic_emits_candidate_ids():
    bus = open_bus("sim", sim_seed=2)
    ids = {bus.recv(0.5).arbitration_id for _ in range(300)}
    bus.shutdown()
    # The doc's high-priority IDs must appear (engine/chassis/fuel/body).
    assert {0x280, 0x5A0, 0x480, 0x30B}.issubset(ids)


def test_lite_profile_runs_and_is_cheap():
    bus = open_bus("sim", sim_seed=5, sim_profile="lite")
    assert isinstance(bus, SimulatedBus)
    assert bus.profile == "lite"
    msg = bus.recv(0.5)
    assert msg is not None and msg.dlc == 8 and len(msg.data) == 8
    bus.shutdown()
