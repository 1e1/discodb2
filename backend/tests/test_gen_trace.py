"""End-to-end check for the offline trace generator (tools/gen_trace.py).

Skipped unless cantools/pyyaml are installed — they are dev-only deps of the
generator, NOT of the lean backend (DESIGN §4.3). Generates a tiny trace from
the real PQ DBC and asserts a cluster frame decodes back to the authored value
(the "ground truth" property), and that the backend's own parser reads it.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

pytest.importorskip("cantools")
pytest.importorskip("yaml")

import cantools  # noqa: E402

from discodb2_backend.candump_log import parse_line  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
DBC = REPO / "docs/vw/dbc/vw_pq-en.dbc"


def _load_gen():
    spec = importlib.util.spec_from_file_location("gen_trace", REPO / "tools/gen_trace.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod  # so @dataclass can resolve the module
    spec.loader.exec_module(mod)
    return mod


def test_generated_cluster_frame_decodes_to_authored_speed(tmp_path):
    gen = _load_gen()
    scenario = tmp_path / "tiny.yaml"
    scenario.write_text(
        "meta: {name: t, duration_s: 2, iface: can0, seed: 1}\n"
        "tracks:\n"
        "  speed: {const: 77}\n"
        "messages:\n"
        "  instrument_cluster_1:\n"
        "    cycle_ms: 100\n"
        "    signals:\n"
        "      displayed_speed: {track: speed}\n"
        "  engine_1:\n"
        "    cycle_ms: 10\n"
        "    signals:\n"
        "      engine_rpm: {const: 2500}\n"
        "noise:\n"
        "  - {id: 0x2AA, cycle_ms: 100, dlc: 8}\n"
    )
    out = tmp_path / "tiny.canlog"
    assert gen.main([str(scenario), str(DBC), "-o", str(out)]) == 0

    db = cantools.database.load_file(str(DBC), strict=False)
    ic1 = db.get_message_by_name("instrument_cluster_1").frame_id

    speeds = []
    with open(out) as fh:
        for line in fh:
            e = parse_line(line)          # backend parser reads it cleanly
            if e and e.arbitration_id == ic1:
                speeds.append(db.decode_message(ic1, e.data)["displayed_speed"])

    assert speeds, "no instrument_cluster_1 frames emitted"
    # const 77 km/h, within the signal's 0.32 km/h quantization.
    assert all(abs(s - 77) <= 0.5 for s in speeds)


def test_steps_track_holds_value_without_interpolating(tmp_path):
    gen = _load_gen()
    scenario = tmp_path / "steps.yaml"
    # gear holds 1 from t=0 then jumps to 5 at t=1 — it must NEVER read 3 mid-way
    # (which a keyframe/interpolated track would).
    scenario.write_text(
        "meta: {duration_s: 2, seed: 1}\n"
        "tracks:\n"
        "  gear: {steps: [[0, 1], [1, 5]]}\n"
        "messages:\n"
        "  transmission_2:\n"
        "    cycle_ms: 20\n"
        "    signals:\n"
        "      gear_display_cluster___transmission_Va: {track: gear}\n"
    )
    out = tmp_path / "steps.canlog"
    assert gen.main([str(scenario), str(DBC), "-o", str(out)]) == 0

    db = cantools.database.load_file(str(DBC), strict=False)
    fid = db.get_message_by_name("transmission_2").frame_id
    seen = set()
    with open(out) as fh:
        for line in fh:
            e = parse_line(line)
            if e and e.arbitration_id == fid:
                seen.add(db.decode_message(fid, e.data)["gear_display_cluster___transmission_Va"])
    assert seen == {1, 5}, f"steps must hold discrete values, got {sorted(seen)}"


def test_packs_at_dbc_start_bit_cockpit_convention():
    # REGRESSION GUARD. The cockpit reads a little-endian signal at its DBC
    # `start` bit (contiguous). cantools' ENCODER places bits a few positions off
    # on this PQ DBC's overlapping/multiplexed messages (e.g. gate_comfort_1),
    # which made the cockpit read the body signals as zero. The generator must
    # therefore pack at `start` itself — assert it does, or the demo silently
    # loses reverse/turn/brake again.
    gen = _load_gen()
    db = cantools.database.load_file(str(DBC), strict=False)
    rev = next(s for s in db.get_message_by_name("gate_comfort_1").signals
               if s.name == "GK1_reverse")
    assert rev.start == 28 and rev.byte_order == "little_endian"

    buf = bytearray(8)
    gen.pack_signal(buf, rev, 1)
    set_bits = [i * 8 + j for i in range(8) for j in range(8) if (buf[i] >> j) & 1]
    assert set_bits == [28], f"GK1_reverse must set exactly DBC bit 28, got {set_bits}"

    # A multi-byte little-endian signal lands contiguously from its start bit.
    spd = next(s for s in db.get_message_by_name("instrument_cluster_1").signals
               if s.name == "displayed_speed")          # start 46, len 10, scale 0.32
    buf2 = bytearray(8)
    gen.pack_signal(buf2, spd, 0.32 * 0b11)             # raw 0b11 -> bits 46,47
    set2 = [i * 8 + j for i in range(8) for j in range(8) if (buf2[i] >> j) & 1]
    assert set2 == [46, 47], set2


def test_check_loop_flags_a_non_seamless_track(tmp_path, capsys):
    gen = _load_gen()
    scenario = tmp_path / "bad.yaml"
    scenario.write_text(
        "meta: {duration_s: 10}\n"
        "tracks:\n"
        "  speed: {keyframes: [[0, 10], [10, 99]]}\n"   # 10 != 99 at the seam
        "messages:\n"
        "  instrument_cluster_1: {cycle_ms: 100, signals: {displayed_speed: {track: speed}}}\n"
    )
    out = tmp_path / "bad.canlog"
    gen.main([str(scenario), str(DBC), "-o", str(out), "--check-loop"])
    err = capsys.readouterr().err
    assert "seam" in err and "speed" in err
