#!/usr/bin/env python3
"""Built-in cameras and camera paths for the active-duty maps, checked against CS2's own geometry.

Usage:
    python3 -m venv .venv && .venv/bin/pip install awpy==3.1.1
    # navs.zip and geometry.zip from an awpy-data release (github.com/pnxenopoulos/awpy-data), unzipped
    .venv/bin/python scripts/generate-map-cameras.py --navs navs/ --meshes geometry/ --manifest manifest.json

Input: the CS2 navigation meshes (walkable areas) and collision meshes that awpy-data extracts from
the game files of one CS2 build (awpy 3.1.1 reads both: NavMesh, and VisibilityChecker for line-of-
sight tests). The map packs in assets/map-packs give the areas to film (their regions).

For each bombsite, the mid area (or the map's equivalent) and each spawn:
* target points: the area's region cells dropped onto CS2's walkable floor, at chest height;
* camera spots: walkable floor 300-1100 units from the area's centre, with the camera 140, 200 or
  260 units above it. A spot is kept only when, in CS2's collision geometry, the camera has clear
  space around it and above its floor, it sees the area's centre, it sees most of the area's
  target points, and no wall fills the picture (at most a quarter of it nearer than 150 units).
  Two or three spots far apart in angle are chosen, preferring the ones that see the most, from a
  good distance and a little above;
* paths: an orbit through neighbouring good spots (or a sideways drift) and a slow push-in from the
  best one. The curve the console adapter actually flies (Catmull-Rom through the keyframes, as
  samplePath in services/observer-agent/src/netcon.ts) is sampled every few units: every step must
  be clear of geometry and keep the centre in view.

Every other named area of the pack gets two cameras the same way, for live play only (fight
overviews and nade cameras), and no paths: paths fly in freeze time, where the sites, mid and
spawns are the story. Areas no spot frames well (ladders, vents, narrow tunnels) get none.

Collision geometry is what players collide with: glass, fences, foliage and other see-through or
non-solid props are not in it. So a camera can still look through a fence the tests treat as a
wall (and is dropped), or past a non-solid prop the tests don't see. Nothing here has been seen in
the game: the program confirms each shot with getpos, and operators can turn any camera off.

Existing operator cameras and paths are kept; only the built-in ones (capturedFrom / source
"derived_navmesh") are replaced.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

try:
    from awpy import NavMesh, VisibilityChecker
except ImportError:  # pragma: no cover
    sys.exit("awpy 3.1.1 is required: pip install awpy==3.1.1")

REPO = Path(__file__).resolve().parent.parent
PACKS = REPO / "assets" / "map-packs"
MAPS = ["de_ancient", "de_anubis", "de_cache", "de_dust2", "de_inferno", "de_mirage", "de_nuke", "de_overpass", "de_train", "de_vertigo"]
# The area each map's mid camera films: its "mid" region, or the map's equivalent where it has none.
MID_REGIONS = {"de_nuke": ["outside"], "de_overpass": ["connector", "fountain", "playground"], "de_train": ["connector"]}

AIM = 48.0  # look at chest height above the floor
HEIGHTS = (260.0, 200.0, 140.0)  # camera above its floor, highest first
MIN_D, MAX_D, BEST_D = 300.0, 1100.0, 650.0
CLEAR = 24.0  # free space around a camera in every direction
SPOT_GRID = 64.0  # camera spots: one per cell of this size
SAMPLE = 48.0  # walkable samples inside each navigation area
MAX_TARGETS = 64
PATH_SPEED = 110.0  # units per second
MAX_PATH_SPEED = 220.0
MAX_ORBIT_MS = 10000  # a path has to fit in freeze time
PUSH_MS = 6000
DRIFT = 220.0  # sideways move of a drift path
PATH_STEP = 24.0  # path curve checked every this many units
MIN_COVER = {"bombsite": 0.5, "mid": 0.45, "spawn": 0.4, "area": 0.45}
# Framing: rays across the picture (16:9, CS2's default 90 degree spectator view) that run this far
# without hitting anything; a wall or pillar right in front of the camera fills the frame.
OPEN_RANGE = 220.0
MIN_OPEN = 0.55
MIN_OPEN_TIGHT = 0.45  # for narrow areas (a connector) where no spot does better
# A wall at the lens: at most this share of the whole picture (CS2's 90 degrees at 4:3, so about 106
# degrees across on 16:9) may be geometry nearer than NEAR_RANGE.
NEAR_RANGE = 150.0
MAX_NEAR = 0.25
LABEL = {"bombsite_a": "A site", "bombsite_b": "B site", "ct_spawn": "CT spawn", "t_spawn": "T spawn"}

_NUMERIC_ARRAY = re.compile(r"\[\s*(-?\d[\d.eE+-]*(?:\s*,\s*-?\d[\d.eE+-]*)*)\s*\]")


def dumps_readable(obj: object) -> str:
    """As workers/common/mf_common/emit.py: indented JSON with innermost numeric arrays on one line."""
    text = json.dumps(obj, indent=2, ensure_ascii=False, allow_nan=False)
    return _NUMERIC_ARRAY.sub(lambda m: "[" + ",".join(x.strip() for x in m.group(1).split(",")) + "]", text)


def human(name: str) -> str:
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", name).replace("_", " ").replace("Bombsite", "Site ").strip()


def angles(cam: tuple[float, float, float], target: tuple[float, float, float]) -> tuple[float, float]:
    dx, dy, dz = target[0] - cam[0], target[1] - cam[1], target[2] - cam[2]
    yaw = math.degrees(math.atan2(dy, dx))
    pitch = -math.degrees(math.atan2(dz, math.hypot(dx, dy)))  # Source: positive pitch looks down
    return round(pitch, 2), round(yaw, 2)


def r1(p: tuple[float, float, float]) -> tuple[float, float, float]:
    return (round(p[0], 1), round(p[1], 1), round(p[2], 1))


def plane(corners: list[tuple[float, float, float]]):
    """z = a*x + b*y + c through an area's corners (least squares; flat when degenerate)."""
    n = len(corners)
    sx = sum(c[0] for c in corners); sy = sum(c[1] for c in corners); sz = sum(c[2] for c in corners)
    sxx = sum(c[0] * c[0] for c in corners); syy = sum(c[1] * c[1] for c in corners); sxy = sum(c[0] * c[1] for c in corners)
    sxz = sum(c[0] * c[2] for c in corners); syz = sum(c[1] * c[2] for c in corners)
    m = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]]
    v = [sxz, syz, sz]
    det = (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]))
    if abs(det) < 1e-6:
        return lambda x, y: sz / n
    def solve(col: int) -> float:
        mm = [row[:] for row in m]
        for r in range(3):
            mm[r][col] = v[r]
        return (mm[0][0] * (mm[1][1] * mm[2][2] - mm[1][2] * mm[2][1]) - mm[0][1] * (mm[1][0] * mm[2][2] - mm[1][2] * mm[2][0]) + mm[0][2] * (mm[1][0] * mm[2][1] - mm[1][1] * mm[2][0])) / det
    a, b, c0 = solve(0), solve(1), solve(2)
    lo, hi = min(p[2] for p in corners), max(p[2] for p in corners)
    return lambda x, y: min(hi, max(lo, a * x + b * y + c0))


def inside(poly: list[tuple[float, float, float]], x: float, y: float) -> bool:
    hit = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i][0], poly[i][1]
        xj, yj = poly[j][0], poly[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
            hit = not hit
        j = i
    return hit


class Map:
    def __init__(self, name: str, nav_path: Path, mesh_path: Path):
        self.name = name
        self.nav = NavMesh(nav_path)
        self.vc = VisibilityChecker(mesh_path)
        self.planes: dict[int, object] = {}
        self.walk: list[tuple[float, float, float]] = []
        areas = self.nav.areas
        for area_id in areas["area_id"].to_list():
            a = self.nav.area(int(area_id))
            corners = [tuple(map(float, c)) for c in a["corners"]]
            z_at = plane(corners)
            self.planes[int(area_id)] = z_at
            xs = [c[0] for c in corners]; ys = [c[1] for c in corners]
            cx, cy = float(a["centroid"][0]), float(a["centroid"][1])
            self.walk.append((cx, cy, z_at(cx, cy)))
            x = math.floor(min(xs) / SAMPLE) * SAMPLE + SAMPLE / 2
            while x < max(xs):
                y = math.floor(min(ys) / SAMPLE) * SAMPLE + SAMPLE / 2
                while y < max(ys):
                    if inside(corners, x, y):
                        self.walk.append((x, y, z_at(x, y)))
                    y += SAMPLE
                x += SAMPLE

    def floor_at(self, x: float, y: float, z: float) -> float | None:
        area = self.nav.find_area((x, y, z))
        if area is None:
            return None
        return self.planes[area](x, y)

    def visible(self, a, b) -> bool:
        return self.vc.is_visible(a, b)

    def openness(self, cam: tuple[float, float, float], aim: tuple[float, float, float]) -> float:
        """Share of a 9 x 5 grid of view rays with no geometry within OPEN_RANGE."""
        dx, dy, dz = aim[0] - cam[0], aim[1] - cam[1], aim[2] - cam[2]
        n = math.sqrt(dx * dx + dy * dy + dz * dz) or 1.0
        f = (dx / n, dy / n, dz / n)
        h = math.hypot(f[0], f[1]) or 1.0
        r = (f[1] / h, -f[0] / h, 0.0)
        u = (r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0])
        tanh = 1.0  # tan(45 degrees)
        tanv = tanh * 9 / 16
        hits = total = 0
        for i in range(9):
            for j in range(5):
                sx, sy = (i / 4 - 1) * tanh * 0.9, (j / 2 - 1) * tanv * 0.9
                d = [f[k] + sx * r[k] + sy * u[k] for k in range(3)]
                m = math.sqrt(sum(x * x for x in d))
                end = tuple(cam[k] + d[k] / m * OPEN_RANGE for k in range(3))
                total += 1
                hits += not self.vc.is_visible(cam, end)
        return 1 - hits / total

    def near(self, cam: tuple[float, float, float], aim: tuple[float, float, float]) -> float:
        """Share of a 9 x 5 grid of rays across the whole picture that hit geometry within NEAR_RANGE."""
        dx, dy, dz = aim[0] - cam[0], aim[1] - cam[1], aim[2] - cam[2]
        n = math.sqrt(dx * dx + dy * dy + dz * dz) or 1.0
        f = (dx / n, dy / n, dz / n)
        h = math.hypot(f[0], f[1]) or 1.0
        r = (f[1] / h, -f[0] / h, 0.0)
        u = (r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0])
        tanh = 4 / 3  # tan(53.13 degrees): 90 degrees at 4:3 is 106 degrees across 16:9
        tanv = tanh * 9 / 16
        hits = 0
        for i in range(9):
            for j in range(5):
                sx, sy = (i / 4 - 1) * tanh * 0.95, (j / 2 - 1) * tanv * 0.95
                d = [f[k] + sx * r[k] + sy * u[k] for k in range(3)]
                m = math.sqrt(sum(x * x for x in d))
                hits += not self.vc.is_visible(cam, tuple(cam[k] + d[k] / m * NEAR_RANGE for k in range(3)))
        return hits / 45

    def clear_around(self, p: tuple[float, float, float], r: float = CLEAR) -> bool:
        """Free space in the six axis directions, checked at two lengths (a ray can graze a triangle edge at one length only)."""
        x, y, z = p
        return all(self.vc.is_visible(p, (x + dx * k, y + dy * k, z + dz * k)) for k in (r * 0.6, r) for dx, dy, dz in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)))


def region_targets(m: Map, region: dict) -> dict | None:
    """The region's cells dropped onto CS2's walkable floor, at chest height."""
    pts = []
    for shape in region["shapes"]:
        if shape["kind"] != "cells":
            continue
        cs, zs = shape["cellSize"], shape["zCellSize"]
        for ix, iy, iz in shape["cells"]:
            x, y, z = (ix + 0.5) * cs, (iy + 0.5) * cs, (iz + 0.5) * zs
            f = m.floor_at(x, y, z)
            if f is not None and abs(f - z) <= zs:
                pts.append((x, y, f + AIM))
    if len(pts) < 3:
        return None
    pts.sort()
    if len(pts) > MAX_TARGETS:
        step = len(pts) / MAX_TARGETS
        pts = [pts[int(i * step)] for i in range(MAX_TARGETS)]
    mx = sum(p[0] for p in pts) / len(pts)
    my = sum(p[1] for p in pts) / len(pts)
    centre = min(pts, key=lambda p: (p[0] - mx) ** 2 + (p[1] - my) ** 2)
    radius = max(math.hypot(p[0] - centre[0], p[1] - centre[1]) for p in pts)
    zs_ = sorted(p[2] for p in pts)
    return {"points": pts, "centre": centre, "radius": radius, "zmin": zs_[0] - AIM, "zmax": zs_[-1] - AIM}


def candidates(m: Map, t: dict, kind: str, min_open: float = MIN_OPEN) -> list[dict]:
    cx, cy, cz = t["centre"]
    seen: set[tuple[int, int, int]] = set()
    out = []
    for x, y, z in m.walk:
        d = math.hypot(x - cx, y - cy)
        if not (MIN_D <= d <= MAX_D) or abs(z - (cz - AIM)) > 400:
            continue
        key = (math.floor(x / SPOT_GRID), math.floor(y / SPOT_GRID), math.floor(z / 96))
        if key in seen:
            continue
        seen.add(key)
        best = None
        for h in HEIGHTS:
            cam = r1((x, y, z + h))  # tested exactly as it is written to the pack
            # Room above the floor and around the camera: not inside a wall, prop or ceiling.
            if not m.visible((x, y, z + 16), (x, y, z + h + CLEAR)) or not m.clear_around(cam):
                continue
            if not m.visible(cam, t["centre"]):
                continue
            sees = [p for p in t["points"] if m.visible(cam, p)]
            cover = len(sees) / len(t["points"])
            # Frame what this camera sees of the area: its middle, not the region's centre.
            aim = tuple(sum(p[k] for p in sees) / len(sees) for k in range(3)) if sees else t["centre"]
            open_ = m.openness(cam, aim)
            if open_ < min_open or m.near(cam, aim) > MAX_NEAR:
                continue
            pitch, _ = angles(cam, aim)
            score = 1.2 * cover + 0.5 * open_ + 0.5 * (1 - abs(d - BEST_D) / BEST_D) + 0.4 * max(0.0, min(1.0, (cam[2] - cz) / 250)) - (0.6 if pitch > 50 else 0)
            if best is None or score > best["score"]:
                best = {"x": x, "y": y, "floor": z, "h": h, "pos": cam, "d": d, "cover": cover, "open": open_, "score": score, "aim": aim, "angle": math.atan2(y - cy, x - cx)}
        if best and best["cover"] >= MIN_COVER[kind]:
            out.append(best)
    return out


def pick_spread(cands: list[dict], n: int) -> list[dict]:
    for sep in (70, 45, 30):
        chosen: list[dict] = []
        for c in sorted(cands, key=lambda c: (-c["score"], c["x"], c["y"])):
            if all(abs(math.degrees(math.atan2(math.sin(c["angle"] - o["angle"]), math.cos(c["angle"] - o["angle"])))) >= sep for o in chosen):
                chosen.append(c)
            if len(chosen) == n:
                return chosen
        if len(chosen) == n or sep == 30:
            return chosen
    return []


def catmull(k: list[tuple[float, float, float]], i: int, u: float) -> tuple[float, float, float]:
    """The point samplePath (netcon.ts) flies between keyframes i and i+1 at fraction u."""
    p0, p1, p2, p3 = k[max(0, i - 1)], k[i], k[min(len(k) - 1, i + 1)], k[min(len(k) - 1, i + 2)]
    return tuple(0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * u + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * u * u + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * u * u * u) for j in range(3))


def flyable(m: Map, keys: list[tuple[float, float, float]], aim: tuple[float, float, float]) -> int:
    """How many keyframe-to-keyframe spans, from the start, the camera flies without touching geometry or losing the aim point."""
    for i in range(len(keys) - 1):
        span = math.dist(keys[i], keys[i + 1])
        steps = max(2, math.ceil(span / PATH_STEP))
        prev = keys[i]
        lost = 0
        for s in range(1, steps + 1):
            p = catmull(keys, i, s / steps)
            if not m.visible(prev, p) or not m.clear_around(p, 16):
                return i
            lost += not m.visible(p, aim)
            prev = p
        if lost > steps * 0.15:
            return i
    return len(keys) - 1


def path_keys(points: list[tuple[float, float, float]], aim: tuple[float, float, float], durations: list[float] | None = None) -> list[dict]:
    keys, tms = [], 0.0
    for i, p in enumerate(points):
        if i:
            tms += durations[i - 1] if durations else math.dist(points[i - 1], p) / PATH_SPEED * 1000
        pitch, yaw = angles(p, aim)
        keys.append({"tMs": round(tms), "position": {"x": round(p[0], 1), "y": round(p[1], 1), "z": round(p[2], 1)}, "pitch": pitch, "yaw": yaw})
    return keys


def orbit(m: Map, t: dict, cands: list[dict]) -> list[dict]:
    ring = [c for c in cands if 450 <= c["d"] <= 950]
    by_sector: dict[int, dict] = {}
    for c in ring:  # best spot per 15-degree sector
        k = int((math.degrees(c["angle"]) + 180) // 15) % 24
        if k not in by_sector or c["score"] > by_sector[k]["score"]:
            by_sector[k] = c
    best: list[dict] = []
    for start in sorted(by_sector):
        chain = [by_sector[start]]
        k = start
        while len(chain) < 8:
            nxt = None
            for step in (2, 3, 1):
                kk = (k + step) % 24
                c = by_sector.get(kk)
                if c and c not in chain and m.visible(chain[-1]["pos"], c["pos"]):
                    nxt, k = c, kk
                    break
            if not nxt:
                break
            chain.append(nxt)
        if len(chain) >= 3:
            # Keep the part of the chain whose real flight curve is clear.
            ok = flyable(m, [c["pos"] for c in chain], t["centre"])
            chain = chain[: ok + 1]
        if len(chain) > len(best):
            best = chain
    if len(best) < 3:
        return []
    pts = [c["pos"] for c in best]
    # Long orbits fly faster, and are cut short when even that doesn't fit in freeze time.
    while len(pts) >= 3:
        total = sum(math.dist(a, b) for a, b in zip(pts, pts[1:]))
        speed = max(PATH_SPEED, min(MAX_PATH_SPEED, total / (MAX_ORBIT_MS / 1000)))
        if total / speed * 1000 <= MAX_ORBIT_MS:
            break
        pts = pts[:-1]
    if len(pts) < 3:
        return []
    keys = path_keys(pts, t["centre"], [math.dist(a, b) / speed * 1000 for a, b in zip(pts, pts[1:])])
    return keys if keys[-1]["tMs"] >= 3000 else []


def drift(m: Map, t: dict, c: dict) -> list[dict]:
    """A slow sideways move past the area, for areas without an orbit."""
    cx, cy, _ = t["centre"]
    dx, dy = cx - c["pos"][0], cy - c["pos"][1]
    n = math.hypot(dx, dy) or 1.0
    side = (-dy / n, dx / n)
    for sign in (1, -1):
        end = r1((c["pos"][0] + side[0] * DRIFT * sign, c["pos"][1] + side[1] * DRIFT * sign, c["pos"][2]))
        pts = [c["pos"], end]
        if flyable(m, pts, t["centre"]) == 1:
            return path_keys(pts, t["centre"], [PUSH_MS])
    return []


def push_in(m: Map, t: dict, c: dict) -> list[dict]:
    """A slow dolly from the best spot toward the centre, stopping well short of it."""
    cx, cy, cz = t["centre"]
    for frac in (0.45, 0.35, 0.25):
        end = r1((c["pos"][0] + (cx - c["pos"][0]) * frac, c["pos"][1] + (cy - c["pos"][1]) * frac, c["pos"][2] - 30 * frac))
        if math.dist(end, t["centre"]) < 250:
            continue
        pts = [c["pos"], end]
        if flyable(m, pts, t["centre"]) == 1:
            return path_keys(pts, t["centre"], [PUSH_MS])
    return []


def place_of(pack: dict, p: tuple[float, float, float]) -> str | None:
    x, y, z = p
    for r in pack["regions"]:
        for shape in r["shapes"]:
            if shape["kind"] != "cells":
                continue
            cs, zs = shape["cellSize"], shape["zCellSize"]
            cell = [math.floor(x / cs), math.floor(y / cs), math.floor(z / zs)]
            if cell in shape["cells"]:
                return r["name"]
    return None


def level_of(levels: list[dict], z: float) -> str | None:
    if len(levels) <= 1:
        return levels[0]["id"] if levels else None
    return next((lv["id"] for lv in levels if lv["zMin"] <= z < lv["zMax"]), None)


def targets_for(pack: dict) -> list[tuple[dict, str]]:
    by_id = {r["id"]: r for r in pack["regions"]}
    out = []
    for b in sorted(pack["bombsites"], key=lambda b: b["site"]):
        if b["regionId"] in by_id:
            out.append((by_id[b["regionId"]], "bombsite"))
    mids = [r for r in pack["regions"] if r["kind"] == "mid"]
    mid = next((r for rid in ("middle", "mid", "topof_mid") for r in mids if r["id"] == rid), None)
    if mid:
        out.append((mid, "mid"))
    else:
        # The map's equivalents, tried in order until one gets cameras.
        out += [(by_id[i], "mid?") for i in MID_REGIONS.get(pack["mapName"], []) if i in by_id]
    for rid in ("ct_spawn", "t_spawn"):
        if rid in by_id:
            out.append((by_id[rid], "spawn"))
    return out


def generate(map_name: str, navs: Path, meshes: Path, build: str) -> dict:
    path = PACKS / f"{map_name}.json"
    pack = json.loads(path.read_text())
    m = Map(map_name, navs / f"{map_name}.nav", meshes / f"{map_name}.mesh")
    revision = pack["mapRevision"]
    short = map_name.removeprefix("de_")
    cameras = [c for c in pack["cameras"] if c.get("capturedFrom") != "derived_navmesh"]
    paths = [p for p in pack["paths"] if p.get("source") != "derived_navmesh"]
    report = []
    mid_done = False
    filmed: set[str] = set()
    main = targets_for(pack)
    main_ids = {r["id"] for r, k in main if k != "mid?"}
    # Every other named area gets cameras too, for fight overviews and nade cameras in live play.
    areas = [(r, "area") for r in pack["regions"] if r["id"] not in main_ids]
    for region, kind in main + areas:
        if kind == "mid?":
            if mid_done:
                continue
            kind = "mid"
        if region["id"] in filmed:
            continue
        t = region_targets(m, region)
        if not t:
            report.append(f"{region['id']}: no walkable CS2 floor under the region")
            continue
        want = 3 if kind == "bombsite" else 2
        cands = candidates(m, t, kind)
        chosen = pick_spread(cands, want)
        if len(chosen) < want:
            cands = candidates(m, t, kind, MIN_OPEN_TIGHT)
            chosen = pick_spread(cands, want)
        if not chosen:
            report.append(f"{region['id']}: no spot frames it well")
            continue
        if kind == "mid":
            mid_done = True
        filmed.add(region["id"])
        label = LABEL.get(region["id"]) or ("Mid" if kind == "mid" and region["id"] in ("middle", "mid") else human(region["name"]))
        for n, c in enumerate(chosen, 1):
            pitch, yaw = angles(c["pos"], c["aim"])
            spot = place_of(pack, (c["x"], c["y"], c["floor"]))
            name = f"{label} from {human(spot)}" if spot and spot != region["name"] else f"{label} #{n}"
            classes = {"bombsite": ["bomb", "tactical", "establishing", "utility"], "mid": ["tactical", "establishing", "utility"], "spawn": ["establishing"], "area": ["tactical", "utility"]}[kind]
            cameras.append({
                "id": f"cs2-{short}-{region['id']}-{n}",
                "displayName": name,
                "mapName": map_name,
                "mapRevision": revision,
                "position": {"x": round(c["pos"][0], 1), "y": round(c["pos"][1], 1), "z": round(c["pos"][2], 1)},
                "pitch": pitch,
                "yaw": yaw,
                "fov": None,
                "observerMode": "roaming_static",
                "targetRegionIds": [region["id"]],
                "coverage": {
                    "center": {"x": round(t["centre"][0], 1), "y": round(t["centre"][1], 1), "z": round(t["centre"][2], 1)},
                    "radiusUnits": round(max(500.0, t["radius"] * 1.25), 1),
                    "zMin": round(t["zmin"] - 100, 1),
                    "zMax": round(t["zmax"] + 250, 1),
                    "levelId": level_of(pack["levels"], t["centre"][2] - AIM),
                },
                "allowedPhases": {"spawn": ["freezetime"], "area": ["live", "over"]}.get(kind, ["freezetime", "live", "over"]),
                "actionClasses": classes,
                "grenadeTypes": [],
                "minAcquisitionMs": 150,
                "normalDurationMs": {"spawn": 5000, "area": 3500}.get(kind, 4000),
                "maxDurationMs": 7000,
                # Line of sight checked against CS2's collision geometry; not yet seen by eye.
                "occlusionValidation": "validated",
                "validation": "unvalidated",
                "exitStrategy": "most_relevant_player",
                "lastTestedGameBuild": None,
                "lastTestedMapVersion": None,
                "capturedFrom": "derived_navmesh",
                "notes": f"Placed on CS2's walkable floor ({human(spot) if spot else 'no named area'}), {round(c['h'])} units up, {round(c['d'])} units from the {label} centre. In CS2's collision geometry (build {build}) it has clear space around it, sees the centre and {round(c['cover'] * 100)}% of the area, and {round(c['open'] * 100)}% of its view is open for at least {round(OPEN_RANGE)} units. Not seen in game yet.",
            })
        made = []
        if kind == "area":
            # Paths fly in freeze time only, where the sites, mid and spawns are the story.
            report.append(f"{region['id']}: {len(chosen)} cameras")
            continue
        orb = orbit(m, t, cands)
        if orb:
            made.append(("orbit", "orbit", orb))
        elif chosen:
            for c in chosen:
                d = drift(m, t, c)
                if d:
                    made.append(("drift", "drift", d))
                    break
        if chosen:
            push = push_in(m, t, chosen[0])
            if push:
                made.append(("push", "push-in", push))
        for suffix, what, keys in made:
            paths.append({
                "id": f"cs2-{short}-{region['id']}-{suffix}",
                "displayName": f"{label} {what}",
                "mapName": map_name,
                "mapRevision": revision,
                "keyframes": keys,
                "maxDurationMs": round(keys[-1]["tMs"] + 1000),
                "maxSpeedUnitsPerSec": 300,
                # The flight curve was checked against CS2's collision geometry.
                "collisionValidated": True,
                "validation": "unvalidated",
                "targetRegionIds": [region["id"]],
                "source": "derived_navmesh",
            })
        seen = ", ".join(str(round(c["cover"] * 100)) + "%" for c in chosen)
        flights = ", ".join(f"{w} {k[-1]['tMs'] / 1000:.1f} s" for _, w, k in made) or "none"
        report.append(f"{region['id']}: {len(cands)} spots, {len(chosen)} cameras ({seen} seen), paths: {flights}")
    pack["cameras"] = cameras
    pack["paths"] = paths
    source = f"CS2 navigation and collision meshes from awpy-data (build {build}, read with awpy 3.1.1, MIT): built-in cameras and paths placed on walkable floor and checked for line of sight and clearance"
    pack["provenance"]["sources"] = [s for s in pack["provenance"]["sources"] if not s.startswith("CS2 navigation and collision meshes from awpy-data")] + [source]
    path.write_text(dumps_readable(pack) + "\n")
    print(f"{map_name}: {len(m.walk)} walkable samples, {m.vc.triangle_count} triangles\n  " + "\n  ".join(report))
    return pack


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--navs", type=Path, required=True, help="folder with <map>.nav files")
    ap.add_argument("--meshes", type=Path, required=True, help="folder with <map>.mesh files")
    ap.add_argument("--manifest", type=Path, help="awpy-data manifest.json (for the CS2 build number)")
    ap.add_argument("maps", nargs="*", default=MAPS)
    args = ap.parse_args()
    build = json.loads(args.manifest.read_text()).get("buildid", "unknown") if args.manifest else "unknown"
    for name in args.maps:
        generate(name, args.navs, args.meshes, build)


if __name__ == "__main__":
    main()
