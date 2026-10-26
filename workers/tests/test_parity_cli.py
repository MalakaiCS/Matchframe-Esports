"""Committed parity fixture reproduces with the reference tree evaluator; CLI JSON-lines protocol."""

from __future__ import annotations

import io
import json
import subprocess
import sys
from contextlib import redirect_stdout
from pathlib import Path

from mf_common.cli import main
from mf_common.emit import NullEmitter
from mf_training.synthetic import make_parity_fixture
from mf_training.tree_eval import predict_proba, predict_raw

WORKERS = Path(__file__).resolve().parents[1]


def test_committed_fixture_parity(repo_root: Path) -> None:
    fx = repo_root / "fixtures" / "models" / "contact_2s_parity"
    model = json.loads((fx / "model.json").read_text())
    parity = json.loads((fx / "parity_vectors.json").read_text())
    card = json.loads((fx / "model_card.json").read_text())
    assert parity["count"] >= 50 and len(parity["vectors"]) == parity["count"]
    assert any(any(v is None for v in vec["features"]) for vec in parity["vectors"])
    assert card["status"] == "experimental" and "synthetic" in card["notes"].lower()
    assert [f["name"] for f in card["feature_schema"]] == parity["feature_names"] == model["feature_names"]
    for vec in parity["vectors"]:
        assert abs(predict_raw(model, vec["features"]) - vec["raw_score"]) <= parity["tolerance"]
        assert abs(predict_proba(model, vec["features"]) - vec["probability"]) <= parity["tolerance"]


def test_fixture_generation_matches_lightgbm(tmp_path: Path) -> None:
    res = make_parity_fixture(tmp_path / "fx", NullEmitter(), seed=5, parity_count=50)
    assert res["parity_vectors"] >= 50
    model = json.loads((tmp_path / "fx" / "model.json").read_text())
    parity = json.loads((tmp_path / "fx" / "parity_vectors.json").read_text())
    # vectors hold LightGBM's own predictions; the JSON dump alone must reproduce them
    for vec in parity["vectors"]:
        assert abs(predict_raw(model, vec["features"]) - vec["raw_score"]) < 1e-9
    card = json.loads((tmp_path / "fx" / "model_card.json").read_text())
    assert card["required_capabilities"] == ["gsi_compatible"]


def _run(argv: list[str]) -> tuple[int, list[dict]]:
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = main(argv)
    return code, [json.loads(line) for line in buf.getvalue().splitlines() if line.strip()]


def test_cli_hash_emits_json_lines(tmp_path: Path) -> None:
    f = tmp_path / "a.bin"
    f.write_bytes(b"abc")
    code, lines = _run(["hash", "--input", str(f)])
    assert code == 0
    assert lines[-1]["type"] == "result"
    assert lines[-1]["sha256"] == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    assert all(line["type"] in ("progress", "result") for line in lines)


def test_cli_errors_are_json_with_nonzero_exit(tmp_path: Path) -> None:
    code, lines = _run(["inspect", "--input", str(tmp_path / "missing.dem")])
    assert code == 1 and lines[-1]["type"] == "error" and lines[-1]["code"] == "INPUT_NOT_FOUND"
    junk = tmp_path / "junk.dem"
    junk.write_bytes(b"not a demo at all")
    code, lines = _run(["extract", "--input", str(junk), "--dataset-root", str(tmp_path / "d")])
    assert code == 1 and lines[-1]["code"] == "UNSUPPORTED_FORMAT"
    assert not (tmp_path / "d").exists() or not list((tmp_path / "d").glob("map=*"))


def test_module_entry_point_runs() -> None:
    env_path = ":".join(str(WORKERS / s) for s in ("common", "demo-parser", "features", "training", "evaluation"))
    proc = subprocess.run(
        [sys.executable, "-m", "mf_common.cli", "registry", "--models-dir", "/nonexistent-models-dir"],
        capture_output=True,
        text=True,
        env={"PYTHONPATH": env_path, "PATH": "/usr/bin:/bin"},
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout.strip().splitlines()[-1])["models"] == []
