"""Test configuration: make the five source roots importable without installation."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

WORKERS = Path(__file__).resolve().parents[1]
for sub in ("common", "demo-parser", "features", "training", "evaluation"):
    p = str(WORKERS / sub)
    if p not in sys.path:
        sys.path.insert(0, p)
TESTS = Path(__file__).resolve().parent
if str(TESTS) not in sys.path:
    sys.path.insert(0, str(TESTS))

REPO = WORKERS.parent


def demo_dir() -> Path | None:
    raw = os.environ.get("MF_TEST_DEMOS")
    if not raw:
        return None
    p = Path(raw)
    return p if p.is_dir() else None


@pytest.fixture
def repo_root() -> Path:
    return REPO
