"""Process/runtime introspection: peak memory, git revision."""

from __future__ import annotations

import resource
import subprocess
import sys
from pathlib import Path


def peak_rss_mb(children: bool = False) -> float:
    """Peak resident set size in MiB (``ru_maxrss`` is KiB on Linux, bytes on macOS)."""
    who = resource.RUSAGE_CHILDREN if children else resource.RUSAGE_SELF
    raw = resource.getrusage(who).ru_maxrss
    divisor = 1024 * 1024 if sys.platform == "darwin" else 1024
    return round(raw / divisor, 1)


def git_commit(start: Path | None = None) -> str | None:
    """Current git commit of the repository containing ``start`` (None if unavailable)."""
    cwd = start if start is not None else Path(__file__).resolve().parent
    try:
        out = subprocess.run(["git", "rev-parse", "HEAD"], cwd=cwd, capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    sha = out.stdout.strip()
    if out.returncode != 0 or len(sha) < 7:
        return None
    dirty = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=no"],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    return f"{sha}-dirty" if dirty.returncode == 0 and dirty.stdout.strip() else sha
