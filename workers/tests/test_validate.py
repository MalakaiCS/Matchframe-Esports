"""Validation verdicts on synthetic datasets: usable, quarantine on integrity/plausibility failures."""

from __future__ import annotations

import json
from pathlib import Path

import polars as pl

from mf_common.emit import NullEmitter
from mf_demo_parser.validate import validate_dataset, verify_dataset
from synthetic_demo import build_dataset


def _check(result: dict, name: str) -> dict:
    return next(c for c in result["checks"] if c["name"] == name)


def test_clean_synthetic_dataset_is_usable(tmp_path: Path) -> None:
    ds = build_dataset(tmp_path)
    res = validate_dataset(ds, NullEmitter(), expected_map="de_synthetic")
    assert res["verdict"] == "usable", res["reasons"]
    assert (ds / "validation.json").exists()
    assert _check(res, "round_result_reconciliation")["status"] == "pass"
    assert _check(res, "duckdb_queries")["details"]["opening"]["tick_rows"] > 0
    assert verify_dataset(ds, NullEmitter())["ok"] is True


def test_checksum_tampering_quarantines_and_fails_verify(tmp_path: Path) -> None:
    ds = build_dataset(tmp_path)
    p = ds / "events.parquet"
    df = pl.read_parquet(p)
    df.head(df.height - 1).write_parquet(p)
    res = validate_dataset(ds, NullEmitter())
    assert res["verdict"] == "quarantine"
    assert _check(res, "checksums")["status"] == "fail"
    assert verify_dataset(ds, NullEmitter())["ok"] is False


def test_wrong_expected_map_quarantines(tmp_path: Path) -> None:
    ds = build_dataset(tmp_path)
    res = validate_dataset(ds, NullEmitter(), expected_map="de_inferno")
    assert res["verdict"] == "quarantine"
    assert any("expected_map" in r for r in res["reasons"])


def test_positions_outside_world_quarantine(tmp_path: Path) -> None:
    ds = build_dataset(tmp_path, coord_scale=40.0)
    res = validate_dataset(ds, NullEmitter())
    assert res["verdict"] == "quarantine"
    assert _check(res, "map_bounds")["status"] == "fail"


def test_uncommitted_manifest_quarantines(tmp_path: Path) -> None:
    ds = build_dataset(tmp_path)
    m = json.loads((ds / "manifest.json").read_text())
    m["status"] = "EXTRACTED"
    (ds / "manifest.json").write_text(json.dumps(m))
    res = validate_dataset(ds, NullEmitter())
    assert res["verdict"] == "quarantine"


def test_unusual_long_round_is_flagged_not_rejected(tmp_path: Path) -> None:
    ds = build_dataset(tmp_path, long_round=True)
    res = validate_dataset(ds, NullEmitter())
    assert res["verdict"] == "usable", res["reasons"]
    assert any("long_live_phase" in f for f in res["flags"])


def test_missing_kills_is_not_a_successful_empty_match(tmp_path: Path) -> None:
    ds = build_dataset(tmp_path)
    ev = pl.read_parquet(ds / "events.parquet").filter(pl.col("event_type") != "player_death")
    ev.write_parquet(ds / "events.parquet")
    res = validate_dataset(ds, NullEmitter())
    assert res["verdict"] == "quarantine"
    assert _check(res, "nonempty_parse")["status"] == "fail"
    assert _check(res, "checksums")["status"] == "fail"
