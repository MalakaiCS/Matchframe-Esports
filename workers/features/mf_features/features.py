"""``build-features``: causal pairwise features + separate future labels for one dataset.

Causality contract
------------------
* Samples are the uniform-grid frames (``in_grid``) of live round phases. Event-window frames are
  **never** used as inputs: whether such a frame exists depends on a *future* death or grenade, so
  using it (even as history) would leak.
* Every feature of a row at tick ``t`` is computed from grid rows with ``tick <= t`` only
  (current frame + as-of history). ``max_input_tick`` records the latest input tick and must
  equal ``t``; ``validate`` and the leakage check enforce it.
* Labels (``labels.parquet``, ``utility_labels.parquet``, ``pov_labels.parquet``) look strictly
  into ``(t, t + h]`` and live in separate files; no label column appears in ``features.parquet``.
* ``pov_labels.parquet`` is the hindsight observer: for each live grid frame and alive player,
  whether that player gets a kill, dies, or starts a multi-frag soon, i.e. whether their POV
  would show the action.
"""

from __future__ import annotations

import math
import time
from pathlib import Path
from typing import Any

import polars as pl

from mf_common import errors
from mf_common.datasets import FEATURES_MANIFEST, load_dataset
from mf_common.emit import Emitter
from mf_common.frames import asof_backward
from mf_common.fsutil import read_json, utc_now, write_json_atomic
from mf_common.runtime import peak_rss_mb
from mf_common.tables import write_table

FEATURES_VERSION = 2
HISTORY_S = 0.5
HORIZONS_S: tuple[float, ...] = (0.5, 1.0, 2.0, 3.0)
#: POV label horizons (s): a kill or death this soon is on screen from that player's POV.
POV_HORIZONS_S: tuple[float, ...] = (2.0, 5.0)
#: A multi-frag: two or more kills by the player within this many seconds.
MULTI_FRAG_WINDOW_S = 10.0
KEY_COLUMNS = ["dataset_id", "round_index", "tick", "a_id", "b_id"]

#: Feature name → required source capability (``gsi_compatible`` features are available from a
#: spectator GSI feed at ~10 Hz; ``demo_rich`` ones need demo-level state such as place names).
FEATURE_CAPABILITIES: dict[str, str] = {
    "dist_3d": "gsi_compatible",
    "dist_2d": "gsi_compatible",
    "dz": "gsi_compatible",
    "facing_a": "gsi_compatible",
    "facing_b": "gsi_compatible",
    "facing_max": "gsi_compatible",
    "facing_min": "gsi_compatible",
    "closing_speed": "gsi_compatible",
    "speed_a": "gsi_compatible",
    "speed_b": "gsi_compatible",
    "health_a": "gsi_compatible",
    "health_b": "gsi_compatible",
    "armor_a": "gsi_compatible",
    "armor_b": "gsi_compatible",
    "weapon_class_a": "gsi_compatible",
    "weapon_class_b": "gsi_compatible",
    "alive_t": "gsi_compatible",
    "alive_ct": "gsi_compatible",
    "round_time_s": "gsi_compatible",
    "flash_a": "demo_rich",
    "flash_b": "demo_rich",
    "same_place": "demo_rich",
}
FEATURE_COLUMNS = list(FEATURE_CAPABILITIES)

WEAPON_CLASS: dict[str, int] = {}
for _names, _cls in (
    (("AWP", "SSG 08", "SCAR-20", "G3SG1"), 4),
    (("AK-47", "M4A1-S", "M4A4", "AUG", "SG 553", "FAMAS", "Galil AR", "M249", "Negev"), 3),
    (("MAC-10", "MP5-SD", "MP7", "MP9", "P90", "PP-Bizon", "UMP-45", "Nova", "XM1014", "MAG-7", "Sawed-Off"), 2),
    (("Glock-18", "USP-S", "P2000", "P250", "Five-SeveN", "Tec-9", "CZ75-Auto", "Desert Eagle", "Dual Berettas", "R8 Revolver"), 1),
):
    for _n in _names:
        WEAPON_CLASS[_n] = _cls


def weapon_class_expr(col: str) -> pl.Expr:
    """Ordinal engagement-range class: 4 sniper, 3 rifle/MG, 2 SMG/shotgun, 1 pistol, 0 other."""
    return pl.when(pl.col(col).is_null()).then(None).otherwise(pl.col(col).replace_strict(WEAPON_CLASS, default=0, return_dtype=pl.Int8))


def _view_vec(pitch: str, yaw: str) -> tuple[pl.Expr, pl.Expr, pl.Expr]:
    p = pl.col(pitch).radians()
    y = pl.col(yaw).radians()
    return p.cos() * y.cos(), p.cos() * y.sin(), -p.sin()


def live_grid(ticks: pl.DataFrame, rounds: pl.DataFrame) -> pl.DataFrame:
    """Grid rows of alive T/CT players inside live phases (freeze end .. round end)."""
    live = rounds.filter(~pl.col("is_warmup") & pl.col("freeze_end_tick").is_not_null() & pl.col("end_tick").is_not_null())
    bounds = live.select(
        pl.col("round_index").cast(pl.Int64),
        pl.col("freeze_end_tick").alias("_live_start"),
        pl.col("end_tick").alias("_live_end"),
    )
    g = ticks.filter(pl.col("in_grid") & pl.col("is_alive").fill_null(False) & pl.col("team_num").is_in([2, 3]))
    g = g.with_columns(pl.col("round_index").cast(pl.Int64), pl.col("tick").cast(pl.Int64))
    g = g.join(bounds, on="round_index", how="inner")
    return g.filter((pl.col("tick") >= pl.col("_live_start")) & (pl.col("tick") <= pl.col("_live_end")))


def compute_pair_features(ticks: pl.DataFrame, rounds: pl.DataFrame, tick_rate: float, dataset_id: str) -> pl.DataFrame:
    """Pure function: pairwise T×CT features for every live grid tick (inputs at or before t only)."""
    grid = ticks.filter(pl.col("in_grid")).with_columns(pl.col("tick").cast(pl.Int64), pl.col("round_index").cast(pl.Int64))
    samples = live_grid(ticks, rounds)
    cols = [
        "tick",
        "round_index",
        "_live_start",
        "player_id",
        "x",
        "y",
        "z",
        "vx",
        "vy",
        "pitch",
        "yaw",
        "health",
        "armor",
        "active_weapon",
        "flash_duration",
        "place",
    ]
    teams = samples.select("tick", "player_id", "team_num")
    counts = teams.group_by("tick").agg(
        (pl.col("team_num") == 2).sum().cast(pl.Int16).alias("alive_t"),
        (pl.col("team_num") == 3).sum().cast(pl.Int16).alias("alive_ct"),
    )
    t_side = samples.filter(pl.col("team_num") == 2).select(cols)
    ct_side = samples.filter(pl.col("team_num") == 3).select(cols)
    a = t_side.rename({c: f"a_{c}" for c in cols if c not in ("tick", "round_index", "_live_start")})
    b = ct_side.rename({c: f"b_{c}" for c in cols if c not in ("tick", "round_index", "_live_start")}).drop(["round_index", "_live_start"])
    pairs = a.join(b, on="tick", how="inner").rename({"a_player_id": "a_id", "b_player_id": "b_id"})
    pairs = pairs.join(counts, on="tick", how="left")

    # history (as-of, grid only, strictly <= t - HISTORY_S)
    lag = round(HISTORY_S * tick_rate)
    hist = grid.select(pl.col("player_id"), pl.col("tick").alias("lookup_tick"), pl.col("tick").alias("hist_tick"), "x", "y", "z")
    pairs = pairs.with_columns((pl.col("tick") - lag).alias("lookup_tick"))
    for side in ("a", "b"):
        h = hist.rename(
            {"player_id": f"{side}_id", "hist_tick": f"{side}_hist_tick", "x": f"{side}_hx", "y": f"{side}_hy", "z": f"{side}_hz"}
        )
        pairs = asof_backward(pairs, h, on="lookup_tick", by=f"{side}_id")

    dx = pl.col("b_x") - pl.col("a_x")
    dy = pl.col("b_y") - pl.col("a_y")
    dzc = pl.col("b_z") - pl.col("a_z")
    d3 = (dx**2 + dy**2 + dzc**2).sqrt()
    pairs = pairs.with_columns(
        d3.alias("dist_3d"),
        (dx**2 + dy**2).sqrt().alias("dist_2d"),
        dzc.alias("dz"),
    )
    ax, ay, az = _view_vec("a_pitch", "a_yaw")
    bx, by, bz = _view_vec("b_pitch", "b_yaw")
    safe = pl.when(pl.col("dist_3d") > 1e-3).then(pl.col("dist_3d")).otherwise(None)
    pairs = pairs.with_columns(
        ((ax * dx + ay * dy + az * dzc) / safe).alias("facing_a"),
        ((bx * -dx + by * -dy + bz * -dzc) / safe).alias("facing_b"),
    )
    hist_dist = (
        (pl.col("b_hx") - pl.col("a_hx")) ** 2 + (pl.col("b_hy") - pl.col("a_hy")) ** 2 + (pl.col("b_hz") - pl.col("a_hz")) ** 2
    ).sqrt()
    hist_dt = (pl.col("tick") - (pl.col("a_hist_tick") + pl.col("b_hist_tick")) / 2.0) / tick_rate
    hist_ok = (
        pl.col("a_hist_tick").is_not_null()
        & pl.col("b_hist_tick").is_not_null()
        & (pl.col("a_hist_tick") >= pl.col("_live_start"))
        & (pl.col("b_hist_tick") >= pl.col("_live_start"))
        & (hist_dt >= HISTORY_S * 0.5)
        & (hist_dt <= HISTORY_S * 2.0)
    )
    pairs = pairs.with_columns(
        pl.when(hist_ok).then((hist_dist - pl.col("dist_3d")) / hist_dt).otherwise(None).alias("closing_speed"),
        pl.max_horizontal("facing_a", "facing_b").alias("facing_max"),
        pl.min_horizontal("facing_a", "facing_b").alias("facing_min"),
        (pl.col("a_vx") ** 2 + pl.col("a_vy") ** 2).sqrt().alias("speed_a"),
        (pl.col("b_vx") ** 2 + pl.col("b_vy") ** 2).sqrt().alias("speed_b"),
        pl.col("a_health").cast(pl.Float32).alias("health_a"),
        pl.col("b_health").cast(pl.Float32).alias("health_b"),
        pl.col("a_armor").cast(pl.Float32).alias("armor_a"),
        pl.col("b_armor").cast(pl.Float32).alias("armor_b"),
        weapon_class_expr("a_active_weapon").alias("weapon_class_a"),
        weapon_class_expr("b_active_weapon").alias("weapon_class_b"),
        ((pl.col("tick") - pl.col("_live_start")) / tick_rate).alias("round_time_s"),
        pl.col("a_flash_duration").alias("flash_a"),
        pl.col("b_flash_duration").alias("flash_b"),
        pl.when(pl.col("a_place").is_null() | pl.col("b_place").is_null() | (pl.col("a_place") == "") | (pl.col("b_place") == ""))
        .then(None)
        .otherwise((pl.col("a_place") == pl.col("b_place")).cast(pl.Int8))
        .alias("same_place"),
        pl.max_horizontal("tick", "a_hist_tick", "b_hist_tick").alias("max_input_tick"),
        pl.lit(dataset_id).alias("dataset_id"),
    )
    out = pairs.select(KEY_COLUMNS + FEATURE_COLUMNS + ["max_input_tick"])
    return out.with_columns([pl.col(c).cast(pl.Float32) for c in FEATURE_COLUMNS]).sort(["tick", "a_id", "b_id"])


# --------------------------------------------------------------------------------------------
# Labels
# --------------------------------------------------------------------------------------------


def pair_interactions(attributions: pl.DataFrame, events: pl.DataFrame) -> pl.DataFrame:
    """(tick, p_lo, p_hi, kind) for known attacker/victim interactions (counters ∪ events)."""
    parts = []
    if attributions.height:
        a = attributions.filter(pl.col("status") == "attributed").select(
            "tick", pl.col("attacker_id").alias("u"), pl.col("victim_id").alias("v"), pl.col("kind")
        )
        parts.append(a)
    if events.height:
        e = events.filter(
            pl.col("event_type").is_in(["player_hurt", "player_death"])
            & pl.col("user_id").is_not_null()
            & pl.col("attacker_id").is_not_null()
        ).select(
            "tick",
            pl.col("attacker_id").alias("u"),
            pl.col("user_id").alias("v"),
            pl.when(pl.col("event_type") == "player_death").then(pl.lit("kill")).otherwise(pl.lit("damage")).alias("kind"),
        )
        parts.append(e)
    if not parts:
        return pl.DataFrame(schema={"tick": pl.Int64, "p_lo": pl.Utf8, "p_hi": pl.Utf8, "kind": pl.Utf8})
    df = pl.concat(parts).filter(pl.col("u") != pl.col("v"))
    return (
        df.select(
            pl.col("tick").cast(pl.Int64),
            pl.min_horizontal("u", "v").alias("p_lo"),
            pl.max_horizontal("u", "v").alias("p_hi"),
            "kind",
        )
        .unique()
        .sort("tick")
    )


def kill_ticks(attributions: pl.DataFrame, events: pl.DataFrame) -> pl.DataFrame:
    """(tick, attacker_id, victim_id) of every kill: death events with an attacker, plus kills
    attributed from counters in demos without events. Suicides and duplicates dropped."""
    parts = []
    if events.height:
        parts.append(
            events.filter((pl.col("event_type") == "player_death") & pl.col("user_id").is_not_null()).select(
                pl.col("tick").cast(pl.Int64), "attacker_id", pl.col("user_id").alias("victim_id")
            )
        )
    if attributions.height:
        parts.append(
            attributions.filter((pl.col("status") == "attributed") & (pl.col("kind") == "kill")).select(
                pl.col("tick").cast(pl.Int64), "attacker_id", "victim_id"
            )
        )
    if not parts:
        return pl.DataFrame(schema={"tick": pl.Int64, "attacker_id": pl.Utf8, "victim_id": pl.Utf8})
    return pl.concat(parts).unique(subset=["tick", "victim_id"]).sort("tick")


def compute_pov_labels(ticks: pl.DataFrame, rounds: pl.DataFrame, kills: pl.DataFrame, tick_rate: float, dataset_id: str) -> pl.DataFrame:
    """The hindsight observer: per live grid frame and alive player, looking into ``(t, t + h]``.

    ``kill_<h>`` / ``death_<h>``: the player kills / dies within h; ``action_<h>``: either (their POV
    shows a kill); ``kills_10s``: their kills within the multi-frag window; ``multikill_10s``: two or
    more (a multi-frag starts on their POV).
    """
    import numpy as np

    g = live_grid(ticks, rounds).select("round_index", "tick", "player_id", "team_num")
    by: dict[str, dict[str, np.ndarray]] = {"attacker_id": {}, "victim_id": {}}
    for col in by:
        k = kills.filter(pl.col(col).is_not_null() & (pl.col("attacker_id").is_null() | (pl.col("attacker_id") != pl.col("victim_id"))))
        for pid, grp in k.group_by(col):
            by[col][str(pid[0])] = np.sort(grp["tick"].to_numpy())
    frames = []
    for pid, grp in g.group_by("player_id"):
        t = grp["tick"].to_numpy()
        cols: dict[str, Any] = {}
        empty = np.array([], dtype=np.int64)
        kt = by["attacker_id"].get(str(pid[0]), empty)
        dt = by["victim_id"].get(str(pid[0]), empty)

        def within(ev: np.ndarray, sec: float) -> np.ndarray:
            return np.searchsorted(ev, t + round(sec * tick_rate), side="right") - np.searchsorted(ev, t, side="right")

        for h in POV_HORIZONS_S:
            tag = f"{h:g}s"
            k_n, d_n = within(kt, h), within(dt, h)
            cols[f"kill_{tag}"] = (k_n > 0).astype(np.int8)
            cols[f"death_{tag}"] = (d_n > 0).astype(np.int8)
            cols[f"action_{tag}"] = ((k_n + d_n) > 0).astype(np.int8)
        multi = within(kt, MULTI_FRAG_WINDOW_S)
        cols["kills_10s"] = np.minimum(multi, 127).astype(np.int8)
        cols["multikill_10s"] = (multi >= 2).astype(np.int8)
        frames.append(grp.with_columns(**{c: pl.Series(v) for c, v in cols.items()}))
    if not frames:
        return pl.DataFrame()
    return pl.concat(frames).with_columns(pl.lit(dataset_id).alias("dataset_id")).select("dataset_id", pl.exclude("dataset_id")).sort("tick", "player_id")


def damage_attribution_rate(attributions: pl.DataFrame) -> float:
    d = attributions.filter(pl.col("kind") == "damage")
    if d.height == 0:
        return 0.0
    return float((d["status"] == "attributed").sum()) / d.height


def compute_labels(
    keys: pl.DataFrame, attributions: pl.DataFrame, events: pl.DataFrame, tick_rate: float
) -> tuple[pl.DataFrame, dict[str, Any]]:
    """Future-outcome labels for each (tick, a, b) key in ``(t, t + h]``.

    1 = an attributed damage/kill between the pair; 0 = none; null = unknown (an ambiguous
    attribution touched either player before any positive, or damage attribution is unavailable
    for this dataset).
    """
    rate = damage_attribution_rate(attributions)
    available = rate >= 0.5
    inter = pair_interactions(attributions, events)
    k = keys.with_columns(
        pl.min_horizontal("a_id", "b_id").alias("p_lo"), pl.max_horizontal("a_id", "b_id").alias("p_hi"), pl.col("tick").cast(pl.Int64)
    )
    out = keys.select(KEY_COLUMNS)
    amb = attributions.filter(pl.col("status") == "ambiguous").select(pl.col("tick").cast(pl.Int64), pl.col("victim_id"))
    for kind_label, kinds in (("damage", ["damage"]), ("death", ["kill"]), ("contact", ["damage", "kill"])):
        nxt = (
            inter.filter(pl.col("kind").is_in(kinds))
            .select("p_lo", "p_hi", pl.col("tick").alias("_on"), pl.col("tick").alias(f"_next_{kind_label}"))
            .unique()
        )
        joined = (
            k.with_columns(pl.col("tick").alias("_on"))
            .sort("_on")
            .join_asof(
                nxt.sort("_on"), on="_on", by=["p_lo", "p_hi"], strategy="forward", allow_exact_matches=False, check_sortedness=False
            )
        )
        out = out.join(joined.select([*KEY_COLUMNS, f"_next_{kind_label}"]), on=KEY_COLUMNS, how="left")
    # next ambiguous attribution touching a or b
    for side in ("a", "b"):
        av = amb.rename({"victim_id": f"{side}_id"}).with_columns(pl.col("tick").alias(f"_amb_{side}")).rename({"tick": "_t"})
        tmp = out.select(KEY_COLUMNS).with_columns(pl.col("tick").cast(pl.Int64).alias("_t")).sort("_t")
        j = tmp.join_asof(av.sort("_t"), on="_t", by=f"{side}_id", strategy="forward", allow_exact_matches=False, check_sortedness=False)
        out = out.join(j.select([*KEY_COLUMNS, f"_amb_{side}"]), on=KEY_COLUMNS, how="left")
    exprs = []
    for h in HORIZONS_S:
        lim = pl.col("tick") + round(h * tick_rate)
        amb_hit = (pl.col("_amb_a") <= lim).fill_null(False) | (pl.col("_amb_b") <= lim).fill_null(False)
        tag = f"{h:g}s".replace(".", "p")
        for kind_label in ("damage", "death", "contact"):
            pos = (pl.col(f"_next_{kind_label}") <= lim).fill_null(False)
            needs_damage = kind_label in ("damage", "contact")
            val = pl.when(pos).then(1).when(amb_hit).then(None).otherwise(0)
            if needs_damage and not available:
                val = pl.lit(None)  # damage attribution unusable for this dataset
            exprs.append(val.cast(pl.Int8).alias(f"{kind_label}_{tag}"))
    labels = out.with_columns(exprs).drop([c for c in out.columns if c.startswith("_")])
    info = {
        "damage_attribution_rate": round(rate, 4),
        "damage_labels_available": available,
        "interactions": inter.height,
        "ambiguous_attributions": amb.height,
    }
    return labels, info


def place_lookup(ticks: pl.DataFrame, cell: float = 64.0) -> dict[tuple[int, int, int], str]:
    """Most frequent place name per (64u XY, 128u Z) cell from alive samples of this dataset."""
    t = ticks.filter(
        pl.col("is_alive").fill_null(False)
        & pl.col("place").is_not_null()
        & (pl.col("place") != "")
        & pl.col("x").is_not_null()
        & pl.col("y").is_not_null()
        & pl.col("z").is_not_null()
    )
    g = (
        t.with_columns(
            (pl.col("x") / cell).floor().cast(pl.Int64).alias("ix"),
            (pl.col("y") / cell).floor().cast(pl.Int64).alias("iy"),
            (pl.col("z") / 128.0).floor().cast(pl.Int64).alias("iz"),
        )
        .group_by(["ix", "iy", "iz", "place"])
        .len("n")
        .sort("n", descending=True)
        .unique(subset=["ix", "iy", "iz"], keep="first")
    )
    return {(int(a), int(b), int(c)): str(p) for a, b, c, p, _n in g.iter_rows()}


def lookup_place(
    cells: dict[tuple[int, int, int], str], x: float | None, y: float | None, z: float | None, cell: float = 64.0
) -> str | None:
    if x is None or y is None or z is None or any(map(math.isnan, (x, y, z))):
        return None
    ix, iy, iz = math.floor(x / cell), math.floor(y / cell), math.floor(z / 128.0)
    for dz in (0, -1, -2, 1):
        for dx, dy in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)):
            p = cells.get((ix + dx, iy + dy, iz + dz))
            if p is not None:
                return p
    return None


def compute_utility_labels(grenades: pl.DataFrame, ticks: pl.DataFrame, tick_rate: float, dataset_id: str) -> pl.DataFrame:
    """Per throw: future activation delay/position/place (labels only; never feature inputs)."""
    cells = place_lookup(ticks)
    rows = []
    for g in grenades.iter_rows(named=True):
        exact = g["activation_evidence"] in ("event_entityid", "event_time_position")
        rows.append(
            {
                "dataset_id": dataset_id,
                "grenade_id": g["grenade_id"],
                "round_index": g["round_index"],
                "type": g["type"],
                "throw_tick": g["throw_tick"],
                "activation_delay_s": (g["activation_tick"] - g["first_seen_tick"]) / tick_rate
                if exact and g["activation_tick"] is not None
                else None,
                "activation_x": g["activation_x"] if exact else None,
                "activation_y": g["activation_y"] if exact else None,
                "activation_z": g["activation_z"] if exact else None,
                "activation_place": lookup_place(cells, g["activation_x"], g["activation_y"], g["activation_z"]) if exact else None,
                "activation_evidence": g["activation_evidence"],
            }
        )
    schema = {
        "dataset_id": pl.Utf8,
        "grenade_id": pl.Utf8,
        "round_index": pl.Int32,
        "type": pl.Utf8,
        "throw_tick": pl.Int64,
        "activation_delay_s": pl.Float64,
        "activation_x": pl.Float64,
        "activation_y": pl.Float64,
        "activation_z": pl.Float64,
        "activation_place": pl.Utf8,
        "activation_evidence": pl.Utf8,
    }
    return pl.DataFrame(rows, schema=schema) if rows else pl.DataFrame(schema=schema)


def build_features(dataset: Path, emitter: Emitter, force: bool = False) -> dict[str, Any]:
    from .leakage import check_leakage  # local import: leakage depends on this module

    t0 = time.monotonic()
    ref = load_dataset(Path(dataset))
    fm_path = ref.path / FEATURES_MANIFEST
    if fm_path.exists() and not force:
        fm = read_json(fm_path)
        # Built by an older version (no POV labels before version 2): built again.
        if fm.get("features_version") == FEATURES_VERSION:
            return {"status": "exists", "dataset": str(ref.path), "rows": {k: v["rows"] for k, v in fm["files"].items()}}
    ticks = pl.read_parquet(ref.path / "ticks.parquet")
    rounds = pl.read_parquet(ref.path / "rounds.parquet")
    events = pl.read_parquet(ref.path / "events.parquet")
    attributions = pl.read_parquet(ref.path / "attributions.parquet")
    grenades = pl.read_parquet(ref.path / "grenades.parquet")
    rate = ref.tick_rate
    emitter.progress("features", 0.2)
    feats = compute_pair_features(ticks, rounds, rate, ref.dataset_id)
    if feats.height == 0:
        raise errors.MfError(errors.INSUFFICIENT_DATA, "no live T/CT pairs to featurize", dataset=str(ref.path))
    if feats.filter(pl.col("max_input_tick") > pl.col("tick")).height:
        raise errors.MfError(errors.LEAKAGE_DETECTED, "feature rows use inputs after their sample tick")
    emitter.progress("leakage_check", 0.5)
    leak = check_leakage(ticks, rounds, rate, ref.dataset_id, cuts=3)
    if not leak["passed"]:
        raise errors.MfError(errors.LEAKAGE_DETECTED, "perturbing future frames changed past features", details=leak)
    emitter.progress("labels", 0.7)
    labels, label_info = compute_labels(feats.select(KEY_COLUMNS), attributions, events, rate)
    utility_labels = compute_utility_labels(grenades, ticks, rate, ref.dataset_id)
    pov = compute_pov_labels(ticks, rounds, kill_ticks(attributions, events), rate, ref.dataset_id)
    written = {
        "features": write_table(feats, ref.path, "features"),
        "labels": write_table(labels, ref.path, "labels"),
        "utility_labels": write_table(utility_labels, ref.path, "utility_labels"),
        "pov_labels": write_table(pov, ref.path, "pov_labels"),
    }
    pov_positives = {c: int(pov[c].sum() or 0) for c in pov.columns if c.startswith(("kill_", "death_", "action_", "multikill_"))}
    positives = {c: int(labels[c].sum() or 0) for c in labels.columns if c.startswith("contact_")}
    nulls = {c: int(labels[c].null_count()) for c in labels.columns if c.startswith("contact_")}
    fm = {
        "features_version": FEATURES_VERSION,
        "created_at": utc_now(),
        "dataset_id": ref.dataset_id,
        "key_columns": KEY_COLUMNS,
        "feature_columns": FEATURE_COLUMNS,
        "feature_capabilities": FEATURE_CAPABILITIES,
        "history_s": HISTORY_S,
        "horizons_s": list(HORIZONS_S),
        "sampling": "uniform grid frames of live phases; event-window frames excluded from inputs",
        "labels": label_info,
        "label_positives": positives,
        "label_nulls": nulls,
        "pov_horizons_s": list(POV_HORIZONS_S),
        "pov_positives": pov_positives,
        "leakage_check": leak,
        "files": {k: w.as_manifest_entry() for k, w in written.items()},
    }
    write_json_atomic(fm_path, fm)
    wall = time.monotonic() - t0
    return {
        "status": "built",
        "dataset": str(ref.path),
        "rows": {k: w.rows for k, w in written.items()},
        "bytes": {k: w.bytes for k, w in written.items()},
        "label_positives": positives,
        "label_nulls": nulls,
        "pov_positives": pov_positives,
        "labels": label_info,
        "leakage_check": {"passed": leak["passed"], "cuts": len(leak["cuts"])},
        "wall_s": round(wall, 3),
        "peak_rss_mb": peak_rss_mb(),
    }
