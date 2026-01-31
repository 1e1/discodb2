"""Plain-text health log to stdout (DESIGN.md §6: TTY periodic lines, no TUI).

Emits one line every ``interval_s``. On a TTY it prints a compact human line; on
a non-TTY (pipe, journald, Docker logs) it prints a ``key=value`` structured
line that is trivial to grep/parse. No curses, no TUI -- safe under systemd.
"""

from __future__ import annotations

import sys
from typing import Callable


def _human_line(h: dict) -> str:
    bus = h["bus"]
    stream = h["stream"]
    rec = h["record"]
    src = h["source"] or "-"
    recording = h["recording"] or "-"
    return (
        f"[{h['uptime_s']:>6}s] src={src:<9} {bus['state']:<6} "
        f"fps={bus['fps']:>5} avg={bus['fps_avg']:>5} total={bus['total']:>8} "
        f"ids={bus['unique_ids']:>4} err={bus['errors']:>4} "
        f"load={bus['bus_load']*100:5.1f}% "
        f"clients={stream['clients']} out={stream['out_bps']//1000:>5}kbps "
        f"drop={stream['dropped']} rec={recording}"
    )


def _structured_line(h: dict) -> str:
    bus = h["bus"]
    stream = h["stream"]
    rec = h["record"]
    proc = h["proc"]
    parts = [
        f"uptime_s={h['uptime_s']}",
        f"source={h['source']}",
        f"listen_only={str(h['listen_only']).lower()}",
        f"state={bus['state']}",
        f"fps={bus['fps']}",
        f"fps_avg={bus['fps_avg']}",
        f"total={bus['total']}",
        f"unique_ids={bus['unique_ids']}",
        f"errors={bus['errors']}",
        f"last_frame_ms={bus['last_frame_ms']}",
        f"bus_load={bus['bus_load']}",
        f"clients={stream['clients']}",
        f"out_bps={stream['out_bps']}",
        f"dropped={stream['dropped']}",
        f"rec_active={str(rec['active']).lower()}",
        f"rec_file={rec['file']}",
        f"reader_q={proc['reader_q']}",
        f"ws_q={proc['ws_q']}",
        f"cpu={proc['cpu']}",
        f"rss={proc['rss']}",
    ]
    return "health " + " ".join(parts)


def format_health_line(h: dict, *, is_tty: bool) -> str:
    return _human_line(h) if is_tty else _structured_line(h)


def make_logger(snapshot: Callable[[], dict], stream=None) -> Callable[[], None]:
    """Return a zero-arg callable that prints one health line when invoked."""
    out = stream if stream is not None else sys.stdout
    is_tty = bool(getattr(out, "isatty", lambda: False)())

    def emit() -> None:
        line = format_health_line(snapshot(), is_tty=is_tty)
        print(line, file=out, flush=True)

    return emit
