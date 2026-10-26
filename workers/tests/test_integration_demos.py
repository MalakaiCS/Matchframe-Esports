"""End-to-end checks on real CS2 demos. Skipped unless ``MF_TEST_DEMOS`` points at a directory of
``.dem`` files (never copied into the repository)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import polars as pl
import pytest

from conftest import demo_dir
from mf_common.datasets import discover
from mf_common.emit import NullEmitter
from mf_common.fsutil import read_json
from mf_demo_parser.extract import extract_demo
from mf_demo_parser.inspect_demo import inspect_demo
from mf_demo_parser.validate import validate_dataset, verify_dataset
from mf_features.features import build_features
from mf_features.map_pack import build_map_pack
from mf_features.map_pack_schema import validate_map_pack
from mf_features.utility_profiles import measure_utility
from mf_training.export import export_model
from mf_training.splits import audit_split, freeze_dataset
from mf_training.train import train_model
from mf_training.tree_eval import predict_raw

DEMOS = demo_dir()
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(DEMOS is None, reason="set MF_TEST_DEMOS to a directory of real .dem files"),
]


@pytest.fixture(scope="session")
def corpus(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    assert DEMOS is not None
    root = tmp_path_factory.mktemp("mfdata")
    results = []
    for dem in sorted(DEMOS.glob("*.dem")):
        results.append(extract_demo(dem, root, NullEmitter()))
    validations = {}
    for r in results:
        validations[r["dataset_id"]] = validate_dataset(Path(r["dataset"]), NullEmitter())
    for r in results:
        if validations[r["dataset_id"]]["verdict"] == "usable":
            build_features(Path(r["dataset"]), NullEmitter())
            validations[r["dataset_id"]] = validate_dataset(Path(r["dataset"]), NullEmitter())
    return {"root": root, "results": results, "validations": validations, "tmp": tmp_path_factory.mktemp("mfwork")}


def test_every_demo_commits_with_derived_timing(corpus: dict[str, Any]) -> None:
    assert corpus["results"], "no demos found"
    for r in corpus["results"]:
        assert r["status"] == "committed"
        m = read_json(Path(r["dataset"]) / "manifest.json")
        assert m["map"] == m["header"]["map_name"].lower()
        assert m["timing"]["tick_rate_evidence"] == "game_time_slope"
        assert m["timing"]["tick_rate"] in (64.0, 128.0)
        players = pl.read_parquet(Path(r["dataset"]) / "players.parquet")
        assert players.schema["steamid"] == pl.Utf8
        assert players["steamid"].drop_nulls().str.contains(r"^\d+$").all()


def test_inspect_reports_parser_and_notes() -> None:
    assert DEMOS is not None
    dem = min(DEMOS.glob("*.dem"), key=lambda p: p.stat().st_size)
    out = inspect_demo(dem, NullEmitter())
    assert out["parser"]["name"] == "demoparser2"
    assert out["header"]["map_name"].startswith("de_")
    assert isinstance(out["compatibility_notes"], list)
    assert "client_name" not in json.dumps(out["header"])


def test_duplicate_detection_on_real_demo(corpus: dict[str, Any]) -> None:
    assert DEMOS is not None
    dem = min(DEMOS.glob("*.dem"), key=lambda p: p.stat().st_size)
    again = extract_demo(dem, corpus["root"], NullEmitter())
    assert again["status"] == "duplicate"


def test_sourcetv_demos_validate_and_verify(corpus: dict[str, Any]) -> None:
    usable = 0
    for r in corpus["results"]:
        v = corpus["validations"][r["dataset_id"]]
        m = read_json(Path(r["dataset"]) / "manifest.json")
        assert v["verdict"] in ("usable", "quarantine")
        if m["header"]["recorded_by_sourcetv"]:
            assert v["verdict"] == "usable", v["reasons"]
        usable += v["verdict"] == "usable"
        assert verify_dataset(Path(r["dataset"]), NullEmitter())["ok"]
    assert usable >= 1


def test_grenade_resolution_quality(corpus: dict[str, Any]) -> None:
    for r in corpus["results"]:
        qa = read_json(Path(r["dataset"]) / "qa.json")["grenades"]
        assert qa["held_weapon_rows_with_position"] == 0
        assert qa["projectiles"] > 0
        unknown = sum(qa["unknown_by_raw_class"].values())
        assert unknown / qa["projectiles"] < 0.05
        cc = qa["type_crosscheck"]
        assert cc.get("prop_vs_event_disagree", 0) == 0
        assert cc.get("weapon_fire_vs_isinc_disagree", 0) == 0


def test_identity_recovery_agrees_with_parser_where_both_exist(corpus: dict[str, Any]) -> None:
    for r in corpus["results"]:
        cc = read_json(Path(r["dataset"]) / "qa.json")["identity_crosscheck"]
        for stats in cc.values():
            assert stats["agree"] == stats["recovered"]


def test_features_pass_leakage_check(corpus: dict[str, Any]) -> None:
    built = 0
    for r in corpus["results"]:
        fm = Path(r["dataset"]) / "features_manifest.json"
        if fm.exists():
            doc = read_json(fm)
            assert doc["leakage_check"]["passed"]
            built += 1
            checks = {c["name"]: c["status"] for c in corpus["validations"][r["dataset_id"]]["checks"]}
            assert checks["causal_features"] == "pass"
    assert built >= 1


def test_map_packs_and_utility_profiles(corpus: dict[str, Any]) -> None:
    work = corpus["tmp"]
    refs = discover([corpus["root"]])
    for map_name in sorted({r.map_name for r in refs if r.verdict() == "usable"}):
        out = work / f"{map_name}.json"
        build_map_pack([corpus["root"]], map_name, out, NullEmitter(), graph_out=work / f"{map_name}.graph.json")
        pack = json.loads(out.read_text())
        assert validate_map_pack(pack) == []
        assert out.stat().st_size < 1_500_000
        if map_name == "de_inferno":
            ids = {r["id"] for r in pack["regions"]}
            assert {"bottom_banana", "top_banana"} <= ids
            derived = [r for r in pack["regions"] if "derived_split" in r["tags"]]
            assert all("requires_operator_validation" in r["tags"] and not r["validated"] for r in derived)
    prof = measure_utility([corpus["root"]], work / "measured.json", NullEmitter())
    assert prof["gravity_overall"]["n"] > 50
    assert abs(prof["gravity_overall"]["gravityMedian"] - 320.0) < 5.0


def test_freeze_audit_train_export(corpus: dict[str, Any]) -> None:
    work = corpus["tmp"]
    frozen = work / "frozen.json"
    fr = freeze_dataset([corpus["root"]], frozen, NullEmitter())
    assert audit_split(frozen, NullEmitter())["passed"]
    if not fr["splits"]["train"]:
        pytest.skip("not enough usable matches to train")
    models = work / "models"
    tr = train_model("contact_2s", frozen, models, NullEmitter())
    exp = export_model(Path(tr["model_dir"]), work / "export", NullEmitter(), parity_count=50)
    assert exp["parity_vectors"] >= 50
    model = json.loads((work / "export" / "model.json").read_text())
    parity = json.loads((work / "export" / "parity_vectors.json").read_text())
    for vec in parity["vectors"]:
        assert abs(predict_raw(model, vec["features"]) - vec["raw_score"]) < 1e-9
