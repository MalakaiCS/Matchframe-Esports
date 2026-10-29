"""``export-model``: LightGBM ``dump_model()`` JSON, ``model_card.json`` and ``parity_vectors.json``.

Parity vectors let the TypeScript runtime prove it evaluates the dumped trees exactly like the
Python LightGBM: each vector lists the input features (``null`` = missing → NaN) with the
expected ``raw_score`` and ``probability = sigmoid(raw_score)``.
"""

from __future__ import annotations

import importlib.metadata
import math
from pathlib import Path
from typing import Any

import lightgbm as lgb
import numpy as np

from mf_common.emit import Emitter, dumps
from mf_common.fsutil import read_json, sha256_bytes, utc_now, write_json_atomic, write_text_atomic

PARITY_TOLERANCE = 1e-9
LABEL_DEFINITION = {
    "contact_2s": "1 if the T/CT pair exchanges attributed damage or a kill within (t, t+2s]",
    "pov_2s": "1 if the player kills or dies within (t, t+2s] (their POV shows a kill)",
}


def parity_vectors(booster: lgb.Booster, X: np.ndarray, feature_names: list[str]) -> list[dict[str, Any]]:
    raw = booster.predict(X, raw_score=True)
    prob = booster.predict(X)
    out = []
    for i in range(X.shape[0]):
        feats = [None if not math.isfinite(float(v)) else float(v) for v in X[i]]
        out.append({"features": feats, "raw_score": float(raw[i]), "probability": float(prob[i])})
    return out


def pick_parity_rows(X: np.ndarray, count: int, seed: int) -> np.ndarray:
    """Deterministic sample that includes rows with missing values when available."""
    rng = np.random.default_rng(seed)
    n = X.shape[0]
    if n <= count:
        return np.arange(n)
    has_nan = np.where(np.isnan(X).any(axis=1))[0]
    take_nan = rng.choice(has_nan, size=min(len(has_nan), max(1, count // 8)), replace=False) if len(has_nan) else np.array([], dtype=int)
    rest = np.setdiff1d(np.arange(n), take_nan)
    take = rng.choice(rest, size=count - len(take_nan), replace=False)
    return np.sort(np.concatenate([take_nan, take]).astype(int))


def write_export(
    out: Path,
    booster: lgb.Booster,
    X_parity: np.ndarray,
    card: dict[str, Any],
) -> dict[str, Any]:
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    dump = booster.dump_model()
    model_json = dumps(dump)
    write_text_atomic(out / "model.json", model_json)
    model_sha = sha256_bytes((model_json + "\n").encode())
    names = list(booster.feature_name())
    vectors = parity_vectors(booster, X_parity, names)
    parity = {
        "model_id": card["id"],
        "model_sha256": model_sha,
        "feature_names": names,
        "missing_value_encoding": "null -> NaN (LightGBM missing)",
        "output": "probability = 1 / (1 + exp(-raw_score))",
        "tolerance": PARITY_TOLERANCE,
        "count": len(vectors),
        "vectors": vectors,
    }
    write_json_atomic(out / "parity_vectors.json", parity)
    card = {**card, "model_sha256": model_sha, "files": {"model": "model.json", "parity_vectors": "parity_vectors.json"}}
    write_json_atomic(out / "model_card.json", card)
    return {"out": str(out), "model_sha256": model_sha, "parity_vectors": len(vectors), "trees": len(dump.get("tree_info", []))}


def export_model(model_dir: Path, out: Path, emitter: Emitter, parity_count: int = 64) -> dict[str, Any]:
    from mf_training.data import load_manifest, load_split
    from mf_training.registry import load_registry
    from mf_training.train import load_training_record

    model_dir = Path(model_dir)
    record = load_training_record(model_dir)
    booster = lgb.Booster(model_file=str(model_dir / "model.txt"))
    manifest = load_manifest(Path(record["dataset_manifest"]["path"]))
    data = None
    for split in ("val", "test", "train"):
        d = load_split(manifest, split, record["label"], record["features"])
        if d.n:
            data = d
            break
    if data is None:
        raise ValueError("no rows available for parity vectors")
    rows = pick_parity_rows(data.X, max(parity_count, 50), seed=int(record["seed"]))
    ev_path = model_dir / "evaluation.json"
    evaluation = read_json(ev_path) if ev_path.exists() else None
    reg = load_registry(model_dir.parent)
    status = reg["models"].get(record["model_id"], {}).get("status", "experimental")

    def strip_bins(m: dict[str, Any] | None) -> dict[str, Any] | None:
        return None if m is None else {k: v for k, v in m.items() if k != "calibration_bins"}

    metrics: dict[str, Any] = {
        "validation": {k: strip_bins(v) if isinstance(v, dict) else v for k, v in record.get("validation_metrics", {}).items()},
    }
    if evaluation:
        metrics["evaluation"] = {
            "split": evaluation["split"],
            "model": strip_bins(evaluation["overall"]["model"]),
            "heuristic": strip_bins(evaluation["overall"]["heuristic"]),
            "model_ci": evaluation["overall"]["model_ci"],
            "per_map": {
                m: {"model_auc": b["model"]["auc"], "heuristic_auc": b["heuristic"]["auc"], "n": b["model"]["n"]}
                for m, b in evaluation["per_map"].items()
            },
        }
    members = manifest["members"]
    card = {
        "id": record["model_id"],
        "task": record["task"],
        "status": status,
        "created_at": record["created_at"],
        "exported_at": utc_now(),
        "objective": "binary",
        "label_definition": LABEL_DEFINITION.get(record["task"], record["label"]),
        "metrics": metrics,
        "feature_schema": [
            {"index": i, "name": f, "capability": record["feature_capabilities"][f], "dtype": "float32", "missing": "null/NaN allowed"}
            for i, f in enumerate(record["features"])
        ],
        "required_capabilities": record["required_capabilities"],
        "supported_builds": sorted({m["build"] for m in members if m["split"] == "train"}),
        "supported_maps": sorted({m["map"] for m in members if m["split"] == "train"}),
        "training": {
            "seed": record["seed"],
            "params": record["params"],
            "num_boost_round": record["num_boost_round"],
            "dataset_manifest_hash": record["dataset_manifest"]["content_hash"],
            "git_commit": record["git_commit"],
            "lightgbm_version": importlib.metadata.version("lightgbm"),
            "data": {k: {kk: vv for kk, vv in v.items() if kk != "matches"} for k, v in record["data"].items()},
        },
        "notes": record.get("notes"),
    }
    emitter.progress("export", 0.5)
    res = write_export(Path(out), booster, data.X[rows], card)
    return {"model_id": record["model_id"], **res}
