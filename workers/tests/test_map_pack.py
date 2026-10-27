"""Map-pack building from synthetic place samples and the MapPack contract validator."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import polars as pl
import pytest

from mf_common import errors
from mf_common.emit import NullEmitter
from mf_demo_parser.validate import validate_dataset
from mf_features.map_pack import build_map_pack, cluster_floors, principal_axis_split, region_id, region_kind
from mf_features.map_pack_schema import validate_map_pack
from synthetic_demo import build_dataset


def test_kind_and_id_mapping() -> None:
    assert region_kind("BombsiteA") == "bombsite"
    assert region_kind("CTSpawn") == "spawn"
    assert region_kind("TopofMid") == "mid" and region_kind("Middle") == "mid"
    assert region_kind("LowerMid") == "other" and region_kind("Banana") == "other"
    assert region_id("CTSpawn") == "ct_spawn"
    assert region_id("TSpawn") == "t_spawn"
    assert region_id("BombsiteB") == "bombsite_b"


def test_principal_axis_split_orients_by_reference() -> None:
    # a diagonal corridor of cells from (0,0) to (19,19)
    cells = pl.DataFrame({"ix": list(range(20)), "iy": list(range(20)), "iz": [0] * 20, "n": [5] * 20})
    near, far, info = principal_axis_split(cells, 64.0, reference_xy=(-500.0, -500.0))
    assert near["ix"].max() < far["ix"].min()
    assert near.height == far.height == 10
    near2, _far2, _ = principal_axis_split(cells, 64.0, reference_xy=(5000.0, 5000.0))
    assert near2["ix"].min() >= 10
    assert abs(abs(info["principal_axis"][0]) - abs(info["principal_axis"][1])) < 1e-6


def test_floor_clustering_separates_stacked_floors() -> None:
    zs = np.concatenate([np.full(20, 0.0), np.full(10, 3.0), np.full(15, 200.0), np.array([600.0])])
    assert cluster_floors(zs, 72.0, 3) == [0.0, 200.0]


def test_build_pack_from_synthetic_dataset(tmp_path: Path) -> None:
    ds = build_dataset(tmp_path)
    validate_dataset(ds, NullEmitter())
    out = tmp_path / "pack.json"
    res = build_map_pack([tmp_path / "data"], "de_synthetic", out, NullEmitter(), graph_out=tmp_path / "g.json")
    pack = json.loads(out.read_text())
    assert validate_map_pack(pack) == []
    assert pack["radar"] is None and pack["cameras"] == [] and pack["paths"] == []
    assert [lv["id"] for lv in pack["levels"]] == ["ground"]
    assert {r["id"] for r in pack["regions"]} >= {"t_spawn", "ct_spawn", "middle", "bombsite_a"}
    assert all(r["source"] == "demo_place_names" and r["validated"] is False for r in pack["regions"])
    assert pack["bombsites"] == [{"site": "A", "regionId": "bombsite_a"}]
    assert any(len(c) > 3 for c in pack["floorGrid"]["cells"])  # the 'Upper' area stacks above ground
    assert res["bytes"] < 1_500_000
    graph = json.loads((tmp_path / "g.json").read_text())
    assert any({e["a"], e["b"]} == {"middle", "t_spawn"} for e in graph["edges"])


def test_no_pack_without_data(tmp_path: Path) -> None:
    ds = build_dataset(tmp_path)
    validate_dataset(ds, NullEmitter())
    with pytest.raises(errors.MfError) as exc:
        build_map_pack([tmp_path / "data"], "de_nuke", tmp_path / "nuke.json", NullEmitter())
    assert exc.value.code == errors.INSUFFICIENT_DATA
    assert not (tmp_path / "nuke.json").exists()


def test_validator_rejects_contract_violations() -> None:
    pack = {
        "schemaVersion": 1,
        "mapName": "de_x",
        "displayName": "X",
        "mapRevision": "r",
        "radar": None,
        "levels": [{"id": "ground", "name": "Ground", "zMin": 0, "zMax": 10, "radar": None}],
        "regions": [
            {
                "id": "a",
                "name": "A",
                "kind": "bombsite",
                "levelId": "ground",
                "source": "demo_place_names",
                "validated": False,
                "tags": [],
                "shapes": [{"kind": "cells", "cellSize": 64, "zCellSize": 64, "cells": [[1, 2, 3]]}],
            }
        ],
        "cameras": [],
        "paths": [],
        "bombsites": [{"site": "A", "regionId": "a"}],
        "scenarios": [],
        "floorGrid": {"cellSize": 64, "cells": [[1, 2, 0.5]], "source": "s", "sampleCount": 3},
        "coverage": [],
        "provenance": {"createdBy": "t", "createdAt": "now", "sources": []},
    }
    assert validate_map_pack(pack) == []
    bad = json.loads(json.dumps(pack))
    bad["regions"][0]["kind"] = "lobby"
    bad["regions"][0]["shapes"][0]["cells"] = [[1, 2]]
    bad["bombsites"][0]["regionId"] = "missing"
    bad["floorGrid"]["cells"] = [[1]]
    bad["radar"] = {"posX": 0, "posY": 0, "scale": -1, "source": "guessed", "verified": True}
    issues = validate_map_pack(bad)
    joined = "\n".join(issues)
    for frag in ("kind", "cells[0]", "regionId", "floorGrid.cells[0]", "radar.scale", "radar.source"):
        assert frag in joined
