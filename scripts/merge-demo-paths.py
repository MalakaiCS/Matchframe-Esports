#!/usr/bin/env python3
"""Puts the camera paths built from demos in the map packs.

Usage:
    python3 scripts/merge-demo-paths.py --paths DIR [--maps de_mirage,de_nuke]

DIR holds services/local-engine/scripts/generate-demo-paths.ts output (``<map>.json``:
``{map, matches, paths}``). Each pack's built-from-demos paths (source ``derived_demos``) are
replaced; operator paths and the navigation-mesh ones (scripts/generate-map-cameras.py) are kept.
Keyframes are written one to a line (as by the other scripts that write packs).
"""

from __future__ import annotations

import argparse
import itertools
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKS = ROOT / "assets" / "map-packs"
SOURCE = "Camera paths from CS2 demos"

_NUMERIC_ARRAY = re.compile(r"\[\s*(-?\d[\d.eE+-]*(?:\s*,\s*-?\d[\d.eE+-]*)*)\s*\]")
_KEYFRAME = re.compile(r'\{\s*"tMs": ([^,\s]+),\s*"position": \{\s*"x": ([^,\s]+),\s*"y": ([^,\s]+),\s*"z": ([^,\s]+)\s*\},\s*"pitch": ([^,\s]+),\s*"yaw": ([^,\s}]+)\s*\}')


def dumps_readable(obj: object) -> str:
    """As workers/common/mf_common/emit.py: indented JSON with innermost numeric arrays on one line,
    and camera path keyframes one to a line (the packs hold hundreds of paths)."""
    text = json.dumps(obj, indent=2, ensure_ascii=False, allow_nan=False)
    text = _NUMERIC_ARRAY.sub(lambda m: "[" + ",".join(x.strip() for x in m.group(1).split(",")) + "]", text)
    return _KEYFRAME.sub(lambda m: '{{"tMs": {}, "position": {{"x": {}, "y": {}, "z": {}}}, "pitch": {}, "yaw": {}}}'.format(*m.groups()), text)


def check(map_name: str, pack: dict, paths: list[dict]) -> None:
    ids = [p["id"] for p in paths]
    if len(set(ids)) != len(ids):
        raise SystemExit(f"{map_name}: duplicate path ids")
    for p in paths:
        if p.get("source") != "derived_demos" or p["mapName"] != map_name or p["mapRevision"] != pack["mapRevision"]:
            raise SystemExit(f"{map_name}: {p['id']} is not a demo path of this map revision")
        ts = [k["tMs"] for k in p["keyframes"]]
        if len(ts) < 2 or ts[0] != 0 or any(b <= a for a, b in itertools.pairwise(ts)):
            raise SystemExit(f"{map_name}: {p['id']} keyframes are not in time order")
    taken = {p["id"] for p in pack["paths"] if p.get("source") != "derived_demos"}
    if taken & set(ids):
        raise SystemExit(f"{map_name}: path ids already used in the pack: {sorted(taken & set(ids))[:3]}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--paths", required=True, type=Path)
    ap.add_argument("--maps", default=None)
    a = ap.parse_args()
    files = sorted(a.paths.glob("de_*.json"))
    if a.maps:
        files = [f for f in files if f.stem in a.maps.split(",")]
    for f in files:
        data = json.loads(f.read_text())
        name = data["map"]
        pack_file = PACKS / f"{name}.json"
        pack = json.loads(pack_file.read_text())
        paths = data["paths"]
        check(name, pack, paths)
        kept = [p for p in pack["paths"] if p.get("source") != "derived_demos"]
        pack["paths"] = kept + paths
        n = data.get("matches", 0)
        source = f"{SOURCE}: {len(paths)} paths built where players walked and fought in {n} CS2 demo{'s' if n != 1 else ''} (scripts/demo-path-anchors.py, services/local-engine/scripts/generate-demo-paths.ts), each flown through the CS2 collision grid before keeping"
        pack["provenance"]["sources"] = [s for s in pack["provenance"]["sources"] if not s.startswith(SOURCE)] + [source]
        pack_file.write_text(dumps_readable(pack) + "\n")
        print(f"{name}: {len(kept)} other paths kept, {len(paths)} from demos")


if __name__ == "__main__":
    main()
