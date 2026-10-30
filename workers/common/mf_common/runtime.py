"""Process/runtime introspection: peak memory, git revision."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

try:
    import resource
except ImportError:  # Windows has no ``resource`` module.
    resource = None  # type: ignore[assignment]


def peak_rss_mb(children: bool = False) -> float:
    """Peak resident set size in MiB.

    Linux and macOS: ``ru_maxrss`` (KiB on Linux, bytes on macOS). Windows: this process's peak
    working set; child processes are not measured there (0.0).
    """
    if resource is None:
        return 0.0 if children else _windows_peak_working_set_mb()
    who = resource.RUSAGE_CHILDREN if children else resource.RUSAGE_SELF
    raw = resource.getrusage(who).ru_maxrss
    divisor = 1024 * 1024 if sys.platform == "darwin" else 1024
    return round(raw / divisor, 1)


def _windows_peak_working_set_mb() -> float:
    """PeakWorkingSetSize from GetProcessMemoryInfo (0.0 when it can't be read)."""
    import ctypes
    from ctypes import wintypes

    class ProcessMemoryCounters(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    try:
        kernel32 = ctypes.WinDLL("kernel32")
        psapi = ctypes.WinDLL("psapi")
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessMemoryCounters), wintypes.DWORD]
        psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
        counters = ProcessMemoryCounters()
        counters.cb = ctypes.sizeof(counters)
        if not psapi.GetProcessMemoryInfo(kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
            return 0.0
    except (AttributeError, OSError):
        return 0.0
    return round(counters.PeakWorkingSetSize / (1024 * 1024), 1)


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
