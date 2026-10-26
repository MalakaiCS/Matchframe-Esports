"""``benchmark`` (measured per-demo cost) and ``estimate`` (capacity forecast vs the 2 TB plan)."""

from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

from mf_common import errors
from mf_common.emit import Emitter
from mf_common.fsutil import read_json, utc_now, write_json_atomic

#: Storage plan allocations in GB (spec §17; total 2,000 GB).
ALLOCATIONS_GB: dict[str, float] = {
    "sampled_state": 600.0,
    "events_features": 300.0,
    "raw_ingest": 200.0,
    "curated_raw": 150.0,
    "models": 100.0,
    "clips": 150.0,
    "metadata_logs": 50.0,
    "headroom": 450.0,
}

SAMPLED_STATE_TABLES = ("ticks", "grenade_samples")
EVENTS_FEATURE_TABLES = ("events", "grenades", "rounds", "players", "attributions", "team_scores", "features", "labels")


def _run_cli(args: list[str]) -> tuple[dict[str, Any], float]:
    """Run one CLI command in a child process; return its final JSON line and wall time."""
    t0 = time.monotonic()
    proc = subprocess.run(
        [sys.executable, "-m", "mf_common.cli", *args],
        capture_output=True,
        text=True,
        env=os.environ.copy(),
        check=False,
    )
    wall = time.monotonic() - t0
    last: dict[str, Any] = {"type": "error", "code": errors.INTERNAL, "message": proc.stderr[-500:]}
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if obj.get("type") in ("result", "error"):
                last = obj
    return last, wall


def _stats(values: list[float]) -> dict[str, float | None]:
    if not values:
        return {"n": 0, "p50": None, "p95": None, "mean": None, "min": None, "max": None}
    a = np.asarray(values, dtype=float)
    return {
        "n": int(a.size),
        "p50": round(float(np.percentile(a, 50)), 4),
        "p95": round(float(np.percentile(a, 95)), 4),
        "mean": round(float(a.mean()), 4),
        "min": round(float(a.min()), 4),
        "max": round(float(a.max()), 4),
    }


def _json_bytes(dataset: Path) -> int:
    return sum(p.stat().st_size for p in dataset.glob("*.json"))


def run_benchmark(
    inputs: Path, dataset_root: Path, emitter: Emitter, with_features: bool = False, out: str | None = None
) -> dict[str, Any]:
    demos = sorted(p for p in Path(inputs).glob("*.dem") if p.is_file())
    if not demos:
        raise errors.MfError(errors.INPUT_NOT_FOUND, f"no .dem files in {inputs}", path=str(inputs))
    per_demo: list[dict[str, Any]] = []
    for i, demo in enumerate(demos):
        emitter.progress("extract", i / len(demos), file=demo.name)
        res, proc_wall = _run_cli(["extract", "--input", str(demo), "--dataset-root", str(dataset_root)])
        entry: dict[str, Any] = {"file": demo.name, "size_bytes": demo.stat().st_size, "process_wall_s": round(proc_wall, 3)}
        if res.get("type") == "error":
            entry.update({"status": "error", "error_code": res.get("code"), "error": res.get("message")})
            per_demo.append(entry)
            continue
        entry.update(
            {
                "status": res["status"],
                "dataset": res.get("dataset"),
                "dataset_id": res.get("dataset_id"),
                "map": res.get("map"),
                "build": res.get("build"),
            }
        )
        if res["status"] == "committed":
            entry.update(
                {
                    "wall_s": res["wall_s"],
                    "parse_s": res["parse_s"],
                    "transform_s": res["transform_s"],
                    "throughput_mb_s": res["throughput_mb_s"],
                    "peak_rss_mb": res["peak_rss_mb"],
                    "staging_peak_bytes": res["staging_peak_bytes"],
                    "output_bytes": res["output_bytes"],
                    "bytes_by_table": res["bytes"],
                    "rows_by_table": res["rows"],
                    "recorded_frame_hz": res.get("recorded_frame_hz"),
                }
            )
        if with_features and res.get("dataset"):
            emitter.progress("features", (i + 0.5) / len(demos), file=demo.name)
            fres, fwall = _run_cli(["build-features", "--dataset", res["dataset"], "--force"])
            if fres.get("type") == "result":
                entry["features"] = {
                    "wall_s": fres.get("wall_s"),
                    "process_wall_s": round(fwall, 3),
                    "peak_rss_mb": fres.get("peak_rss_mb"),
                    "bytes": fres.get("bytes"),
                    "rows": fres.get("rows"),
                }
            else:
                entry["features"] = {"error_code": fres.get("code"), "error": fres.get("message")}
        if res.get("dataset"):
            entry["metadata_bytes"] = _json_bytes(Path(res["dataset"]))
        per_demo.append(entry)

    ok = [e for e in per_demo if e.get("status") == "committed"]
    tables = sorted({t for e in ok for t in e["bytes_by_table"]})
    summary: dict[str, Any] = {
        "throughput_mb_s": _stats([e["throughput_mb_s"] for e in ok]),
        "wall_s": _stats([e["wall_s"] for e in ok]),
        "peak_rss_mb": _stats([e["peak_rss_mb"] for e in ok]),
        "staging_peak_bytes": _stats([e["staging_peak_bytes"] for e in ok]),
        "output_bytes": _stats([e["output_bytes"] for e in ok]),
        "output_bytes_per_raw_byte": _stats([e["output_bytes"] / e["size_bytes"] for e in ok]),
        "raw_bytes": _stats([e["size_bytes"] for e in ok]),
        "bytes_by_table": {t: _stats([e["bytes_by_table"].get(t, 0) for e in ok]) for t in tables},
        "metadata_bytes": _stats([e.get("metadata_bytes", 0) for e in ok]),
    }
    feats = [e["features"] for e in ok if isinstance(e.get("features"), dict) and "bytes" in e["features"]]
    if feats:
        summary["features_wall_s"] = _stats([f["wall_s"] for f in feats])
        summary["features_peak_rss_mb"] = _stats([f["peak_rss_mb"] for f in feats])
        for name in ("features", "labels"):
            summary["bytes_by_table"][name] = _stats([f["bytes"].get(name, 0) for f in feats])
    result = {
        "created_at": utc_now(),
        "inputs": str(inputs),
        "dataset_root": str(dataset_root),
        "n_demos": len(demos),
        "n_committed": len(ok),
        "n_duplicate": sum(1 for e in per_demo if e.get("status") == "duplicate"),
        "n_error": sum(1 for e in per_demo if e.get("status") == "error"),
        "per_demo": per_demo,
        "summary": summary,
        "machine": {"cpu_count": os.cpu_count(), "platform": platform.platform(), "python": platform.python_version()},
        "notes": [
            "peak_rss_mb is the extract child process's own ru_maxrss",
            "staging_peak_bytes is the staging directory size just before the atomic rename (temp disk peak)",
            "duplicates are detected before parsing and carry no timing",
        ],
    }
    if out:
        write_json_atomic(Path(out), result)
    return result


def estimate_capacity(
    benchmark_json: Path,
    *,
    maps: int,
    demos_per_map: int,
    budget_gb: float,
    raw_queue_demos: int = 200,
    curated_raw_fraction: float = 0.02,
    out: str | None = None,
) -> dict[str, Any]:
    bench = read_json(Path(benchmark_json))
    summary = bench.get("summary", {})
    by_table: dict[str, dict[str, Any]] = summary.get("bytes_by_table", {})
    if not by_table:
        raise errors.MfError(errors.INSUFFICIENT_DATA, "benchmark has no committed demos")
    n = maps * demos_per_map
    gb = 1e9

    def per_demo(tables: tuple[str, ...], key: str) -> tuple[float, list[str]]:
        total = 0.0
        missing = []
        for t in tables:
            st = by_table.get(t)
            if st is None or st.get(key) is None:
                missing.append(t)
                continue
            total += float(st[key])
        return total, missing

    categories: dict[str, dict[str, Any]] = {}
    for name, tables in (("sampled_state", SAMPLED_STATE_TABLES), ("events_features", EVENTS_FEATURE_TABLES)):
        mean_b, missing = per_demo(tables, "mean")
        p95_b, _ = per_demo(tables, "p95")
        categories[name] = {
            "per_demo_bytes_mean": round(mean_b),
            "per_demo_bytes_p95": round(p95_b),
            "projected_gb_mean": round(n * mean_b / gb, 2),
            "projected_gb_p95": round(n * p95_b / gb, 2),
            "unmeasured_tables": missing,
        }
    raw = summary.get("raw_bytes", {})
    raw_mean = float(raw.get("mean") or 0)
    raw_p95 = float(raw.get("p95") or 0)
    categories["raw_ingest"] = {
        "basis": f"transient queue of {raw_queue_demos} raw demos at p95 size",
        "projected_gb_mean": round(raw_queue_demos * raw_mean / gb, 2),
        "projected_gb_p95": round(raw_queue_demos * raw_p95 / gb, 2),
    }
    categories["curated_raw"] = {
        "basis": f"{curated_raw_fraction:.1%} of demos kept as raw curated samples",
        "projected_gb_mean": round(n * curated_raw_fraction * raw_mean / gb, 2),
        "projected_gb_p95": round(n * curated_raw_fraction * raw_p95 / gb, 2),
    }
    meta = summary.get("metadata_bytes", {})
    categories["metadata_logs"] = {
        "basis": "dataset JSON (manifest, qa, validation) per demo; process logs not measured",
        "projected_gb_mean": round(n * float(meta.get("mean") or 0) / gb, 3),
        "projected_gb_p95": round(n * float(meta.get("p95") or 0) / gb, 3),
    }
    for name in ("models", "clips"):
        categories[name] = {"basis": "not measured by this benchmark; full allocation reserved", "projected_gb_mean": None, "projected_gb_p95": None}

    rows = []
    total_p95 = 0.0
    for name, alloc in ALLOCATIONS_GB.items():
        if name == "headroom":
            continue
        cat = categories.get(name, {})
        proj = cat.get("projected_gb_p95")
        used = float(proj) if proj is not None else alloc
        total_p95 += used
        rows.append(
            {
                "category": name,
                "allocation_gb": alloc,
                "projected_gb_mean": cat.get("projected_gb_mean"),
                "projected_gb_p95": proj,
                "utilization_p95": round(float(proj) / alloc, 4) if proj is not None else None,
                "fits": (float(proj) <= alloc) if proj is not None else None,
                "basis": cat.get("basis"),
            }
        )
    sampled_p95 = categories["sampled_state"]["per_demo_bytes_p95"]
    max_demos_per_map = int(ALLOCATIONS_GB["sampled_state"] * gb / (maps * sampled_p95)) if sampled_p95 else None
    result = {
        "benchmark": str(benchmark_json),
        "benchmark_demos": bench.get("n_committed"),
        "maps": maps,
        "demos_per_map": demos_per_map,
        "total_demos": n,
        "budget_gb": budget_gb,
        "allocations_gb": ALLOCATIONS_GB,
        "categories": rows,
        "projected_total_gb_p95_with_reserved": round(total_p95, 2),
        "headroom_left_gb_p95": round(budget_gb - total_p95, 2),
        "fits_budget_p95": total_p95 <= budget_gb,
        "max_demos_per_map_in_sampled_state_allocation_p95": max_demos_per_map,
        "raw_if_all_kept_gb_mean": round(n * raw_mean / gb, 1),
        "throughput": summary.get("throughput_mb_s"),
        "single_worker_hours_for_all_demos_mean": round(n * float(summary.get("wall_s", {}).get("mean") or 0) / 3600, 1),
        "caveats": [
            f"extrapolated from {bench.get('n_committed')} demos (2023 builds); current-build demos may differ in size and rate",
            "p95 over a handful of demos is a weak tail estimate",
            "models and clips are not measured; their allocations are reserved in full",
        ],
    }
    if out:
        write_json_atomic(Path(out), result)
    return result
