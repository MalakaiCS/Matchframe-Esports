"""Parser-agnostic interface. Extraction logic only talks to :class:`ParsedDemo`.

Adapters are responsible for normalisation so downstream code never sees parser quirks:

* SteamIDs are decimal **strings** (never floats; float columns are discarded as precision-unsafe).
* Tick columns are ``Int64``; coordinates ``Float64``.
* Player display names are dropped (only bots get a hashed pseudo-id).
* Field names are the canonical names below, not the parser's own property names.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import polars as pl

#: Canonical per-player tick fields that extraction may request.
TICK_FIELDS: tuple[str, ...] = (
    "x",
    "y",
    "z",
    "pitch",
    "yaw",
    "health",
    "armor",
    "is_alive",
    "team_num",
    "place",
    "active_weapon",
    "flash_duration",
    "balance",
    "total_rounds_played",
    "game_time",
    "is_freeze_period",
    "is_warmup_period",
    "round_win_status",
    "round_win_reason",
    "team_rounds_total",
    "kills_total",
    "deaths_total",
    "damage_total",
    "round_damage_dealt",
)

#: Canonical grenade entity properties requested in addition to class/position/owner.
GRENADE_EXTRA_FIELDS: tuple[str, ...] = (
    "is_inc_grenade",
    "dmg_radius",
    "damage",
    "bounces",
    "explode_effect_tick",
)

DEMO_MAGIC_CS2 = b"PBDEMS2\x00"
DEMO_MAGIC_CSGO = b"HL2DEMO\x00"


@dataclass(frozen=True)
class DemoHeader:
    map_name: str
    build: str | None
    server_name: str | None
    demo_version_name: str | None
    recorded_by_sourcetv: bool
    #: Remaining header fields (client name removed: it is a person's name on POV demos).
    extra: dict[str, str] = field(default_factory=dict)


@dataclass
class AdapterNotes:
    """Compatibility observations collected while reading a demo."""

    missing_tick_fields: list[str] = field(default_factory=list)
    missing_grenade_fields: list[str] = field(default_factory=list)
    discarded_float_steamids: dict[str, int] = field(default_factory=dict)
    event_errors: dict[str, str] = field(default_factory=dict)


class ParsedDemo(Protocol):
    """An opened demo. All methods may raise; extraction maps failures to ``PARSER_FAILED``."""

    notes: AdapterNotes

    def header(self) -> DemoHeader: ...

    def event_names(self) -> list[str]: ...

    def event(self, name: str) -> pl.DataFrame:
        """Rows of one game event with ``tick`` plus normalised columns (``*_steamid`` as strings)."""
        ...

    def events(self, names: list[str]) -> dict[str, pl.DataFrame]:
        """Several events in one pass (names absent from the demo are skipped)."""
        ...

    def ticks(self, fields: list[str]) -> pl.DataFrame:
        """One row per recorded frame per player: ``tick``, ``steamid``, ``player_id`` + canonical fields."""
        ...

    def grenades(self, extra: list[str]) -> pl.DataFrame:
        """Grenade entity samples: ``raw_class, entity_id, tick, x, y, z, owner_id`` + canonical extras."""
        ...

    def players(self) -> pl.DataFrame:
        """Player list from the parser (``steamid``, ``player_id``, ``team_num``) — may be empty."""
        ...


class ParserAdapter(Protocol):
    name: str
    version: str

    def open(self, path: Path) -> ParsedDemo: ...


def sniff_format(path: Path) -> str:
    """Return ``cs2``, ``csgo`` or ``unknown`` from the file magic (cheap pre-parse check)."""
    with path.open("rb") as fh:
        magic = fh.read(8)
    if magic == DEMO_MAGIC_CS2:
        return "cs2"
    if magic == DEMO_MAGIC_CSGO:
        return "csgo"
    return "unknown"


def get_adapter(name: str = "demoparser2") -> ParserAdapter:
    if name == "demoparser2":
        from .demoparser2_adapter import Demoparser2Adapter

        return Demoparser2Adapter()
    raise ValueError(f"unknown parser adapter: {name}")
