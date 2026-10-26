"""Extraction on a synthetic demo: atomic commit, duplicates, failure cleanup, empty parses."""

from __future__ import annotations

import json
from pathlib import Path

import polars as pl
import pytest

from mf_common import errors
from mf_common.emit import NullEmitter
from mf_common.fsutil import CommitConflict, commit_directory, read_json, staging_directory
from mf_demo_parser.extract import extract_demo
from synthetic_demo import FakeAdapter, write_fake_dem


def _visible_datasets(root: Path) -> list[Path]:
    return [p for p in root.glob("map=*/build=*/demo=*")]


def test_extract_commits_complete_dataset(tmp_path: Path) -> None:
    dem = write_fake_dem(tmp_path / "x.dem", "x")
    res = extract_demo(dem, tmp_path / "data", NullEmitter(), adapter=FakeAdapter())
    assert res["status"] == "committed"
    ds = Path(res["dataset"])
    assert ds.parent.name == "build=99999" and ds.parent.parent.name == "map=de_synthetic"
    assert ds.name == f"demo={res['sha256'][:16]}"
    manifest = read_json(ds / "manifest.json")
    assert manifest["status"] == "COMMITTED"
    assert manifest["source"]["sha256"] == res["sha256"]
    assert manifest["parser"] == {"name": "synthetic", "version": "0.0.0"}
    for name in ("rounds", "players", "ticks", "events", "grenades", "grenade_samples", "attributions", "team_scores"):
        entry = manifest["files"][name]
        assert (ds / entry["file"]).exists()
        assert pl.read_parquet(ds / entry["file"]).height == entry["rows"]
    # staging area is empty after commit
    assert not any((tmp_path / "data" / ".staging").iterdir())


def test_tick_rate_is_derived_and_ids_are_strings(tmp_path: Path) -> None:
    dem = write_fake_dem(tmp_path / "x.dem", "x")
    res = extract_demo(dem, tmp_path / "data", NullEmitter(), adapter=FakeAdapter())
    ds = Path(res["dataset"])
    manifest = read_json(ds / "manifest.json")
    assert manifest["timing"]["tick_rate"] == 64.0
    assert manifest["timing"]["tick_rate_evidence"] == "game_time_slope"
    assert manifest["timing"]["recorded_frame_hz"] == 32.0
    players = pl.read_parquet(ds / "players.parquet")
    assert players.schema["steamid"] == pl.Utf8
    assert players.schema["player_id"] == pl.Utf8
    ticks = pl.read_parquet(ds / "ticks.parquet")
    assert set(ticks["sampling_policy"].unique()) <= {"grid_16hz", "event_window", "grid_16hz+event_window"}
    grid = ticks.filter(pl.col("in_grid"))
    # grid spacing ≈ 1/16 s even though frames are recorded every 2 ticks
    spacing = grid.select("tick").unique().sort("tick")["tick"].diff().drop_nulls()
    assert spacing.median() == 4


def test_duplicate_is_reported_without_rewriting(tmp_path: Path) -> None:
    dem = write_fake_dem(tmp_path / "x.dem", "x")
    first = extract_demo(dem, tmp_path / "data", NullEmitter(), adapter=FakeAdapter())
    mtime = (Path(first["dataset"]) / "manifest.json").stat().st_mtime_ns
    second = extract_demo(dem, tmp_path / "data", NullEmitter(), adapter=FakeAdapter())
    assert second["status"] == "duplicate"
    assert second["dataset"] == first["dataset"]
    assert (Path(first["dataset"]) / "manifest.json").stat().st_mtime_ns == mtime


def test_parser_failure_leaves_nothing_visible(tmp_path: Path) -> None:
    dem = write_fake_dem(tmp_path / "x.dem", "x")
    with pytest.raises(errors.MfError) as exc:
        extract_demo(dem, tmp_path / "data", NullEmitter(), adapter=FakeAdapter(fail_stage="grenades"))
    assert exc.value.code == errors.PARSER_FAILED
    assert _visible_datasets(tmp_path / "data") == []
    staging = tmp_path / "data" / ".staging"
    assert not staging.exists() or not any(staging.iterdir())


def test_empty_parse_is_an_error_not_an_empty_match(tmp_path: Path) -> None:
    dem = write_fake_dem(tmp_path / "x.dem", "x")
    with pytest.raises(errors.MfError) as exc:
        extract_demo(dem, tmp_path / "data", NullEmitter(), adapter=FakeAdapter(empty=True))
    assert exc.value.code == errors.EMPTY_PARSE
    assert _visible_datasets(tmp_path / "data") == []


def test_non_cs2_input_is_rejected(tmp_path: Path) -> None:
    bad = tmp_path / "old.dem"
    bad.write_bytes(b"HL2DEMO\x00" + b"\x00" * 100)
    with pytest.raises(errors.MfError) as exc:
        extract_demo(bad, tmp_path / "data", NullEmitter(), adapter=FakeAdapter())
    assert exc.value.code == errors.UNSUPPORTED_FORMAT
    with pytest.raises(errors.MfError) as exc2:
        extract_demo(tmp_path / "missing.dem", tmp_path / "data", NullEmitter(), adapter=FakeAdapter())
    assert exc2.value.code == errors.INPUT_NOT_FOUND


def test_conflicting_directory_is_not_overwritten(tmp_path: Path) -> None:
    dem = write_fake_dem(tmp_path / "x.dem", "x")
    res = extract_demo(dem, tmp_path / "data", NullEmitter(), adapter=FakeAdapter())
    mpath = Path(res["dataset"]) / "manifest.json"
    doc = json.loads(mpath.read_text())
    doc["status"] = "PARTIAL"
    mpath.write_text(json.dumps(doc))
    with pytest.raises(errors.MfError) as exc:
        extract_demo(dem, tmp_path / "data", NullEmitter(), adapter=FakeAdapter())
    assert exc.value.code == errors.DATASET_CONFLICT


def test_commit_directory_is_all_or_nothing(tmp_path: Path) -> None:
    final = tmp_path / "root" / "map=x" / "demo=1"
    with staging_directory(tmp_path / "root", "a") as st:
        (st / "f.txt").write_text("one")
        commit_directory(st, final)
    assert (final / "f.txt").read_text() == "one"
    with staging_directory(tmp_path / "root", "b") as st2:
        (st2 / "f.txt").write_text("two")
        with pytest.raises(CommitConflict):
            commit_directory(st2, final)
    assert (final / "f.txt").read_text() == "one"
    assert not any((tmp_path / "root" / ".staging").iterdir())


def test_grenade_type_resolved_and_held_weapons_excluded(tmp_path: Path) -> None:
    dem = write_fake_dem(tmp_path / "x.dem", "x")
    res = extract_demo(dem, tmp_path / "data", NullEmitter(), adapter=FakeAdapter())
    ds = Path(res["dataset"])
    g = pl.read_parquet(ds / "grenades.parquet")
    assert g.height == 3  # one HE per round; CHEGrenade held rows dropped
    assert set(g["type"]) == {"he"}
    assert all(e.startswith("event:hegrenade_detonate") for e in g["type_evidence"].str.split("; ").list.first())
    assert g["activation_evidence"].to_list() == ["event_entityid"] * 3
    assert g["throw_tick_evidence"].to_list() == ["event:weapon_fire"] * 3
    qa = read_json(ds / "qa.json")
    assert qa["grenades"]["held_weapon_rows_excluded"] == 60
    assert qa["grenades"]["held_weapon_rows_with_position"] == 0
    assert qa["grenades"]["type_crosscheck"] == {"prop_vs_event_agree": 3}
