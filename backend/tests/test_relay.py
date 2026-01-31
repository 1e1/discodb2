"""Wizard relay (§3.3): the backend fans ``wizard`` / ``trialFeedback`` control
messages out VERBATIM to every OTHER connected client and never interprets them.

These are end-to-end tests over a REAL in-process WebSocket server (the same
``websockets`` lib the server uses), with two real clients connected at once:

  * client A sends a ``wizard`` message -> client B receives the SAME raw text
    and A receives nothing back;
  * same for ``trialFeedback``;
  * an unknown control type still yields the existing ``{"type":"error"}``;
  * the per-connection "client" kind from ``hello`` is recorded and cleaned up.

Style follows the existing backend tests (pytest, ``asyncio_mode = "auto"`` so
plain ``async def test_*`` runs on the loop; deps are stdlib + ``websockets``).
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager

import pytest
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from discodb2_backend.config import Config
from discodb2_backend.engine import Engine
from discodb2_backend.server import Server


@asynccontextmanager
async def running_server(tmp_path):
    """Start a real Server on an ephemeral port and yield its ``ws://`` URL.

    Mirrors ``Server.serve_forever`` setup (engine + ``serve`` context +
    ``self._ws_server``) WITHOUT the infinite health loop, so the relay /
    control path is exercised exactly as in production. We never autostart a
    source: the relay is independent of the bus and needs no hardware/sim.
    """
    config = Config(host="127.0.0.1", port=0, record_dir=str(tmp_path))
    server = Server(config)
    server._loop = asyncio.get_running_loop()
    server._engine = Engine(server._loop, batch_ms=config.batch_ms, record_dir=config.record_dir)
    async with serve(
        server._handle,
        config.host,
        0,  # ephemeral port -> no collisions between tests / dev boxes
        process_request=server._process_request,
        compression=None,
    ) as ws_server:
        server._ws_server = ws_server
        sock = next(iter(ws_server.sockets))
        port = sock.getsockname()[1]
        try:
            yield server, f"ws://{config.host}:{port}{config.ws_path}"
        finally:
            server._engine.stop()


async def _drain_status(ws, *, expect: int) -> None:
    """Consume ``expect`` server->client ``status`` frames (initial snapshot on
    connect, plus one per ``hello``) so later asserts see only relayed frames."""
    for _ in range(expect):
        raw = await asyncio.wait_for(ws.recv(), timeout=2.0)
        msg = json.loads(raw)
        assert msg.get("type") == "status", f"expected status, got {msg!r}"


async def _hello(ws, kind: str) -> None:
    await ws.send(json.dumps({"type": "hello", "client": kind}))


async def _assert_silent(ws, *, timeout: float = 0.3) -> None:
    """Assert ``ws`` receives nothing within ``timeout`` (sender must NOT get
    its own relayed message echoed back)."""
    with pytest.raises(asyncio.TimeoutError):
        got = await asyncio.wait_for(ws.recv(), timeout=timeout)
        raise AssertionError(f"expected silence, but received: {got!r}")


@pytest.mark.parametrize(
    "raw",
    [
        # Verbatim fidelity matters: odd key order, extra fields, unicode, and
        # whitespace must all survive untouched (the backend never re-encodes).
        # The note mixes a non-Latin script, an emoji, and an escaped code point
        # (—, em dash) so multibyte UTF-8 round-trips byte-for-byte.
        '{"type":"wizard","phase":"hunt","rep":3,"good":1,"target":5,"silence":false,'
        '"candidates":[{"id":1408,"score":0.9}],"cue":"audio","note":"日本語 🎵 \\u2014 dt"}',
        '{ "rep": 0 , "type":   "wizard", "extra": [1,2,3] }',
    ],
)
async def test_wizard_relayed_verbatim_to_other_only(tmp_path, raw):
    async with running_server(tmp_path) as (_server, url):
        async with connect(url) as a, connect(url) as b:
            await _drain_status(a, expect=1)  # initial snapshot
            await _drain_status(b, expect=1)
            await _hello(a, "cockpit")
            await _hello(b, "copilot")
            await _drain_status(a, expect=1)  # hello -> one more status
            await _drain_status(b, expect=1)

            await a.send(raw)

            # B (the OTHER client) gets the byte-for-byte original message.
            got = await asyncio.wait_for(b.recv(), timeout=2.0)
            assert got == raw
            # A (the sender) is excluded from the fan-out.
            await _assert_silent(a)


async def test_trial_feedback_relayed_verbatim_to_other_only(tmp_path):
    raw = '{"type":"trialFeedback","action":"success","at":1234567}'
    async with running_server(tmp_path) as (_server, url):
        async with connect(url) as a, connect(url) as b:
            await _drain_status(a, expect=1)
            await _drain_status(b, expect=1)
            await _hello(a, "copilot")   # any device -> host
            await _hello(b, "cockpit")
            await _drain_status(a, expect=1)
            await _drain_status(b, expect=1)

            await a.send(raw)

            got = await asyncio.wait_for(b.recv(), timeout=2.0)
            assert got == raw
            await _assert_silent(a)


async def test_relay_reaches_all_other_clients(tmp_path):
    """With three clients, a relay from one reaches BOTH others (and not self)."""
    raw = '{"type":"wizard","phase":"confirm"}'
    async with running_server(tmp_path) as (_server, url):
        async with connect(url) as a, connect(url) as b, connect(url) as c:
            for ws in (a, b, c):
                await _drain_status(ws, expect=1)
            for ws, kind in ((a, "cockpit"), (b, "copilot"), (c, "copilot")):
                await _hello(ws, kind)
                await _drain_status(ws, expect=1)

            await a.send(raw)

            assert await asyncio.wait_for(b.recv(), timeout=2.0) == raw
            assert await asyncio.wait_for(c.recv(), timeout=2.0) == raw
            await _assert_silent(a)


async def test_relay_does_not_require_hello(tmp_path):
    """The relay is independent of hello: a client that never said hello still
    receives a peer's relayed message (kind defaults to ``unknown``)."""
    raw = '{"type":"wizard","x":1}'
    async with running_server(tmp_path) as (server, url):
        async with connect(url) as a, connect(url) as b:
            await _drain_status(a, expect=1)
            await _drain_status(b, expect=1)
            # Only A says hello; B never does.
            await _hello(a, "cockpit")
            await _drain_status(a, expect=1)

            await a.send(raw)
            assert await asyncio.wait_for(b.recv(), timeout=2.0) == raw
            await _assert_silent(a)


async def test_unknown_control_type_still_errors(tmp_path):
    """Unknown control types are NOT relayed; the existing error is returned to
    the sender (and peers stay silent)."""
    async with running_server(tmp_path) as (_server, url):
        async with connect(url) as a, connect(url) as b:
            await _drain_status(a, expect=1)
            await _drain_status(b, expect=1)

            await a.send(json.dumps({"type": "totally_unknown"}))

            err = json.loads(await asyncio.wait_for(a.recv(), timeout=2.0))
            assert err["type"] == "error"
            assert "unknown control type" in err["message"]
            # An unknown type must never fan out to peers.
            await _assert_silent(b)


async def test_hello_kind_recorded_and_cleaned_up(tmp_path):
    """The hello ``client`` kind is stored per connection (diagnostics/routing)
    and removed on disconnect -- the map must not leak."""
    async with running_server(tmp_path) as (server, url):
        async with connect(url) as a:
            await _drain_status(a, expect=1)
            await _hello(a, "cockpit")
            await _drain_status(a, expect=1)
            # Exactly one connection, recorded as the declared kind.
            assert list(server._client_kinds.values()) == ["cockpit"]

            # A hello with no "client" field defaults to "unknown".
            async with connect(url) as b:
                await _drain_status(b, expect=1)
                await b.send(json.dumps({"type": "hello"}))
                await _drain_status(b, expect=1)
                assert sorted(server._client_kinds.values()) == ["cockpit", "unknown"]

        # Both clients gone -> the kind map is empty (no leak).
        for _ in range(50):
            if not server._client_kinds:
                break
            await asyncio.sleep(0.02)
        assert server._client_kinds == {}
