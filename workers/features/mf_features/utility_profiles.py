"""``measure-utility``: per-type utility lifecycle profiles measured from demos.

Output profiles follow ``UtilityTypeProfile`` in ``packages/cs2-state/src/utility/profiles.ts``
(``source: "measured_from_demos"``). Only lifecycle quantities with exact event support are
measured; ``activation``, ``effectRadiusUnits`` and ``editorialWeight`` are copied from the TS
defaults and listed under ``measurement.copiedFromDefaults``. Types whose primary quantity has
fewer than ``min_samples`` measurements are omitted with a reason.

Definitions (ticks converted with each dataset's derived tick rate):

* ``fuse``: first observed projectile frame → activation event (``hegrenade_detonate``,
  ``flashbang_detonate``, ``inferno_startburn``). Frame quantisation: SourceTV demos record every
  3 ticks, so first-seen can trail the true spawn by up to 2 ticks (≈31 ms at 64 tick).
* ``fuseFromWeaponFire``: tick-matched ``weapon_fire`` → activation (reported, not used by TS).
* ``effectDuration``: activation → end event (``smokegrenade_expired``, ``inferno_expire``,
  ``decoy_detonate``), both exact event ticks.
* gravity: quadratic fit ``z(t)`` over the airborne prefix (``m_nBounces == 0`` or, if the
  property is missing, until the first vertical bounce) of each projectile trajectory.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import polars as pl

from mf_common import __version__, errors
from mf_common.datasets import DatasetRef, discover, require_usable
from mf_common.emit import Emitter
from mf_common.fsutil import utc_now, write_json_atomic

ACTIVATION_KIND = {
    "he": "fuse",
    "flashbang": "fuse",
    "smoke": "at_rest",
    "molotov": "impact_or_fuse",
    "incendiary": "impact_or_fuse",
    "decoy": "at_rest",
}
#: Copied from DEFAULT_PROFILES in profiles.ts (not measured here).
DEFAULT_RADIUS = {"he": 350, "flashbang": None, "smoke": 144, "molotov": 150, "incendiary": 150, "decoy": None}
DEFAULT_WEIGHT = {"he": 0.8, "flashbang": 0.7, "smoke": 0.5, "molotov": 0.65, "incendiary": 0.65, "decoy": 0.1}
PRIMARY = {
    "he": "fuse",
    "flashbang": "fuse",
    "smoke": "effectDuration",
    "molotov": "effectDuration",
    "incendiary": "effectDuration",
    "decoy": "effectDuration",
}
USES_FUSE = {"he", "flashbang", "molotov", "incendiary"}
HAS_EFFECT = {"smoke", "molotov", "incendiary", "decoy"}
MIN_TYPE_CONFIDENCE = 0.9


def describe(values: list[float]) -> dict[str, Any]:
    if not values:
        return {"n": 0}
    a = np.asarray(values, dtype=float)
    return {
        "n": int(a.size),
        "meanMs": round(float(a.mean()), 1),
        "sdMs": round(float(a.std(ddof=1)) if a.size > 1 else 0.0, 1),
        "medianMs": round(float(np.median(a)), 1),
        "p05Ms": round(float(np.percentile(a, 5)), 1),
        "p95Ms": round(float(np.percentile(a, 95)), 1),
        "minMs": round(float(a.min()), 1),
        "maxMs": round(float(a.max()), 1),
    }


def collect_durations(refs: list[DatasetRef]) -> tuple[dict[str, dict[str, list[float]]], dict[str, dict[str, str]]]:
    """Event-linked durations per type, plus ``type → {dataset_id: build}`` of contributing datasets."""
    out: dict[str, dict[str, list[float]]] = {}
    contributors: dict[str, dict[str, str]] = {}
    for ref in refs:
        g = pl.read_parquet(ref.path / "grenades.parquet")
        if g.height == 0:
            continue
        rate = ref.tick_rate
        g = g.filter(pl.col("type_confidence") >= MIN_TYPE_CONFIDENCE)
        for row in g.iter_rows(named=True):
            t = row["type"]
            q = out.setdefault(t, {"fuse": [], "fuseFromWeaponFire": [], "effectDuration": []})
            exact_activation = row["activation_evidence"] in ("event_entityid", "event_time_position")
            if exact_activation and row["activation_tick"] is not None:
                contributors.setdefault(t, {})[ref.dataset_id] = ref.build
                q["fuse"].append((row["activation_tick"] - row["first_seen_tick"]) / rate * 1000.0)
                if row["throw_tick_evidence"] == "event:weapon_fire":
                    q["fuseFromWeaponFire"].append((row["activation_tick"] - row["throw_tick"]) / rate * 1000.0)
                if row["expire_tick"] is not None:
                    q["effectDuration"].append((row["expire_tick"] - row["activation_tick"]) / rate * 1000.0)
    return out, contributors


def measured_on(datasets: dict[str, str]) -> str:
    builds = sorted(set(datasets.values()))
    n = len(datasets)
    return f"cs2 builds {','.join(builds)} ({n} demo{'s' if n != 1 else ''} with event-linked samples)"


def airborne_prefix(z: np.ndarray, bounces: np.ndarray | None) -> int:
    """Number of leading samples before the first bounce."""
    if bounces is not None and bounces.size and not np.all(np.isnan(bounces)):
        nz = np.where(np.nan_to_num(bounces, nan=0.0) > 0)[0]
        return int(nz[0]) if nz.size else int(z.size)
    vz = np.diff(z)
    for i in range(1, vz.size):
        if vz[i - 1] < 0 <= vz[i]:
            return i + 1
    return int(z.size)


def fit_gravity(refs: list[DatasetRef], min_points: int = 8, min_duration_s: float = 0.3, max_rms: float = 2.0) -> dict[str, Any]:
    fits: dict[str, list[tuple[float, float]]] = {}
    rejected = 0
    for ref in refs:
        samples = pl.read_parquet(ref.path / "grenade_samples.parquet")
        g = pl.read_parquet(ref.path / "grenades.parquet", columns=["grenade_id", "type", "type_confidence", "activation_tick"])
        g = g.filter(pl.col("type_confidence") >= MIN_TYPE_CONFIDENCE)
        types = dict(zip(g["grenade_id"].to_list(), g["type"].to_list(), strict=True))
        act = dict(zip(g["grenade_id"].to_list(), g["activation_tick"].to_list(), strict=True))
        rate = ref.tick_rate
        for (gid,), part in samples.sort(["grenade_id", "tick"]).group_by(["grenade_id"], maintain_order=True):
            if gid not in types:
                continue
            part = part.filter(pl.col("z").is_not_null())
            if act.get(gid) is not None:
                part = part.filter(pl.col("tick") <= act[gid])
            if part.height < min_points:
                continue
            t = (part["tick"].to_numpy() - part["tick"][0]) / rate
            z = part["z"].to_numpy().astype(float)
            b = part["bounces"].to_numpy().astype(float) if part["bounces"].null_count() < part.height else None
            n = airborne_prefix(z, b)
            if n < min_points or t[n - 1] < min_duration_s:
                continue
            coef, res, *_ = np.polyfit(t[:n], z[:n], 2, full=True)
            rms = float(np.sqrt(res[0] / n)) if len(res) else 0.0
            if rms > max_rms:
                rejected += 1
                continue
            fits.setdefault(types[gid], []).append((-2.0 * float(coef[0]), rms))

    def summarize(vals: list[tuple[float, float]]) -> dict[str, Any]:
        g_ = np.asarray([v[0] for v in vals])
        r_ = np.asarray([v[1] for v in vals])
        return {
            "n": int(g_.size),
            "gravityMedian": round(float(np.median(g_)), 2),
            "gravityMean": round(float(g_.mean()), 2),
            "gravitySd": round(float(g_.std(ddof=1)) if g_.size > 1 else 0.0, 2),
            "residualRmsMedian": round(float(np.median(r_)), 3),
            "residualRmsP95": round(float(np.percentile(r_, 95)), 3),
        }

    all_fits = [v for vs in fits.values() for v in vs]
    return {
        "units": "world units / s^2",
        "method": "per-projectile quadratic fit z(t) over the airborne prefix (before first bounce and before activation)",
        "minPoints": min_points,
        "minDurationS": min_duration_s,
        "maxResidualRms": max_rms,
        "rejectedFits": rejected,
        "overall": summarize(all_fits) if all_fits else {"n": 0},
        "byType": {t: summarize(v) for t, v in sorted(fits.items())},
    }


def measure_utility(
    dataset_paths: list[Path],
    out: Path,
    emitter: Emitter,
    min_samples: int = 5,
    allow_unvalidated: bool = False,
) -> dict[str, Any]:
    refs, skipped = require_usable(discover(dataset_paths), allow_unvalidated)
    if not refs:
        raise errors.MfError(errors.INSUFFICIENT_DATA, "no usable datasets", skipped=skipped)
    emitter.progress("durations", 0.2, datasets=len(refs))
    q, contributors = collect_durations(refs)
    builds = sorted({r.build for r in refs})
    profiles: dict[str, Any] = {}
    omitted: dict[str, str] = {}
    for t in ("he", "flashbang", "smoke", "molotov", "incendiary", "decoy"):
        stats = {k: describe(v) for k, v in q.get(t, {}).items()}
        primary = PRIMARY[t]
        n_primary = stats.get(primary, {}).get("n", 0)
        if n_primary < min_samples:
            omitted[t] = f"{primary}: {n_primary} event-linked samples < {min_samples}"
            continue
        fuse = None
        notes: list[str] = []
        if t in USES_FUSE:
            fs = stats.get("fuse", {"n": 0})
            if fs["n"] >= min_samples:
                fuse = {"meanMs": fs["meanMs"], "sdMs": fs["sdMs"]}
            else:
                notes.append(f"fuse not measured: {fs['n']} samples")
        effect = None
        if t in HAS_EFFECT:
            es = stats.get("effectDuration", {"n": 0})
            if es["n"] >= min_samples:
                effect = {"meanMs": es["meanMs"], "sdMs": es["sdMs"]}
            else:
                notes.append(f"effectDuration not measured: {es['n']} samples")
        profiles[t] = {
            "type": t,
            "activation": ACTIVATION_KIND[t],
            "fuse": fuse,
            "effectDuration": effect,
            "effectRadiusUnits": DEFAULT_RADIUS[t],
            "editorialWeight": DEFAULT_WEIGHT[t],
            "source": "measured_from_demos",
            "sampleCount": int(n_primary),
            "measuredOn": measured_on(contributors.get(t, {})),
            "measurement": {
                "datasets": sorted(contributors.get(t, {})),
                "primaryQuantity": primary,
                "quantities": stats,
                "measuredFields": [f for f, v in (("fuse", fuse), ("effectDuration", effect)) if v is not None],
                "copiedFromDefaults": ["activation", "effectRadiusUnits", "editorialWeight"],
                "notes": notes,
            },
        }
    emitter.progress("gravity", 0.6)
    gravity = fit_gravity(refs)
    doc = {
        "schemaVersion": 1,
        "source": "measured_from_demos",
        "createdBy": f"matchframe-workers {__version__} mf_features.utility_profiles",
        "createdAt": utc_now(),
        "datasets": [r.dataset_id for r in refs],
        "datasetsSkipped": skipped,
        "builds": builds,
        "lifecycleDatasets": sorted({ds for group in contributors.values() for ds in group}),
        "minSamples": min_samples,
        "minTypeConfidence": MIN_TYPE_CONFIDENCE,
        "profiles": profiles,
        "omitted": omitted,
        "gravity": gravity,
        "definitions": {
            "fuse": "first observed projectile frame -> activation event tick",
            "fuseFromWeaponFire": "tick-matched weapon_fire event -> activation event tick",
            "effectDuration": "activation event tick -> end event tick (smokegrenade_expired / inferno_expire / decoy_detonate)",
        },
    }
    write_json_atomic(Path(out), doc)
    return {
        "out": str(out),
        "datasets_used": doc["datasets"],
        "datasets_skipped": skipped,
        "profiles": {
            t: {"sampleCount": p["sampleCount"], "fuse": p["fuse"], "effectDuration": p["effectDuration"]} for t, p in profiles.items()
        },
        "omitted": omitted,
        "gravity_overall": gravity["overall"],
    }
