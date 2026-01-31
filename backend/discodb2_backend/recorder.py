"""Lossless record-to-disk in candump ``-l`` format (DESIGN.md §4.2, §4.4).

Frames are appended to a ``.log`` file as they stream, with MONOTONIC µs
timestamps (never wall clock). The same files are read back by the ``replay``
source, so record -> replay is a lossless round-trip through the identical
stream path.

The recorder is synchronous and line-buffered: each frame is one ``write`` of a
short line. That is cheap enough for a CAN bus (a few thousand frames/s of
~40-byte lines) and keeps the on-disk file valid even if the process is killed
mid-session (no batching to lose).
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass
from typing import Optional

from .candump_log import format_line
from .protocol import Frame

# candump default extension; canplayer/SavvyCAN expect this.
LOG_SUFFIX = ".log"
_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_name(name: str) -> str:
    """Strip path separators / odd chars from a client-supplied record name."""
    cleaned = _SAFE_NAME_RE.sub("_", name.strip()).strip("._-")
    return cleaned or "capture"


@dataclass(slots=True)
class RecordInfo:
    active: bool = False
    file: Optional[str] = None  # absolute path
    name: Optional[str] = None  # basename
    frames: int = 0
    size: int = 0  # bytes written so far


class Recorder:
    """Appends streamed frames to a candump ``-l`` log file."""

    def __init__(self, record_dir: str) -> None:
        self.record_dir = os.path.abspath(record_dir)
        os.makedirs(self.record_dir, exist_ok=True)
        self._fh = None
        self.info = RecordInfo()

    @property
    def active(self) -> bool:
        return self._fh is not None

    def start(self, name: Optional[str] = None, iface: str = "can0") -> RecordInfo:
        """Begin a new recording. Stops any in-progress one first."""
        self.stop()
        base = _safe_name(name) if name else time.strftime("capture_%Y%m%d_%H%M%S")
        if not base.endswith(LOG_SUFFIX):
            base += LOG_SUFFIX
        path = os.path.join(self.record_dir, base)
        # Avoid clobbering an existing capture of the same name.
        path = _unique_path(path)
        self._iface = iface
        # Line-buffered text append.
        self._fh = open(path, "a", buffering=1, encoding="utf-8")
        self.info = RecordInfo(active=True, file=path, name=os.path.basename(path), frames=0, size=0)
        return self.info

    def write(self, frame: Frame) -> None:
        """Append one frame. No-op if not recording."""
        if self._fh is None:
            return
        line = format_line(
            frame.t_us,
            frame.can_id,
            frame.data,
            dlc=frame.dlc,
            is_extended=frame.is_extended,
            is_rtr=frame.is_rtr,
            iface=self._iface,
        )
        self._fh.write(line + "\n")
        self.info.frames += 1
        self.info.size += len(line) + 1

    def stop(self) -> Optional[RecordInfo]:
        """Close the current recording; returns its final info (or None)."""
        if self._fh is None:
            return None
        try:
            self._fh.flush()
            os.fsync(self._fh.fileno())
        except (OSError, ValueError):
            pass
        try:
            self._fh.close()
        finally:
            self._fh = None
        done = self.info
        self.info = RecordInfo()
        return done

    def list_files(self) -> list[dict]:
        """List recorded ``.log`` files in the record dir, newest first."""
        out = []
        try:
            names = os.listdir(self.record_dir)
        except OSError:
            return out
        for n in names:
            if not n.endswith(LOG_SUFFIX):
                continue
            full = os.path.join(self.record_dir, n)
            try:
                st = os.stat(full)
            except OSError:
                continue
            out.append({"name": n, "size": st.st_size, "mtime": int(st.st_mtime)})
        out.sort(key=lambda d: d["mtime"], reverse=True)
        return out


def _unique_path(path: str) -> str:
    if not os.path.exists(path):
        return path
    root, ext = os.path.splitext(path)
    i = 1
    while True:
        candidate = f"{root}_{i}{ext}"
        if not os.path.exists(candidate):
            return candidate
        i += 1


def disk_free(path: str) -> int:
    """Free bytes on the filesystem holding ``path`` (0 if unknown)."""
    try:
        st = os.statvfs(path)
        return st.f_bavail * st.f_frsize
    except (OSError, AttributeError):  # AttributeError: no statvfs (Windows)
        return 0
