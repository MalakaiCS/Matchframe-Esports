"""``doctor``: is this Python ready for the pipeline? Imports nothing heavy until asked."""

from __future__ import annotations

import importlib.metadata
import importlib.util
import sys
from typing import Any

from .emit import Emitter

#: Import name → distribution name (as in workers/pyproject.toml).
REQUIRED: dict[str, str] = {
    "demoparser2": "demoparser2",
    "polars": "polars",
    "pyarrow": "pyarrow",
    "duckdb": "duckdb",
    "lightgbm": "lightgbm",
    "numpy": "numpy",
    "pandas": "pandas",
}
MIN_PYTHON = (3, 11)


def doctor(emitter: Emitter) -> dict[str, Any]:
    found: dict[str, str] = {}
    missing: list[str] = []
    for module, dist in REQUIRED.items():
        if importlib.util.find_spec(module) is None:
            missing.append(dist)
            continue
        try:
            found[dist] = importlib.metadata.version(dist)
        except importlib.metadata.PackageNotFoundError:
            found[dist] = "unknown"
    python_ok = sys.version_info[:2] >= MIN_PYTHON
    emitter.progress("checked", 1.0)
    return {
        "ok": python_ok and not missing,
        "python": sys.version.split()[0],
        "python_ok": python_ok,
        "executable": sys.executable,
        "packages": found,
        "missing": missing,
    }
