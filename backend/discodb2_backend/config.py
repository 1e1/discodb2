"""Backend configuration: CLI flags + environment, with contract defaults.

Defaults follow DESIGN.md §3.1 (``ws://0.0.0.0:8765/ws``). Every setting can be
overridden by an env var (``DISCODB2_*``) and then by a CLI flag, in that order
of precedence (CLI wins).
"""

from __future__ import annotations

import argparse
import os
from dataclasses import dataclass

DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8765
DEFAULT_WS_PATH = "/ws"
DEFAULT_BITRATE = 500000
# Batch window: DESIGN.md §3.2 says ~20-50 ms. 25 ms is a good live default.
DEFAULT_BATCH_MS = 25
DEFAULT_HEALTH_INTERVAL_S = 2.0


def _env(name: str, default: str) -> str:
    return os.environ.get(f"DISCODB2_{name}", default)


@dataclass(slots=True)
class Config:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    ws_path: str = DEFAULT_WS_PATH
    record_dir: str = "./recordings"
    batch_ms: int = DEFAULT_BATCH_MS
    health_interval_s: float = DEFAULT_HEALTH_INTERVAL_S
    # Optional autostart (handy for headless / Docker): start a source on boot
    # without waiting for a client `start`. Empty = wait for control message.
    autostart_source: str = ""
    autostart_file: str = ""
    autostart_bitrate: int = DEFAULT_BITRATE
    # Replay pacing: real-time by default; --replay-fast disables it.
    replay_realtime: bool = True
    # Replay looping: replay a capture endlessly (re-anchored each lap). Handy
    # for a headless/Docker demo bus built from a generated circuit trace.
    replay_loop: bool = False
    sim_seed: int | None = None
    sim_profile: str = "realistic"

    @property
    def ws_url(self) -> str:
        return f"ws://{self.host}:{self.port}{self.ws_path}"


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="discodb2-backend",
        description="discodb2 thin CAN backend: binary WebSocket stream + JSON control.",
    )
    p.add_argument("--host", default=_env("HOST", DEFAULT_HOST))
    p.add_argument("--port", type=int, default=int(_env("PORT", str(DEFAULT_PORT))))
    p.add_argument("--ws-path", default=_env("WS_PATH", DEFAULT_WS_PATH))
    p.add_argument("--record-dir", default=_env("RECORD_DIR", "./recordings"))
    p.add_argument(
        "--batch-ms",
        type=int,
        default=int(_env("BATCH_MS", str(DEFAULT_BATCH_MS))),
        help="binary batch coalescing window in ms (~20-50 recommended)",
    )
    p.add_argument(
        "--health-interval",
        type=float,
        default=float(_env("HEALTH_INTERVAL", str(DEFAULT_HEALTH_INTERVAL_S))),
        help="seconds between health log lines on stdout",
    )
    p.add_argument(
        "--source",
        default=_env("SOURCE", ""),
        help="autostart this source on boot (sim|replay|socketcan|gs_usb|slcan); "
        "omit to wait for a client 'start' control message",
    )
    p.add_argument("--file", default=_env("FILE", ""), help="replay file for autostart --source replay")
    p.add_argument("--bitrate", type=int, default=int(_env("BITRATE", str(DEFAULT_BITRATE))))
    p.add_argument(
        "--replay-fast",
        action="store_true",
        help="replay as fast as possible instead of at the recorded rate",
    )
    p.add_argument(
        "--loop",
        action="store_true",
        default=_env("LOOP", "") not in ("", "0", "false", "False"),
        help="loop a replay capture endlessly (re-anchored each lap); "
        "ideal for a generated circuit trace as a demo bus",
    )
    p.add_argument(
        "--sim-seed",
        type=int,
        default=(int(os.environ["DISCODB2_SIM_SEED"]) if "DISCODB2_SIM_SEED" in os.environ else None),
        help="deterministic seed for the sim source",
    )
    p.add_argument(
        "--sim-profile",
        choices=("realistic", "lite"),
        default=_env("SIM_PROFILE", "realistic"),
        help="sim signal model: 'realistic' (undulating signals) or 'lite' "
        "(minimal CPU, for constrained hosts like a Pi)",
    )
    return p


def config_from_args(argv: list[str] | None = None) -> Config:
    args = build_parser().parse_args(argv)
    return Config(
        host=args.host,
        port=args.port,
        ws_path=args.ws_path,
        record_dir=args.record_dir,
        batch_ms=args.batch_ms,
        health_interval_s=args.health_interval,
        autostart_source=args.source,
        autostart_file=args.file,
        autostart_bitrate=args.bitrate,
        replay_realtime=not args.replay_fast,
        replay_loop=args.loop,
        sim_seed=args.sim_seed,
        sim_profile=args.sim_profile,
    )
