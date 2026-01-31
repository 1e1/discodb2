"""discodb2 thin CAN backend.

Owns the hardware, enforces listen-only, streams a batched BINARY CAN frame
protocol plus a JSON control/status channel over one WebSocket, serves
``GET /health``, and records/replays captures losslessly. See ``DESIGN.md`` for
the authoritative contract; this package implements §3 (transport/protocol),
§4 (invariants), and §5 (adapter abstraction).
"""

from __future__ import annotations

__version__ = "0.1.0"
