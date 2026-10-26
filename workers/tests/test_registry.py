"""Model registry promotion rules."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from mf_common import errors
from mf_training.registry import load_registry, promote, register_model


def _setup(tmp: Path) -> Path:
    models = tmp / "models"
    (models / "m1").mkdir(parents=True)
    register_model(models, "m1", {"task": "contact_2s", "path": str(models / "m1")})
    return models


def test_new_models_start_experimental(tmp_path: Path) -> None:
    models = _setup(tmp_path)
    assert load_registry(models)["models"]["m1"]["status"] == "experimental"


def test_cannot_skip_stages(tmp_path: Path) -> None:
    models = _setup(tmp_path)
    with pytest.raises(errors.MfError) as exc:
        promote(models, "m1", "approved")
    assert exc.value.code == errors.PROMOTION_REFUSED and exc.value.exit_code == errors.EXIT_CHECK_FAILED


def test_approval_requires_test_evaluation(tmp_path: Path) -> None:
    models = _setup(tmp_path)
    promote(models, "m1", "shadow")
    promote(models, "m1", "candidate")
    with pytest.raises(errors.MfError) as exc:
        promote(models, "m1", "approved")
    assert "no evaluation.json" in exc.value.details["blockers"][0]
    (models / "m1" / "evaluation.json").write_text(json.dumps({"split": "val", "overall": {"model": {"auc": 0.7}}}))
    with pytest.raises(errors.MfError):
        promote(models, "m1", "approved")
    (models / "m1" / "evaluation.json").write_text(json.dumps({"split": "test", "overall": {"model": {"auc": 0.7}}}))
    assert promote(models, "m1", "approved", reason="ok")["to"] == "approved"
    reg = load_registry(models)
    assert [h["to"] for h in reg["models"]["m1"]["history"]] == ["experimental", "shadow", "candidate", "approved"]
    assert promote(models, "m1", "rolled_back")["to"] == "rolled_back"


def test_retired_is_terminal_and_unknown_models_fail(tmp_path: Path) -> None:
    models = _setup(tmp_path)
    promote(models, "m1", "retired")
    with pytest.raises(errors.MfError):
        promote(models, "m1", "experimental")
    with pytest.raises(errors.MfError) as exc:
        promote(models, "nope", "shadow")
    assert exc.value.code == errors.MODEL_NOT_FOUND
