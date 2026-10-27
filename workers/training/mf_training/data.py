"""Loading feature/label matrices for a split of a frozen dataset manifest."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl

from mf_common import errors
from mf_common.fsutil import read_json

TASK_LABELS = {"contact_2s": "contact_2s"}


@dataclass
class SplitData:
    X: np.ndarray
    y: np.ndarray
    groups: list[str]
    maps: list[str]
    builds: list[str]
    feature_names: list[str]
    frame: pl.DataFrame

    @property
    def n(self) -> int:
        return int(self.y.size)


def load_manifest(path: Path) -> dict[str, Any]:
    doc = read_json(Path(path))
    if doc.get("kind") != "frozen_dataset_manifest":
        raise errors.MfError(errors.DATASET_INVALID, f"{path} is not a frozen dataset manifest")
    return doc


def load_split(manifest: dict[str, Any], split: str, label: str, feature_names: list[str]) -> SplitData:
    members = [m for m in manifest["members"] if m["split"] == split]
    missing = [m["dataset_id"] for m in members if not (Path(m["path"]) / "features.parquet").exists()]
    if missing:
        raise errors.MfError(errors.FEATURES_MISSING, f"run build-features first for {len(missing)} dataset(s)", datasets=missing)
    frames = []
    for m in members:
        d = Path(m["path"])
        f = pl.read_parquet(d / "features.parquet")
        lab = pl.read_parquet(d / "labels.parquet", columns=["dataset_id", "round_index", "tick", "a_id", "b_id", label])
        j = f.join(lab, on=["dataset_id", "round_index", "tick", "a_id", "b_id"], how="inner").filter(pl.col(label).is_not_null())
        frames.append(j.with_columns(pl.lit(m["map"]).alias("_map"), pl.lit(m["build"]).alias("_build")))
    if not frames:
        empty = pl.DataFrame()
        return SplitData(np.zeros((0, len(feature_names)), dtype=np.float64), np.zeros(0), [], [], [], feature_names, empty)
    df = pl.concat(frames, how="vertical_relaxed")
    X = df.select([pl.col(c).cast(pl.Float64) for c in feature_names]).to_numpy()
    y = df[label].cast(pl.Int8).to_numpy().astype(np.float64)
    return SplitData(X, y, df["dataset_id"].to_list(), df["_map"].to_list(), df["_build"].to_list(), feature_names, df)


def heuristic_score(frame: pl.DataFrame) -> np.ndarray:
    """Deterministic distance/facing heuristic: high when close and either player faces the other."""
    dist = frame["dist_3d"].cast(pl.Float64).fill_null(4000.0).to_numpy()
    facing = frame["facing_max"].cast(pl.Float64).fill_null(-1.0).to_numpy()
    return np.clip((facing + 1.0) / 2.0, 0.0, 1.0) ** 2 * np.exp(-dist / 1000.0)
