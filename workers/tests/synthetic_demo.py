"""A deterministic synthetic 'demo' behind the ParsedDemo interface (no real demo content).

Two T and two CT players over ``n_rounds`` rounds, frames every 2 ticks at 64 tick:
freeze 5 s → live 25 s (T1 hurts then kills CT1, T2 throws an HE) → 5 s after-round.
Used to unit-test extraction, validation, splits, features and map packs end to end.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import polars as pl

from mf_demo_parser.adapter import DEMO_MAGIC_CS2, AdapterNotes, DemoHeader

RATE = 64
FRAME = 2
FREEZE = 5 * RATE
LIVE = 25 * RATE
POST = 5 * RATE
ROUND_LEN = FREEZE + LIVE + POST


def write_fake_dem(path: Path, salt: str) -> Path:
    path.write_bytes(DEMO_MAGIC_CS2 + f"synthetic-demo:{salt}".encode() * 64)
    return path


@dataclass
class FakeDemo:
    n_rounds: int = 3
    map_name: str = "de_synthetic"
    build: str = "99999"
    coord_scale: float = 1.0
    player_prefix: str = "7656119000000000"
    empty: bool = False
    fail_stage: str | None = None
    long_round: bool = False
    notes: AdapterNotes = field(default_factory=AdapterNotes)

    @property
    def roster(self) -> dict[str, int]:
        return {f"{self.player_prefix}{i}": (2 if i <= 2 else 3) for i in (1, 2, 3, 4)}

    def pid(self, i: int) -> str:
        return f"{self.player_prefix}{i}"

    def _maybe_fail(self, stage: str) -> None:
        if self.fail_stage == stage:
            raise RuntimeError(f"synthetic parser failure in {stage}")

    # -- timeline -------------------------------------------------------------------------
    def round_bounds(self, r: int) -> tuple[int, int, int, int]:
        extra = 200 * RATE if (self.long_round and r == 1) else 0
        start = sum(ROUND_LEN + (200 * RATE if (self.long_round and k == 1) else 0) for k in range(r))
        fe = start + FREEZE
        end = fe + LIVE + extra
        nxt = end + POST
        return start, fe, end, nxt

    @property
    def last_tick(self) -> int:
        return self.round_bounds(self.n_rounds - 1)[3] - FRAME

    def header(self) -> DemoHeader:
        self._maybe_fail("header")
        return DemoHeader(self.map_name, self.build, "synthetic server", "valve_demo_2", True, {})

    def event_names(self) -> list[str]:
        return sorted(["player_death", "player_hurt", "round_end", "round_freeze_end", "hegrenade_detonate", "weapon_fire"])

    def _hurt_kill_ticks(self, r: int) -> tuple[int, int]:
        _, fe, _, _ = self.round_bounds(r)
        return fe + 15 * RATE, fe + 16 * RATE

    def _he_ticks(self, r: int) -> tuple[int, int]:
        _, fe, _, _ = self.round_bounds(r)
        t0 = fe + 5 * RATE
        return t0, t0 + 104

    def ticks(self, fields: list[str]) -> pl.DataFrame:
        self._maybe_fail("ticks")
        rows: list[dict[str, Any]] = []
        if self.empty:
            return pl.DataFrame({"tick": pl.Series([], dtype=pl.Int64), "steamid": pl.Series([], dtype=pl.Utf8), "player_id": pl.Series([], dtype=pl.Utf8)})
        score = {2: 0, 3: 0}
        kills = {p: 0 for p in self.roster}
        deaths = {p: 0 for p in self.roster}
        for r in range(self.n_rounds):
            start, fe, end, nxt = self.round_bounds(r)
            hurt, kill = self._hurt_kill_ticks(r)
            for t in range(start, nxt, FRAME):
                live_s = max(0.0, (min(t, end) - fe) / RATE)
                rnd_dmg = {p: 0 for p in self.roster}
                if t >= hurt:
                    rnd_dmg[self.pid(1)] = 73
                if t >= kill:
                    rnd_dmg[self.pid(1)] = 100
                if t == end:
                    score[2] += 1
                if t >= kill and t - FRAME < kill:
                    kills[self.pid(1)] += 1
                    deaths[self.pid(3)] += 1
                for i, (p, team) in enumerate(self.roster.items(), start=1):
                    sign = -1 if team == 2 else 1
                    x = sign * max(100.0, 1000.0 - 30.0 * live_s) + (i % 2) * 150.0
                    y = 0.0 if i != 4 else 800.0
                    if i == 4:
                        x = 800.0
                    z = 0.0 if i != 2 else (0.0 if live_s < 12 else 200.0)
                    health = 100
                    alive = True
                    if i == 3 and t >= hurt:
                        health = 27
                    if i == 3 and t >= kill:
                        health, alive = 0, False
                    place = "TSpawn" if x < -300 else ("CTSpawn" if x > 300 else "Middle")
                    if i == 4:
                        place = "BombsiteA"
                    if z > 100:
                        place = "Upper"
                    row = {
                        "tick": t,
                        "steamid": p,
                        "player_id": p,
                        "x": x * self.coord_scale,
                        "y": y * self.coord_scale,
                        "z": z,
                        "pitch": 0.0,
                        "yaw": 0.0 if team == 2 else 180.0,
                        "health": health,
                        "armor": 100,
                        "is_alive": alive,
                        "team_num": team,
                        "place": place,
                        "active_weapon": "AK-47" if team == 2 else "M4A1-S",
                        "flash_duration": 0.0,
                        "balance": 800,
                        "total_rounds_played": r + (1 if t >= end else 0),
                        "game_time": t / RATE,
                        "is_freeze_period": start <= t < fe,
                        "is_warmup_period": False,
                        "round_win_status": 2 if t >= end else 0,
                        "round_win_reason": 9 if t >= end else 0,
                        "team_rounds_total": score[team],
                        "kills_total": kills[p],
                        "deaths_total": deaths[p],
                        "damage_total": 0,
                        "round_damage_dealt": rnd_dmg[p],
                    }
                    rows.append(row)
        df = pl.DataFrame(rows)
        keep = ["tick", "steamid", "player_id"] + [f for f in fields if f in df.columns]
        return df.select(keep).with_columns(
            pl.col("tick").cast(pl.Int64),
            pl.col(["x", "y", "z", "pitch", "yaw", "flash_duration", "game_time"]).cast(pl.Float32),
        )

    def _event_frames(self) -> dict[str, pl.DataFrame]:
        deaths, hurts, ends, fes, dets, fires = [], [], [], [], [], []
        for r in range(self.n_rounds):
            _, fe, end, _ = self.round_bounds(r)
            hurt, kill = self._hurt_kill_ticks(r)
            he0, he1 = self._he_ticks(r)
            hurts.append({"tick": hurt, "user_steamid": self.pid(3), "attacker_steamid": self.pid(1), "weapon": "ak47", "dmg_health": 73, "health": 27})
            hurts.append({"tick": kill, "user_steamid": self.pid(3), "attacker_steamid": self.pid(1), "weapon": "ak47", "dmg_health": 27, "health": 0})
            deaths.append({"tick": kill, "user_steamid": self.pid(3), "attacker_steamid": self.pid(1), "assister_steamid": None, "weapon": "ak47", "headshot": True})
            ends.append({"tick": end, "winner": 2, "reason": 9})
            fes.append({"tick": fe})
            dets.append({"tick": he1 + 1, "entityid": 100 + r, "user_steamid": self.pid(2), "x": -500.0, "y": 300.0, "z": 0.0})
            fires.append({"tick": he0 - 6, "user_steamid": self.pid(2), "weapon": "weapon_hegrenade"})
        return {
            "player_death": pl.DataFrame(deaths, schema={"tick": pl.Int64, "user_steamid": pl.Utf8, "attacker_steamid": pl.Utf8, "assister_steamid": pl.Utf8, "weapon": pl.Utf8, "headshot": pl.Boolean}),
            "player_hurt": pl.DataFrame(hurts),
            "round_end": pl.DataFrame(ends),
            "round_freeze_end": pl.DataFrame(fes),
            "hegrenade_detonate": pl.DataFrame(dets),
            "weapon_fire": pl.DataFrame(fires),
        }

    def event(self, name: str) -> pl.DataFrame:
        return self._event_frames()[name]

    def events(self, names: list[str]) -> dict[str, pl.DataFrame]:
        self._maybe_fail("events")
        frames = self._event_frames()
        return {n: frames[n] for n in names if n in frames}

    def grenades(self, extra: list[str]) -> pl.DataFrame:
        self._maybe_fail("grenades")
        rows: list[dict[str, Any]] = []
        for r in range(self.n_rounds):
            he0, he1 = self._he_ticks(r)
            for t in range(he0, he1 + 1, FRAME):
                s = (t - he0) / RATE
                rows.append(
                    {
                        "raw_class": "CBaseCSGrenadeProjectile",
                        "entity_id": 100 + r,
                        "tick": t,
                        "x": -900.0 + 250.0 * s,
                        "y": 300.0,
                        "z": 64.0 + 250.0 * s - 0.5 * 320.0 * s * s,
                        "owner_id": self.pid(2),
                        "is_inc_grenade": None,
                        "dmg_radius": 350.0,
                        "damage": 99.0,
                        "bounces": 0.0,
                        "explode_effect_tick": 0.0,
                    }
                )
            for t in range(he0 - 40, he0, FRAME):
                rows.append(
                    {"raw_class": "CHEGrenade", "entity_id": 300 + r, "tick": t, "x": None, "y": None, "z": None, "owner_id": self.pid(2),
                     "is_inc_grenade": None, "dmg_radius": None, "damage": None, "bounces": None, "explode_effect_tick": None}
                )
        schema = {"raw_class": pl.Utf8, "entity_id": pl.Int64, "tick": pl.Int64, "x": pl.Float64, "y": pl.Float64, "z": pl.Float64, "owner_id": pl.Utf8,
                  "is_inc_grenade": pl.Boolean, "dmg_radius": pl.Float64, "damage": pl.Float64, "bounces": pl.Float64, "explode_effect_tick": pl.Float64}
        return pl.DataFrame(rows, schema=schema)

    def players(self) -> pl.DataFrame:
        r = self.roster
        return pl.DataFrame({"steamid": list(r), "player_id": list(r), "team_num": list(r.values())})


class FakeAdapter:
    name = "synthetic"
    version = "0.0.0"

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs

    def open(self, path: Path) -> FakeDemo:
        return FakeDemo(**self.kwargs)


def build_dataset(tmp: Path, salt: str = "a", **kwargs: Any) -> Path:
    """Extract a synthetic demo into ``tmp/data`` and return the committed dataset directory."""
    from mf_common.emit import NullEmitter
    from mf_demo_parser.extract import extract_demo

    dem = write_fake_dem(tmp / f"{salt}.dem", salt)
    res = extract_demo(dem, tmp / "data", NullEmitter(), adapter=FakeAdapter(**kwargs))
    assert res["status"] in ("committed", "duplicate"), res
    return Path(res["dataset"])


def unit_angle(deg: float) -> tuple[float, float]:
    return math.cos(math.radians(deg)), math.sin(math.radians(deg))
