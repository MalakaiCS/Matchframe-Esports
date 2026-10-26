"""JSON-lines protocol used by every CLI command.

Each stdout line is one JSON object with a ``type`` of ``progress``, ``warning``, ``result`` or
``error``. Exactly one ``result`` or ``error`` line terminates a command. Human-oriented logging
never goes to stdout (the TypeScript engine parses it line by line).
"""

from __future__ import annotations

import json
import math
import sys
import time
from typing import Any, TextIO


def _default(value: Any) -> Any:
    """JSON fallback for numpy scalars, paths and sets."""
    if hasattr(value, "item"):
        return value.item()
    if isinstance(value, set | frozenset):
        return sorted(value)
    return str(value)


def _sanitize(value: Any) -> Any:
    """Replace non-finite floats (not valid JSON) with null, recursively."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: _sanitize(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_sanitize(v) for v in value]
    if hasattr(value, "item") and not isinstance(value, str | bytes):
        try:
            return _sanitize(value.item())
        except (ValueError, AttributeError):
            return value
    return value


def dumps(obj: Any, *, indent: int | None = None) -> str:
    """Strict JSON serialization (no NaN/Infinity) shared by all writers."""
    return json.dumps(_sanitize(obj), default=_default, allow_nan=False, indent=indent, ensure_ascii=False)


class Emitter:
    """Writes protocol lines for one command invocation."""

    def __init__(self, command: str, stream: TextIO | None = None) -> None:
        self.command = command
        self.stream = stream if stream is not None else sys.stdout
        self._t0 = time.monotonic()

    def _write(self, kind: str, payload: dict[str, Any]) -> None:
        line = {"type": kind, "command": self.command, "elapsed_s": round(time.monotonic() - self._t0, 3)}
        line.update(payload)
        self.stream.write(dumps(line) + "\n")
        self.stream.flush()

    def progress(self, stage: str, fraction: float | None = None, **fields: Any) -> None:
        self._write("progress", {"stage": stage, "fraction": fraction, **fields})

    def warning(self, code: str, message: str, **fields: Any) -> None:
        self._write("warning", {"code": code, "message": message, **fields})

    def result(self, payload: dict[str, Any]) -> None:
        self._write("result", payload)

    def error(self, code: str, message: str, **details: Any) -> None:
        self._write("error", {"code": code, "message": message, "details": details})


class NullEmitter(Emitter):
    """Emitter that discards everything (library use and tests)."""

    def __init__(self) -> None:
        super().__init__("null")

    def _write(self, kind: str, payload: dict[str, Any]) -> None:  # noqa: D102
        return None
