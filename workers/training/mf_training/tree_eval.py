"""Reference evaluator for LightGBM ``dump_model()`` JSON (numerical splits only).

This mirrors what the TypeScript runtime must implement; tests use it to prove that the exported
JSON alone reproduces LightGBM's raw scores for the parity vectors.

Split semantics (LightGBM): ``decision_type`` ``<=`` sends ``x <= threshold`` left. Missing
handling per node via ``missing_type``: ``NaN`` → NaN follows ``default_left``; ``Zero`` → zero
*and* NaN follow ``default_left``; ``None`` → NaN is treated as 0.0 before comparing.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

ZERO_EPS = 1e-35


def _is_zero(v: float) -> bool:
    return -ZERO_EPS <= v <= ZERO_EPS


def _leaf_value(node: dict[str, Any], x: Sequence[float | None]) -> float:
    while "leaf_value" not in node:
        raw = x[node["split_feature"]]
        v = math.nan if raw is None else float(raw)
        missing = node.get("missing_type", "None")
        if node.get("decision_type", "<=") != "<=":
            raise ValueError(f"unsupported decision_type {node.get('decision_type')!r} (categorical splits)")
        if missing == "NaN" and math.isnan(v):
            go_left = bool(node["default_left"])
        elif missing == "Zero" and (math.isnan(v) or _is_zero(v)):
            go_left = bool(node["default_left"])
        else:
            if math.isnan(v):
                v = 0.0
            go_left = v <= float(node["threshold"])
        node = node["left_child"] if go_left else node["right_child"]
    return float(node["leaf_value"])


def predict_raw(model: dict[str, Any], x: Sequence[float | None]) -> float:
    return sum(_leaf_value(t["tree_structure"], x) for t in model["tree_info"])


def predict_proba(model: dict[str, Any], x: Sequence[float | None]) -> float:
    return 1.0 / (1.0 + math.exp(-predict_raw(model, x)))
