"""Causal features, the automated leakage check, and future labels on a synthetic dataset."""

from __future__ import annotations

from pathlib import Path

import polars as pl

from mf_common.emit import NullEmitter
from mf_features.features import FEATURE_COLUMNS, KEY_COLUMNS, build_features, compute_pair_features
from mf_features.leakage import check_leakage
from synthetic_demo import RATE, FakeDemo, build_dataset


def _load(ds: Path) -> tuple[pl.DataFrame, pl.DataFrame]:
    return pl.read_parquet(ds / "ticks.parquet"), pl.read_parquet(ds / "rounds.parquet")


def test_features_are_causal_and_labels_separate(tmp_path: Path) -> None:
    ds = build_dataset(tmp_path)
    res = build_features(ds, NullEmitter())
    assert res["leakage_check"]["passed"] is True
    feats = pl.read_parquet(ds / "features.parquet")
    labels = pl.read_parquet(ds / "labels.parquet")
    assert feats.filter(pl.col("max_input_tick") > pl.col("tick")).height == 0
    assert not (set(labels.columns) - set(KEY_COLUMNS)) & set(feats.columns)
    assert set(FEATURE_COLUMNS) <= set(feats.columns)
    # only uniform-grid frames are samples (event windows depend on the future)
    ticks = pl.read_parquet(ds / "ticks.parquet")
    grid_ticks = set(ticks.filter(pl.col("in_grid"))["tick"].to_list())
    assert set(feats["tick"].to_list()) <= grid_ticks


def test_leakage_check_passes_for_pipeline_features(tmp_path: Path) -> None:
    ticks, rounds = _load(build_dataset(tmp_path))
    out = check_leakage(ticks, rounds, 64.0, "ds", cuts=3)
    assert out["passed"] and all(c["identical"] and c["rows_compared"] > 0 for c in out["cuts"])


def test_leakage_check_catches_a_future_looking_feature(tmp_path: Path) -> None:
    ticks, rounds = _load(build_dataset(tmp_path))

    def leaky(t: pl.DataFrame, r: pl.DataFrame, rate: float, dsid: str) -> pl.DataFrame:
        f = compute_pair_features(t, r, rate, dsid)
        # "closing speed" computed from the NEXT sample of the pair: uses the future
        return f.sort(["a_id", "b_id", "tick"]).with_columns(
            (pl.col("dist_3d").shift(-1).over(["a_id", "b_id"]) - pl.col("dist_3d")).alias("closing_speed")
        )

    out = check_leakage(ticks, rounds, 64.0, "ds", cuts=3, feature_fn=leaky)
    assert out["passed"] is False
    assert any("closing_speed" in c["mismatched_columns"] for c in out["cuts"])


def test_contact_labels_match_brute_force(tmp_path: Path) -> None:
    ds = build_dataset(tmp_path)
    build_features(ds, NullEmitter())
    labels = pl.read_parquet(ds / "labels.parquet")
    fake = FakeDemo()
    p1, p2, p3, p4 = (fake.pid(i) for i in (1, 2, 3, 4))
    rounds = pl.read_parquet(ds / "rounds.parquet").filter(pl.col("end_tick").is_not_null())
    for r in range(fake.n_rounds):
        hurt, kill = fake._hurt_kill_ticks(r)
        ri = rounds.filter(pl.col("freeze_end_tick") == fake.round_bounds(r)[1])["round_index"][0]
        pair = labels.filter((pl.col("round_index") == ri) & (pl.col("a_id") == p1) & (pl.col("b_id") == p3)).sort("tick")
        assert pair.height > 100 and 0 < pair["contact_2s"].sum() < pair.height
        for t, v in zip(pair["tick"].to_list(), pair["contact_2s"].to_list(), strict=True):
            expected = int((t < hurt <= t + 2 * RATE) or (t < kill <= t + 2 * RATE))
            assert v == expected, (t, hurt, kill)
        quiet = labels.filter((pl.col("round_index") == ri) & (pl.col("a_id") == p2) & (pl.col("b_id") == p4))
        assert quiet["contact_3s"].sum() == 0
        death = pair["death_1s"].to_list()
        assert sum(death) == sum(1 for t in pair["tick"].to_list() if t < kill <= t + RATE)


def test_pov_labels_match_brute_force(tmp_path: Path) -> None:
    """The hindsight observer: each player's kills and deaths in (t, t + h], counted by hand."""
    from mf_features.features import MULTI_FRAG_WINDOW_S, POV_HORIZONS_S, kill_ticks

    ds = build_dataset(tmp_path)
    res = build_features(ds, NullEmitter())
    pov = pl.read_parquet(ds / "pov_labels.parquet")
    assert pov.height > 0 and res["pov_positives"]["action_2s"] > 0
    kills = kill_ticks(pl.read_parquet(ds / "attributions.parquet"), pl.read_parquet(ds / "events.parquet"))
    rows = kills.to_dicts()
    for r in pov.sample(n=min(400, pov.height), seed=3).to_dicts():
        t, p = r["tick"], r["player_id"]
        for h in POV_HORIZONS_S:
            lim = t + round(h * RATE)
            k = sum(1 for e in rows if e["attacker_id"] == p and e["attacker_id"] != e["victim_id"] and t < e["tick"] <= lim)
            d = sum(1 for e in rows if e["victim_id"] == p and t < e["tick"] <= lim)
            tag = f"{h:g}s"
            assert r[f"kill_{tag}"] == int(k > 0) and r[f"death_{tag}"] == int(d > 0) and r[f"action_{tag}"] == int(k + d > 0)
        lim = t + round(MULTI_FRAG_WINDOW_S * RATE)
        k10 = sum(1 for e in rows if e["attacker_id"] == p and e["attacker_id"] != e["victim_id"] and t < e["tick"] <= lim)
        assert r["kills_10s"] == k10 and r["multikill_10s"] == int(k10 >= 2)
    # Labels only: never a feature column.
    feats = pl.read_parquet(ds / "features.parquet")
    assert not {"kill_2s", "action_2s", "multikill_10s"} & set(feats.columns)


def test_older_features_are_built_again(tmp_path: Path) -> None:
    import json

    ds = build_dataset(tmp_path)
    build_features(ds, NullEmitter())
    fm = ds / "features_manifest.json"
    m = json.loads(fm.read_text())
    m["features_version"] = 1
    fm.write_text(json.dumps(m))
    assert build_features(ds, NullEmitter())["status"] == "built"
    assert build_features(ds, NullEmitter())["status"] == "exists"
