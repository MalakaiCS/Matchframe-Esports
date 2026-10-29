"""The ``pov_2s`` task: one row per live grid frame and alive player, "does their POV show a kill
within 2 s" (``pov_labels.action_2s``), from what a spectator's game data shows at that moment.

Player features are aggregates of the T×CT pair features (``features.parquet``), so the live
runtime computes them from the same pair vectors it already computes for ``contact_2s``
(``services/local-engine/src/live/model-runtime.ts``, ``povFeatures``), plus the player's kills so
far this round (GSI ``round_kills``). Aggregates ignore missing values, like polars ``min``/``max``.
"""

from __future__ import annotations

from pathlib import Path

import polars as pl

from mf_common.frames import asof_backward
from mf_features.features import kill_ticks

POV_TASKS = {"pov_2s": "action_2s"}
POV_LABELS = set(POV_TASKS.values())

#: Feature order is the model's input order (live code mirrors it).
POV_FEATURES = [
    "side_t",
    "health",
    "armor",
    "speed",
    "weapon_class",
    "alive_own",
    "alive_opp",
    "round_time_s",
    "round_kills",
    "nearest_dist",
    "nearest_facing_self",
    "nearest_facing_opp",
    "opp_within_1000",
    "opp_within_2000",
    "max_facing_self_2000",
    "max_facing_opp_2000",
    "max_closing",
    "heur_max",
    "heur_sum",
]
POV_CAPABILITIES = {f: "gsi_compatible" for f in POV_FEATURES}
#: Distances (units) for the "near" aggregates; must match the live runtime.
NEAR_1, NEAR_2 = 1000.0, 2000.0


def pair_heuristic(dist: pl.Expr, facing_max: pl.Expr) -> pl.Expr:
    """The ``contact_2s`` heuristic per pair (see ``data.heuristic_score``)."""
    return ((facing_max.fill_null(-1.0) + 1.0) / 2.0).clip(0.0, 1.0) ** 2 * (-dist.fill_null(4000.0) / 1000.0).exp()


def player_view(features: pl.DataFrame) -> pl.DataFrame:
    """Pair rows seen from each player: T rows (a side) and CT rows (b side), same columns."""
    keep = ["dataset_id", "round_index", "tick", "dist_3d", "closing_speed", "alive_t", "alive_ct", "round_time_s", "facing_max"]
    t = features.select(
        *keep,
        pl.col("a_id").alias("player_id"),
        pl.lit(1.0).alias("side_t"),
        pl.col("facing_a").alias("facing_self"),
        pl.col("facing_b").alias("facing_opp"),
        pl.col("speed_a").alias("speed"),
        pl.col("health_a").alias("health"),
        pl.col("armor_a").alias("armor"),
        pl.col("weapon_class_a").alias("weapon_class"),
    )
    ct = features.select(
        *keep,
        pl.col("b_id").alias("player_id"),
        pl.lit(0.0).alias("side_t"),
        pl.col("facing_b").alias("facing_self"),
        pl.col("facing_a").alias("facing_opp"),
        pl.col("speed_b").alias("speed"),
        pl.col("health_b").alias("health"),
        pl.col("armor_b").alias("armor"),
        pl.col("weapon_class_b").alias("weapon_class"),
    )
    return pl.concat([t, ct], how="vertical_relaxed")


def player_features(features: pl.DataFrame, kills: pl.DataFrame) -> pl.DataFrame:
    """Per (dataset_id, round_index, tick, player_id): ``POV_FEATURES`` (Float64, null = unknown)."""
    v = player_view(features).with_columns(
        pair_heuristic(pl.col("dist_3d"), pl.col("facing_max")).alias("_heur"),
        pl.col("dist_3d").rank("ordinal").over(["tick", "player_id"]).alias("_rank"),
    )
    near2 = pl.col("dist_3d") <= NEAR_2
    agg = v.group_by(["dataset_id", "round_index", "tick", "player_id"]).agg(
        pl.col("side_t").first(),
        pl.col("health").first(),
        pl.col("armor").first(),
        pl.col("speed").first(),
        pl.col("weapon_class").first(),
        pl.when(pl.col("side_t").first() == 1.0).then(pl.col("alive_t").first()).otherwise(pl.col("alive_ct").first()).alias("alive_own"),
        pl.when(pl.col("side_t").first() == 1.0).then(pl.col("alive_ct").first()).otherwise(pl.col("alive_t").first()).alias("alive_opp"),
        pl.col("round_time_s").first(),
        pl.col("dist_3d").min().alias("nearest_dist"),
        pl.col("facing_self").filter(pl.col("_rank") == 1).first().alias("nearest_facing_self"),
        pl.col("facing_opp").filter(pl.col("_rank") == 1).first().alias("nearest_facing_opp"),
        (pl.col("dist_3d") <= NEAR_1).sum().alias("opp_within_1000"),
        near2.sum().alias("opp_within_2000"),
        pl.col("facing_self").filter(near2).max().alias("max_facing_self_2000"),
        pl.col("facing_opp").filter(near2).max().alias("max_facing_opp_2000"),
        pl.col("closing_speed").max().alias("max_closing"),
        pl.col("_heur").max().alias("heur_max"),
        pl.col("_heur").sum().alias("heur_sum"),
    )
    agg = agg.with_columns(pl.col("tick").cast(pl.Int64), pl.col("round_index").cast(pl.Int64)).sort("tick")
    agg = with_round_kills(agg, kills)
    return agg.with_columns([pl.col(c).cast(pl.Float64) for c in POV_FEATURES])


def with_round_kills(rows: pl.DataFrame, kills: pl.DataFrame) -> pl.DataFrame:
    """``round_kills``: the player's kills at or before the row's tick in the same round (no suicides)."""
    k = kills.filter(pl.col("attacker_id").is_not_null() & (pl.col("attacker_id") != pl.col("victim_id"))).select(
        pl.col("tick").cast(pl.Int64), pl.col("attacker_id").alias("player_id")
    )
    if k.height == 0 or rows.height == 0:
        return rows.with_columns(pl.lit(0.0).alias("round_kills"))
    rounds = rows.select("tick", "round_index").unique("tick").sort("tick")
    k = asof_backward(k.sort("tick"), rounds, on="tick").filter(pl.col("round_index").is_not_null())
    k = k.sort("tick").with_columns(pl.int_range(1, pl.len() + 1).over(["round_index", "player_id"]).alias("round_kills"))
    k = k.select("round_index", "player_id", "tick", pl.col("round_kills").cast(pl.Float64))
    out = asof_backward(rows, k, on="tick", by=["round_index", "player_id"])
    return out.with_columns(pl.col("round_kills").fill_null(0.0))


def pov_frame(dataset_dir: Path, label: str) -> pl.DataFrame:
    """Player rows of one dataset with ``POV_FEATURES`` and ``label`` (rows without a label dropped)."""
    d = Path(dataset_dir)
    features = pl.read_parquet(d / "features.parquet")
    events = pl.read_parquet(d / "events.parquet") if (d / "events.parquet").exists() else pl.DataFrame()
    attributions = pl.read_parquet(d / "attributions.parquet") if (d / "attributions.parquet").exists() else pl.DataFrame()
    rows = player_features(features, kill_ticks(attributions, events))
    lab = pl.read_parquet(d / "pov_labels.parquet", columns=["dataset_id", "round_index", "tick", "player_id", label]).with_columns(
        pl.col("tick").cast(pl.Int64), pl.col("round_index").cast(pl.Int64)
    )
    return rows.join(lab, on=["dataset_id", "round_index", "tick", "player_id"], how="inner").filter(pl.col(label).is_not_null())


def pov_heuristic(frame: pl.DataFrame) -> pl.Series:
    """Deterministic baseline for ``pov_2s``: the best pair heuristic of the player."""
    return frame["heur_max"].cast(pl.Float64).fill_null(0.0)
