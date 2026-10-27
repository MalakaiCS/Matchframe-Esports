"""``hash`` and ``inspect``: cheap pre-flight commands used by the engine before queueing a parse."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from mf_common import errors
from mf_common.emit import Emitter
from mf_common.fsutil import sha256_file

from .adapter import ParserAdapter, get_adapter, sniff_format
from .events import identity_coverage, normalize_events
from .extract import _guard, compatibility_notes


def _require_file(path: Path) -> int:
    if not path.is_file():
        raise errors.MfError(errors.INPUT_NOT_FOUND, f"input not found: {path}", path=str(path))
    size = path.stat().st_size
    if size == 0:
        raise errors.MfError(errors.INPUT_UNREADABLE, "input file is empty", path=str(path))
    return size


def hash_file(path: Path, emitter: Emitter) -> dict[str, Any]:
    size = _require_file(path)
    emitter.progress("hashing", 0.0, bytes=size)
    return {"path": str(path), "sha256": sha256_file(path), "size_bytes": size, "format": sniff_format(path)}


def inspect_demo(path: Path, emitter: Emitter, adapter: ParserAdapter | None = None) -> dict[str, Any]:
    size = _require_file(path)
    fmt = sniff_format(path)
    if fmt != "cs2":
        raise errors.MfError(errors.UNSUPPORTED_FORMAT, f"not a CS2 demo (detected: {fmt})", detected=fmt)
    adapter = adapter or get_adapter()
    demo = _guard("open", adapter.open, path)
    header = _guard("header", demo.header)
    events = _guard("event_list", demo.event_names)
    emitter.progress("probe_events", 0.3)
    probe = _guard("events", demo.events, [e for e in ("player_death", "player_hurt", "weapon_fire", "player_blind") if e in events])
    coverage = identity_coverage(normalize_events(probe))
    emitter.progress("probe_grenades", 0.6)
    grenades = _guard("grenades", demo.grenades, [])
    classes = {str(k): int(v) for k, v in grenades.group_by("raw_class").len().sort("raw_class").iter_rows()} if grenades.height else {}
    return {
        "path": str(path),
        "size_bytes": size,
        "format": fmt,
        "parser": {"name": adapter.name, "version": adapter.version},
        "header": {
            "map_name": header.map_name,
            "build": header.build,
            "server_name": header.server_name,
            "demo_version_name": header.demo_version_name,
            "recorded_by_sourcetv": header.recorded_by_sourcetv,
        },
        "events": events,
        "event_counts": {k: v.height for k, v in probe.items()},
        "identity_coverage": coverage,
        "grenade_entity_classes": classes,
        "compatibility_notes": compatibility_notes(events, classes, coverage, [], demo.notes.discarded_float_steamids),
    }
