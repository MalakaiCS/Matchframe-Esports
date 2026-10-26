"""Normalisation of parser game events into one long ``events`` table.

Column semantics follow the game events: ``user_id`` is the event subject (victim for
``player_death``/``player_hurt``/``player_blind``; thrower/shooter/planter otherwise),
``attacker_id``/``assister_id`` as in the game. ``*_evidence`` says where an id came from
(``event`` = parser, ``counter_delta`` = recovered, see :mod:`identity`).
"""

from __future__ import annotations

from typing import Any

import polars as pl

#: Game events extracted when the demo contains them.
EXTRACTED_EVENTS: tuple[str, ...] = (
    "player_death",
    "player_hurt",
    "player_blind",
    "weapon_fire",
    "bomb_beginplant",
    "bomb_planted",
    "bomb_begindefuse",
    "bomb_defused",
    "bomb_exploded",
    "round_start",
    "round_freeze_end",
    "round_end",
    "round_officially_ended",
    "begin_new_match",
    "hegrenade_detonate",
    "flashbang_detonate",
    "smokegrenade_detonate",
    "smokegrenade_expired",
    "inferno_startburn",
    "inferno_expire",
    "decoy_started",
    "decoy_detonate",
)

#: Events the downstream pipeline relies on, by capability.
KEY_EVENTS: dict[str, tuple[str, ...]] = {
    "kills": ("player_death",),
    "damage": ("player_hurt",),
    "round_results": ("round_end",),
    "utility_lifecycle": (
        "hegrenade_detonate",
        "flashbang_detonate",
        "smokegrenade_detonate",
        "smokegrenade_expired",
        "inferno_startburn",
        "inferno_expire",
    ),
    "throws": ("weapon_fire",),
    "flash_effects": ("player_blind",),
    "bomb": ("bomb_planted", "bomb_defused"),
}

EVENTS_SCHEMA: dict[str, pl.DataType] = {
    "event_type": pl.Utf8(),
    "tick": pl.Int64(),
    "user_id": pl.Utf8(),
    "user_evidence": pl.Utf8(),
    "attacker_id": pl.Utf8(),
    "attacker_evidence": pl.Utf8(),
    "assister_id": pl.Utf8(),
    "weapon": pl.Utf8(),
    "dmg_health": pl.Int64(),
    "dmg_armor": pl.Int64(),
    "health_after": pl.Int64(),
    "hitgroup": pl.Utf8(),
    "headshot": pl.Boolean(),
    "penetrated": pl.Int64(),
    "thrusmoke": pl.Boolean(),
    "attackerblind": pl.Boolean(),
    "noscope": pl.Boolean(),
    "distance": pl.Float64(),
    "blind_duration": pl.Float64(),
    "entity_id": pl.Int64(),
    "x": pl.Float64(),
    "y": pl.Float64(),
    "z": pl.Float64(),
    "site": pl.Int64(),
    "winner": pl.Int64(),
    "reason": pl.Int64(),
}

_RENAMES: dict[str, str] = {
    "user_steamid": "user_id",
    "attacker_steamid": "attacker_id",
    "assister_steamid": "assister_id",
    "entityid": "entity_id",
    "health": "health_after",
}


def _clean(v: Any) -> Any:
    if isinstance(v, float) and v != v:  # NaN
        return None
    return v


def normalize_events(parsed: dict[str, pl.DataFrame]) -> pl.DataFrame:
    rows: list[dict[str, Any]] = []
    for name in EXTRACTED_EVENTS:
        df = parsed.get(name)
        if df is None or df.height == 0:
            continue
        for rec in df.to_dicts():
            row: dict[str, Any] = {k: None for k in EVENTS_SCHEMA}
            row["event_type"] = name
            for key, val in rec.items():
                target = _RENAMES.get(key, key)
                if target in row and target != "event_type":
                    row[target] = _clean(val)
            row["user_evidence"] = "event" if row["user_id"] is not None else None
            row["attacker_evidence"] = "event" if row["attacker_id"] is not None else None
            rows.append(row)
    if not rows:
        return pl.DataFrame(schema=EVENTS_SCHEMA)
    return _coerce(rows).sort(["tick", "event_type"])


def _coerce(rows: list[dict[str, Any]]) -> pl.DataFrame:
    cols: dict[str, pl.Series] = {}
    for name, dtype in EVENTS_SCHEMA.items():
        vals = [r[name] for r in rows]
        if dtype == pl.Utf8():
            vals = [None if v is None else str(v) for v in vals]
        elif dtype == pl.Int64():
            vals = [None if v is None or v == "" else int(float(v)) for v in vals]
        elif dtype == pl.Float64():
            vals = [None if v is None or v == "" else float(v) for v in vals]
        elif dtype == pl.Boolean():
            vals = [None if v is None else bool(v) for v in vals]
        cols[name] = pl.Series(name, vals, dtype=dtype)
    return pl.DataFrame(cols)


def identity_coverage(events: pl.DataFrame) -> dict[str, dict[str, float | int]]:
    """Fraction of player-centric events with known user/attacker ids, by evidence."""
    out: dict[str, dict[str, float | int]] = {}
    for name in ("player_death", "player_hurt", "player_blind", "weapon_fire"):
        sub = events.filter(pl.col("event_type") == name)
        if sub.height == 0:
            continue
        n = sub.height
        out[name] = {
            "rows": n,
            "user_known": round(sub["user_id"].is_not_null().sum() / n, 4),
            "user_from_event": round((sub["user_evidence"] == "event").sum() / n, 4),
            "attacker_known": round(sub["attacker_id"].is_not_null().sum() / n, 4),
            "attacker_from_event": round((sub["attacker_evidence"] == "event").sum() / n, 4),
        }
    return out
