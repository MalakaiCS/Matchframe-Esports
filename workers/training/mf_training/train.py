"""``train``: LightGBM baseline for ``contact_2s`` vs a deterministic distance/facing heuristic."""

from __future__ import annotations

import importlib.metadata
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import lightgbm as lgb
import numpy as np

from mf_common import errors
from mf_common.emit import Emitter
from mf_common.fsutil import read_json, sha256_bytes, sha256_file, utc_now, write_json_atomic
from mf_common.runtime import git_commit
from mf_evaluation.metrics import summarize
from mf_features.features import FEATURE_CAPABILITIES

from .data import TASK_LABELS, SplitData, heuristic_score, load_manifest, load_split
from .registry import register_model

DEFAULT_PARAMS: dict[str, Any] = {
    "objective": "binary",
    "learning_rate": 0.05,
    "num_leaves": 15,
    "min_data_in_leaf": 200,
    "feature_fraction": 0.9,
    "bagging_fraction": 0.8,
    "bagging_freq": 1,
    "lambda_l2": 1.0,
    "deterministic": True,
    "force_row_wise": True,
    "num_threads": 4,
    "verbose": -1,
}
MAX_ROUNDS = 400
EARLY_STOP = 40

NOTES = (
    "Pipeline proof only: trained on a handful of 2023 demos (different maps, one 2v2 match). "
    "Not a usable director model; metrics are not evidence of production quality."
)


def feature_list(feature_set: str) -> list[str]:
    if feature_set == "gsi_compatible":
        return [f for f, cap in FEATURE_CAPABILITIES.items() if cap == "gsi_compatible"]
    return list(FEATURE_CAPABILITIES)


def required_capabilities(features: list[str]) -> list[str]:
    caps = {FEATURE_CAPABILITIES[f] for f in features}
    return ["gsi_compatible"] if caps == {"gsi_compatible"} else sorted(caps)


def fit_platt(score: np.ndarray, y: np.ndarray, iters: int = 200) -> tuple[float, float]:
    """1-D logistic calibration p = sigmoid(a·score + b) by Newton's method (deterministic)."""
    a, b = 1.0, 0.0
    x = score.astype(float)
    for _ in range(iters):
        z = np.clip(a * x + b, -30, 30)
        p = 1.0 / (1.0 + np.exp(-z))
        w = p * (1 - p) + 1e-9
        g = np.array([np.sum((p - y) * x), np.sum(p - y)])
        h = np.array([[np.sum(w * x * x), np.sum(w * x)], [np.sum(w * x), np.sum(w)]]) + np.eye(2) * 1e-6
        step = np.linalg.solve(h, g)
        a, b = a - step[0], b - step[1]
        if np.max(np.abs(step)) < 1e-10:
            break
    return float(a), float(b)


def platt_apply(score: np.ndarray, ab: tuple[float, float]) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(ab[0] * score + ab[1], -30, 30)))


def _describe(d: SplitData) -> dict[str, Any]:
    return {
        "rows": d.n,
        "positives": int(d.y.sum()),
        "matches": sorted(set(d.groups)),
        "maps": sorted(set(d.maps)),
        "builds": sorted(set(d.builds)),
    }


def train_model(task: str, manifest_path: Path, out_dir: Path, emitter: Emitter, seed: int = 7, feature_set: str = "gsi_compatible") -> dict[str, Any]:
    t0 = time.monotonic()
    if task not in TASK_LABELS:
        raise errors.MfError(errors.INSUFFICIENT_DATA, f"unknown task {task}")
    label = TASK_LABELS[task]
    manifest = load_manifest(manifest_path)
    feats = feature_list(feature_set)
    emitter.progress("load", 0.1)
    train = load_split(manifest, "train", label, feats)
    val = load_split(manifest, "val", label, feats)
    if train.n == 0 or train.y.sum() == 0:
        raise errors.MfError(errors.INSUFFICIENT_DATA, "training split has no labelled positives", train=_describe(train))
    params = {**DEFAULT_PARAMS, "seed": seed, "bagging_seed": seed, "feature_fraction_seed": seed, "data_random_seed": seed}
    dtrain = lgb.Dataset(train.X, label=train.y, feature_name=feats, free_raw_data=False)
    callbacks = []
    valid_sets = []
    use_val = val.n > 0 and 0 < val.y.sum() < val.n
    if use_val:
        dval = lgb.Dataset(val.X, label=val.y, reference=dtrain, feature_name=feats)
        valid_sets = [dval]
        callbacks = [lgb.early_stopping(EARLY_STOP, verbose=False)]
    emitter.progress("fit", 0.3, rows=train.n)
    booster = lgb.train(params, dtrain, num_boost_round=MAX_ROUNDS, valid_sets=valid_sets, callbacks=callbacks)
    best_iter = booster.best_iteration or booster.current_iteration()
    model_text = booster.model_to_string(num_iteration=best_iter)
    model_hash = sha256_bytes(model_text.encode())
    model_id = f"{task}-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}-{model_hash[:8]}"
    mdir = Path(out_dir) / model_id
    mdir.mkdir(parents=True, exist_ok=False)
    (mdir / "model.txt").write_text(model_text, encoding="utf-8")

    # heuristic baseline: deterministic score, Platt-calibrated on train for Brier/log-loss
    platt = fit_platt(heuristic_score(train.frame), train.y)
    metrics: dict[str, Any] = {}
    if val.n:
        booster_loaded = lgb.Booster(model_str=model_text)
        p_val = booster_loaded.predict(val.X, num_iteration=best_iter)
        h_val = platt_apply(heuristic_score(val.frame), platt)
        metrics = {"model": summarize(val.y, p_val), "heuristic": summarize(val.y, h_val)}
        if metrics["model"]["auc"] is not None and metrics["heuristic"]["auc"] is not None:
            metrics["model_minus_heuristic_auc"] = round(metrics["model"]["auc"] - metrics["heuristic"]["auc"], 6)
    importance = dict(zip(feats, (float(x) for x in booster.feature_importance("gain")), strict=True))
    record = {
        "model_id": model_id,
        "task": task,
        "label": label,
        "created_at": utc_now(),
        "seed": seed,
        "params": params,
        "num_boost_round": int(best_iter),
        "early_stopping": {"used": use_val, "rounds": EARLY_STOP if use_val else None, "on": "val" if use_val else None},
        "feature_set": feature_set,
        "features": feats,
        "feature_capabilities": {f: FEATURE_CAPABILITIES[f] for f in feats},
        "required_capabilities": required_capabilities(feats),
        "feature_importance_gain": importance,
        "git_commit": git_commit(Path(__file__).resolve().parent),
        "lightgbm_version": importlib.metadata.version("lightgbm"),
        "dataset_manifest": {"path": str(manifest_path), "content_hash": manifest["content_hash"], "file_sha256": sha256_file(Path(manifest_path))},
        "data": {"train": _describe(train), "val": _describe(val)},
        "validation_metrics": metrics,
        "heuristic": {
            "formula": "clip((facing_max + 1) / 2, 0, 1)^2 * exp(-dist_3d / 1000)",
            "calibration": {"method": "platt_on_train", "a": platt[0], "b": platt[1]},
        },
        "model_sha256": model_hash,
        "notes": NOTES,
    }
    write_json_atomic(mdir / "training_record.json", record)
    register_model(Path(out_dir), model_id, {"task": task, "path": str(mdir), "model_sha256": model_hash})
    return {
        "model_id": model_id,
        "model_dir": str(mdir),
        "num_boost_round": int(best_iter),
        "train": {k: v for k, v in _describe(train).items()},
        "val": {k: v for k, v in _describe(val).items()},
        "validation": {
            k: ({kk: vv for kk, vv in v.items() if kk != "calibration_bins"} if isinstance(v, dict) else v) for k, v in metrics.items()
        },
        "required_capabilities": record["required_capabilities"],
        "wall_s": round(time.monotonic() - t0, 3),
    }


def load_training_record(model_dir: Path) -> dict[str, Any]:
    p = Path(model_dir) / "training_record.json"
    if not p.exists():
        raise errors.MfError(errors.MODEL_NOT_FOUND, f"no training_record.json in {model_dir}")
    return read_json(p)
