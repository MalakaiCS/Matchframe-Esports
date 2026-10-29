"""The ``pov_2s`` task (player rows from pair features), the replay export for the test bench, and
splits that hold nothing back (a shipped model)."""

from __future__ import annotations

import itertools
import json
from pathlib import Path

import polars as pl

from mf_common.emit import NullEmitter
from mf_features.features import build_features, kill_ticks
from mf_features.replay import export_replay
from mf_training.pov import POV_FEATURES, player_features, pov_frame
from mf_training.splits import assign_splits
from synthetic_demo import build_dataset


def _pairs() -> pl.DataFrame:
    """Two T×CT pairs at one tick: T ``t1`` against CT ``c1`` (800 u, facing) and ``c2`` (1500 u)."""
    base = {
        "dataset_id": "d",
        "round_index": 0,
        "tick": 640,
        "closing_speed": None,
        "speed_a": 100.0,
        "speed_b": 0.0,
        "health_a": 80.0,
        "health_b": 100.0,
        "armor_a": 100.0,
        "armor_b": 50.0,
        "weapon_class_a": 4.0,
        "weapon_class_b": 3.0,
        "alive_t": 1,
        "alive_ct": 2,
        "round_time_s": 12.5,
    }
    return pl.DataFrame(
        [
            {**base, "a_id": "t1", "b_id": "c1", "dist_3d": 800.0, "facing_a": 1.0, "facing_b": 0.5, "facing_max": 1.0},
            {**base, "a_id": "t1", "b_id": "c2", "dist_3d": 1500.0, "facing_a": 0.0, "facing_b": None, "facing_max": 0.0},
        ]
    )


def test_player_rows_aggregate_the_pairs_like_the_live_runtime() -> None:
    # a frame earlier in the round (the round's kills are matched to it), then the one under test
    pairs = pl.concat([_pairs().with_columns(pl.lit(320, dtype=pl.Int64).alias("tick")), _pairs()])
    kills = pl.DataFrame({"tick": [400, 500, 900], "attacker_id": ["t1", "t1", "t1"], "victim_id": ["x", "t1", "y"]})
    rows = {r["player_id"]: r for r in player_features(pairs, kills).filter(pl.col("tick") == 640).to_dicts()}
    t1, c1, c2 = rows["t1"], rows["c1"], rows["c2"]
    assert set(POV_FEATURES) <= set(t1)
    assert t1["side_t"] == 1.0 and c1["side_t"] == 0.0
    assert (t1["alive_own"], t1["alive_opp"], c1["alive_own"], c1["alive_opp"]) == (1.0, 2.0, 2.0, 1.0)
    assert t1["nearest_dist"] == 800.0 and t1["opp_within_1000"] == 1.0 and t1["opp_within_2000"] == 2.0
    assert t1["nearest_facing_self"] == 1.0 and t1["nearest_facing_opp"] == 0.5
    assert t1["max_facing_self_2000"] == 1.0 and t1["max_facing_opp_2000"] == 0.5
    assert c1["nearest_facing_self"] == 0.5 and c1["nearest_facing_opp"] == 1.0
    assert c2["max_facing_self_2000"] is None  # unknown stays unknown, never 0
    assert c1["health"] == 100.0 and c1["armor"] == 50.0 and c1["weapon_class"] == 3.0 and t1["speed"] == 100.0
    assert t1["max_closing"] is None
    # the heuristic of each pair: clip((facing_max + 1) / 2)^2 * exp(-d / 1000)
    import math

    assert abs(t1["heur_max"] - math.exp(-0.8)) < 1e-9
    assert abs(t1["heur_sum"] - (math.exp(-0.8) + 0.25 * math.exp(-1.5))) < 1e-9
    # kills at or before the tick, no suicides: 400 counts, 500 is a suicide, 900 is later
    assert t1["round_kills"] == 1.0 and c1["round_kills"] == 0.0


def test_pov_frame_joins_the_hindsight_labels(tmp_path: Path) -> None:
    ds = build_dataset(tmp_path)
    build_features(ds, NullEmitter())
    f = pov_frame(ds, "action_2s")
    labels = pl.read_parquet(ds / "pov_labels.parquet")
    assert f.height > 0 and f.height <= labels.height
    assert f["action_2s"].sum() > 0
    assert f.select(["tick", "player_id"]).is_duplicated().sum() == 0
    kills = kill_ticks(pl.read_parquet(ds / "attributions.parquet"), pl.read_parquet(ds / "events.parquet"))
    starts = f.group_by("round_index").agg(pl.col("tick").min().alias("first"))
    first = dict(zip(starts["round_index"].to_list(), starts["first"].to_list(), strict=True))
    # round_kills: the player's kills in this round up to the frame, counted by hand
    rows = kills.filter(pl.col("attacker_id") != pl.col("victim_id")).to_dicts()
    for r in f.sample(n=min(300, f.height), seed=5).to_dicts():
        n = sum(1 for e in rows if e["attacker_id"] == r["player_id"] and first[r["round_index"]] <= e["tick"] <= r["tick"])
        assert r["round_kills"] == n


def test_a_zero_fraction_holds_nothing_back() -> None:
    groups = {f"g{i}": 14191 for i in range(7)}
    assert set(assign_splits(groups, 0.0, 0.0).values()) == {"train"}
    default = assign_splits(groups, 0.2, 0.2)
    assert "test" in default.values() and "val" in default.values()


def test_export_replay_streams_frames_and_kills_in_tick_order(tmp_path: Path) -> None:
    ds = build_dataset(tmp_path)
    out = tmp_path / "replay.jsonl"
    res = export_replay(ds, out, 8.0, NullEmitter())
    lines = [json.loads(x) for x in out.read_text().splitlines()]
    assert lines[0]["type"] == "header" and lines[0]["map"] == res["map"]
    frames = [x for x in lines if x["type"] == "frame"]
    kills = [x for x in lines if x["type"] == "kill"]
    assert len(frames) == res["frames"] > 0 and len(kills) == res["kills"]
    ticks = [x["tick"] for x in lines[1:]]
    assert ticks == sorted(ticks)
    assert {f["phase"] for f in frames} <= {"freezetime", "live", "over"} and "live" in {f["phase"] for f in frames}
    # alive players only, ten values each; about 8 frames a second
    assert all(len(p) == 10 and p[1] in ("T", "CT") for f in frames for p in f["players"])
    gaps = [b["tick"] - a["tick"] for a, b in itertools.pairwise(frames)]
    assert min(gaps) >= round(res["tick_rate"] / 8.0)
