"""Entry point: ``python -m discodb2_backend [options]``.

Boots the asyncio WebSocket server with config from CLI flags / env. Logging
goes to stderr (plain text); the periodic HEALTH lines go to stdout so they can
be redirected/parsed independently (DESIGN.md §6).
"""

from __future__ import annotations

import asyncio
import logging
import sys

from .config import config_from_args
from .server import run


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    config = config_from_args(argv)
    try:
        asyncio.run(run(config))
    except KeyboardInterrupt:
        print("shutting down", file=sys.stderr)
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
