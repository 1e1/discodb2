"""Stream engine: source -> reader thread -> batcher -> clients (+ recorder).

This owns the hardware lifecycle and the hot path. Design:

  * A blocking adapter ``recv()`` runs in a dedicated DAEMON THREAD so it never
    stalls the asyncio loop. The thread pushes :class:`Frame` objects onto a
    thread-safe ``queue.Queue``.
  * An asyncio BATCHER task drains the queue every ``batch_ms`` (DESIGN.md §3.2
    ~20-50 ms), encodes ONE binary batch, hands frames to the recorder, and
    broadcasts the batch to all subscribed clients.
  * Per-client send queues are bounded; on overflow we DROP whole batches for
    that client (and count it in stream.dropped) rather than let a slow copilot
    phone back up the whole pipeline. The binary stream is the hot path -- a lost
    batch is acceptable, head-of-line blocking is not.

Timestamps are always backend monotonic µs (the reader stamps live frames on
arrival; replay supplies its own monotonic µs). listen-only is enforced in the
adapter layer (:func:`adapters.open_bus`).
"""

from __future__ import annotations

import asyncio
import queue
import threading
from dataclasses import dataclass
from typing import Awaitable, Callable, Optional

from . import adapters
from .clock import now_us
from .protocol import (
    CAN_ID_MASK,
    Frame,
    encode_batch,
)
from .recorder import Recorder, disk_free
from .stats import BusStats, StreamStats

# Max batches buffered per client before we start dropping for that client.
CLIENT_QUEUE_MAX = 64
# How long the reader thread blocks in one recv() call.
RECV_TIMEOUT_S = 0.25


@dataclass(slots=True)
class SourceState:
    source: str = ""
    bitrate: int = 0
    listen_only: bool = True
    file: Optional[str] = None
    running: bool = False


class _Client:
    """One subscribed WebSocket client's outgoing binary batch queue."""

    __slots__ = ("queue", "name")

    def __init__(self, name: str = "?") -> None:
        self.queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=CLIENT_QUEUE_MAX)
        self.name = name


class Engine:
    def __init__(self, loop: asyncio.AbstractEventLoop, *, batch_ms: int, record_dir: str,
                 replay_realtime: bool = True, sim_seed: Optional[int] = None,
                 sim_profile: str = "realistic") -> None:
        self._loop = loop
        self._batch_ms = max(batch_ms, 1)
        self._replay_realtime = replay_realtime
        self._sim_seed = sim_seed
        self._sim_profile = sim_profile

        self._bus: Optional[adapters.CanBus] = None
        self.state = SourceState()
        self._is_replay_source = False

        # reader thread -> this queue -> batcher task
        self._frame_q: "queue.Queue[Frame]" = queue.Queue(maxsize=100_000)
        self._reader_thread: Optional[threading.Thread] = None
        self._reader_stop = threading.Event()
        self._batcher_task: Optional[asyncio.Task] = None

        self._clients: set[_Client] = set()
        self.bus_stats = BusStats()
        self.stream_stats = StreamStats()
        self.recorder = Recorder(record_dir)

        self._started_us = now_us()
        self._reader_q_depth = 0  # snapshot for health

    # --- client subscription ------------------------------------------------
    def add_client(self, name: str = "?") -> _Client:
        client = _Client(name)
        self._clients.add(client)
        return client

    def remove_client(self, client: _Client) -> None:
        self._clients.discard(client)

    @property
    def client_count(self) -> int:
        return len(self._clients)

    # --- source lifecycle ---------------------------------------------------
    def start(self, source: str, *, bitrate: int = 500000, listen_only: bool = True,
              file: Optional[str] = None, channel: Optional[str] = None, index: int = 0) -> SourceState:
        """Open ``source`` and begin streaming. Stops any current source first."""
        self.stop()
        effective_lo = adapters.clamp_listen_only(source, listen_only)
        bus = adapters.open_bus(
            source,
            bitrate=bitrate,
            listen_only=effective_lo,
            file=file,
            channel=channel,
            index=index,
            realtime=self._replay_realtime,
            sim_seed=self._sim_seed,
            sim_profile=self._sim_profile,
        )
        self._bus = bus
        self._is_replay_source = bool(getattr(bus, "is_replay", False))
        self.state = SourceState(
            source=source,
            bitrate=bitrate,
            listen_only=effective_lo,
            file=file,
            running=True,
        )
        self.bus_stats.start(bitrate, "REPLAY" if self._is_replay_source else "LIVE")

        self._reader_stop.clear()
        self._reader_thread = threading.Thread(
            target=self._reader_loop, args=(bus,), name="can-reader", daemon=True
        )
        self._reader_thread.start()
        self._batcher_task = self._loop.create_task(self._batcher_loop())
        return self.state

    def stop(self) -> None:
        """Stop streaming and release the source. Safe to call when idle."""
        self._reader_stop.set()
        if self._batcher_task is not None:
            self._batcher_task.cancel()
            self._batcher_task = None
        if self._reader_thread is not None:
            self._reader_thread.join(timeout=2.0)
            self._reader_thread = None
        if self._bus is not None:
            try:
                self._bus.shutdown()
            except Exception:
                pass
            self._bus = None
        # Drain any leftover frames.
        self._drain_queue_nowait()
        self.bus_stats.stop()
        self.state.running = False

    def _drain_queue_nowait(self) -> None:
        try:
            while True:
                self._frame_q.get_nowait()
        except queue.Empty:
            pass

    # --- reader thread ------------------------------------------------------
    def _reader_loop(self, bus: adapters.CanBus) -> None:
        """Blocking recv loop. Stamps live frames with monotonic µs on arrival."""
        stop = self._reader_stop
        q = self._frame_q
        while not stop.is_set():
            try:
                msg = bus.recv(timeout=RECV_TIMEOUT_S)
            except Exception:
                # An adapter blowing up shouldn't take the process down; mark the
                # bus errored and keep looping so stop() can join cleanly.
                self.bus_stats.state = "ERROR"
                stop.wait(RECV_TIMEOUT_S)
                continue
            if msg is None:
                continue
            t_us = msg.timestamp_us if msg.timestamp_us is not None else now_us()
            frame = Frame(
                t_us=t_us,
                can_id=msg.arbitration_id & CAN_ID_MASK,
                dlc=msg.dlc,
                data=msg.data,
                is_extended=msg.is_extended,
                is_error=msg.is_error,
                is_rtr=msg.is_rtr,
            )
            try:
                q.put_nowait(frame)
            except queue.Full:
                # Backend-side overflow (consumer far behind). Count as a drop.
                self.stream_stats.record_drop()

    # --- batcher task -------------------------------------------------------
    async def _batcher_loop(self) -> None:
        """Coalesce frames into ~batch_ms binary batches and broadcast them."""
        interval = self._batch_ms / 1000.0
        q = self._frame_q
        try:
            while True:
                await asyncio.sleep(interval)
                frames = self._drain_frames(q)
                self._reader_q_depth = q.qsize()
                if not frames:
                    continue
                # Stats + recording on the drained frames.
                for f in frames:
                    self.bus_stats.record_frame(f.can_id, f.dlc, f.is_error, f.is_extended)
                    self.recorder.write(f)
                base = frames[0].t_us
                payload = encode_batch(frames, base, replay=self._is_replay_source)
                self._broadcast(payload)
        except asyncio.CancelledError:
            raise

    @staticmethod
    def _drain_frames(q: "queue.Queue[Frame]") -> list[Frame]:
        out: list[Frame] = []
        try:
            while True:
                out.append(q.get_nowait())
        except queue.Empty:
            pass
        return out

    def _broadcast(self, payload: bytes) -> None:
        """Enqueue ``payload`` to every client; drop for any whose queue is full."""
        n = len(payload)
        any_sent = False
        for client in self._clients:
            try:
                client.queue.put_nowait(payload)
                any_sent = True
            except asyncio.QueueFull:
                # Slow client: drop this batch for them only.
                self.stream_stats.record_drop()
        if any_sent:
            # out_bps is measured once per broadcast (per-client fan-out byte
            # accounting is approximated by the single batch size).
            self.stream_stats.record_out(n)

    # --- recording proxies --------------------------------------------------
    def record_start(self, name: Optional[str] = None):
        iface = self.state.source or "can0"
        return self.recorder.start(name=name, iface=iface)

    def record_stop(self):
        return self.recorder.stop()

    # --- health snapshot ----------------------------------------------------
    def health(self) -> dict:
        """Build the §3.4 health payload."""
        bs = self.bus_stats
        ss = self.stream_stats
        rec = self.recorder.info
        return {
            "uptime_s": int((now_us() - self._started_us) / 1_000_000),
            "source": self.state.source or None,
            "listen_only": self.state.listen_only,
            "recording": rec.name if rec.active else None,
            "bus": {
                "bitrate": bs.bitrate,
                "state": bs.state,
                "fps": bs.fps(),
                "fps_avg": bs.fps_avg(),
                "total": bs.total,
                "unique_ids": bs.unique_ids,
                "errors": bs.errors,
                "last_frame_ms": bs.last_frame_ms(),
                "bus_load": round(bs.bus_load(), 4),
            },
            "stream": {
                "clients": self.client_count,
                "out_bps": ss.out_bps(),
                "dropped": ss.dropped,
            },
            "record": {
                "active": rec.active,
                "file": rec.file,
                "size": rec.size,
                "disk_free": disk_free(self.recorder.record_dir),
            },
            "proc": _proc_stats(self._reader_q_depth, self._total_ws_q()),
        }

    def _total_ws_q(self) -> int:
        return sum(c.queue.qsize() for c in self._clients)


def _proc_stats(reader_q: int, ws_q: int) -> dict:
    """CPU/RSS via psutil if present; degrade gracefully on the Pi/sandbox."""
    cpu = 0.0
    rss = 0
    try:
        import psutil  # optional, not in the lean dep set

        p = psutil.Process()
        cpu = float(p.cpu_percent(interval=None))
        rss = int(p.memory_info().rss)
    except Exception:
        # Fallback: RSS from resource (ru_maxrss), CPU left at 0.
        try:
            import resource
            import sys

            maxrss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            # Linux reports kB, macOS reports bytes.
            rss = maxrss * 1024 if sys.platform.startswith("linux") else maxrss
        except Exception:
            rss = 0
    return {"cpu": round(cpu, 1), "rss": rss, "reader_q": reader_q, "ws_q": ws_q}
