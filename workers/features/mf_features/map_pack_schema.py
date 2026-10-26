"""Python mirror of ``packages/contracts/src/maps.ts`` (MapPack zod schema).

The generated JSON schema in ``packages/contracts/schema`` predates the optional ``floorGrid``
field, so packs are validated against this hand-written mirror of the TypeScript source instead.
Returns a list of ``"path: problem"`` strings (empty = valid).
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

REGION_KINDS = {
    "bombsite",
    "entrance",
    "choke",
    "corridor",
    "mid",
    "connector",
    "spawn",
    "rotation",
    "retake_route",
    "elevated",
    "open_area",
    "other",
}
REGION_SOURCES = {"demo_place_names", "authored", "imported"}
RADAR_SOURCES = {"game_overview_file", "operator_calibration", "recalled_unverified"}
CAMERA_VALIDATION = {"unvalidated", "preview_only", "validated", "invalidated"}
GRENADE_TYPES = {"he", "flashbang", "smoke", "molotov", "incendiary", "decoy"}
SUPPORT = {"supported", "partial", "unsupported", "unverified"}


class _V:
    def __init__(self) -> None:
        self.issues: list[str] = []

    def err(self, path: str, msg: str) -> None:
        self.issues.append(f"{path}: {msg}")

    def num(self, v: Any, path: str, *, positive: bool = False, integer: bool = False) -> bool:
        if isinstance(v, bool) or not isinstance(v, int | float) or not math.isfinite(float(v)):
            self.err(path, "expected finite number")
            return False
        if integer and float(v) != int(v):
            self.err(path, "expected integer")
            return False
        if positive and v <= 0:
            self.err(path, "expected positive number")
            return False
        return True

    def string(self, v: Any, path: str) -> bool:
        if not isinstance(v, str):
            self.err(path, "expected string")
            return False
        return True

    def boolean(self, v: Any, path: str) -> bool:
        if not isinstance(v, bool):
            self.err(path, "expected boolean")
            return False
        return True

    def array(self, v: Any, path: str) -> bool:
        if not isinstance(v, list):
            self.err(path, "expected array")
            return False
        return True

    def obj(self, v: Any, path: str) -> bool:
        if not isinstance(v, dict):
            self.err(path, "expected object")
            return False
        return True

    def enum(self, v: Any, allowed: set[str], path: str) -> None:
        if v not in allowed:
            self.err(path, f"expected one of {sorted(allowed)}, got {v!r}")

    def nullable_string(self, v: Any, path: str) -> None:
        if v is not None:
            self.string(v, path)


def _radar(v: _V, r: Any, path: str) -> None:
    if r is None:
        return
    if not v.obj(r, path):
        return
    v.num(r.get("posX"), f"{path}.posX")
    v.num(r.get("posY"), f"{path}.posY")
    v.num(r.get("scale"), f"{path}.scale", positive=True)
    if "rotationDeg" in r:
        v.num(r["rotationDeg"], f"{path}.rotationDeg")
    if "imageSizePx" in r:
        v.num(r["imageSizePx"], f"{path}.imageSizePx", positive=True, integer=True)
    v.enum(r.get("source"), RADAR_SOURCES, f"{path}.source")
    v.boolean(r.get("verified"), f"{path}.verified")


def _vec3(v: _V, p: Any, path: str) -> None:
    if v.obj(p, path):
        for k in ("x", "y", "z"):
            v.num(p.get(k), f"{path}.{k}")


def _shape(v: _V, s: Any, path: str) -> None:
    if not v.obj(s, path):
        return
    kind = s.get("kind")
    if kind == "polygon":
        pts = s.get("points")
        if v.array(pts, f"{path}.points"):
            if len(pts) < 3:
                v.err(f"{path}.points", "polygon needs at least 3 points")
            for i, pt in enumerate(pts):
                if not (isinstance(pt, list) and len(pt) == 2):
                    v.err(f"{path}.points[{i}]", "expected [x, y]")
                    continue
                v.num(pt[0], f"{path}.points[{i}][0]")
                v.num(pt[1], f"{path}.points[{i}][1]")
        v.num(s.get("zMin"), f"{path}.zMin")
        v.num(s.get("zMax"), f"{path}.zMax")
    elif kind == "cells":
        v.num(s.get("cellSize"), f"{path}.cellSize", positive=True)
        v.num(s.get("zCellSize"), f"{path}.zCellSize", positive=True)
        cells = s.get("cells")
        if v.array(cells, f"{path}.cells"):
            for i, c in enumerate(cells):
                if not (isinstance(c, list) and len(c) == 3 and all(isinstance(x, int) and not isinstance(x, bool) for x in c)):
                    v.err(f"{path}.cells[{i}]", "expected [ix, iy, iz] integers")
                    if len(v.issues) > 200:
                        return
    else:
        v.err(f"{path}.kind", f"unknown shape kind {kind!r}")


def _region(v: _V, r: Any, path: str) -> None:
    if not v.obj(r, path):
        return
    v.string(r.get("id"), f"{path}.id")
    v.string(r.get("name"), f"{path}.name")
    v.enum(r.get("kind"), REGION_KINDS, f"{path}.kind")
    v.nullable_string(r.get("levelId"), f"{path}.levelId")
    if "levelId" not in r:
        v.err(f"{path}.levelId", "required (nullable)")
    shapes = r.get("shapes")
    if v.array(shapes, f"{path}.shapes"):
        for i, s in enumerate(shapes):
            _shape(v, s, f"{path}.shapes[{i}]")
    v.enum(r.get("source"), REGION_SOURCES, f"{path}.source")
    sc = r.get("sampleCount")
    if sc is not None:
        v.num(sc, f"{path}.sampleCount", integer=True)
    v.boolean(r.get("validated"), f"{path}.validated")
    tags = r.get("tags", [])
    if v.array(tags, f"{path}.tags"):
        for i, t in enumerate(tags):
            v.string(t, f"{path}.tags[{i}]")


def validate_map_pack(pack: Any) -> list[str]:
    v = _V()
    if not v.obj(pack, "$"):
        return v.issues
    if pack.get("schemaVersion") != 1:
        v.err("$.schemaVersion", "must be 1")
    for k in ("mapName", "displayName", "mapRevision"):
        v.string(pack.get(k), f"$.{k}")
    if "radar" not in pack:
        v.err("$.radar", "required (nullable)")
    _radar(v, pack.get("radar"), "$.radar")
    levels = pack.get("levels")
    level_ids: set[str] = set()
    if v.array(levels, "$.levels"):
        for i, lv in enumerate(levels):
            p = f"$.levels[{i}]"
            if not v.obj(lv, p):
                continue
            if v.string(lv.get("id"), f"{p}.id"):
                level_ids.add(lv["id"])
            v.string(lv.get("name"), f"{p}.name")
            v.num(lv.get("zMin"), f"{p}.zMin")
            v.num(lv.get("zMax"), f"{p}.zMax")
            _radar(v, lv.get("radar"), f"{p}.radar")
    regions = pack.get("regions")
    region_ids: set[str] = set()
    if v.array(regions, "$.regions"):
        for i, r in enumerate(regions):
            _region(v, r, f"$.regions[{i}]")
            if isinstance(r, dict) and isinstance(r.get("id"), str):
                if r["id"] in region_ids:
                    v.err(f"$.regions[{i}].id", f"duplicate region id {r['id']!r}")
                region_ids.add(r["id"])
                lid = r.get("levelId")
                if lid is not None and lid not in level_ids:
                    v.err(f"$.regions[{i}].levelId", f"unknown level {lid!r}")
    for key in ("cameras", "paths"):
        if v.array(pack.get(key), f"$.{key}") and pack[key]:
            # cameras/paths must be captured in-game; this builder never emits them.
            for i, c in enumerate(pack[key]):
                if v.obj(c, f"$.{key}[{i}]"):
                    v.string(c.get("id"), f"$.{key}[{i}].id")
                    if key == "cameras":
                        _vec3(v, c.get("position"), f"$.{key}[{i}].position")
                        v.enum(c.get("validation"), CAMERA_VALIDATION, f"$.{key}[{i}].validation")
    bombsites = pack.get("bombsites", [])
    if v.array(bombsites, "$.bombsites"):
        for i, b in enumerate(bombsites):
            if v.obj(b, f"$.bombsites[{i}]"):
                v.enum(b.get("site"), {"A", "B"}, f"$.bombsites[{i}].site")
                if b.get("regionId") not in region_ids:
                    v.err(f"$.bombsites[{i}].regionId", f"unknown region {b.get('regionId')!r}")
    scen = pack.get("scenarios", [])
    if v.array(scen, "$.scenarios"):
        for i, s in enumerate(scen):
            v.obj(s, f"$.scenarios[{i}]")
    fg = pack.get("floorGrid")
    if fg is not None and v.obj(fg, "$.floorGrid"):
        v.num(fg.get("cellSize"), "$.floorGrid.cellSize", positive=True)
        v.string(fg.get("source"), "$.floorGrid.source")
        v.num(fg.get("sampleCount"), "$.floorGrid.sampleCount", integer=True)
        cells = fg.get("cells")
        if v.array(cells, "$.floorGrid.cells"):
            for i, row in enumerate(cells):
                if not isinstance(row, list) or not all(isinstance(x, int | float) and not isinstance(x, bool) for x in row):
                    v.err(f"$.floorGrid.cells[{i}]", "expected array of numbers")
                elif len(row) < 3:
                    v.err(f"$.floorGrid.cells[{i}]", "expected [ix, iy, z1, ...]")
                if len(v.issues) > 200:
                    break
    cov = pack.get("coverage", [])
    if v.array(cov, "$.coverage"):
        for i, c in enumerate(cov):
            if v.obj(c, f"$.coverage[{i}]"):
                v.enum(c.get("grenadeType"), GRENADE_TYPES, f"$.coverage[{i}].grenadeType")
                v.enum(c.get("telemetry"), SUPPORT, f"$.coverage[{i}].telemetry")
    prov = pack.get("provenance")
    if v.obj(prov, "$.provenance"):
        v.string(prov.get("createdBy"), "$.provenance.createdBy")
        v.string(prov.get("createdAt"), "$.provenance.createdAt")
        if v.array(prov.get("sources"), "$.provenance.sources"):
            for i, s in enumerate(prov["sources"]):
                v.string(s, f"$.provenance.sources[{i}]")
    return v.issues


def validate_map_pack_file(path: Path) -> list[str]:
    try:
        pack = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return [f"$: unreadable JSON ({exc})"]
    return validate_map_pack(pack)
