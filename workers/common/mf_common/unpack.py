"""``unpack``: the demos inside a ``.zip`` or ``.rar`` (how HLTV ships them), next to the archive.

Only demo files are taken out, each under its own file name (folders inside the archive are
dropped, so nothing lands outside the target folder), and never more than ``MAX_TOTAL_BYTES``.
``.zip`` uses Python's zipfile. ``.rar`` needs bsdtar (Windows 10 and 11 ship it as ``tar.exe``;
it reads RAR5 on Windows 11), else the demos have to be taken out by hand.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from . import errors
from .emit import Emitter

DEMO_RE = re.compile(r"\.(dem|dem\.gz|dem\.bz2|dem\.zst)$", re.IGNORECASE)
MAX_TOTAL_BYTES = 16 * 1024**3


def _target(out_dir: Path, member: str, taken: set[str]) -> Path:
    name = re.sub(r"[^A-Za-z0-9._ -]", "_", member.replace("\\", "/").rsplit("/", 1)[-1]).strip() or "demo.dem"
    base, n = name, 1
    while name.lower() in taken or (out_dir / name).exists():
        n += 1
        stem, _, ext = base.partition(".")
        name = f"{stem}-{n}.{ext}"
    taken.add(name.lower())
    return out_dir / name


def _bsdtar() -> str | None:
    for cand in ("bsdtar", "tar"):
        exe = shutil.which(cand)
        if not exe:
            continue
        try:
            v = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=10).stdout
        except (OSError, subprocess.SubprocessError):
            continue
        if "bsdtar" in v:
            return exe
    return None


def unpack_archive(archive: Path, out_dir: Path, emitter: Emitter) -> dict[str, Any]:
    archive = Path(archive)
    if not archive.is_file():
        raise errors.MfError(errors.INPUT_NOT_FOUND, "archive not found", input=str(archive))
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    taken: set[str] = set()
    written: list[str] = []
    kind = archive.suffix.lower()
    if kind == ".zip":
        try:
            zf = zipfile.ZipFile(archive)
        except zipfile.BadZipFile as exc:
            raise errors.MfError(errors.INPUT_UNREADABLE, f"not a readable zip: {exc}") from exc
        with zf:
            members = [m for m in zf.infolist() if not m.is_dir() and DEMO_RE.search(m.filename)]
            if sum(m.file_size for m in members) > MAX_TOTAL_BYTES:
                raise errors.MfError(errors.INPUT_UNREADABLE, "the demos in this archive are larger than 16 GB")
            for i, m in enumerate(members):
                dst = _target(out_dir, m.filename, taken)
                tmp = dst.with_name(dst.name + ".part")
                with zf.open(m) as src, tmp.open("wb") as fh:
                    shutil.copyfileobj(src, fh, 1 << 20)
                tmp.replace(dst)
                written.append(str(dst))
                emitter.progress("unpack", round((i + 1) / len(members), 3), file=dst.name)
    elif kind == ".rar":
        tar = _bsdtar()
        if not tar:
            raise errors.MfError(errors.ARCHIVE_UNSUPPORTED, "this computer can't open .rar files here: take the .dem files out with Windows File Explorer or 7-Zip and drop those in")
        with tempfile.TemporaryDirectory(dir=out_dir, prefix=".unpack-") as tmpd:
            # bsdtar refuses absolute paths and ".." in member names when extracting.
            r = subprocess.run([tar, "-xf", str(archive), "-C", tmpd], capture_output=True, text=True, timeout=3600)
            if r.returncode != 0:
                raise errors.MfError(errors.ARCHIVE_UNSUPPORTED, f"could not open the .rar: {(r.stderr or r.stdout).strip()[:300]}")
            found = [p for p in Path(tmpd).rglob("*") if p.is_file() and not p.is_symlink() and DEMO_RE.search(p.name)]
            if sum(p.stat().st_size for p in found) > MAX_TOTAL_BYTES:
                raise errors.MfError(errors.INPUT_UNREADABLE, "the demos in this archive are larger than 16 GB")
            for i, p in enumerate(found):
                dst = _target(out_dir, p.name, taken)
                shutil.move(str(p), dst)
                written.append(str(dst))
                emitter.progress("unpack", round((i + 1) / len(found), 3), file=dst.name)
    else:
        raise errors.MfError(errors.ARCHIVE_UNSUPPORTED, f"not a .zip or .rar: {archive.name}")
    if not written:
        raise errors.MfError(errors.EMPTY_PARSE, "no demo files in the archive", input=str(archive))
    return {"status": "unpacked", "files": written, "archive": str(archive)}
