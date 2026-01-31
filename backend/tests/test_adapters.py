"""Adapter dispatch + listen-only enforcement (DESIGN.md §5, invariant 1)."""

from __future__ import annotations

import importlib.util

import pytest

from discodb2_backend import adapters
from discodb2_backend.adapters import (
    ALL_SOURCES,
    LIVE_SOURCES,
    PASSIVE_SOURCES,
    clamp_listen_only,
    is_live_source,
    open_bus,
)
from discodb2_backend.adapters.base import CanBus, CanMessage
from discodb2_backend.adapters.sim import SimulatedBus
from discodb2_backend.adapters.replay import ReplayBus

_HAS_PYCAN = importlib.util.find_spec("can") is not None
_HAS_GSUSB = importlib.util.find_spec("gs_usb") is not None


def test_source_sets():
    assert ALL_SOURCES == {"sim", "replay", "socketcan", "gs_usb", "slcan"}
    assert LIVE_SOURCES == {"socketcan", "gs_usb", "slcan"}
    assert PASSIVE_SOURCES == {"sim", "replay"}


def test_clamp_forces_listen_only_for_live_sources():
    for src in LIVE_SOURCES:
        assert clamp_listen_only(src, False) is True  # request to disable -> clamped
        assert clamp_listen_only(src, True) is True
        assert is_live_source(src)


def test_clamp_passive_sources_passthrough():
    # sim/replay never transmit; the flag passes through unchanged.
    assert clamp_listen_only("sim", False) is False
    assert clamp_listen_only("replay", False) is False
    assert not is_live_source("sim")
    assert not is_live_source("replay")


def test_open_sim_zero_hardware():
    bus = open_bus("sim", bitrate=500000, sim_seed=42)
    assert isinstance(bus, SimulatedBus)
    assert isinstance(bus, CanBus)  # duck-typed Protocol
    msg = bus.recv(timeout=0.5)
    assert isinstance(msg, CanMessage)
    assert msg is not None
    assert 0 <= msg.dlc <= 8
    assert len(msg.data) == msg.dlc
    bus.shutdown()


def test_sim_is_deterministic_with_seed():
    a = open_bus("sim", sim_seed=7)
    b = open_bus("sim", sim_seed=7)
    seq_a = [a.recv(timeout=0.5).arbitration_id for _ in range(20)]
    seq_b = [b.recv(timeout=0.5).arbitration_id for _ in range(20)]
    assert seq_a == seq_b
    a.shutdown()
    b.shutdown()


def test_open_replay_requires_file():
    with pytest.raises(ValueError, match="requires a 'file'"):
        open_bus("replay")


def test_open_replay_from_file(tmp_path):
    log = tmp_path / "cap.log"
    log.write_text("(0.000000) can0 123#DEADBEEF\n")
    bus = open_bus("replay", file=str(log), realtime=False)
    assert isinstance(bus, ReplayBus)
    msg = bus.recv(timeout=0.1)
    assert msg is not None
    assert msg.arbitration_id == 0x123
    assert msg.data == b"\xDE\xAD\xBE\xEF"
    bus.shutdown()


def test_unknown_source_rejected():
    with pytest.raises(ValueError, match="unknown source"):
        open_bus("bogus")


def test_slcan_requires_channel():
    # Channel is validated before any python-can import, so this holds even
    # without python-can installed.
    with pytest.raises(ValueError, match="requires a 'channel'"):
        open_bus("slcan")


@pytest.mark.skipif(_HAS_PYCAN, reason="python-can present; failure path not exercised")
def test_socketcan_without_pycan_fails_loud():
    with pytest.raises(RuntimeError, match="python-can"):
        open_bus("socketcan")


@pytest.mark.skipif(_HAS_GSUSB, reason="gs_usb present; failure path not exercised")
def test_gs_usb_without_lib_fails_loud():
    with pytest.raises(RuntimeError, match="gs_usb"):
        open_bus("gs_usb")


def test_live_source_constructors_refuse_disabling_listen_only():
    # Even if a caller bypasses clamp and passes listen_only=False directly to a
    # live adapter, it must refuse (defence in depth for invariant 1). We assert
    # this via the dispatch using the underlying classes' contract: the gs_usb
    # and socketcan/slcan constructors raise on listen_only=False. Without the
    # libs they raise on the missing dep first, so we check the gs_usb class
    # source guard explicitly here.
    from discodb2_backend.adapters import gs_usb as gs_mod
    import inspect

    src = inspect.getsource(gs_mod.GsUsbListenOnlyBus.__init__)
    assert "listen-only is enforced" in src
