"""``export-replay``: a dataset as a stream the director can be replayed on (the test bench).

JSON lines, in tick order:

* ``{"type": "header", "map", "dataset_id", "tick_rate", "rounds"}``
* ``{"type": "frame", "tick", "round", "phase", "players": [[id, side, x, y, z, pitch, yaw, health,
  armor, weapon], ...], "bomb": {"state", "x", "y", "z"} | null}`` — alive players only, every
  ``1/hz`` s of the grid (freeze time, live, and the end of each round).
* ``{"type": "kill", "tick", "attacker", "victim"}`` — between the frames, where they happened.

Only what a spectator's game data shows goes into frames; kills are for scoring.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import polars as pl

from mf_common import errors
from mf_common.datasets import load_dataset
from mf_common.emit import Emitter

SIDES = {2: "T", 3: "CT"}


def export_replay(dataset: Path, out: Path, hz: float, emitter: Emitter) -> dict[str, Any]:
    ref = load_dataset(Path(dataset))
    rate = ref.tick_rate
    ticks = pl.read_parquet(ref.path / "ticks.parquet").filter(
        pl.col("in_grid") & pl.col("is_alive").fill_null(False) & pl.col("team_num").is_in([2, 3])
    )
    rounds = (
        pl.read_parquet(ref.path / "rounds.parquet").filter(~pl.col("is_warmup") & pl.col("start_tick").is_not_null()).sort("start_tick")
    )
    events = pl.read_parquet(ref.path / "events.parquet")
    if ticks.height == 0 or rounds.height == 0:
        raise errors.MfError(errors.INSUFFICIENT_DATA, "no live rounds with player positions to replay", dataset=str(ref.path))

    grid = sorted(set(ticks["tick"].to_list()))
    step_ticks = max(1, round(rate / hz))
    keep: list[int] = []
    for t in grid:
        if not keep or t - keep[-1] >= step_ticks:
            keep.append(t)
    by_tick = {t: g for (t,), g in ticks.filter(pl.col("tick").is_in(keep)).group_by("tick")}

    bounds = []
    rows = rounds.to_dicts()
    for i, r in enumerate(rows):
        end = (
            rows[i + 1]["start_tick"]
            if i + 1 < len(rows)
            else (r.get("official_end_tick") or r.get("end_tick") or r["start_tick"]) + int(5 * rate)
        )
        bounds.append((r["start_tick"], r.get("freeze_end_tick"), r.get("end_tick"), end, int(r.get("round_number") or i + 1)))

    def phase_at(t: int) -> tuple[str, int] | None:
        for start, freeze_end, live_end, end, number in bounds:
            if start <= t < end:
                if freeze_end is not None and t < freeze_end:
                    return "freezetime", number
                if live_end is not None and t > live_end:
                    return "over", number
                return "live", number
        return None

    kills = (
        events.filter((pl.col("event_type") == "player_death") & pl.col("user_id").is_not_null())
        .select(pl.col("tick").cast(pl.Int64), "attacker_id", "user_id")
        .sort("tick")
        .to_dicts()
    )
    bomb_events = events.filter(pl.col("event_type").is_in(["bomb_planted", "bomb_defused", "bomb_exploded"])).sort("tick").to_dicts()

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    n_frames = 0
    with out.open("w", encoding="utf-8") as fh:
        fh.write(
            json.dumps({"type": "header", "map": ref.map_name, "dataset_id": ref.dataset_id, "tick_rate": rate, "rounds": len(bounds)})
            + "\n"
        )
        ki = 0
        bomb: dict[str, Any] | None = None
        bi = 0
        for t in keep:
            while ki < len(kills) and kills[ki]["tick"] <= t:
                k = kills[ki]
                fh.write(json.dumps({"type": "kill", "tick": k["tick"], "attacker": k["attacker_id"], "victim": k["user_id"]}) + "\n")
                ki += 1
            while bi < len(bomb_events) and bomb_events[bi]["tick"] <= t:
                e = bomb_events[bi]
                bomb = (
                    {"state": "planted", "x": e.get("x"), "y": e.get("y"), "z": e.get("z")} if e["event_type"] == "bomb_planted" else None
                )
                bi += 1
            ph = phase_at(t)
            g = by_tick.get(t)
            if ph is None or g is None:
                continue
            if ph[0] == "freezetime":
                bomb = None
            players = [
                [
                    r["player_id"],
                    SIDES[r["team_num"]],
                    round(r["x"], 1),
                    round(r["y"], 1),
                    round(r["z"], 1),
                    round(r["pitch"] or 0, 2),
                    round(r["yaw"] or 0, 2),
                    r["health"],
                    r["armor"],
                    r["active_weapon"],
                ]
                for r in g.sort("player_id").to_dicts()
            ]
            fh.write(json.dumps({"type": "frame", "tick": t, "round": ph[1], "phase": ph[0], "players": players, "bomb": bomb}) + "\n")
            n_frames += 1
    emitter.progress("export", 1.0)
    return {
        "status": "exported",
        "out": str(out),
        "frames": n_frames,
        "kills": len(kills),
        "rounds": len(bounds),
        "map": ref.map_name,
        "dataset_id": ref.dataset_id,
        "tick_rate": rate,
    }
