"""Binary-classification metrics with cluster (match-level) bootstrap.

Frames from one match are strongly correlated, so confidence intervals resample whole matches
(clusters) with replacement rather than individual frames.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

import numpy as np

Metric = Callable[[np.ndarray, np.ndarray], float | None]


def auc(y: np.ndarray, p: np.ndarray) -> float | None:
    """ROC AUC via the Mann–Whitney U statistic with average ranks for ties."""
    y = np.asarray(y).astype(bool)
    p = np.asarray(p, dtype=float)
    n_pos = int(y.sum())
    n_neg = int(y.size - n_pos)
    if n_pos == 0 or n_neg == 0:
        return None
    _uniq, inverse, counts = np.unique(p, return_inverse=True, return_counts=True)
    avg_rank = np.cumsum(counts) - (counts - 1) / 2.0  # 1-based average rank of each tie block
    ranks = avg_rank[inverse]
    return float((ranks[y].sum() - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg))


def brier(y: np.ndarray, p: np.ndarray) -> float | None:
    if y.size == 0:
        return None
    return float(np.mean((np.asarray(p, dtype=float) - np.asarray(y, dtype=float)) ** 2))


def log_loss(y: np.ndarray, p: np.ndarray, eps: float = 1e-12) -> float | None:
    if y.size == 0:
        return None
    q = np.clip(np.asarray(p, dtype=float), eps, 1 - eps)
    yy = np.asarray(y, dtype=float)
    return float(-np.mean(yy * np.log(q) + (1 - yy) * np.log(1 - q)))


def calibration_bins(y: np.ndarray, p: np.ndarray, n_bins: int = 10) -> list[dict[str, Any]]:
    """Equal-width probability bins: count, mean predicted, observed rate."""
    y = np.asarray(y, dtype=float)
    p = np.asarray(p, dtype=float)
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    idx = np.clip(np.digitize(p, edges[1:-1], right=False), 0, n_bins - 1)
    out = []
    for b in range(n_bins):
        m = idx == b
        n = int(m.sum())
        out.append(
            {
                "bin": b,
                "lo": round(float(edges[b]), 3),
                "hi": round(float(edges[b + 1]), 3),
                "count": n,
                "mean_predicted": round(float(p[m].mean()), 6) if n else None,
                "observed_rate": round(float(y[m].mean()), 6) if n else None,
            }
        )
    return out


def expected_calibration_error(bins: list[dict[str, Any]]) -> float | None:
    total = sum(b["count"] for b in bins)
    if total == 0:
        return None
    return float(sum(b["count"] * abs(b["mean_predicted"] - b["observed_rate"]) for b in bins if b["count"]) / total)


def summarize(y: np.ndarray, p: np.ndarray, n_bins: int = 10) -> dict[str, Any]:
    bins = calibration_bins(y, p, n_bins)
    return {
        "n": int(y.size),
        "positives": int(np.asarray(y).sum()),
        "prevalence": round(float(np.mean(y)), 6) if y.size else None,
        "auc": auc(y, p),
        "brier": brier(y, p),
        "brier_prevalence_baseline": brier(y, np.full(y.size, float(np.mean(y)))) if y.size else None,
        "log_loss": log_loss(y, p),
        "ece": expected_calibration_error(bins),
        "calibration_bins": bins,
    }


def cluster_bootstrap(
    groups: Sequence[str],
    y: np.ndarray,
    p: np.ndarray,
    metrics: dict[str, Metric],
    *,
    n_boot: int = 1000,
    seed: int = 0,
    alpha: float = 0.05,
) -> dict[str, Any]:
    """Percentile CIs from resampling whole groups (matches) with replacement."""
    g = np.asarray(groups)
    uniq = np.unique(g)
    if uniq.size < 2:
        return {
            "n_clusters": int(uniq.size),
            "n_boot": 0,
            "intervals": {k: None for k in metrics},
            "note": "fewer than 2 matches: a match-level confidence interval cannot be estimated",
        }
    idx_by = {u: np.where(g == u)[0] for u in uniq}
    rng = np.random.default_rng(seed)
    samples: dict[str, list[float]] = {k: [] for k in metrics}
    for _ in range(n_boot):
        pick = rng.choice(uniq, size=uniq.size, replace=True)
        idx = np.concatenate([idx_by[u] for u in pick])
        for k, fn in metrics.items():
            v = fn(y[idx], p[idx])
            if v is not None:
                samples[k].append(v)
    intervals: dict[str, Any] = {}
    for k, vals in samples.items():
        if len(vals) < max(10, n_boot // 10):
            intervals[k] = None
            continue
        a = np.asarray(vals)
        intervals[k] = {
            "lo": round(float(np.percentile(a, 100 * alpha / 2)), 6),
            "hi": round(float(np.percentile(a, 100 * (1 - alpha / 2))), 6),
            "valid_resamples": int(a.size),
        }
    return {
        "n_clusters": int(uniq.size),
        "n_boot": n_boot,
        "alpha": alpha,
        "intervals": intervals,
        "note": "match-level (cluster) bootstrap; with few matches intervals are wide and unstable",
    }
