"""Adapter for the ``demoparser2`` (Rust, LaihoE/demoparser) Python bindings."""

from __future__ import annotations

import hashlib
import importlib.metadata
import math
from pathlib import Path

import pandas as pd
import polars as pl

from .adapter import AdapterNotes, DemoHeader

_TICK_FIELD_MAP: dict[str, str] = {
    "x": "X",
    "y": "Y",
    "z": "Z",
    "pitch": "pitch",
    "yaw": "yaw",
    "health": "health",
    "armor": "armor_value",
    "is_alive": "is_alive",
    "team_num": "team_num",
    "place": "last_place_name",
    "active_weapon": "active_weapon_name",
    "flash_duration": "flash_duration",
    "balance": "balance",
    "total_rounds_played": "total_rounds_played",
    "game_time": "game_time",
    "is_freeze_period": "is_freeze_period",
    "is_warmup_period": "is_warmup_period",
    "round_win_status": "round_win_status",
    "round_win_reason": "round_win_reason",
    "team_rounds_total": "team_rounds_total",
    "kills_total": "kills_total",
    "deaths_total": "deaths_total",
    "damage_total": "damage_total",
    # Live per-round damage counter on the pawn; ``damage_total`` only updates at round end.
    "round_damage_dealt": "CCSPlayerPawn.m_unTotalRoundDamageDealt",
}

_GRENADE_FIELD_MAP: dict[str, str] = {
    "is_inc_grenade": "m_bIsIncGrenade",
    "dmg_radius": "m_DmgRadius",
    "damage": "m_flDamage",
    "bounces": "m_nBounces",
    "explode_effect_tick": "m_nExplodeEffectTickBegin",
}

_FLOAT32_FIELDS = {"x", "y", "z", "pitch", "yaw", "flash_duration", "game_time"}
_BOOL_FIELDS = {"is_alive", "is_freeze_period", "is_warmup_period"}
_INT_FIELDS = {
    "health",
    "armor",
    "team_num",
    "balance",
    "total_rounds_played",
    "round_win_status",
    "round_win_reason",
    "team_rounds_total",
    "kills_total",
    "deaths_total",
    "damage_total",
    "round_damage_dealt",
}
_STR_FIELDS = {"place", "active_weapon"}


def _is_steamid_column(name: str) -> bool:
    return name == "steamid" or name.endswith("_steamid") or name.endswith("_xuid")


def _steamids_to_str(series: pd.Series, column: str, notes: AdapterNotes) -> list[str | None]:
    """Convert a parser SteamID column to decimal strings without ever passing through float."""
    dtype = series.dtype
    if pd.api.types.is_integer_dtype(dtype):
        return series.astype("uint64").astype(str).tolist()
    if pd.api.types.is_float_dtype(dtype):
        # A float64 SteamID64 has already lost precision inside the parser binding: discard.
        non_null = int(series.notna().sum())
        if non_null:
            notes.discarded_float_steamids[column] = notes.discarded_float_steamids.get(column, 0) + non_null
        return [None] * len(series)
    out: list[str | None] = []
    for v in series.tolist():
        if v is None or (isinstance(v, float) and math.isnan(v)):
            out.append(None)
            continue
        s = str(v).strip()
        out.append(s if s.isdigit() else None)
    return out


def _bot_id(name: object) -> str:
    return "bot:" + hashlib.sha1(str(name).encode("utf-8")).hexdigest()[:10]


class Demoparser2Demo:
    def __init__(self, path: Path) -> None:
        from demoparser2 import DemoParser

        self._parser = DemoParser(str(path))
        self.notes = AdapterNotes()
        self._event_names: list[str] | None = None

    def header(self) -> DemoHeader:
        raw = {str(k): str(v) for k, v in self._parser.parse_header().items()}
        client = raw.pop("client_name", None)
        map_name = raw.get("map_name", "")
        return DemoHeader(
            map_name=map_name,
            build=raw.get("patch_version"),
            server_name=raw.get("server_name"),
            demo_version_name=raw.get("demo_version_name"),
            recorded_by_sourcetv=client == "SourceTV Demo",
            extra={k: v for k, v in raw.items() if k not in {"map_name", "patch_version", "server_name"}},
        )

    def event_names(self) -> list[str]:
        if self._event_names is None:
            self._event_names = sorted(str(e) for e in self._parser.list_game_events())
        return self._event_names

    def event(self, name: str) -> pl.DataFrame:
        return self._normalize_event(name, self._parser.parse_event(name))

    def events(self, names: list[str]) -> dict[str, pl.DataFrame]:
        wanted = [n for n in names if n in set(self.event_names())]
        if not wanted:
            return {}
        try:
            parsed = self._parser.parse_events(wanted)
        except Exception as exc:  # fall back to one pass per event so one bad event cannot hide others
            self.notes.event_errors["parse_events"] = repr(exc)[:300]
            out: dict[str, pl.DataFrame] = {}
            for n in wanted:
                try:
                    out[n] = self.event(n)
                except Exception as exc2:
                    self.notes.event_errors[n] = repr(exc2)[:300]
            return out
        return {str(name): self._normalize_event(str(name), df) for name, df in parsed}

    def _normalize_event(self, name: str, df: pd.DataFrame | None) -> pl.DataFrame:
        if df is None or len(df) == 0:
            return pl.DataFrame({"tick": pl.Series([], dtype=pl.Int64)})
        cols: dict[str, pl.Series] = {}
        for col in df.columns:
            if col == "name" or col.endswith("_name"):
                continue  # never carry player display names
            if _is_steamid_column(col):
                cols[col] = pl.Series(col, _steamids_to_str(df[col], f"{name}.{col}", self.notes), dtype=pl.Utf8)
                continue
            series = df[col]
            if pd.api.types.is_object_dtype(series.dtype) or pd.api.types.is_string_dtype(series.dtype):
                cols[col] = pl.Series(col, [None if (isinstance(v, float) and math.isnan(v)) else str(v) for v in series.tolist()], dtype=pl.Utf8)
            else:
                cols[col] = pl.from_pandas(series).alias(col)
        out = pl.DataFrame(cols)
        return out.with_columns(pl.col("tick").cast(pl.Int64))

    def ticks(self, fields: list[str]) -> pl.DataFrame:
        wanted = [_TICK_FIELD_MAP[f] for f in fields]
        df = self._parser.parse_ticks(wanted)
        steamid = pl.Series("steamid", _steamids_to_str(df["steamid"], "ticks.steamid", self.notes), dtype=pl.Utf8)
        names = _to_polars(df["name"], "place") if "name" in df.columns else pl.Series([None] * len(df), dtype=pl.Utf8)
        is_bot = steamid.is_null() | (steamid == "0")
        bot_names = names.filter(is_bot).unique().to_list()
        bot_map = {nm: _bot_id(nm) for nm in bot_names}
        bot_ids = names.replace_strict(bot_map, default=None, return_dtype=pl.Utf8) if bot_map else names
        player_id = pl.select(pl.when(is_bot).then(bot_ids).otherwise(steamid)).to_series().alias("player_id")
        cols: dict[str, pl.Series] = {
            "tick": pl.Series("tick", df["tick"].to_numpy(), dtype=pl.Int64),
            "steamid": steamid,
            "player_id": player_id,
        }
        n = len(df)
        for canon, native in zip(fields, wanted, strict=True):
            if native not in df.columns:
                self.notes.missing_tick_fields.append(canon)
                dtype = _canonical_dtype(canon)
                cols[canon] = pl.Series(canon, [None] * n, dtype=dtype)
                continue
            cols[canon] = _to_polars(df[native], canon)
        return pl.DataFrame(cols)

    def grenades(self, extra: list[str]) -> pl.DataFrame:
        native_extra = [_GRENADE_FIELD_MAP[f] for f in extra]
        df = self._parser.parse_grenades(extra=native_extra)
        n = len(df)
        cols: dict[str, pl.Series] = {
            "raw_class": pl.Series("raw_class", [str(v) for v in df["grenade_type"].tolist()], dtype=pl.Utf8),
            "entity_id": pl.Series("entity_id", df["grenade_entity_id"].to_numpy(), dtype=pl.Int64),
            "tick": pl.Series("tick", df["tick"].to_numpy(), dtype=pl.Int64),
            "x": pl.from_pandas(df["x"]).cast(pl.Float64).fill_nan(None).alias("x"),
            "y": pl.from_pandas(df["y"]).cast(pl.Float64).fill_nan(None).alias("y"),
            "z": pl.from_pandas(df["z"]).cast(pl.Float64).fill_nan(None).alias("z"),
            "owner_id": pl.Series("owner_id", _steamids_to_str(df["steamid"], "grenades.steamid", self.notes), dtype=pl.Utf8),
        }
        for canon, native in zip(extra, native_extra, strict=True):
            if native not in df.columns:
                self.notes.missing_grenade_fields.append(canon)
                cols[canon] = pl.Series(canon, [None] * n, dtype=pl.Float64 if canon != "is_inc_grenade" else pl.Boolean)
                continue
            if canon == "is_inc_grenade":
                vals = [None if v is None or (isinstance(v, float) and math.isnan(v)) else bool(v) for v in df[native].tolist()]
                cols[canon] = pl.Series(canon, vals, dtype=pl.Boolean)
            else:
                cols[canon] = pl.from_pandas(df[native]).cast(pl.Float64).fill_nan(None).alias(canon)
        out = pl.DataFrame(cols)
        # owner "0" means no thrower resolved
        return out.with_columns(
            pl.when(pl.col("owner_id") == "0").then(None).otherwise(pl.col("owner_id")).alias("owner_id")
        )

    def players(self) -> pl.DataFrame:
        df = self._parser.parse_player_info()
        if df is None or len(df) == 0:
            return pl.DataFrame(
                {"steamid": pl.Series([], dtype=pl.Utf8), "player_id": pl.Series([], dtype=pl.Utf8), "team_num": pl.Series([], dtype=pl.Int64)}
            )
        sids = _steamids_to_str(df["steamid"], "player_info.steamid", self.notes)
        names = df["name"].tolist() if "name" in df.columns else [None] * len(df)
        pids = [s if s not in (None, "0") else _bot_id(n) for s, n in zip(sids, names, strict=True)]
        teams = df["team_number"].tolist() if "team_number" in df.columns else [None] * len(df)
        return pl.DataFrame(
            {
                "steamid": pl.Series(sids, dtype=pl.Utf8),
                "player_id": pl.Series(pids, dtype=pl.Utf8),
                "team_num": pl.Series([None if t is None or (isinstance(t, float) and math.isnan(t)) else int(t) for t in teams], dtype=pl.Int64),
            }
        )


def _canonical_dtype(canon: str) -> pl.DataType:
    if canon in _FLOAT32_FIELDS:
        return pl.Float32()
    if canon in _BOOL_FIELDS:
        return pl.Boolean()
    if canon in _INT_FIELDS:
        return pl.Int64()
    return pl.Utf8()


def _to_polars(series: pd.Series, canon: str) -> pl.Series:
    if canon in _STR_FIELDS:
        try:
            return pl.from_pandas(series).cast(pl.Utf8).alias(canon)
        except Exception:  # mixed object column: fall back to a Python pass
            vals = [None if v is None or (isinstance(v, float) and math.isnan(v)) else str(v) for v in series.tolist()]
            return pl.Series(canon, vals, dtype=pl.Utf8)
    if canon in _BOOL_FIELDS:
        vals = [None if v is None or (isinstance(v, float) and math.isnan(v)) else bool(v) for v in series.tolist()]
        return pl.Series(canon, vals, dtype=pl.Boolean)
    s = pl.from_pandas(series).alias(canon)
    if canon in _FLOAT32_FIELDS:
        return s.cast(pl.Float32).fill_nan(None)
    if canon in _INT_FIELDS:
        # parser exposes some integer props as float (NaN for missing)
        return s.cast(pl.Float64).fill_nan(None).cast(pl.Int64, strict=False)
    return s


class Demoparser2Adapter:
    name = "demoparser2"

    def __init__(self) -> None:
        try:
            self.version = importlib.metadata.version("demoparser2")
        except importlib.metadata.PackageNotFoundError:  # pragma: no cover - environment issue
            self.version = "unknown"

    def open(self, path: Path) -> Demoparser2Demo:
        return Demoparser2Demo(path)
