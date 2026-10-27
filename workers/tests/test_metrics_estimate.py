"""Metrics (vs scikit-learn), cluster bootstrap behaviour and the capacity estimate arithmetic."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from sklearn.metrics import brier_score_loss, roc_auc_score

from mf_demo_parser.benchmark import ALLOCATIONS_GB, estimate_capacity
from mf_evaluation.metrics import auc, brier, calibration_bins, cluster_bootstrap


def test_auc_and_brier_match_sklearn() -> None:
    rng = np.random.default_rng(3)
    y = rng.integers(0, 2, 2000)
    p = np.round(rng.random(2000), 2)  # many ties
    assert auc(y, p) == pytest.approx(roc_auc_score(y, p), abs=1e-12)
    assert brier(y, p) == pytest.approx(brier_score_loss(y, p), abs=1e-12)
    assert auc(np.ones(5), np.random.rand(5)) is None


def test_calibration_bins_cover_all_rows() -> None:
    p = np.linspace(0, 1, 101)
    y = (p > 0.5).astype(float)
    bins = calibration_bins(y, p, 10)
    assert sum(b["count"] for b in bins) == 101


def test_cluster_bootstrap_needs_two_matches_and_is_wider_than_frame_bootstrap() -> None:
    rng = np.random.default_rng(0)
    one = cluster_bootstrap(["m"] * 100, rng.integers(0, 2, 100), rng.random(100), {"auc": auc})
    assert one["intervals"]["auc"] is None and one["n_clusters"] == 1
    # 6 matches whose AUC differs strongly → match-level CI must be wide
    groups, ys, ps = [], [], []
    for m in range(6):
        y = rng.integers(0, 2, 500)
        signal = 0.2 + 0.15 * m
        p = np.clip(y * signal + rng.random(500) * (1 - signal), 0, 1)
        groups += [f"m{m}"] * 500
        ys.append(y)
        ps.append(p)
    y_all, p_all = np.concatenate(ys), np.concatenate(ps)
    cl = cluster_bootstrap(groups, y_all, p_all, {"auc": auc}, n_boot=300, seed=1)
    frame = cluster_bootstrap([str(i) for i in range(y_all.size)], y_all, p_all, {"auc": auc}, n_boot=300, seed=1)
    w_cluster = cl["intervals"]["auc"]["hi"] - cl["intervals"]["auc"]["lo"]
    w_frame = frame["intervals"]["auc"]["hi"] - frame["intervals"]["auc"]["lo"]
    assert w_cluster > w_frame


def test_capacity_estimate_arithmetic(tmp_path: Path) -> None:
    mb = 1e6
    bench = {
        "n_committed": 2,
        "summary": {
            "bytes_by_table": {
                "ticks": {"mean": 8 * mb, "p95": 10 * mb},
                "grenade_samples": {"mean": 0.5 * mb, "p95": 1 * mb},
                "events": {"mean": 0.1 * mb, "p95": 0.2 * mb},
                "features": {"mean": 5 * mb, "p95": 6 * mb},
            },
            "raw_bytes": {"mean": 100 * mb, "p95": 200 * mb},
            "metadata_bytes": {"mean": 20000, "p95": 30000},
            "wall_s": {"mean": 10.0},
        },
    }
    p = tmp_path / "bench.json"
    p.write_text(json.dumps(bench))
    est = estimate_capacity(p, maps=9, demos_per_map=1000, budget_gb=2000, raw_queue_demos=100, curated_raw_fraction=0.01)
    rows = {r["category"]: r for r in est["categories"]}
    assert rows["sampled_state"]["projected_gb_p95"] == pytest.approx(9000 * 11 * mb / 1e9)
    assert rows["sampled_state"]["projected_gb_mean"] == pytest.approx(9000 * 8.5 * mb / 1e9)
    assert rows["raw_ingest"]["projected_gb_p95"] == pytest.approx(100 * 200 * mb / 1e9)
    assert rows["curated_raw"]["projected_gb_mean"] == pytest.approx(9000 * 0.01 * 100 * mb / 1e9)
    assert rows["models"]["projected_gb_p95"] is None
    reserved = ALLOCATIONS_GB["models"] + ALLOCATIONS_GB["clips"]
    measured = sum(r["projected_gb_p95"] for r in est["categories"] if r["projected_gb_p95"] is not None)
    assert est["projected_total_gb_p95_with_reserved"] == pytest.approx(measured + reserved, abs=0.05)
    assert est["max_demos_per_map_in_sampled_state_allocation_p95"] == int(600e9 / (9 * 11 * mb))
    assert est["single_worker_hours_for_all_demos_mean"] == pytest.approx(9000 * 10 / 3600, abs=0.1)
