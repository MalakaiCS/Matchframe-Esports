"""File-based model registry (``<models_dir>/registry.json``).

Statuses: experimental → shadow → candidate → approved; approved → rolled_back; any → retired.
``approved`` additionally requires an ``evaluation.json`` on the held-out *test* split with a
computed AUC — promotion is refused otherwise.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from mf_common import errors
from mf_common.fsutil import read_json, utc_now, write_json_atomic

STATUSES = ("experimental", "shadow", "candidate", "approved", "retired", "rolled_back")
TRANSITIONS: dict[str, tuple[str, ...]] = {
    "experimental": ("shadow", "retired"),
    "shadow": ("candidate", "experimental", "retired"),
    "candidate": ("approved", "shadow", "retired"),
    "approved": ("rolled_back", "retired"),
    "rolled_back": ("experimental", "retired"),
    "retired": (),
}
REGISTRY = "registry.json"


def load_registry(models_dir: Path) -> dict[str, Any]:
    p = Path(models_dir) / REGISTRY
    if not p.exists():
        return {"schemaVersion": 1, "models": {}}
    return read_json(p)


def save_registry(models_dir: Path, reg: dict[str, Any]) -> None:
    write_json_atomic(Path(models_dir) / REGISTRY, reg)


def register_model(models_dir: Path, model_id: str, entry: dict[str, Any]) -> None:
    reg = load_registry(models_dir)
    if model_id in reg["models"]:
        raise errors.MfError(errors.DATASET_CONFLICT, f"model {model_id} already registered")
    reg["models"][model_id] = {
        "status": "experimental",
        "created_at": utc_now(),
        "history": [{"at": utc_now(), "from": None, "to": "experimental", "reason": "trained"}],
        **entry,
    }
    save_registry(models_dir, reg)


def approval_blockers(model_dir: Path) -> list[str]:
    ev_path = model_dir / "evaluation.json"
    if not ev_path.exists():
        return ["no evaluation.json (run evaluate on the test split)"]
    ev = read_json(ev_path)
    blockers = []
    if ev.get("split") != "test":
        blockers.append(f"evaluation is on split {ev.get('split')!r}, approval requires the held-out test split")
    if (ev.get("overall", {}).get("model") or {}).get("auc") is None:
        blockers.append("evaluation has no AUC (no positives or negatives in the test split)")
    return blockers


def promote(models_dir: Path, model_id: str, to: str, reason: str | None = None) -> dict[str, Any]:
    if to not in STATUSES:
        raise errors.MfError(errors.PROMOTION_REFUSED, f"unknown status {to!r}", exit_code=errors.EXIT_CHECK_FAILED)
    reg = load_registry(models_dir)
    entry = reg["models"].get(model_id)
    if entry is None:
        raise errors.MfError(errors.MODEL_NOT_FOUND, f"model {model_id} not in registry")
    current = entry["status"]
    if to not in TRANSITIONS[current]:
        raise errors.MfError(
            errors.PROMOTION_REFUSED,
            f"transition {current} -> {to} not allowed",
            exit_code=errors.EXIT_CHECK_FAILED,
            allowed=list(TRANSITIONS[current]),
        )
    if to == "approved":
        blockers = approval_blockers(Path(models_dir) / model_id)
        if blockers:
            raise errors.MfError(
                errors.PROMOTION_REFUSED, "approval requires evaluation results", exit_code=errors.EXIT_CHECK_FAILED, blockers=blockers
            )
    entry["status"] = to
    entry.setdefault("history", []).append({"at": utc_now(), "from": current, "to": to, "reason": reason})
    save_registry(models_dir, reg)
    card = Path(models_dir) / model_id / "model_card.json"
    if card.exists():
        doc = read_json(card)
        doc["status"] = to
        write_json_atomic(card, doc)
    return {"model_id": model_id, "from": current, "to": to}


def list_models(models_dir: Path) -> dict[str, Any]:
    reg = load_registry(models_dir)
    return {
        "models_dir": str(models_dir),
        "models": [{"model_id": k, "status": v["status"], "task": v.get("task"), "created_at": v.get("created_at")} for k, v in sorted(reg["models"].items())],
    }
