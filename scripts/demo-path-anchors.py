#!/usr/bin/env python3
"""Where players walk and fight, from read demos: the input of scripts/generate-demo-paths.ts.

Usage:
    python3 scripts/demo-path-anchors.py --datasets DATASET_ROOT --out anchors/

DATASET_ROOT holds committed datasets (``map=<map>/build=<build>/demo=<hash>/``, workers
``extract`` + ``build-features``). One JSON per map, merged over its datasets:

* ``routes``: stretches of real movement in live rounds, 6 s at 4 Hz (feet positions), where a
  player ran or walked steadily (90-320 units/s), with the side and the time into the round;
* ``kills``: the victim's and the killer's positions when someone died;
* ``plants``: where the bomb was planted;
* ``freeze``: every player's position at the end of freeze time (the spawns as teams stand);
* ``floor``: 64-unit cells with how often a living player stood there and the floor height
  (cells split by height, for maps with floors above one another).

Only positions leave this script: no names, no Steam IDs, no demo files.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import polars as pl

HZ = 4  # route samples a second
ROUTE_S = 6  # seconds per route
STRIDE_S = 3  # a long run gives a route every this many seconds
MIN_SPEED, MAX_SPEED = 90.0, 320.0
CELL = 64.0
LEVEL = 96.0


def runs(xs: list[float], ys: list[float], ticks: list[int], rate: float) -> list[tuple[int, int]]:
    """Index ranges of steady movement in 4 Hz samples."""
    out = []
    start = None
    for i in range(1, len(xs)):
        dt = (ticks[i] - ticks[i - 1]) / rate
        speed = ((xs[i] - xs[i - 1]) ** 2 + (ys[i] - ys[i - 1]) ** 2) ** 0.5 / dt if dt > 0 else 0.0
        moving = 0 < dt <= 0.4 and MIN_SPEED <= speed <= MAX_SPEED
        if moving and start is None:
            start = i - 1
        if not moving and start is not None:
            out.append((start, i - 1))
            start = None
    if start is not None:
        out.append((start, len(xs) - 1))
    return out


def anchors_for(ds: Path) -> tuple[str, dict]:
    manifest = json.loads((ds / "manifest.json").read_text())
    map_name = manifest.get("map_name") or manifest.get("map") or ds.parts[-3].split("=", 1)[1]
    rate = float(manifest.get("tick_rate") or 64)
    ticks = pl.read_parquet(ds / "ticks.parquet", columns=["tick", "round_index", "player_id", "team_num", "is_alive", "x", "y", "z", "in_grid"])
    rounds = pl.read_parquet(ds / "rounds.parquet").filter(~pl.col("is_warmup") & pl.col("freeze_end_tick").is_not_null())
    events = pl.read_parquet(ds / "events.parquet")
    live = (
        ticks.filter(pl.col("in_grid") & pl.col("is_alive").fill_null(False) & pl.col("team_num").is_in([2, 3]))
        .join(rounds.select("round_index", "freeze_end_tick", "end_tick"), on="round_index")
        .filter((pl.col("tick") >= pl.col("freeze_end_tick")) & (pl.col("end_tick").is_null() | (pl.col("tick") <= pl.col("end_tick"))))
    )
    routes = []
    for (_, _), g in live.sort("tick").group_by(["round_index", "player_id"], maintain_order=True):
        g = g.gather_every(max(1, round(16 / HZ)))  # grid ticks are 16 a second
        xs, ys, zs, tk = g["x"].to_list(), g["y"].to_list(), g["z"].to_list(), g["tick"].to_list()
        side = "T" if g["team_num"][0] == 2 else "CT"
        fe = g["freeze_end_tick"][0]
        n = ROUTE_S * HZ
        for a, b in runs(xs, ys, tk, rate):
            for s in range(a, b - n + 2, STRIDE_S * HZ):
                pts = [[round(xs[i]), round(ys[i]), round(zs[i])] for i in range(s, s + n)]
                routes.append({"side": side, "t": round((tk[s] - fe) / rate, 1), "pts": pts})

    deaths = events.filter((pl.col("event_type") == "player_death") & pl.col("user_id").is_not_null()).select(pl.col("tick").cast(pl.Int64), "user_id", "attacker_id", "round_index")
    pos = ticks.filter(pl.col("x").is_not_null()).select(pl.col("tick").cast(pl.Int64), "player_id", "x", "y", "z").sort("tick")

    def at(pid: str | None, tick: int) -> list[float] | None:
        if not pid:
            return None
        p = pos.filter((pl.col("player_id") == pid) & (pl.col("tick") <= tick)).tail(1)
        return [round(p["x"][0]), round(p["y"][0]), round(p["z"][0])] if p.height else None

    kills = []
    for d in deaths.to_dicts():
        v = at(d["user_id"], d["tick"])
        if v:
            kills.append({"v": v, "a": at(d["attacker_id"], d["tick"]) if d["attacker_id"] != d["user_id"] else None})

    # The planter's position (plant events carry no coordinates).
    plants = []
    for e in events.filter(pl.col("event_type") == "bomb_planted").to_dicts():
        p = [round(e["x"]), round(e["y"]), round(e["z"])] if e.get("x") is not None else at(e.get("user_id"), int(e["tick"]))
        if p:
            plants.append(p)

    freeze = []
    for r in rounds.to_dicts():
        fe = r["freeze_end_tick"]
        snap = ticks.filter((pl.col("tick") <= fe) & (pl.col("tick") >= fe - int(rate)) & pl.col("is_alive").fill_null(False) & pl.col("team_num").is_in([2, 3])).sort("tick").group_by("player_id").last()
        for p in snap.to_dicts():
            freeze.append({"side": "T" if p["team_num"] == 2 else "CT", "p": [round(p["x"]), round(p["y"]), round(p["z"])]})

    floor = (
        live.with_columns((pl.col("x") / CELL).floor().cast(pl.Int32).alias("cx"), (pl.col("y") / CELL).floor().cast(pl.Int32).alias("cy"), (pl.col("z") / LEVEL).floor().cast(pl.Int32).alias("cz"))
        .group_by(["cx", "cy", "cz"])
        .agg(pl.len().alias("n"), pl.col("z").median().alias("z"))
        .sort(["cx", "cy", "cz"])
    )
    cells = [[r["cx"], r["cy"], round(r["z"]), r["n"]] for r in floor.to_dicts()]
    return map_name, {"routes": routes, "kills": kills, "plants": plants, "freeze": freeze, "floor": cells}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--datasets", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    a = ap.parse_args()
    merged: dict[str, dict] = {}
    for manifest in sorted(a.datasets.glob("map=*/build=*/demo=*/manifest.json")):
        name, anc = anchors_for(manifest.parent)
        m = merged.setdefault(name, {"map": name, "cell": CELL, "matches": 0, "routes": [], "kills": [], "plants": [], "freeze": [], "floor": []})
        m["matches"] += 1
        for k in ("routes", "kills", "plants", "freeze", "floor"):
            m[k].extend(anc[k])
    a.out.mkdir(parents=True, exist_ok=True)
    for name, m in merged.items():
        (a.out / f"{name}.json").write_text(json.dumps(m, separators=(",", ":")))
        print(f"{name}: {m['matches']} match(es), {len(m['routes'])} routes, {len(m['kills'])} kills, {len(m['plants'])} plants, {len(m['freeze'])} freeze-time positions, {len(m['floor'])} floor cells")


if __name__ == "__main__":
    main()
