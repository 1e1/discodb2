"""WebSocket server: one socket carries binary stream + JSON control (§3.1-3.4).

A single ``websockets`` server:
  * Upgrades ``ws://<host>:<port><ws_path>`` (default ``/ws``) to a WebSocket.
    On that socket, **binary** messages are the CAN frame stream (server->client)
    and **text** messages are JSON control (client->server) / status
    (server->client) -- §3.1.
  * Serves ``GET /health`` as JSON via the ``process_request`` HTTP hook, before
    any upgrade -- §3.4.

Per connection we run two coroutines: a *reader* (handles inbound JSON control)
and a *writer* (pumps the engine's per-client binary batch queue out the wire).
Status frames (health snapshots, file lists, errors) are sent as JSON text.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional

import websockets
from websockets.asyncio.server import ServerConnection, serve
from websockets.datastructures import Headers
from websockets.http11 import Request, Response

from . import adapters
from .config import Config
from .engine import Engine

log = logging.getLogger("discodb2.server")


class Server:
    def __init__(self, config: Config) -> None:
        self.config = config
        self._engine: Optional[Engine] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._ws_server = None
        # Declared "client" kind (cockpit|copilot|...) per live connection, set
        # from the hello message. Diagnostics/routing only -- the relay itself
        # never reads it. Keyed by the ServerConnection so it survives the whole
        # connection, and is cleaned up on disconnect (see _handle's finally).
        self._client_kinds: dict[ServerConnection, str] = {}

    # --- HTTP /health hook --------------------------------------------------
    def _process_request(self, connection: ServerConnection, request: Request) -> Optional[Response]:
        # Strip query string for routing.
        path = request.path.split("?", 1)[0]
        if path == "/health":
            body = json.dumps(self._engine.health()).encode("utf-8")
            # Build the Response with FRESH headers; reusing connection.respond()'s
            # headers would leave its default text/plain Content-Type and a
            # Content-Length: 0, producing duplicate (and wrong) headers.
            headers = Headers()
            headers["Content-Type"] = "application/json"
            headers["Content-Length"] = str(len(body))
            return Response(200, "OK", headers, body)
        if path == self.config.ws_path:
            return None  # proceed to WebSocket upgrade
        return connection.respond(404, "not found\n")

    # --- per-connection handler --------------------------------------------
    async def _handle(self, ws: ServerConnection) -> None:
        engine = self._engine
        assert engine is not None
        client = engine.add_client()
        log.info("client connected (%d total)", engine.client_count)
        # Send an initial status snapshot so the client sees current state.
        await self._send_status(ws, engine)
        writer = asyncio.create_task(self._writer(ws, client))
        try:
            await self._reader(ws, engine, client)
        finally:
            writer.cancel()
            engine.remove_client(client)
            # Drop the per-connection kind so the map cannot leak across the
            # server's lifetime (pop is a no-op if hello was never sent).
            self._client_kinds.pop(ws, None)
            log.info("client disconnected (%d total)", engine.client_count)

    async def _writer(self, ws: ServerConnection, client) -> None:
        """Pump binary batches from the client's queue to the socket."""
        try:
            while True:
                payload = await client.queue.get()
                await ws.send(payload)  # bytes -> binary frame
        except (asyncio.CancelledError, websockets.exceptions.ConnectionClosed):
            return

    async def _reader(self, ws: ServerConnection, engine: Engine, client) -> None:
        """Handle inbound JSON control messages (text frames)."""
        async for message in ws:
            if isinstance(message, (bytes, bytearray)):
                # Clients never send binary; ignore (could be a stray ping payload).
                continue
            await self._handle_control(ws, engine, message)

    async def _handle_control(self, ws: ServerConnection, engine: Engine, raw: str) -> None:
        try:
            msg = json.loads(raw)
            if not isinstance(msg, dict):
                raise ValueError("control message must be a JSON object")
            mtype = msg.get("type")
        except (json.JSONDecodeError, ValueError) as exc:
            await self._send_error(ws, f"bad control message: {exc}")
            return

        try:
            if mtype == "hello":
                # Record the declared client kind (cockpit|copilot|...). Accept
                # any string; default "unknown". For diagnostics/routing only --
                # the relay never interprets it. No other behavioural change.
                kind = msg.get("client")
                self._client_kinds[ws] = str(kind) if kind is not None else "unknown"
                await self._send_status(ws, engine)

            elif mtype == "wizard" or mtype == "trialFeedback":
                # Wizard relay (§3.3): fan the RAW original message out verbatim
                # to every OTHER client. The backend never parses/validates the
                # payload beyond the "type" already read above (zero compute --
                # safe on a Pi 1).
                await self.relay_to_others(ws, raw)

            elif mtype == "start":
                source = str(msg.get("source", "")).lower()
                if source not in adapters.ALL_SOURCES:
                    raise ValueError(
                        f"unknown source {source!r}; expected one of {sorted(adapters.ALL_SOURCES)}"
                    )
                requested_lo = bool(msg.get("listen_only", True))
                effective_lo = adapters.clamp_listen_only(source, requested_lo)
                state = engine.start(
                    source,
                    bitrate=int(msg.get("bitrate", self.config.autostart_bitrate)),
                    listen_only=effective_lo,
                    file=msg.get("file"),
                    channel=msg.get("channel"),
                    index=int(msg.get("index", 0)),
                )
                if adapters.is_live_source(source) and requested_lo is False:
                    # Invariant 1: we clamped; tell the client we refused.
                    await self._send_error(
                        ws,
                        f"listen_only is enforced for live source '{source}'; "
                        "request to disable it was clamped to true.",
                    )
                # Broadcast so EVERY connected client reflects the new bus state
                # immediately (not just the one that changed it).
                await self.broadcast_status()

            elif mtype == "stop":
                engine.stop()
                await self.broadcast_status()

            elif mtype == "record_start":
                engine.record_start(name=msg.get("name"))
                await self.broadcast_status()

            elif mtype == "record_stop":
                engine.record_stop()
                await self.broadcast_status()

            elif mtype == "list_files":
                files = engine.recorder.list_files()
                await ws.send(json.dumps({"type": "files", "files": files}))

            else:
                await self._send_error(ws, f"unknown control type: {mtype!r}")
        except (ValueError, RuntimeError, FileNotFoundError) as exc:
            # Adapter/selection errors are reported to the client, never fatal.
            await self._send_error(ws, str(exc))

    async def _send_status(self, ws: ServerConnection, engine: Engine) -> None:
        payload = engine.health()
        payload["type"] = "status"
        try:
            await ws.send(json.dumps(payload))
        except websockets.exceptions.ConnectionClosed:
            pass

    async def _send_error(self, ws: ServerConnection, message: str) -> None:
        try:
            await ws.send(json.dumps({"type": "error", "message": message}))
        except websockets.exceptions.ConnectionClosed:
            pass

    # --- status broadcast (health pushed to all connected clients) ----------
    async def broadcast_status(self) -> None:
        engine = self._engine
        if engine is None:
            return
        payload = engine.health()
        payload["type"] = "status"
        text = json.dumps(payload)
        # Send over each connection. websockets tracks them; iterate a copy.
        if self._ws_server is None:
            return
        for conn in list(self._ws_server.connections):
            try:
                await conn.send(text)
            except websockets.exceptions.ConnectionClosed:
                pass

    # --- Wizard relay (fan raw control out verbatim, §3.3) ------------------
    async def relay_to_others(self, sender: ServerConnection, raw: str) -> None:
        """Send the RAW message ``raw`` verbatim to every connected client
        EXCEPT ``sender``.

        The payload is opaque: the caller has already read its ``type`` and we
        forward the original text untouched (no parse/validate/transform). A
        send to a peer that closed is swallowed (mirrors broadcast_status). The
        per-peer sends are dispatched concurrently and shielded from each other
        so one slow peer can never stall delivery to the rest of the fan-out.
        """
        if self._ws_server is None:
            return

        async def _send_one(conn: ServerConnection) -> None:
            try:
                await conn.send(raw)
            except websockets.exceptions.ConnectionClosed:
                pass

        # Snapshot the connection set and exclude the sender by identity.
        targets = [c for c in self._ws_server.connections if c is not sender]
        if not targets:
            return
        # gather(return_exceptions=True): a failure to one peer never aborts the
        # others, and a slow peer only delays its own coroutine, not the relay.
        await asyncio.gather(
            *(_send_one(c) for c in targets), return_exceptions=True
        )

    # --- lifecycle ----------------------------------------------------------
    async def serve_forever(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._engine = Engine(
            self._loop,
            batch_ms=self.config.batch_ms,
            record_dir=self.config.record_dir,
            replay_realtime=self.config.replay_realtime,
            sim_seed=self.config.sim_seed,
            sim_profile=self.config.sim_profile,
        )

        # Optional autostart for headless/Docker.
        if self.config.autostart_source:
            try:
                self._engine.start(
                    self.config.autostart_source,
                    bitrate=self.config.autostart_bitrate,
                    file=self.config.autostart_file or None,
                )
                log.info("autostarted source %s", self.config.autostart_source)
            except Exception as exc:
                log.error("autostart failed: %s", exc)

        async with serve(
            self._handle,
            self.config.host,
            self.config.port,
            process_request=self._process_request,
            # Binary CAN batches are small; keep default max_size. Disable
            # permessage-deflate: payloads are tiny binary, compression adds CPU
            # (matters on ARMv6) for little gain.
            compression=None,
        ) as server:
            self._ws_server = server
            log.info("listening on %s (health: http://%s:%d/health)",
                     self.config.ws_url, self.config.host, self.config.port)
            await self._status_and_health_loop()

    async def _status_and_health_loop(self) -> None:
        """Periodically log health to stdout and push status to clients."""
        from .healthlog import make_logger

        emit = make_logger(self._engine.health)
        interval = self.config.health_interval_s
        while True:
            await asyncio.sleep(interval)
            try:
                emit()
            except Exception:
                log.exception("health log failed")
            await self.broadcast_status()


async def run(config: Config) -> None:
    server = Server(config)
    await server.serve_forever()
