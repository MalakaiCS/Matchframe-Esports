"""Synthetic contact data and the committed TypeScript parity fixture.

The committed fixture (``fixtures/models/contact_2s_parity``) is trained on synthetic feature
vectors with the real ``contact_2s`` feature schema, so it carries no player identities or demo
content while exercising the same LightGBM export path (including missing values).
"""

from __future__ import annotations

import importlib.metadata
from pathlib import Path
from typing import Any

import lightgbm as lgb
import numpy as np

from mf_common.emit import Emitter
from mf_common.fsutil import utc_now

from .export import pick_parity_rows, write_export
from .train import feature_list, required_capabilities


def synthetic_contact_frame(n: int, seed: int) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """Feature matrix with the gsi_compatible schema and a known logistic contact process."""
    rng = np.random.default_rng(seed)
    names = feature_list("gsi_compatible")
    cols: dict[str, np.ndarray] = {}
    cols["dist_2d"] = rng.gamma(2.0, 700.0, n)
    cols["dz"] = rng.normal(0, 90, n)
    cols["dist_3d"] = np.sqrt(cols["dist_2d"] ** 2 + cols["dz"] ** 2)
    cols["facing_a"] = np.clip(rng.normal(0.2, 0.6, n), -1, 1)
    cols["facing_b"] = np.clip(rng.normal(0.2, 0.6, n), -1, 1)
    cols["facing_max"] = np.maximum(cols["facing_a"], cols["facing_b"])
    cols["facing_min"] = np.minimum(cols["facing_a"], cols["facing_b"])
    cols["closing_speed"] = rng.normal(0, 120, n)
    cols["speed_a"] = np.abs(rng.normal(120, 90, n))
    cols["speed_b"] = np.abs(rng.normal(120, 90, n))
    cols["health_a"] = rng.integers(1, 101, n).astype(float)
    cols["health_b"] = rng.integers(1, 101, n).astype(float)
    cols["armor_a"] = rng.choice([0.0, 50.0, 100.0], n)
    cols["armor_b"] = rng.choice([0.0, 50.0, 100.0], n)
    cols["weapon_class_a"] = rng.integers(0, 5, n).astype(float)
    cols["weapon_class_b"] = rng.integers(0, 5, n).astype(float)
    cols["alive_t"] = rng.integers(1, 6, n).astype(float)
    cols["alive_ct"] = rng.integers(1, 6, n).astype(float)
    cols["round_time_s"] = rng.uniform(0, 115, n)
    z = -1.5 - cols["dist_3d"] / 600.0 + 2.2 * cols["facing_max"] + cols["closing_speed"] / 200.0 + 0.15 * cols["weapon_class_a"]
    y = (rng.random(n) < 1.0 / (1.0 + np.exp(-z))).astype(float)
    X = np.stack([cols[c] for c in names], axis=1)
    # missing values like the real pipeline produces (no history at round start, unknown weapon)
    X[rng.random(n) < 0.05, names.index("closing_speed")] = np.nan
    X[rng.random(n) < 0.02, names.index("weapon_class_b")] = np.nan
    return X.astype(np.float32).astype(np.float64), y, names


def make_parity_fixture(out: Path, emitter: Emitter, seed: int = 1234, parity_count: int = 64) -> dict[str, Any]:
    X, y, names = synthetic_contact_frame(20000, seed)
    params = {
        "objective": "binary",
        "learning_rate": 0.1,
        "num_leaves": 7,
        "min_data_in_leaf": 50,
        "deterministic": True,
        "force_row_wise": True,
        "num_threads": 1,
        "seed": seed,
        "verbose": -1,
    }
    emitter.progress("fit", 0.3)
    booster = lgb.train(params, lgb.Dataset(X, label=y, feature_name=names), num_boost_round=40)
    rows = pick_parity_rows(X, max(parity_count, 50), seed)
    card = {
        "id": "contact_2s-synthetic-parity-fixture",
        "task": "contact_2s",
        "status": "experimental",
        "created_at": utc_now(),
        "objective": "binary",
        "label_definition": "synthetic logistic process over the contact_2s feature schema",
        "metrics": None,
        "feature_schema": [
            {"index": i, "name": f, "capability": "gsi_compatible", "dtype": "float32", "missing": "null/NaN allowed"}
            for i, f in enumerate(names)
        ],
        "required_capabilities": required_capabilities(names),
        "supported_builds": [],
        "supported_maps": [],
        "training": {
            "seed": seed,
            "params": params,
            "num_boost_round": 40,
            "data": {
                "rows": int(X.shape[0]),
                "positives": int(y.sum()),
                "source": "synthetic (mf_training.synthetic.synthetic_contact_frame)",
            },
            "lightgbm_version": importlib.metadata.version("lightgbm"),
        },
        "notes": "Trained on synthetic data. Exists only so the TypeScript runtime can prove LightGBM JSON parity; never use for direction.",
    }
    res = write_export(Path(out), booster, X[rows], card)
    return {"fixture": str(out), **res}
