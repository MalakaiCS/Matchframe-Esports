"""The workers run on Windows, which has no ``resource`` module (demo reading failed there with
"ModuleNotFoundError: No module named 'resource'")."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

COMMON = Path(__file__).resolve().parents[1] / "common"


def test_runtime_imports_and_measures_without_the_resource_module() -> None:
    # A fresh interpreter where ``import resource`` fails, as on Windows.
    code = (
        "import sys; sys.modules['resource'] = None\n"
        "import mf_common.runtime as rt\n"
        "assert rt.resource is None\n"
        "rt._windows_peak_working_set_mb = lambda: 123.4\n"
        "assert rt.peak_rss_mb() == 123.4\n"
        "assert rt.peak_rss_mb(children=True) == 0.0\n"
        "import mf_demo_parser.extract, mf_features.features\n"
        "print('ok')\n"
    )
    roots = [str(COMMON), str(COMMON.parent / "demo-parser"), str(COMMON.parent / "features")]
    # The whole environment (Python doesn't start on Windows without SystemRoot), plus the packages.
    env = {**os.environ, "PYTHONPATH": os.pathsep.join(roots)}
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env, timeout=120)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "ok"


def test_peak_memory_off_windows() -> None:
    from mf_common.runtime import peak_rss_mb

    assert peak_rss_mb() > 0
