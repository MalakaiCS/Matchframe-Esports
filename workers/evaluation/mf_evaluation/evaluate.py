"""``evaluate``: AUC / Brier / calibration overall and per map, with match-level bootstrap CIs."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import lightgbm as lgb
import numpy as np

from mf_common import errors
from mf_common.emit import Emitter
from mf_common.fsutil import utc_now, write_json_atomic

from .metrics import auc, brier, cluster_bootstrap, summarize


def evaluate_model(
    model_dir: Path, manifest_path: Path, emitter: Emitter, split: str = "test", bootstrap: int = 1000, seed: int = 11
) -> dict[str, Any]:
    from mf_training.data import heuristic_score, load_manifest, load_split
    from mf_training.registry import load_registry, save_registry
    from mf_training.train import load_training_record, platt_apply

    model_dir = Path(model_dir)
    record = load_training_record(model_dir)
    manifest = load_manifest(manifest_path)
    if manifest["content_hash"] != record["dataset_manifest"]["content_hash"]:
        raise errors.MfError(
            errors.DATASET_INVALID,
            "dataset manifest differs from the one the model was trained on",
            trained_on=record["dataset_manifest"]["content_hash"],
            given=manifest["content_hash"],
        )
    data = load_split(manifest, split, record["label"], record["features"])
    if data.n == 0:
        raise errors.MfError(errors.INSUFFICIENT_DATA, f"split {split!r} has no labelled rows")
    booster = lgb.Booster(model_file=str(model_dir / "model.txt"))
    emitter.progress("predict", 0.2, rows=data.n)
    p = booster.predict(data.X)
    cal = record["heuristic"]["calibration"]
    h = platt_apply(heuristic_score(data.frame), (cal["a"], cal["b"]))
    groups = np.asarray(data.groups)
    maps = np.asarray(data.maps)

    def block(mask: np.ndarray) -> dict[str, Any]:
        y, pm, hm, g = data.y[mask], p[mask], h[mask], groups[mask]
        emitter.progress("bootstrap", None, rows=int(mask.sum()))
        return {
            "matches": sorted(set(g.tolist())),
            "model": summarize(y, pm),
            "heuristic": summarize(y, hm),
            "model_ci": cluster_bootstrap(g.tolist(), y, pm, {"auc": auc, "brier": brier}, n_boot=bootstrap, seed=seed),
            "heuristic_ci": cluster_bootstrap(g.tolist(), y, hm, {"auc": auc, "brier": brier}, n_boot=bootstrap, seed=seed),
        }

    overall = block(np.ones(data.n, dtype=bool))
    per_map = {m: block(maps == m) for m in sorted(set(maps.tolist()))}
    doc = {
        "model_id": record["model_id"],
        "task": record["task"],
        "split": split,
        "evaluated_at": utc_now(),
        "dataset_manifest_hash": manifest["content_hash"],
        "bootstrap": {"unit": "match (dataset)", "n_boot": bootstrap, "seed": seed},
        "overall": overall,
        "per_map": per_map,
        "notes": [
            "frames within a match are correlated; CIs resample whole matches",
            "with < 2 matches in a block no CI is reported",
            record.get("notes", ""),
        ],
    }
    write_json_atomic(model_dir / "evaluation.json", doc)
    models_dir = model_dir.parent
    reg = load_registry(models_dir)
    if record["model_id"] in reg["models"]:
        reg["models"][record["model_id"]].setdefault("evaluations", []).append(
            {"split": split, "at": doc["evaluated_at"], "auc": overall["model"]["auc"], "brier": overall["model"]["brier"]}
        )
        save_registry(models_dir, reg)

    def brief(b: dict[str, Any]) -> dict[str, Any]:
        return {
            "matches": b["matches"],
            "n": b["model"]["n"],
            "positives": b["model"]["positives"],
            "model_auc": b["model"]["auc"],
            "model_brier": b["model"]["brier"],
            "heuristic_auc": b["heuristic"]["auc"],
            "heuristic_brier": b["heuristic"]["brier"],
            "model_auc_ci": b["model_ci"]["intervals"].get("auc"),
            "ci_note": b["model_ci"].get("note"),
        }

    return {
        "model_id": record["model_id"],
        "split": split,
        "evaluation": str(model_dir / "evaluation.json"),
        "overall": brief(overall),
        "per_map": {m: brief(b) for m, b in per_map.items()},
    }
