"""``build-map-pack``: MapPack JSON from real player positions labelled with demo place names.

Geometry source: alive-player samples from committed datasets, each carrying the engine's
``last_place_name`` (navmesh place). Nothing here is authored or recalled:

* one Region per place, ``cells`` shape (voxels with ≥ ``min_cell_samples`` samples),
  ``source: demo_place_names``, ``validated: false``;
* region kind from the name only: ``Bombsite*`` → bombsite, ``*Spawn`` → spawn,
  ``Mid`` / ``Middle`` / ``TopofMid`` → mid, everything else → other;
* ``floorGrid`` from player Z per XY cell, clustered into stacked floors;
* a single ``ground`` level (no level split is invented), ``radar: null`` (no overview
  calibration available), no cameras or paths;
* optional derived splits (Inferno ``Banana`` → ``bottom_banana`` / ``top_banana``) along the
  region's principal axis, tagged ``derived_split`` + ``requires_operator_validation``.

A place-transition adjacency graph is written to a separate ``<map>.graph.json``.
"""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl

from mf_common import __version__, errors
from mf_common.datasets import DatasetRef, discover, require_usable
from mf_common.emit import Emitter, dumps_readable
from mf_common.fsutil import utc_now, write_text_atomic

from .map_pack_schema import validate_map_pack

DISPLAY_NAMES = {
    "de_inferno": "Inferno",
    "de_mirage": "Mirage",
    "de_dust2": "Dust II",
    "de_nuke": "Nuke",
    "de_ancient": "Ancient",
    "de_anubis": "Anubis",
    "de_overpass": "Overpass",
    "de_train": "Train",
    "de_vertigo": "Vertigo",
}

MID_NAMES = {"Mid", "Middle", "TopofMid"}

#: Derived splits: map → (source place, reference place, near-half id/name, far-half id/name).
DERIVED_SPLITS: dict[str, list[dict[str, str]]] = {
    "de_inferno": [
        {
            "place": "Banana",
            "reference": "TSpawn",
            "near_id": "bottom_banana",
            "near_name": "Bottom Banana (derived)",
            "far_id": "top_banana",
            "far_name": "Top Banana (derived)",
        }
    ]
}


@dataclass(frozen=True)
class MapPackSettings:
    cell_size: float = 64.0
    z_cell_size: float = 128.0
    floor_cell_size: float = 64.0
    min_cell_samples: int = 2
    floor_gap_units: float = 72.0
    floor_min_samples: int = 3
    max_bytes: int = 1_500_000
    graph_min_transitions: int = 2


def region_kind(place: str) -> str:
    if place.startswith("Bombsite"):
        return "bombsite"
    if place.endswith("Spawn"):
        return "spawn"
    if place in MID_NAMES:
        return "mid"
    return "other"


def region_id(place: str) -> str:
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", place)
    s = re.sub(r"([a-z\d])([A-Z])", r"\1_\2", s)
    return re.sub(r"[^a-z0-9_]+", "_", s.lower()).strip("_")


def load_position_samples(refs: list[DatasetRef]) -> pl.DataFrame:
    frames = []
    for ref in refs:
        t = pl.read_parquet(
            ref.path / "ticks.parquet",
            columns=["tick", "round_index", "player_id", "is_alive", "x", "y", "z", "place", "dt"],
        )
        t = t.filter(
            pl.col("is_alive").fill_null(False) & pl.col("x").is_not_null() & pl.col("y").is_not_null() & pl.col("z").is_not_null()
        ).with_columns(pl.lit(ref.dataset_id).alias("dataset_id"))
        frames.append(t)
    if not frames:
        return pl.DataFrame()
    return pl.concat(frames)


def build_cells(samples: pl.DataFrame, cell: float, zcell: float, min_samples: int) -> pl.DataFrame:
    """(place, ix, iy, iz, n) for voxels with at least ``min_samples`` samples of that place."""
    named = samples.filter(pl.col("place").is_not_null() & (pl.col("place") != ""))
    return (
        named.with_columns(
            (pl.col("x") / cell).floor().cast(pl.Int64).alias("ix"),
            (pl.col("y") / cell).floor().cast(pl.Int64).alias("iy"),
            (pl.col("z") / zcell).floor().cast(pl.Int64).alias("iz"),
        )
        .group_by(["place", "ix", "iy", "iz"])
        .len("n")
        .filter(pl.col("n") >= min_samples)
        .sort(["place", "ix", "iy", "iz"])
    )


def cluster_floors(zs: np.ndarray, gap: float, min_samples: int) -> list[float]:
    """Split sorted Z samples where consecutive values differ by more than ``gap``; median per floor."""
    if zs.size == 0:
        return []
    zs = np.sort(zs)
    breaks = np.where(np.diff(zs) > gap)[0]
    groups = np.split(zs, breaks + 1)
    return [round(float(np.median(g)), 1) for g in groups if g.size >= min_samples]


def build_floor_grid(samples: pl.DataFrame, settings: MapPackSettings) -> dict[str, Any]:
    fc = settings.floor_cell_size
    grouped = (
        samples.with_columns(
            (pl.col("x") / fc).floor().cast(pl.Int64).alias("fx"),
            (pl.col("y") / fc).floor().cast(pl.Int64).alias("fy"),
        )
        .group_by(["fx", "fy"])
        .agg(pl.col("z").alias("zs"))
        .sort(["fx", "fy"])
    )
    cells: list[list[float]] = []
    multi = 0
    for fx, fy, zs in grouped.iter_rows():
        floors = cluster_floors(np.asarray(zs, dtype=float), settings.floor_gap_units, settings.floor_min_samples)
        if floors:
            cells.append([int(fx), int(fy), *floors])
            multi += len(floors) > 1
    return {
        "cellSize": fc,
        "cells": cells,
        "source": "demo_player_positions",
        "sampleCount": int(samples.height),
        "_multi_floor_cells": multi,
    }


def principal_axis_split(
    cells: pl.DataFrame, cell_size: float, reference_xy: tuple[float, float]
) -> tuple[pl.DataFrame, pl.DataFrame, dict[str, Any]]:
    """Split cells along the sample-weighted principal XY axis at the weighted median projection.

    Returns ``(near, far, info)`` where *near* is the half whose weighted centroid is closer to
    ``reference_xy``. Cells sharing an XY column always land in the same half.
    """
    xy = cells.group_by(["ix", "iy"]).agg(pl.col("n").sum()).sort(["ix", "iy"])
    cx = (xy["ix"].to_numpy() + 0.5) * cell_size
    cy = (xy["iy"].to_numpy() + 0.5) * cell_size
    w = xy["n"].to_numpy().astype(float)
    mean = np.array([np.average(cx, weights=w), np.average(cy, weights=w)])
    pts = np.stack([cx, cy], axis=1) - mean
    cov = (pts * w[:, None]).T @ pts / w.sum()
    evals, evecs = np.linalg.eigh(cov)
    axis = evecs[:, int(np.argmax(evals))]
    proj = pts @ axis
    order = np.argsort(proj)
    cum = np.cumsum(w[order])
    cut = proj[order][int(np.searchsorted(cum, cum[-1] / 2.0))]
    side_a = proj <= cut
    xy = xy.with_columns(pl.Series("side_a", side_a))

    def centroid(mask: np.ndarray) -> np.ndarray:
        return np.array([np.average(cx[mask], weights=w[mask]), np.average(cy[mask], weights=w[mask])])

    ca, cb = centroid(side_a), centroid(~side_a)
    ref = np.asarray(reference_xy)
    a_is_near = float(np.linalg.norm(ca - ref)) <= float(np.linalg.norm(cb - ref))
    joined = cells.join(xy.select("ix", "iy", "side_a"), on=["ix", "iy"], how="left")
    near = joined.filter(pl.col("side_a") == a_is_near).drop("side_a")
    far = joined.filter(pl.col("side_a") != a_is_near).drop("side_a")
    info = {
        "principal_axis": [round(float(axis[0]), 4), round(float(axis[1]), 4)],
        "explained_variance_ratio": round(float(evals.max() / evals.sum()), 4) if evals.sum() > 0 else None,
        "split_projection": round(float(cut), 1),
        "near_centroid": [round(float(x), 1) for x in (ca if a_is_near else cb)],
        "far_centroid": [round(float(x), 1) for x in (cb if a_is_near else ca)],
        "reference_xy": [round(float(x), 1) for x in ref],
    }
    return near, far, info


def place_centroid(samples: pl.DataFrame, place: str) -> tuple[float, float] | None:
    sub = samples.filter(pl.col("place") == place)
    if sub.height == 0:
        return None
    return float(sub["x"].mean()), float(sub["y"].mean())  # type: ignore[arg-type]


def build_graph(samples: pl.DataFrame, min_transitions: int, max_gap_s: float = 1.0) -> dict[str, Any]:
    """Undirected place adjacency from consecutive samples of the same player within a round."""
    named = samples.filter(pl.col("place").is_not_null() & (pl.col("place") != "")).sort(["dataset_id", "round_index", "player_id", "tick"])
    keys = ["dataset_id", "round_index", "player_id"]
    named = named.with_columns(
        pl.col("place").shift(1).over(keys).alias("prev_place"),
        pl.col("dt").alias("gap"),
    )
    trans = named.filter(pl.col("prev_place").is_not_null() & (pl.col("prev_place") != pl.col("place")) & (pl.col("gap") <= max_gap_s))
    directed = trans.group_by(["prev_place", "place"]).len("n")
    undirected: dict[tuple[str, str], dict[str, int]] = {}
    for a, b, n in directed.iter_rows():
        k = (a, b) if a < b else (b, a)
        e = undirected.setdefault(k, {"a_to_b": 0, "b_to_a": 0})
        e["a_to_b" if (a, b) == k else "b_to_a"] += int(n)
    edges = [
        {"a": region_id(a), "b": region_id(b), "transitions": v["a_to_b"] + v["b_to_a"], "a_to_b": v["a_to_b"], "b_to_a": v["b_to_a"]}
        for (a, b), v in sorted(undirected.items())
        if v["a_to_b"] + v["b_to_a"] >= min_transitions
    ]
    counts = named.group_by("place").len("n").sort("place")
    nodes = [{"id": region_id(p), "place": p, "sampleCount": int(n)} for p, n in counts.iter_rows()]
    return {"nodes": nodes, "edges": edges, "transitionsObserved": int(trans.height)}


def _render(pack: dict[str, Any]) -> str:
    return dumps_readable(pack)


def build_map_pack(
    dataset_paths: list[Path],
    map_name: str,
    out: Path,
    emitter: Emitter,
    settings: MapPackSettings | None = None,
    graph_out: Path | None = None,
    allow_unvalidated: bool = False,
) -> dict[str, Any]:
    settings = settings or MapPackSettings()
    refs_all = discover(dataset_paths, map_name=map_name)
    refs, skipped = require_usable(refs_all, allow_unvalidated)
    if not refs:
        raise errors.MfError(
            errors.INSUFFICIENT_DATA,
            f"no usable datasets for {map_name}; refusing to build a pack without data",
            skipped=skipped,
        )
    emitter.progress("load", 0.1, datasets=len(refs))
    samples = load_position_samples(refs)
    if samples.height == 0:
        raise errors.MfError(errors.INSUFFICIENT_DATA, f"no alive position samples for {map_name}")

    cell, zcell = settings.cell_size, settings.z_cell_size
    attempts: list[dict[str, Any]] = []
    while True:
        emitter.progress("regions", 0.4, cell_size=cell)
        pack, stats = _assemble(samples, refs, map_name, settings, cell, zcell)
        text = _render(pack)
        attempts.append({"cell_size": cell, "z_cell_size": zcell, "bytes": len(text.encode("utf-8"))})
        if len(text.encode("utf-8")) <= settings.max_bytes or cell >= 512:
            break
        cell *= 1.5
    issues = validate_map_pack(pack)
    if issues:
        raise errors.MfError(errors.SCHEMA_INVALID, "generated pack does not match the MapPack contract", issues=issues[:20])
    write_text_atomic(Path(out), text)
    result: dict[str, Any] = {
        "map": map_name,
        "out": str(out),
        "bytes": len(text.encode("utf-8")),
        "datasets_used": [r.dataset_id for r in refs],
        "datasets_skipped": skipped,
        "size_attempts": attempts,
        **stats,
    }
    if graph_out is not None:
        graph = build_graph(samples, settings.graph_min_transitions)
        gdoc = {
            "schemaVersion": 1,
            "mapName": map_name,
            "source": "demo_place_name_transitions",
            "description": "Undirected region adjacency from observed place-name transitions of alive players "
            "(consecutive samples ≤ 1 s apart within a round). Not part of the MapPack schema.",
            "minTransitions": settings.graph_min_transitions,
            **graph,
            "provenance": pack["provenance"],
        }
        write_text_atomic(Path(graph_out), dumps_readable(gdoc))
        result["graph_out"] = str(graph_out)
        result["graph_nodes"] = len(graph["nodes"])
        result["graph_edges"] = len(graph["edges"])
    return result


def _assemble(
    samples: pl.DataFrame,
    refs: list[DatasetRef],
    map_name: str,
    settings: MapPackSettings,
    cell: float,
    zcell: float,
) -> tuple[dict[str, Any], dict[str, Any]]:
    cells = build_cells(samples, cell, zcell, settings.min_cell_samples)
    place_counts = dict(samples.filter(pl.col("place").is_not_null() & (pl.col("place") != "")).group_by("place").len("n").iter_rows())
    regions: list[dict[str, Any]] = []
    for place in sorted(place_counts):
        pc = cells.filter(pl.col("place") == place)
        if pc.height == 0:
            continue
        regions.append(
            {
                "id": region_id(place),
                "name": place,
                "kind": region_kind(place),
                "levelId": "ground",
                "shapes": [
                    {
                        "kind": "cells",
                        "cellSize": cell,
                        "zCellSize": zcell,
                        "cells": [[int(a), int(b), int(c)] for a, b, c in pc.select("ix", "iy", "iz").iter_rows()],
                    }
                ],
                "source": "demo_place_names",
                "sampleCount": int(place_counts[place]),
                "validated": False,
                "tags": ["demo_place"],
            }
        )
    derived_info: list[dict[str, Any]] = []
    for spec in DERIVED_SPLITS.get(map_name, []):
        src = cells.filter(pl.col("place") == spec["place"])
        ref_xy = place_centroid(samples, spec["reference"])
        if src.height < 4 or ref_xy is None:
            derived_info.append({"place": spec["place"], "skipped": "insufficient data"})
            continue
        near, far, info = principal_axis_split(src, cell, ref_xy)
        for half, rid, name in ((near, spec["near_id"], spec["near_name"]), (far, spec["far_id"], spec["far_name"])):
            regions.append(
                {
                    "id": rid,
                    "name": name,
                    "kind": "other",
                    "levelId": "ground",
                    "shapes": [
                        {
                            "kind": "cells",
                            "cellSize": cell,
                            "zCellSize": zcell,
                            "cells": [[int(a), int(b), int(c)] for a, b, c in half.select("ix", "iy", "iz").iter_rows()],
                        }
                    ],
                    "source": "demo_place_names",
                    "sampleCount": int(half["n"].sum()),
                    "validated": False,
                    "tags": ["derived_split", "requires_operator_validation", f"derived_from:{region_id(spec['place'])}"],
                }
            )
        derived_info.append(
            {"place": spec["place"], "reference_place": spec["reference"], "near": spec["near_id"], "far": spec["far_id"], **info}
        )
    bombsites = [
        {"site": site, "regionId": region_id(f"Bombsite{site}")}
        for site in ("A", "B")
        if any(r["id"] == region_id(f"Bombsite{site}") for r in regions)
    ]
    z = samples["z"]
    zmin = math.floor(float(z.quantile(0.001)) - 200.0)  # type: ignore[arg-type]
    zmax = math.ceil(float(z.quantile(0.999)) + 600.0)  # type: ignore[arg-type]
    floor = build_floor_grid(samples, settings)
    multi_floor_cells = floor.pop("_multi_floor_cells")
    builds = sorted({r.build for r in refs})
    pack = {
        "schemaVersion": 1,
        "mapName": map_name,
        "displayName": DISPLAY_NAMES.get(map_name, map_name.removeprefix("de_").replace("_", " ").title()),
        "mapRevision": "observed_builds:" + ",".join(builds),
        "radar": None,
        "levels": [{"id": "ground", "name": "Ground", "zMin": zmin, "zMax": zmax, "radar": None}],
        "regions": regions,
        "cameras": [],
        "paths": [],
        "bombsites": bombsites,
        "scenarios": [],
        "floorGrid": floor,
        "coverage": [],
        "provenance": {
            "createdBy": f"matchframe-workers {__version__} mf_features.map_pack",
            "createdAt": utc_now(),
            "sources": [f"dataset:{r.dataset_id}" for r in refs],
        },
    }
    stats = {
        "settings": {**asdict(settings), "cell_size": cell, "z_cell_size": zcell},
        "samples": int(samples.height),
        "regions": len(regions),
        "place_regions": len(place_counts),
        "region_cells": int(sum(len(r["shapes"][0]["cells"]) for r in regions)),
        "floor_cells": len(floor["cells"]),
        "multi_floor_cells": int(multi_floor_cells),
        "bombsites": [b["site"] for b in bombsites],
        "kinds": {k: sum(1 for r in regions if r["kind"] == k) for k in sorted({r["kind"] for r in regions})},
        "derived_splits": derived_info,
        "level_z_range": [zmin, zmax],
    }
    return pack, stats
