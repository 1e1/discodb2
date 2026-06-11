#!/usr/bin/env python3
"""Generate a replayable CAN trace from a high-level scenario + a DBC.

This is an **offline** dev tool (it uses ``cantools`` and is NOT part of the
lean ARMv6 backend — DESIGN §4.3). It turns a human-authored *scenario* (named
physical signals over time, in YAML) into a candump ``-l`` capture that the
backend's ``replay`` source plays back — ideally on a loop::

    python tools/gen_trace.py infra/sim/scenario.cluster.yaml \
        docs/vw/dbc/vw_pq-en.dbc -o backend/recordings/vw_pq_circuit.canlog

    python -m discodb2_backend --source replay \
        --file recordings/vw_pq_circuit.canlog --loop

Why this design (vs a procedural live simulator):

* **DBC-true.** Frames use the real message IDs and bit layouts, so a cockpit
  pointed at the same DBC decodes them correctly — and the scenario is the
  *ground truth* for testing the decoder / cluster.
* **Lean runtime.** All the heavy DBC encoding happens here, offline; the
  backend only replays text. cantools never reaches the Pi/Docker runtime image.
* **Seamless loop.** Author the scenario so every track's value at ``t = 0``
  equals its value at ``t = duration`` (a closed circuit lap). Replay re-anchors
  the clock each lap, so the only thing that can jump at the seam is a signal
  value — and ``--check-loop`` warns when one would.

The generated file is a normal candump capture: open it in SavvyCAN, feed it to
``canplayer``, or diff it in CI.

Scenario YAML (see ``infra/sim/scenario.cluster.yaml`` for a worked example):

    meta: {name, duration_s, bitrate, iface, seed}
    tracks:                       # named signal timelines, authored in PHYSICAL units
      rpm:   {keyframes: [[0,820],[20,4200],...,[300,820]]}     # continuous, linear interp
      gear:  {steps: [[0,0],[34,1],[70,2],...,[292,0]]}         # discrete, hold (no interp)
      coolant: {const: 89}
      blink_left: {pulse: {windows: [[40,55]], freq_hz: 1.5}}   # square wave in windows
    messages:                     # DBC messages to emit, with their cycle time
      engine_1:                   # DBC message NAME
        cycle_ms: 10
        signals: {engine_rpm: {track: rpm}}
        auto_counter: [some_counter]      # 4-bit++ each frame (optional)
    noise:                        # out-of-DBC chatter so the bus looks real
      - {id: 0x2C0, cycle_ms: 50, dlc: 8}                       # continuous
      - {id: 0x7A0, cycle_ms: 50, dlc: 1, windows: [[64, 65]]}  # only inside windows (e.g. a horn)
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Tuple

try:
    import cantools
    import yaml
except ImportError as exc:  # pragma: no cover - offline tool, deps are explicit
    sys.exit(
        f"missing dependency: {exc.name}. This is an offline tool — install with:\n"
        f"    pip install cantools pyyaml"
    )


# --- track samplers --------------------------------------------------------

def _make_keyframe_sampler(pts: List[List[float]]) -> Callable[[float], float]:
    """Linear interpolation between [t, value] keyframes (clamped at the ends)."""
    pts = sorted((float(t), float(v)) for t, v in pts)
    ts = [p[0] for p in pts]
    vs = [p[1] for p in pts]

    def sample(t: float) -> float:
        if t <= ts[0]:
            return vs[0]
        if t >= ts[-1]:
            return vs[-1]
        # find the bracketing pair (small lists; linear scan is fine)
        for i in range(1, len(ts)):
            if t <= ts[i]:
                t0, t1, v0, v1 = ts[i - 1], ts[i], vs[i - 1], vs[i]
                if t1 == t0:
                    return v1
                return v0 + (v1 - v0) * (t - t0) / (t1 - t0)
        return vs[-1]

    return sample


def _make_steps_sampler(pts: List[List[float]]) -> Callable[[float], float]:
    """Step function: hold each [t, value] until the next one (NO interpolation).

    For discrete/enum signals — ignition, gear, lights, reverse, handbrake —
    where interpolation would invent impossible in-between states (e.g. a gear
    sliding through 2.5, or a light at 0.5).
    """
    pts = sorted((float(t), float(v)) for t, v in pts)
    ts = [p[0] for p in pts]
    vs = [p[1] for p in pts]

    def sample(t: float) -> float:
        if t < ts[0]:
            return vs[0]
        # last step whose time is <= t
        lo, hi = 0, len(ts) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if ts[mid] <= t:
                lo = mid
            else:
                hi = mid - 1
        return vs[lo]

    return sample


def _make_pulse_sampler(windows: List[List[float]], freq_hz: float) -> Callable[[float], float]:
    """1 during a window when a square wave at ``freq_hz`` is high, else 0.

    Models a turn signal: it only flashes inside its active windows.
    """
    half = 0.5 / freq_hz if freq_hz > 0 else 0.5
    wins = [(float(a), float(b)) for a, b in windows]

    def sample(t: float) -> float:
        for a, b in wins:
            if a <= t < b:
                phase = (t - a) % (2 * half)
                return 1.0 if phase < half else 0.0
        return 0.0

    return sample


def build_tracks(spec: dict) -> Dict[str, Callable[[float], float]]:
    tracks: Dict[str, Callable[[float], float]] = {}
    for name, body in (spec or {}).items():
        if "keyframes" in body:
            tracks[name] = _make_keyframe_sampler(body["keyframes"])
        elif "steps" in body:
            tracks[name] = _make_steps_sampler(body["steps"])
        elif "const" in body:
            c = float(body["const"])
            tracks[name] = (lambda c: (lambda t: c))(c)
        elif "pulse" in body:
            p = body["pulse"]
            tracks[name] = _make_pulse_sampler(p["windows"], float(p.get("freq_hz", 1.5)))
        else:
            sys.exit(f"track {name!r}: expected one of keyframes|steps|const|pulse")
    return tracks


# --- bit packing (mirrors the cockpit decoder, frontend/.../protocol/decode.ts) -

def _signal_bit_order(start: int, length: int, byte_order: str) -> List[int]:
    """Ascending (LSB→MSB) standard-CAN bit indices for a signal.

    IDENTICAL to the cockpit's ``signalBitOrder`` so a frame we pack here decodes
    bit-for-bit the same in the cockpit. We deliberately do NOT use cantools'
    ``Message.encode``: on this PQ DBC's overlapping/multiplexed messages (e.g.
    ``gate_comfort_1``) cantools places bits a few positions off from the DBC's
    own ``start``, which the cockpit reads literally — so cantools-encoded body
    frames decoded as zero in the cockpit. Packing at ``start`` fixes that.
    """
    if byte_order == "little_endian":
        return [start + i for i in range(length)]
    # Motorola / big-endian sawtooth walk (MSB at `start`, towards the LSB).
    bits: List[int] = []
    byte_index, bit_in_byte = start >> 3, start & 7
    for _ in range(length):
        bits.insert(0, byte_index * 8 + bit_in_byte)
        if bit_in_byte == 0:
            bit_in_byte, byte_index = 7, byte_index + 1
        else:
            bit_in_byte -= 1
    return bits


def pack_signal(buf: bytearray, sig, phys: float) -> None:
    """Set ``sig``'s bits in ``buf`` from a PHYSICAL value (factor/offset applied)."""
    raw = round((phys - sig.offset) / sig.scale)
    length = sig.length
    if sig.is_signed and raw < 0:
        raw += 1 << length
    raw &= (1 << length) - 1
    for i, bit in enumerate(_signal_bit_order(sig.start, length, sig.byte_order)):
        if (raw >> i) & 1:
            bi = bit >> 3
            if bi < len(buf):
                buf[bi] |= 1 << (bit & 7)


# --- frame assembly --------------------------------------------------------

@dataclass(slots=True)
class Emit:
    t_us: int
    frame_id: int
    data: bytes
    is_extended: bool


def format_line(e: Emit, iface: str) -> str:
    sec, usec = divmod(e.t_us, 1_000_000)
    if e.is_extended or e.frame_id > 0x7FF:
        id_str = f"{e.frame_id:08X}"
    else:
        id_str = f"{e.frame_id:03X}"
    return f"({sec}.{usec:06d}) {iface} {id_str}#{e.data.hex().upper()}"


def gen_messages(db, scenario: dict, tracks, duration_s: float) -> List[Emit]:
    out: List[Emit] = []
    for msg_name, mcfg in (scenario.get("messages") or {}).items():
        try:
            message = db.get_message_by_name(msg_name)
        except KeyError:
            sys.exit(f"message {msg_name!r} not found in the DBC")
        cycle_ms = float(mcfg.get("cycle_ms", 100))
        cycle_us = int(cycle_ms * 1000)
        if cycle_us <= 0:
            sys.exit(f"message {msg_name!r}: cycle_ms must be > 0")
        bindings = mcfg.get("signals") or {}
        auto_counter = list(mcfg.get("auto_counter") or [])
        sigs = {s.name: s for s in message.signals}
        for sig_name in list(bindings) + auto_counter:
            if sig_name not in sigs:
                sys.exit(f"message {msg_name!r} has no signal {sig_name!r}")
        # Deterministic per-message phase so messages don't all fire at t=0.
        phase_us = (hash(msg_name) & 0xFFFF) % cycle_us
        counter = 0
        t_us = phase_us
        end_us = int(duration_s * 1_000_000)
        while t_us < end_us:
            t = t_us / 1_000_000
            # Start from a zeroed payload and set only the signals we drive — no
            # cantools encode, so placement matches the cockpit (see pack_signal).
            buf = bytearray(message.length)
            for sig_name, bind in bindings.items():
                if "track" in bind:
                    tname = bind["track"]
                    if tname not in tracks:
                        sys.exit(f"{msg_name}.{sig_name}: unknown track {tname!r}")
                    phys = tracks[tname](t)
                elif "const" in bind:
                    phys = float(bind["const"])
                else:
                    sys.exit(f"{msg_name}.{sig_name}: binding needs 'track' or 'const'")
                pack_signal(buf, sigs[sig_name], phys)
            for cname in auto_counter:
                pack_signal(buf, sigs[cname], counter)
            counter = (counter + 1) & 0x0F
            out.append(Emit(t_us, message.frame_id, bytes(buf), message.is_extended_frame))
            t_us += cycle_us
    return out


def gen_noise(scenario: dict, duration_s: float, rng) -> List[Emit]:
    """Random-walk chatter on out-of-DBC ids so the bus looks like a real one."""
    out: List[Emit] = []
    end_us = int(duration_s * 1_000_000)
    for spec in (scenario.get("noise") or []):
        fid = int(spec["id"]) if not isinstance(spec["id"], str) else int(spec["id"], 0)
        cycle_us = int(float(spec.get("cycle_ms", 50)) * 1000)
        dlc = int(spec.get("dlc", 8))
        is_ext = bool(spec.get("extended", fid > 0x7FF))
        # Optional windows: emit only inside [a, b] spans (e.g. a horn beep).
        # No windows => continuous chatter for the whole trace.
        windows = [(float(a), float(b)) for a, b in (spec.get("windows") or [])]

        def active(ts: float) -> bool:
            return (not windows) or any(a <= ts < b for a, b in windows)

        payload = bytearray(rng.randint(0, 255) for _ in range(dlc))
        phase_us = (hash(("noise", fid)) & 0xFFFF) % max(cycle_us, 1)
        t_us = phase_us
        while t_us < end_us:
            # Walk one byte so it changes without being pure white noise.
            i = rng.randint(0, dlc - 1)
            payload[i] = (payload[i] + rng.randint(1, 4)) & 0xFF
            if active(t_us / 1_000_000):
                out.append(Emit(t_us, fid, bytes(payload), is_ext))
            t_us += cycle_us
    return out


def check_loop(scenario: dict, tracks, duration_s: float, tol: float = 1e-6) -> List[str]:
    """Warn for ANY track whose value at t=0 differs from t=duration.

    A seamless loop needs every signal back at its start state — a continuous
    track (keyframes), a discrete one (steps), or a pulse straddling the seam.
    ``const`` tracks are trivially seamless and skipped.
    """
    warnings: List[str] = []
    for name, body in (scenario.get("tracks") or {}).items():
        if "const" in body:
            continue
        f = tracks[name]
        v0, vN = f(0.0), f(duration_s)
        if abs(v0 - vN) > tol:
            warnings.append(
                f"track {name!r}: value at t=0 ({v0:g}) != t={duration_s:g}s ({vN:g}) "
                f"— the loop will jump at the seam"
            )
    return warnings


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Generate a candump replay trace from a scenario + DBC.")
    p.add_argument("scenario", help="scenario YAML path")
    p.add_argument("dbc", help="DBC file path")
    p.add_argument("-o", "--output", required=True, help="output candump (.canlog) path")
    p.add_argument("--seed", type=int, default=None, help="override the scenario noise seed")
    p.add_argument("--check-loop", action="store_true", help="warn on non-seamless tracks")
    args = p.parse_args(argv)

    with open(args.scenario, "r", encoding="utf-8") as fh:
        scenario = yaml.safe_load(fh)
    meta = scenario.get("meta") or {}
    duration_s = float(meta.get("duration_s", 300))
    iface = meta.get("iface", "can0")
    seed = args.seed if args.seed is not None else int(meta.get("seed", 0))

    import random
    rng = random.Random(seed)

    # strict=False: real-world DBCs (this PQ one included) have messages with
    # overlapping/over-long signals that would reject a strict load. We only
    # encode the messages the scenario names, so a lenient load is safe.
    db = cantools.database.load_file(args.dbc, strict=False)
    tracks = build_tracks(scenario.get("tracks"))

    if args.check_loop:
        for w in check_loop(scenario, tracks, duration_s):
            print(f"WARNING: {w}", file=sys.stderr)

    emits = gen_messages(db, scenario, tracks, duration_s) + gen_noise(scenario, duration_s, rng)
    emits.sort(key=lambda e: (e.t_us, e.frame_id))

    with open(args.output, "w", encoding="utf-8") as fh:
        for e in emits:
            fh.write(format_line(e, iface) + "\n")

    dur = duration_s
    rate = len(emits) / dur if dur else 0
    print(
        f"wrote {len(emits)} frames over {dur:g}s (~{rate:.0f} fps) to {args.output}\n"
        f"  replay it: python -m discodb2_backend --source replay "
        f"--file {args.output} --loop"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
