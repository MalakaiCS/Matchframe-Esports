"""Automated leakage check: features at or before a cut tick must not change when every frame after
the cut is perturbed (positions/angles/health/places scrambled, rows dropped)."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl

from mf_common.datasets import load_dataset
from mf_common.emit import Emitter

from .features import FEATURE_COLUMNS, KEY_COLUMNS, compute_pair_features

FeatureFn = Callable[[pl.DataFrame, pl.DataFrame, float, str], pl.DataFrame]


def perturb_future(ticks: pl.DataFrame, cut_tick: int, seed: int) -> pl.DataFrame:
    """Scramble every row with ``tick > cut_tick`` and drop ~30 % of them."""
    rng = np.random.default_rng(seed)
    past = ticks.filter(pl.col("tick") <= cut_tick)
    fut = ticks.filter(pl.col("tick") > cut_tick)
    n = fut.height
    if n == 0:
        return ticks
    noisy: list[pl.Series] = []
    for c, scale in (("x", 800.0), ("y", 800.0), ("z", 200.0), ("vx", 250.0), ("vy", 250.0)):
        if c in fut.columns:
            noisy.append((fut[c].cast(pl.Float64) + pl.Series(rng.normal(0, scale, n))).cast(fut[c].dtype).alias(c))
    if "pitch" in fut.columns:
        noisy.append(pl.Series("pitch", rng.uniform(-89, 89, n)).cast(fut["pitch"].dtype))
    if "yaw" in fut.columns:
        noisy.append(pl.Series("yaw", rng.uniform(-180, 180, n)).cast(fut["yaw"].dtype))
    if "health" in fut.columns:
        noisy.append(pl.Series("health", rng.integers(1, 101, n)).cast(fut["health"].dtype))
    for c in ("place", "active_weapon"):
        if c in fut.columns:
            noisy.append(fut[c].sample(n=n, shuffle=True, seed=int(rng.integers(0, 2**31))).alias(c))
    fut = fut.with_columns(noisy)
    keep = pl.Series(rng.random(n) > 0.3)
    fut = fut.filter(keep)
    return pl.concat([past, fut], how="vertical_relaxed").sort(["tick", "player_id"])


def _frames_equal(a: pl.DataFrame, b: pl.DataFrame) -> tuple[bool, list[str], float]:
    if a.height != b.height:
        return False, ["<row count>"], float("inf")
    j = a.join(b, on=KEY_COLUMNS, how="inner", suffix="__p")
    if j.height != a.height:
        return False, ["<keys>"], float("inf")
    bad: list[str] = []
    worst = 0.0
    for c in FEATURE_COLUMNS:
        x = j[c].cast(pl.Float64).to_numpy()
        y = j[f"{c}__p"].cast(pl.Float64).to_numpy()
        both_nan = np.isnan(x) & np.isnan(y)
        diff = np.where(both_nan, 0.0, np.abs(x - y))
        diff = np.nan_to_num(diff, nan=np.inf)
        m = float(diff.max()) if diff.size else 0.0
        worst = max(worst, m)
        if m > 1e-6:
            bad.append(c)
    return not bad, bad, worst


def check_leakage(
    ticks: pl.DataFrame,
    rounds: pl.DataFrame,
    tick_rate: float,
    dataset_id: str,
    *,
    cuts: int = 3,
    seed: int = 0,
    feature_fn: FeatureFn = compute_pair_features,
) -> dict[str, Any]:
    base = feature_fn(ticks, rounds, tick_rate, dataset_id)
    static_violations = base.filter(pl.col("max_input_tick") > pl.col("tick")).height if "max_input_tick" in base.columns else 0
    results: list[dict[str, Any]] = []
    if base.height:
        uniq = np.unique(base["tick"].to_numpy())
        qs = np.linspace(0.2, 0.8, cuts) if cuts > 1 else np.array([0.5])
        for i, q in enumerate(qs):
            cut = int(uniq[int(q * (uniq.size - 1))])
            pert = perturb_future(ticks, cut, seed + i)
            after = feature_fn(pert, rounds, tick_rate, dataset_id)
            ok, bad, worst = _frames_equal(base.filter(pl.col("tick") <= cut), after.filter(pl.col("tick") <= cut))
            results.append(
                {
                    "cut_tick": cut,
                    "rows_compared": int(base.filter(pl.col("tick") <= cut).height),
                    "identical": ok,
                    "mismatched_columns": bad,
                    "max_abs_diff": None if not np.isfinite(worst) else round(worst, 9),
                }
            )
    passed = bool(results) and all(r["identical"] for r in results) and static_violations == 0
    return {
        "passed": passed,
        "method": "perturb all frames after cut (noise on x/y/z/vx/vy, random pitch/yaw/health, shuffled place/weapon, drop 30%); compare features at or before cut",
        "static_future_input_rows": static_violations,
        "cuts": results,
    }


def check_dataset_leakage(dataset: Path, emitter: Emitter, cuts: int = 3) -> dict[str, Any]:
    ref = load_dataset(Path(dataset))
    ticks = pl.read_parquet(ref.path / "ticks.parquet")
    rounds = pl.read_parquet(ref.path / "rounds.parquet")
    emitter.progress("leakage_check", 0.1)
    out = check_leakage(ticks, rounds, ref.tick_rate, ref.dataset_id, cuts=cuts)
    return {"dataset": str(ref.path), "dataset_id": ref.dataset_id, **out}
