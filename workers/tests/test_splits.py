"""Frozen manifests and the split audit (acceptance A43)."""

from __future__ import annotations

import json
from pathlib import Path

from mf_common.emit import NullEmitter
from mf_demo_parser.validate import validate_dataset
from mf_training.splits import assign_splits, audit_split, freeze_dataset
from synthetic_demo import build_dataset


def _datasets(tmp: Path) -> list[Path]:
    out = []
    for i, (build, prefix) in enumerate((("90001", "7656119100000000"), ("90002", "7656119200000000"), ("90003", "7656119300000000"), ("90004", "7656119400000000"))):
        ds = build_dataset(tmp, salt=f"d{i}", build=build, player_prefix=prefix)
        validate_dataset(ds, NullEmitter())
        out.append(ds)
    return out


def test_freeze_assigns_newest_build_to_test_and_audit_passes(tmp_path: Path) -> None:
    _datasets(tmp_path)
    out = tmp_path / "frozen.json"
    res = freeze_dataset([tmp_path / "data"], out, NullEmitter())
    assert len(res["splits"]["test"]) == 1 and res["splits"]["test"][0].startswith("de_synthetic-90004-")
    doc = json.loads(out.read_text())
    test_builds = {m["build"] for m in doc["members"] if m["split"] == "test"}
    train_builds = {m["build"] for m in doc["members"] if m["split"] == "train"}
    assert max(int(b) for b in test_builds) > max(int(b) for b in train_builds)
    assert audit_split(out, NullEmitter())["passed"] is True


def test_audit_fails_when_a_match_is_in_two_splits(tmp_path: Path) -> None:
    _datasets(tmp_path)
    out = tmp_path / "frozen.json"
    freeze_dataset([tmp_path / "data"], out, NullEmitter())
    doc = json.loads(out.read_text())
    victim = doc["splits"]["train"][0]
    doc["splits"]["test"].append(victim)
    out.write_text(json.dumps(doc))
    res = audit_split(out, NullEmitter())
    assert res["passed"] is False
    assert any(victim in v for v in res["violations"])
    assert any("content_hash" in v for v in res["violations"])


def test_related_demos_share_a_split(tmp_path: Path) -> None:
    # same roster + map (e.g. POV and SourceTV of one match) but different bytes and builds
    a = build_dataset(tmp_path, salt="pov", build="90001", player_prefix="7656119500000000")
    b = build_dataset(tmp_path, salt="tv", build="90009", player_prefix="7656119500000000")
    for ds in (a, b):
        validate_dataset(ds, NullEmitter())
    for i, prefix in enumerate(("7656119600000000", "7656119700000000")):
        validate_dataset(build_dataset(tmp_path, salt=f"o{i}", build=f"9000{5 + i}", player_prefix=prefix), NullEmitter())
    out = tmp_path / "frozen.json"
    freeze_dataset([tmp_path / "data"], out, NullEmitter())
    doc = json.loads(out.read_text())
    by_id = {m["sha256"]: m for m in doc["members"]}
    groups = {m["group_id"] for m in doc["members"] if m["path"] in (str(a), str(b))}
    splits = {m["split"] for m in doc["members"] if m["path"] in (str(a), str(b))}
    assert len(groups) == 1 and len(splits) == 1
    assert len(by_id) == 4
    # forcing them apart is caught by the recomputed relation check
    for m in doc["members"]:
        if m["path"] == str(a):
            m["split"], m["group_id"] = "train", "g-forced"
            other = next(x for x in doc["members"] if x["path"] == str(b))
            other["split"] = "test"
    doc["splits"] = {s: sorted(m["dataset_id"] for m in doc["members"] if m["split"] == s) for s in ("train", "val", "test")}
    out.write_text(json.dumps(doc))
    res = audit_split(out, NullEmitter())
    assert not res["passed"]
    assert any("related demos" in v for v in res["violations"])


def test_assign_splits_small_sets() -> None:
    assert set(assign_splits({"a": 1, "b": 2}, 0.2, 0.2).values()) == {"train"}
    s = assign_splits({"a": 1, "b": 2, "c": 3}, 0.2, 0.2)
    assert s == {"c": "test", "b": "val", "a": "train"}
