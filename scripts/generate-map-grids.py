#!/usr/bin/env python3
"""Free-space grids for the active-duty maps, from CS2's collision meshes (awpy-data).

Each map gets assets/map-packs/<map>.grid: a 3D grid of 12-unit cells over the playable area (the
navigation mesh's extent plus a margin), where a cell is solid when any collision triangle passes
through it. The engine uses it while a match runs, where the meshes themselves are not available:

* line of sight between players (the director cuts to a fight before it starts);
* clear space for the follow camera (it flies behind a player without entering a wall).

A cell is marked from points sampled on every triangle at most a quarter of a cell apart, so thin
walls are always solid. Collision geometry leaves out see-through and non-solid props (glass, fences,
foliage), so the grid does too.

File format (little-endian): b"MFGR", u32 header length, the header as JSON (map, build, cell size,
origin, dims), then the zlib-compressed bitset; cell (x, y, z) is bit i = (z * ny + y) * nx + x,
byte i >> 3, bit i & 7.

Usage (awpy 3.1.1 venv, run with python -I on downloaded data):
    python -I scripts/generate-map-grids.py --meshes <dir of .mesh> --navs <dir of .nav> \
        --build 26144732 [--maps de_dust2 ...] [--check 4000]

The meshes are Valve's assets and are not committed; only the derived grids are.
"""
from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import zlib
from pathlib import Path

import numpy as np

ACTIVE_DUTY = ["de_ancient", "de_anubis", "de_cache", "de_dust2", "de_inferno", "de_mirage", "de_nuke", "de_overpass", "de_train", "de_vertigo"]
CELL = 12.0
XY_MARGIN = 256.0
Z_BELOW = 96.0
Z_ABOVE = 512.0
EYE = 64.0


def read_mesh(path: Path) -> tuple[np.ndarray, np.ndarray]:
    b = path.read_bytes()
    if b[:4] != b"AWMH":
        raise ValueError(f"{path} is not an awpy mesh")
    _version, nv, nt = struct.unpack("<III", b[4:16])
    verts = np.frombuffer(b, dtype="<f4", count=nv * 3, offset=16).reshape(nv, 3).astype(np.float64)
    tris = np.frombuffer(b, dtype="<u4", count=nt * 3, offset=16 + nv * 12).reshape(nt, 3)
    return verts, tris


def nav_areas(nav_path: Path) -> list[np.ndarray]:
    """Each navigation area's corners."""
    from awpy import NavMesh

    nav = NavMesh(nav_path)
    return [np.array([tuple(map(float, c)) for c in nav.area(int(aid))["corners"]]) for aid in nav.areas["area_id"].to_list()]


def nav_bounds(nav_path: Path) -> tuple[np.ndarray, np.ndarray]:
    p = np.concatenate(nav_areas(nav_path))
    return p.min(axis=0), p.max(axis=0)


def voxelize(verts: np.ndarray, tris: np.ndarray, origin: np.ndarray, dims: tuple[int, int, int]) -> np.ndarray:
    nx, ny, nz = dims
    solid = np.zeros(nx * ny * nz, dtype=bool)
    a, b, c = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    longest = np.maximum.reduce([np.linalg.norm(b - a, axis=1), np.linalg.norm(c - b, axis=1), np.linalg.norm(a - c, axis=1)])
    steps = np.maximum(1, np.ceil(longest / (CELL / 4))).astype(np.int64)
    for n in np.unique(steps):
        sel = np.nonzero(steps == n)[0]
        i, j = np.meshgrid(np.arange(n + 1), np.arange(n + 1), indexing="ij")
        keep = (i + j) <= n
        u = (i[keep] / n)[None, :, None]
        v = (j[keep] / n)[None, :, None]
        per = u.shape[1]
        chunk = max(1, int(4_000_000 // per))
        for s in range(0, len(sel), chunk):
            idx = sel[s : s + chunk]
            pts = a[idx][:, None, :] * (1 - u - v) + b[idx][:, None, :] * u + c[idx][:, None, :] * v
            cell = np.floor((pts.reshape(-1, 3) - origin) / CELL).astype(np.int64)
            ok = (cell[:, 0] >= 0) & (cell[:, 0] < nx) & (cell[:, 1] >= 0) & (cell[:, 1] < ny) & (cell[:, 2] >= 0) & (cell[:, 2] < nz)
            cell = cell[ok]
            solid[(cell[:, 2] * ny + cell[:, 1]) * nx + cell[:, 0]] = True
    return solid


def segment_clear(solid: np.ndarray, origin: np.ndarray, dims: tuple[int, int, int], p: np.ndarray, q: np.ndarray) -> bool:
    """Samples a quarter cell apart from p to q hit no solid cell, ignoring one cell at each end."""
    nx, ny, nz = dims
    d = q - p
    length = float(np.linalg.norm(d))
    ts = np.linspace(0, 1, int(length / (CELL / 4)) + 2)
    keep = np.minimum(ts * length, (1 - ts) * length) > CELL
    pts = p + np.outer(ts[keep], d)
    c = np.floor((pts - origin) / CELL).astype(int)
    ok = (c[:, 0] >= 0) & (c[:, 0] < nx) & (c[:, 1] >= 0) & (c[:, 1] < ny) & (c[:, 2] >= 0) & (c[:, 2] < nz)
    c = c[ok]
    return not solid[(c[:, 2] * ny + c[:, 1]) * nx + c[:, 0]].any()


def grid_los(solid: np.ndarray, origin: np.ndarray, dims: tuple[int, int, int], p: np.ndarray, q: np.ndarray) -> bool:
    """Eye to eye, or 8 units higher (a head over low cover), as the engine tests it."""
    up = np.array([0.0, 0.0, 8.0])
    return segment_clear(solid, origin, dims, p, q) or segment_clear(solid, origin, dims, p + up, q + up)


def check(name: str, mesh: Path, nav_path: Path, solid: np.ndarray, origin: np.ndarray, dims, samples: int) -> dict:
    """Agreement with the exact mesh test on random eye-to-eye sightlines between walkable spots."""
    from awpy import VisibilityChecker

    vc = VisibilityChecker(mesh)
    rng = np.random.default_rng(7)
    centres = np.array([a.mean(axis=0) for a in nav_areas(nav_path)])
    both = vis_exact = blocked_exact = false_block = false_sight = 0
    tried = 0
    while both < samples and tried < samples * 20:
        tried += 1
        i, j = rng.integers(0, len(centres), 2)
        p = centres[i] + np.array([0, 0, EYE])
        q = centres[j] + np.array([0, 0, EYE])
        if not (200 < np.linalg.norm(p - q) < 2500):
            continue
        both += 1
        exact = vc.is_visible(tuple(p), tuple(q))
        g = grid_los(solid, origin, dims, p, q)
        if exact:
            vis_exact += 1
            false_block += not g
        else:
            blocked_exact += 1
            false_sight += g
    return {"map": name, "pairs": both, "visible": vis_exact, "blocked": blocked_exact, "gridBlocksVisible": false_block, "gridSeesBlocked": false_sight}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--meshes", type=Path, required=True)
    ap.add_argument("--navs", type=Path, required=True)
    ap.add_argument("--build", required=True)
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "assets" / "map-packs")
    ap.add_argument("--maps", nargs="*", default=ACTIVE_DUTY)
    ap.add_argument("--check", type=int, default=0, help="compare this many sightlines with the exact mesh test")
    args = ap.parse_args()
    for name in args.maps:
        mesh = args.meshes / f"{name}.mesh"
        nav_path = args.navs / f"{name}.nav"
        verts, tris = read_mesh(mesh)
        lo, hi = nav_bounds(nav_path)
        lo = np.array([lo[0] - XY_MARGIN, lo[1] - XY_MARGIN, lo[2] - Z_BELOW])
        hi = np.array([hi[0] + XY_MARGIN, hi[1] + XY_MARGIN, hi[2] + Z_ABOVE])
        origin = np.floor(lo / CELL) * CELL
        dims = tuple(int(math.ceil((hi[k] - origin[k]) / CELL)) for k in range(3))
        solid = voxelize(verts, tris, origin, dims)
        bits = np.packbits(solid, bitorder="little").tobytes()
        header = json.dumps({"map": name, "build": args.build, "cell": CELL, "origin": [float(x) for x in origin], "dims": list(dims), "generator": "scripts/generate-map-grids.py"}, separators=(",", ":")).encode()
        body = zlib.compress(bits, 9)
        out = args.out / f"{name}.grid"
        out.write_bytes(b"MFGR" + struct.pack("<I", len(header)) + header + body)
        line = f"{name}: {dims[0]}x{dims[1]}x{dims[2]} cells, {solid.mean() * 100:.1f}% solid, {out.stat().st_size // 1024} KB"
        if args.check:
            r = check(name, mesh, nav_path, solid, origin, dims, args.check)
            line += f"; vs mesh on {r['pairs']} sightlines: blocks {r['gridBlocksVisible']} of {r['visible']} visible, sees {r['gridSeesBlocked']} of {r['blocked']} blocked"
        print(line, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
