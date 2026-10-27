#!/usr/bin/env python3
"""Built-in cameras and camera paths for the active-duty maps, from navigation-mesh data.

Usage (stdlib + Pillow):
    pip download --no-deps awpy==1.3.1 -d /tmp/awpy && tar -xzf /tmp/awpy/awpy-1.3.1.tar.gz -C /tmp/awpy
    python3 scripts/generate-map-cameras.py /tmp/awpy/awpy-1.3.1/awpy/data/nav/nav_info.csv

Input: awpy 1.3.1's nav_info.csv (MIT, (c) Peter Xenopoulos): the navigation areas of each map
(axis-aligned walkable rectangles with floor heights and place names such as BombsiteA). They are
the CS:GO meshes; the CS2 versions of these maps kept the layout and coordinates, which this script
checks against the CS2 radar calibration in assets/radars (areas that fall outside the drawn CS2
radar are dropped, e.g. parts of Train that CS2 reworked) and, where a demo-derived pack exists,
against real CS2 player positions.

Output, in assets/map-packs:
* maps without a demo-derived pack get a pack built from the navigation areas (regions, bombsites,
  floor grid, levels from the radar layers);
* every pack gets its built-in cameras and paths replaced (capturedFrom / source "derived_navmesh").

Cameras: for each bombsite, the mid area and each spawn, spots on walkable floor 350-1000 units from
the area's centre, at floor + 140 units (above head height; lower where another floor is above, as
on Nuke), looking at the centre. A spot is kept
only when the line from it to the centre runs over continuous walkable floor drawn on the CS2 radar
(no walls in between), with no walkable surface near the sight line itself (a train or crate stack
in the way, or the slab between two levels), and, where CS2 demo data covers the area, when players have stood there in
CS2. Two or three spots per area are chosen far apart in angle; elevated spots are preferred.
Paths: an orbit through consecutive clear spots around each site and mid (when they link up), and a
slow push-in along the clearest sight line, which is clear by construction. Nothing here has been seen in
the game: the program checks each shot with getpos and operators can turn any camera off.
"""

from __future__ import annotations

import csv
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - Pillow is needed for the CS2 radar check
    sys.exit("Pillow is required: pip install pillow")

REPO = Path(__file__).resolve().parent.parent
PACKS = REPO / "assets" / "map-packs"
RADARS = REPO / "assets" / "radars"
MAPS = ["de_ancient", "de_anubis", "de_dust2", "de_inferno", "de_mirage", "de_nuke", "de_overpass", "de_train", "de_vertigo"]
DISPLAY = {"de_ancient": "Ancient", "de_anubis": "Anubis", "de_dust2": "Dust II", "de_inferno": "Inferno", "de_mirage": "Mirage", "de_nuke": "Nuke", "de_overpass": "Overpass", "de_train": "Train", "de_vertigo": "Vertigo"}
MID_NAMES = {"Mid", "Middle", "TopofMid"}
NAV_REVISION = "navmesh:awpy-1.3.1"
SOURCE = "awpy 1.3.1 nav_info.csv (MIT, (c) Peter Xenopoulos): CS:GO navigation meshes"

GRID = 32.0  # walkability grid
CELL, ZCELL = 64.0, 128.0  # region cells, as in the demo-derived packs
CAM_HEIGHT = 140.0  # camera above the floor at its spot
PATH_HEIGHT = 150.0
AIM_HEIGHT = 48.0  # look at chest height above the area's floor
MIN_D, MAX_D, BEST_D = 350.0, 1000.0, 650.0
LEVEL_TOL = 96.0  # walkable floor along a sight line must stay within this of the line's floor
SURFACE_GAP = 35.0  # no walkable surface (train roof, slab between levels) within this of the sight line
HEADROOM = 50.0  # camera at least this far below any floor above its spot
MIN_CAM_HEIGHT = 90.0
PATH_SPEED = 110.0  # units per second
PUSH_MS = 6000  # push-in duration
PLACE_LABEL = {"BombsiteA": "A site", "BombsiteB": "B site", "CTSpawn": "CT spawn", "TSpawn": "T spawn", "Middle": "Mid", "Mid": "Mid", "TopofMid": "Top of mid"}


_NUMERIC_ARRAY = re.compile(r"\[\s*(-?\d[\d.eE+-]*(?:\s*,\s*-?\d[\d.eE+-]*)*)\s*\]")


def dumps_readable(obj: object) -> str:
    """As workers/common/mf_common/emit.py: indented JSON with innermost numeric arrays on one line."""
    text = json.dumps(obj, indent=2, ensure_ascii=False, allow_nan=False)
    return _NUMERIC_ARRAY.sub(lambda m: "[" + ",".join(x.strip() for x in m.group(1).split(",")) + "]", text)


def region_id(place: str) -> str:
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", place)
    s = re.sub(r"([a-z\d])([A-Z])", r"\1_\2", s)
    return re.sub(r"[^a-z0-9_]+", "_", s.lower()).strip("_")


def region_kind(place: str) -> str:
    if place.startswith("Bombsite"):
        return "bombsite"
    if place.endswith("Spawn"):
        return "spawn"
    if place in MID_NAMES:
        return "mid"
    return "other"


def human(place: str) -> str:
    if place in PLACE_LABEL:
        return PLACE_LABEL[place]
    return re.sub(r"([a-z])([A-Z])", r"\1 \2", place) or "?"


class Radar:
    """CS2 radar drawing and calibration: whether a world point lies on the drawn map."""

    def __init__(self, map_name: str):
        cal = json.loads((RADARS / "radars.json").read_text())["maps"].get(map_name)
        self.cal = cal
        self.img = None
        if cal:
            self.img = Image.open(RADARS / cal["file"]).convert("RGBA")
            self.px = self.img.load()
            self.scale = self.img.size[0] / cal["size"]

    def layers(self) -> list[dict]:
        return self.cal["layers"] if self.cal else []

    def drawn(self, x: float, y: float, z: float) -> bool:
        if not self.img:
            return True
        lay = self.cal["layers"][0]
        for layer in self.cal["layers"]:
            lo, hi = layer.get("zMin"), layer.get("zMax")
            if (lo is None or z >= lo) and (hi is None or z < hi):
                lay = layer
                break
        u = (lay["originX"] + x * lay["pxPerUX"]) * self.scale
        v = (lay["originY"] + y * lay["pxPerUY"]) * self.scale
        w, h = self.img.size
        if not (0 <= u < w and 0 <= v < h):
            return False
        r, g, b, a = self.px[int(u), int(v)]
        return a > 40 and (r + g + b) > 60


class Nav:
    def __init__(self, areas: list[dict], radar: Radar, cs2_floor: dict | None):
        self.radar = radar
        self.cs2_floor = cs2_floor
        kept = [a for a in areas if radar.drawn(a["cx"], a["cy"], a["cz"])]
        self.dropped = len(areas) - len(kept)
        self.areas = kept
        self.floors: dict[tuple[int, int], list[float]] = defaultdict(list)
        self.place_at: dict[tuple[int, int, int], str] = {}
        for a in kept:
            for gx in range(math.floor(a["x1"] / GRID), math.floor((a["x2"] - 1e-6) / GRID) + 1):
                for gy in range(math.floor(a["y1"] / GRID), math.floor((a["y2"] - 1e-6) / GRID) + 1):
                    x, y = (gx + 0.5) * GRID, (gy + 0.5) * GRID
                    z = a["z_at"](x, y)
                    self.floors[(gx, gy)].append(z)
                    if a["place"]:
                        self.place_at[(gx, gy, round(z / 64))] = a["place"]

    def floor_near(self, x: float, y: float, z: float, tol: float = LEVEL_TOL) -> float | None:
        best = None
        for f in self.floors.get((math.floor(x / GRID), math.floor(y / GRID)), []):
            if abs(f - z) <= tol and (best is None or abs(f - z) < abs(best - z)):
                best = f
        return best

    def place_near(self, x: float, y: float, z: float) -> str:
        g = (math.floor(x / GRID), math.floor(y / GRID))
        for dz in (0, -1, 1):
            p = self.place_at.get((g[0], g[1], round(z / 64) + dz))
            if p:
                return p
        return ""

    def covers(self, place: str) -> bool:
        """CS2 demo data has player positions over most of this area (a wingman demo covers one site only)."""
        if self.cs2_floor is None:
            return False
        size = self.cs2_floor["size"]
        cells = {(math.floor(a["cx"] / size), math.floor(a["cy"] / size)) for a in self.areas if a["place"] == place}
        hit = sum(1 for (fx, fy) in cells if any((fx + dx, fy + dy) in self.cs2_floor["cells"] for dx in (-1, 0, 1) for dy in (-1, 0, 1)))
        return bool(cells) and hit / len(cells) >= 0.5

    def in_cs2(self, x: float, y: float, z: float) -> bool:
        """With CS2 demo data: players stood within a cell of this spot in CS2."""
        if self.cs2_floor is None:
            return True
        size = self.cs2_floor["size"]
        fx, fy = math.floor(x / size), math.floor(y / size)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for f in self.cs2_floor["cells"].get((fx + dx, fy + dy), []):
                    if abs(f - z) <= 96:
                        return True
        return False

    def headroom(self, x: float, y: float, f: float, min_gap: float = 40) -> float:
        """Space above floor f at this spot before the next floor up (e.g. Nuke A above B); floors
        less than min_gap up are steps or platforms, not ceilings."""
        above = [g for g in self.floors.get((math.floor(x / GRID), math.floor(y / GRID)), []) if g > f + min_gap]
        return min(above) - f if above else math.inf

    def clear(self, a: tuple[float, float, float], b: tuple[float, float, float], eye_a: float, eye_b: float) -> bool:
        """A sight line from eye height eye_a above floor point a to eye_b above b: continuous walkable
        floor under it (drawn on the CS2 radar), and no walkable surface near the line itself, which
        would be an obstacle top (a train, a crate stack) or the slab between two levels."""
        dist = math.hypot(b[0] - a[0], b[1] - a[1])
        steps = max(2, int(dist / 24))
        for i in range(1, steps):
            t = i / steps
            x, y = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
            zf = a[2] + (b[2] - a[2]) * t
            sight = zf + eye_a + (eye_b - eye_a) * t
            f = self.floor_near(x, y, zf)
            if f is None or not self.radar.drawn(x, y, f):
                return False
            for g in self.floors.get((math.floor(x / GRID), math.floor(y / GRID)), []):
                if g != f and sight - SURFACE_GAP < g < sight + SURFACE_GAP:
                    return False
        return True


def load_nav(path: str) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = defaultdict(list)
    for r in csv.DictReader(open(path, newline="")):
        if r["mapName"] not in MAPS:
            continue
        x1, y1, z1 = float(r["northWestX"]), float(r["northWestY"]), float(r["northWestZ"])
        x2, y2, z2 = float(r["southEastX"]), float(r["southEastY"]), float(r["southEastZ"])
        lx, hx, ly, hy = min(x1, x2), max(x1, x2), min(y1, y2), max(y1, y2)

        def z_at(x: float, y: float, x1=x1, y1=y1, z1=z1, x2=x2, y2=y2, z2=z2) -> float:
            # Floor height from the two known corners: the mean of the x and y fractions along the diagonal.
            tx = (x - x1) / (x2 - x1) if x2 != x1 else 0.5
            ty = (y - y1) / (y2 - y1) if y2 != y1 else 0.5
            t = min(1.0, max(0.0, (tx + ty) / 2))
            return z1 + (z2 - z1) * t

        out[r["mapName"]].append({"place": r["areaName"], "x1": lx, "x2": hx, "y1": ly, "y2": hy, "cx": (lx + hx) / 2, "cy": (ly + hy) / 2, "cz": (z1 + z2) / 2, "area": max(1.0, (hx - lx) * (hy - ly)), "z_at": z_at})
    return out


def cs2_floor_of(pack: dict | None) -> dict | None:
    if not pack or not pack.get("floorGrid") or "demo" not in pack["floorGrid"].get("source", ""):
        return None
    cells: dict[tuple[int, int], list[float]] = {}
    for c in pack["floorGrid"]["cells"]:
        cells[(int(c[0]), int(c[1]))] = [float(z) for z in c[2:]]
    return {"size": pack["floorGrid"]["cellSize"], "cells": cells}


def angles(cam: tuple[float, float, float], target: tuple[float, float, float]) -> tuple[float, float]:
    dx, dy, dz = target[0] - cam[0], target[1] - cam[1], target[2] - cam[2]
    yaw = math.degrees(math.atan2(dy, dx))
    pitch = -math.degrees(math.atan2(dz, math.hypot(dx, dy)))  # Source: positive pitch looks down
    return round(pitch, 2), round(yaw, 2)


def level_id(levels: list[dict], z: float) -> str | None:
    if len(levels) <= 1:
        return levels[0]["id"] if levels else None
    for lv in levels:
        if lv["zMin"] <= z < lv["zMax"]:
            return lv["id"]
    return None


def area_targets(nav: Nav, place: str) -> dict | None:
    pts = [a for a in nav.areas if a["place"] == place]
    if not pts:
        return None
    w = sum(a["area"] for a in pts)
    cx = sum(a["cx"] * a["area"] for a in pts) / w
    cy = sum(a["cy"] * a["area"] for a in pts) / w
    zs = sorted(a["cz"] for a in pts)
    floor = zs[len(zs) // 2]
    centre_floor = nav.floor_near(cx, cy, floor, 200) or floor
    radius = max(math.hypot(a["cx"] - cx, a["cy"] - cy) for a in pts)
    return {"place": place, "x": cx, "y": cy, "floor": centre_floor, "zmin": zs[0], "zmax": zs[-1], "radius": radius}


def candidates(nav: Nav, t: dict) -> list[dict]:
    target_floor = (t["x"], t["y"], t["floor"])
    check_cs2 = nav.covers(t["place"])
    out = []
    seen = set()
    for (gx, gy), floors in nav.floors.items():
        if gx % 2 or gy % 2:  # every other cell: 64-unit spacing is plenty
            continue
        x, y = (gx + 0.5) * GRID, (gy + 0.5) * GRID
        d = math.hypot(x - t["x"], y - t["y"])
        if not (MIN_D <= d <= MAX_D):
            continue
        for f in floors:
            if abs(f - t["floor"]) > 220 or (gx, gy, round(f)) in seen:
                continue
            seen.add((gx, gy, round(f)))
            if not nav.radar.drawn(x, y, f) or (check_cs2 and not nav.in_cs2(x, y, f)):
                continue
            # Room around the spot: walkable floor on all sides, so the camera isn't against a wall.
            if any(nav.floor_near(x + ox, y + oy, f, 48) is None for ox, oy in ((48, 0), (-48, 0), (0, 48), (0, -48))):
                continue
            height = min(CAM_HEIGHT, nav.headroom(x, y, f) - HEADROOM)
            if height < MIN_CAM_HEIGHT or nav.headroom(t["x"], t["y"], t["floor"], 150) < AIM_HEIGHT + HEADROOM:
                continue
            if not nav.clear((x, y, f), target_floor, height, AIM_HEIGHT):
                continue
            elevation = max(0.0, min(1.0, (f - t["floor"]) / 160))
            score = 1.0 - abs(d - BEST_D) / BEST_D + 0.6 * elevation
            out.append({"x": x, "y": y, "floor": f, "height": height, "d": d, "angle": math.atan2(y - t["y"], x - t["x"]), "score": score})
    return out


def pick_spread(cands: list[dict], n: int, min_sep_deg: float) -> list[dict]:
    chosen: list[dict] = []
    for c in sorted(cands, key=lambda c: -c["score"]):
        if all(abs(math.degrees(math.atan2(math.sin(c["angle"] - o["angle"]), math.cos(c["angle"] - o["angle"])))) >= min_sep_deg for o in chosen):
            chosen.append(c)
        if len(chosen) == n:
            break
    return chosen


def orbit(nav: Nav, t: dict, cands: list[dict]) -> list[dict]:
    """The longest chain of clear spots around the target, each linked to the next by a clear line."""
    ring = [c for c in cands if 450 <= c["d"] <= 900]
    if len(ring) < 3:
        return []
    by_angle: dict[int, dict] = {}
    for c in ring:  # best spot per 15-degree sector
        k = int((math.degrees(c["angle"]) + 180) // 15)
        if k not in by_angle or c["score"] > by_angle[k]["score"]:
            by_angle[k] = c
    sectors = sorted(by_angle)
    best: list[dict] = []
    for start in range(len(sectors)):
        chain = [by_angle[sectors[start]]]
        k = sectors[start]
        while len(chain) < 8:
            nxt = None
            for step in (2, 3, 1):  # 30, 45 or 15 degrees on
                kk = (k + step) % 24
                if kk in by_angle and by_angle[kk] not in chain:
                    c = by_angle[kk]
                    p = chain[-1]
                    if nav.clear((p["x"], p["y"], p["floor"]), (c["x"], c["y"], c["floor"]), min(PATH_HEIGHT, p["height"]), min(PATH_HEIGHT, c["height"])):
                        nxt, k = c, kk
                        break
            if not nxt:
                break
            chain.append(nxt)
        if len(chain) > len(best):
            best = chain
    if len(best) < 3:
        return []
    target = (t["x"], t["y"], t["floor"] + AIM_HEIGHT)
    keys, tms = [], 0.0
    for i, c in enumerate(best):
        if i:
            p = best[i - 1]
            tms += math.hypot(c["x"] - p["x"], c["y"] - p["y"], c["floor"] - p["floor"]) / PATH_SPEED * 1000
        pos = (c["x"], c["y"], c["floor"] + min(PATH_HEIGHT, c["height"]))
        pitch, yaw = angles(pos, target)
        keys.append({"tMs": round(tms), "position": {"x": round(pos[0], 1), "y": round(pos[1], 1), "z": round(pos[2], 1)}, "pitch": pitch, "yaw": yaw})
    return keys


def push_in(t: dict, c: dict) -> list[dict]:
    """A slow dolly from a clear spot toward the area's centre, along its (clear) sight line."""
    target = (t["x"], t["y"], t["floor"] + AIM_HEIGHT)
    keys = []
    for i, frac in enumerate((0.0, 0.45)):
        x = c["x"] + (t["x"] - c["x"]) * frac
        y = c["y"] + (t["y"] - c["y"]) * frac
        z = c["floor"] + (t["floor"] - c["floor"]) * frac + min(PATH_HEIGHT, c["height"]) - 30 * frac
        pitch, yaw = angles((x, y, z), target)
        keys.append({"tMs": i * PUSH_MS, "position": {"x": round(x, 1), "y": round(y, 1), "z": round(z, 1)}, "pitch": pitch, "yaw": yaw})
    return keys


def build_regions(nav: Nav, levels: list[dict]) -> tuple[list[dict], dict]:
    by_place: dict[str, set] = defaultdict(set)
    counts: dict[str, int] = defaultdict(int)
    for a in nav.areas:
        if not a["place"]:
            continue
        counts[a["place"]] += 1
        for gx in range(math.floor(a["x1"] / CELL), math.floor((a["x2"] - 1e-6) / CELL) + 1):
            for gy in range(math.floor(a["y1"] / CELL), math.floor((a["y2"] - 1e-6) / CELL) + 1):
                z = a["z_at"]((gx + 0.5) * CELL, (gy + 0.5) * CELL)
                by_place[a["place"]].add((gx, gy, math.floor(z / ZCELL)))
    regions = []
    for place in sorted(by_place):
        cells = sorted(by_place[place])
        zs = [(c[2] + 0.5) * ZCELL for c in cells]
        regions.append({
            "id": region_id(place),
            "name": place,
            "kind": region_kind(place),
            "levelId": level_id(levels, sorted(zs)[len(zs) // 2]),
            "shapes": [{"kind": "cells", "cellSize": CELL, "zCellSize": ZCELL, "cells": [list(c) for c in cells]}],
            "source": "imported",
            "sampleCount": counts[place],
            "validated": False,
            "tags": ["navmesh"],
        })
    floor_cells: dict[tuple[int, int], list[float]] = defaultdict(list)
    for (gx, gy), floors in nav.floors.items():
        floor_cells[(math.floor(gx * GRID / CELL), math.floor(gy * GRID / CELL))].extend(floors)
    grid = []
    for (fx, fy) in sorted(floor_cells):
        zs = sorted(floor_cells[(fx, fy)])
        groups, cur = [], [zs[0]]
        for z in zs[1:]:
            if z - cur[-1] > 96:
                groups.append(cur)
                cur = [z]
            else:
                cur.append(z)
        groups.append(cur)
        grid.append([fx, fy, *[round(g[len(g) // 2], 1) for g in groups]])
    return regions, {"cellSize": CELL, "cells": grid, "source": "navmesh_awpy_1.3.1", "sampleCount": len(nav.areas)}


def levels_for(radar: Radar, areas: list[dict]) -> list[dict]:
    zs = [a["cz"] for a in areas]
    lo, hi = math.floor(min(zs)) - 64, math.ceil(max(zs)) + 256
    layers = radar.layers()
    if len(layers) == 2 and any(l.get("zMin") is not None for l in layers):
        split = next(l["zMin"] for l in layers if l.get("zMin") is not None)
        return [
            {"id": "upper", "name": "Upper", "zMin": split, "zMax": hi, "radar": None},
            {"id": "lower", "name": "Lower", "zMin": lo, "zMax": split, "radar": None},
        ]
    return [{"id": "ground", "name": "Ground", "zMin": lo, "zMax": hi, "radar": None}]


def camera_record(map_name: str, revision: str, nav: Nav, t: dict, c: dict, kind: str, levels: list[dict], n: int) -> dict:
    target = (t["x"], t["y"], t["floor"] + AIM_HEIGHT)
    pos = (c["x"], c["y"], c["floor"] + c["height"])
    pitch, yaw = angles(pos, target)
    spot = nav.place_near(c["x"], c["y"], c["floor"])
    label = human(t["place"]) + (f" from {human(spot)}" if spot and spot != t["place"] else f" #{n}")
    classes = {"bombsite": ["bomb", "tactical", "establishing", "utility"], "mid": ["tactical", "establishing", "utility"], "spawn": ["establishing"]}[kind]
    return {
        "id": f"nav-{map_name.removeprefix('de_')}-{region_id(t['place'])}-{n}",
        "displayName": label,
        "mapName": map_name,
        "mapRevision": revision,
        "position": {"x": round(pos[0], 1), "y": round(pos[1], 1), "z": round(pos[2], 1)},
        "pitch": pitch,
        "yaw": yaw,
        "fov": None,
        "observerMode": "roaming_static",
        "targetRegionIds": [region_id(t["place"])],
        "coverage": {
            "center": {"x": round(t["x"], 1), "y": round(t["y"], 1), "z": round(t["floor"] + AIM_HEIGHT, 1)},
            "radiusUnits": round(max(500.0, t["radius"] * 1.25), 1),
            "zMin": round(t["zmin"] - 100, 1),
            "zMax": round(t["zmax"] + 250, 1),
            "levelId": level_id(levels, t["floor"]),
        },
        "allowedPhases": ["freezetime", "live", "over"] if kind != "spawn" else ["freezetime"],
        "actionClasses": classes,
        "grenadeTypes": [],
        "minAcquisitionMs": 150,
        "normalDurationMs": 4000 if kind != "spawn" else 5000,
        "maxDurationMs": 7000,
        "occlusionValidation": "unvalidated",
        "validation": "unvalidated",
        "exitStrategy": "most_relevant_player",
        "lastTestedGameBuild": None,
        "lastTestedMapVersion": None,
        "capturedFrom": "derived_navmesh",
        "notes": f"Placed from navigation-mesh data ({spot or 'walkable floor'}, {round(c['d'])} units from the {human(t['place'])} centre); the sight line runs over walkable floor. Not seen in game yet.",
    }


def generate(map_name: str, nav_areas: list[dict]) -> dict:
    path = PACKS / f"{map_name}.json"
    existing = json.loads(path.read_text()) if path.exists() else None
    radar = Radar(map_name)
    nav = Nav(nav_areas, radar, cs2_floor_of(existing))
    if existing:
        pack = existing
        levels = pack["levels"]
        # Add what the demo didn't cover (a wingman demo has one site): regions and bombsites.
        regions, _ = build_regions(nav, levels)
        have = {r["name"] for r in pack["regions"]}
        added = [r for r in regions if r["name"] not in have]
        pack["regions"] = [r for r in pack["regions"] if "navmesh" not in r.get("tags", [])] + [r for r in regions if r["name"] not in {x["name"] for x in pack["regions"] if "navmesh" not in x.get("tags", [])}]
        names = {r["name"]: r["id"] for r in pack["regions"]}
        sites = {b["site"] for b in pack["bombsites"]}
        pack["bombsites"] += [{"site": s[-1], "regionId": names[s]} for s in ("BombsiteA", "BombsiteB") if s in names and s[-1] not in sites]
        # The floor grid stays CS2 player positions only (it is the "players stood here in CS2" check).
        if added and SOURCE not in pack["provenance"]["sources"]:
            pack["provenance"]["sources"].append(SOURCE + f": regions for places the demo didn't cover ({', '.join(r['name'] for r in added)})")
    else:
        levels = levels_for(radar, nav.areas)
        regions, floor = build_regions(nav, levels)
        share = 1 - nav.dropped / max(1, len(nav_areas))
        pack = {
            "schemaVersion": 1,
            "mapName": map_name,
            "displayName": DISPLAY[map_name],
            "mapRevision": NAV_REVISION,
            "radar": None,
            "levels": levels,
            "regions": regions,
            "cameras": [],
            "paths": [],
            "bombsites": [{"site": s[-1], "regionId": region_id(s)} for s in ("BombsiteA", "BombsiteB") if any(r["name"] == s for r in regions)],
            "scenarios": [],
            "floorGrid": floor,
            "coverage": [],
            "provenance": {
                "createdBy": "scripts/generate-map-cameras.py",
                "createdAt": "2026-10-27T00:00:00Z",
                "sources": [SOURCE, f"checked against the CS2 radar calibration: {share:.1%} of navigation areas lie on the drawn CS2 radar; the rest were dropped"],
            },
        }
    revision = pack["mapRevision"]
    cameras = [c for c in pack["cameras"] if c.get("capturedFrom") != "derived_navmesh"]
    paths = [p for p in pack["paths"] if p.get("source") != "derived_navmesh"]
    places = ["BombsiteA", "BombsiteB"] + [p for p in ("Middle", "Mid", "TopofMid") if any(a["place"] == p for a in nav.areas)][:1] + ["CTSpawn", "TSpawn"]
    report = []
    for place in places:
        t = area_targets(nav, place)
        if not t:
            continue
        kind = region_kind(place)
        cands = candidates(nav, t)
        want = 3 if kind == "bombsite" else 2
        chosen = pick_spread(cands, want, 70)
        if len(chosen) < want:
            chosen = pick_spread(cands, want, 45)
        for n, c in enumerate(chosen, 1):
            cameras.append(camera_record(map_name, revision, nav, t, c, kind, levels, n))
        made = []
        if kind in ("bombsite", "mid"):
            keys = orbit(nav, t, cands)
            if keys and keys[-1]["tMs"] >= 3000:
                made.append(("orbit", "orbit", keys))
            if chosen:
                made.append(("push", "push-in", push_in(t, chosen[0])))
        for suffix, label, keys in made:
            paths.append({
                "id": f"nav-{map_name.removeprefix('de_')}-{region_id(place)}-{suffix}",
                "displayName": f"{human(place)} {label}",
                "mapName": map_name,
                "mapRevision": revision,
                "keyframes": keys,
                "maxDurationMs": round(keys[-1]["tMs"] + 1000),
                "maxSpeedUnitsPerSec": 300,
                "collisionValidated": False,
                "validation": "unvalidated",
                "targetRegionIds": [region_id(place)],
                "source": "derived_navmesh",
            })
        report.append(f"{place}: {len(cands)} clear spots, {len(chosen)} cameras, paths: " + (", ".join(f"{l} {k[-1]['tMs'] / 1000:.1f} s" for _, l, k in made) or "none"))
    pack["cameras"] = cameras
    pack["paths"] = paths
    path.write_text(dumps_readable(pack) + "\n")
    print(f"{map_name}: {'existing pack' if existing else 'new pack'}, {len(nav.areas)} areas ({nav.dropped} off the CS2 radar) — " + "; ".join(report))
    return pack


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    nav = load_nav(sys.argv[1])
    for m in MAPS:
        if not nav.get(m):
            print(f"{m}: no navigation data")
            continue
        generate(m, nav[m])


if __name__ == "__main__":
    main()
