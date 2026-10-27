"""Filesystem helpers: hashing, durable writes, atomic directory commit."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .emit import dumps

CHUNK = 4 * 1024 * 1024


def utc_now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            block = fh.read(CHUNK)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json(obj: Any) -> str:
    """Deterministic JSON used for content hashes (sorted keys, no whitespace)."""
    return json.dumps(json.loads(dumps(obj)), sort_keys=True, separators=(",", ":"))


def dir_size(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += (Path(root) / name).stat().st_size
            except FileNotFoundError:
                continue
    return total


def fsync_path(path: Path) -> None:
    """fsync a file or directory (best effort on platforms without directory fsync)."""
    flags = os.O_RDONLY
    if path.is_dir():
        flags |= getattr(os, "O_DIRECTORY", 0)
    try:
        fd = os.open(path, flags)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def write_text_atomic(path: Path, text: str) -> None:
    """Write text via a temp file in the same directory + rename, so readers never see partial files."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with tmp.open("w", encoding="utf-8") as fh:
            fh.write(text)
            if not text.endswith("\n"):
                fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()
    fsync_path(path.parent)


def write_json_atomic(path: Path, obj: Any, *, indent: int | None = 2) -> None:
    """Atomically write strict JSON (see :func:`write_text_atomic`)."""
    write_text_atomic(path, dumps(obj, indent=indent))


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


@contextmanager
def staging_directory(root: Path, label: str) -> Iterator[Path]:
    """Create a hidden staging directory under ``root/.staging`` that is removed unless committed.

    The staging area lives on the same filesystem as the final location so the commit is a single
    atomic ``rename``. Dataset discovery never looks inside ``.staging``.
    """
    staging_root = root / ".staging"
    staging_root.mkdir(parents=True, exist_ok=True)
    path = staging_root / f"{label}-{uuid.uuid4().hex[:12]}"
    path.mkdir()
    try:
        yield path
    finally:
        if path.exists():
            shutil.rmtree(path, ignore_errors=True)


class CommitConflict(Exception):
    """The final directory already exists (possibly created concurrently)."""


def commit_directory(staging: Path, final: Path) -> None:
    """Atomically publish ``staging`` as ``final``.

    All files are fsynced first; then a single ``os.rename`` makes the complete directory visible.
    Raises :class:`CommitConflict` if ``final`` already exists (never merges or overwrites).
    """
    for child in staging.rglob("*"):
        if child.is_file():
            fsync_path(child)
    fsync_path(staging)
    final.parent.mkdir(parents=True, exist_ok=True)
    if final.exists():
        raise CommitConflict(str(final))
    try:
        os.rename(staging, final)
    except OSError as exc:  # ENOTEMPTY / EEXIST when a concurrent commit won the race
        if final.exists():
            raise CommitConflict(str(final)) from exc
        raise
    fsync_path(final.parent)
