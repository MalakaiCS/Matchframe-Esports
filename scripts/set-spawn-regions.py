#!/usr/bin/env python3
"""Spawn areas from where players really stand: the t_spawn / ct_spawn regions of each map pack,
rebuilt from CS2 demos.

The packs' spawn regions came from navigation place names ("TSpawn", "CTSpawn"): whole named areas,
whose middles were 100-500 units from where players actually spawn, and on Ancient and Anubis the CT
one missed the spawn points entirely. Spawn cameras aim at their region, so they missed the players.

For each demo, every alive player's position at the end of each round's freeze time (players can't
move in freeze time) is a spawn point. Each map's spawn region becomes the region cells holding
those points and the cells round them (one cell each way, same floor), tagged `spawn_points`.
Other regions are left as they are. Rerun scripts/generate-map-cameras.py afterwards for the spawn
cameras and paths.

Usage (awpy 3.1.1 venv, run with python -I on downloaded demos):
    python -I scripts/set-spawn-regions.py demo1.dem demo2.dem ...

The demos are not committed; only the regions derived from them are.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

try:
    from awpy import Demo
except ImportError:  # pragma: no cover
    sys.exit("awpy 3.1.1 is required: pip install awpy==3.1.1")

PACKS = Path(__file__).resolve().parent.parent / "assets" / "map-packs"
SIDES = {"terrorist": "t_spawn", "counter-terrorist": "ct_spawn"}
_NUMERIC_ARRAY = re.compile(r"\[\s*(-?\d[\d.eE+-]*(?:\s*,\s*-?\d[\d.eE+-]*)*)\s*\]")
_KEYFRAME = re.compile(r'\{\s*"tMs": ([^,\s]+),\s*"position": \{\s*"x": ([^,\s]+),\s*"y": ([^,\s]+),\s*"z": ([^,\s]+)\s*\},\s*"pitch": ([^,\s]+),\s*"yaw": ([^,\s}]+)\s*\}')


def dumps_readable(obj: object) -> str:
    """As workers/common/mf_common/emit.py: indented JSON with innermost numeric arrays on one line,
    and camera path keyframes one to a line (the packs hold hundreds of paths)."""
    text = json.dumps(obj, indent=2, ensure_ascii=False, allow_nan=False)
    text = _NUMERIC_ARRAY.sub(lambda m: "[" + ",".join(x.strip() for x in m.group(1).split(",")) + "]", text)
    return _KEYFRAME.sub(lambda m: '{{"tMs": {}, "position": {{"x": {}, "y": {}, "z": {}}}, "pitch": {}, "yaw": {}}}'.format(*m.groups()), text)


def spawn_points(path: Path) -> tuple[str, dict[str, set[tuple[float, float, float]]]]:
    """The map, and the distinct positions players stood at as each freeze time ended, by spawn."""
    d = Demo(path)
    ends = [int(t) - 16 for t in d.rounds["freeze_end_tick"].to_list() if t is not None and t > 16]
    snap = d.snapshots(ticks=ends)
    out: dict[str, set[tuple[float, float, float]]] = {"t_spawn": set(), "ct_spawn": set()}
    for p in snap.iter_rows(named=True):
        region = SIDES.get(p["side"])
        if region and p["health"] and p["health"] > 0:
            out[region].add((round(p["x"]), round(p["y"]), round(p["z"])))
    return str(d.header.get("map_name")), out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("demos", nargs="+", type=Path)
    args = ap.parse_args()
    by_map: dict[str, dict[str, set[tuple[float, float, float]]]] = {}
    for dem in args.demos:
        name, pts = spawn_points(dem)
        for region, s in pts.items():
            by_map.setdefault(name, {}).setdefault(region, set()).update(s)
    for name, regions in sorted(by_map.items()):
        path = PACKS / f"{name}.json"
        if not path.exists():
            print(f"{name}: no map pack, skipped")
            continue
        pack = json.loads(path.read_text())
        for region_id, pts in sorted(regions.items()):
            region = next((r for r in pack["regions"] if r["id"] == region_id), None)
            if region is None or not pts:
                print(f"{name}: no {region_id} region or no spawn points, skipped")
                continue
            shape = next(s for s in region["shapes"] if s["kind"] == "cells")
            cs, zs = shape["cellSize"], shape["zCellSize"]
            cells = set()
            for x, y, z in pts:
                ix, iy, iz = math.floor(x / cs), math.floor(y / cs), math.floor(z / zs)
                cells.update((ix + dx, iy + dy, iz) for dx in (-1, 0, 1) for dy in (-1, 0, 1))
            region["shapes"] = [{**shape, "cells": [list(c) for c in sorted(cells)]}]
            region["sampleCount"] = len(pts)
            region["tags"] = sorted({*region.get("tags", []), "spawn_points"})
            print(f"{name} {region_id}: {len(pts)} spawn points, {len(cells)} cells")
        src = f"Spawn regions (t_spawn, ct_spawn) from where players stood at the end of freeze time in CS2 demos ({len(args.demos)} read by scripts/set-spawn-regions.py)"
        pack["provenance"]["sources"] = [s for s in pack["provenance"]["sources"] if not s.startswith("Spawn regions (t_spawn, ct_spawn) from")] + [src]
        path.write_text(dumps_readable(pack) + "\n")


if __name__ == "__main__":
    main()
