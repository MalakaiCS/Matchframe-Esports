"""Player-identity recovery from scoreboard counters.

Several 2023 demos in the corpus have game events whose player fields cannot be resolved by the
parser (``user_steamid``/``attacker_steamid`` 100 % null). The per-player counters
``round_damage_dealt`` (pawn ``m_unTotalRoundDamageDealt``, updated live — unlike ``damage_total``,
which only changes at round end), ``kills_total`` / ``deaths_total`` and ``health`` are present on
every recorded frame, so a damage or kill can be attributed when, within one frame transition, exactly one
opposing-team player's counter increases while the victim's health drops (or death count rises).
Multiple candidates → ``ambiguous`` (no attacker); no candidate → ``unattributed`` (world/fall/team
damage). Evidence is always recorded as ``counter_delta``; parser-provided ids stay ``event``.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import polars as pl

ATTRIBUTION_SCHEMA: dict[str, pl.DataType] = {
    "tick": pl.Int64(),
    "kind": pl.Utf8(),
    "victim_id": pl.Utf8(),
    "attacker_id": pl.Utf8(),
    "amount": pl.Int64(),
    "status": pl.Utf8(),
    "n_candidates": pl.Int64(),
    "evidence": pl.Utf8(),
}

_NEEDED = ("tick", "player_id", "team_num", "health", "is_alive", "kills_total", "deaths_total", "round_damage_dealt")


def counter_attributions(ticks: pl.DataFrame) -> pl.DataFrame:
    """Derive damage/kill attributions from consecutive-frame counter deltas (full-rate frames)."""
    if ticks.height == 0 or any(c not in ticks.columns for c in _NEEDED):
        return pl.DataFrame(schema=ATTRIBUTION_SCHEMA)
    df = (
        ticks.select(list(_NEEDED))
        .sort(["player_id", "tick"])
        .with_columns(
            [
                (pl.col(c) - pl.col(c).shift(1).over("player_id")).alias(f"d_{c}")
                for c in ("health", "kills_total", "deaths_total", "round_damage_dealt")
            ]
            + [pl.col("is_alive").shift(1).over("player_id").alias("prev_alive")]
        )
    )
    teams = pl.col("team_num").is_in([2, 3])
    out: list[pl.DataFrame] = []
    for kind, victim_expr, attacker_expr, amount_expr in (
        ("damage", (pl.col("d_health") < 0) & pl.col("prev_alive").fill_null(False), pl.col("d_round_damage_dealt") > 0, -pl.col("d_health")),
        ("kill", pl.col("d_deaths_total") > 0, pl.col("d_kills_total") > 0, pl.col("d_deaths_total")),
    ):
        victims = df.filter(victim_expr & teams).select(
            "tick", pl.col("player_id").alias("victim_id"), pl.col("team_num").alias("vteam"), amount_expr.cast(pl.Int64).alias("amount")
        )
        attackers = df.filter(attacker_expr & teams).select(
            "tick", pl.col("player_id").alias("attacker_id"), pl.col("team_num").alias("ateam")
        )
        if victims.height == 0:
            continue
        joined = victims.join(attackers, on="tick", how="left").with_columns(
            pl.when(pl.col("ateam") != pl.col("vteam")).then(pl.col("attacker_id")).otherwise(None).alias("cand")
        )
        grouped = joined.group_by(["tick", "victim_id"], maintain_order=True).agg(
            pl.col("amount").first(),
            pl.col("cand").drop_nulls().unique().alias("cands"),
        )
        grouped = grouped.with_columns(pl.col("cands").list.len().cast(pl.Int64).alias("n_candidates"))
        grouped = grouped.with_columns(
            pl.when(pl.col("n_candidates") == 1).then(pl.col("cands").list.first()).otherwise(None).alias("attacker_id"),
            pl.when(pl.col("n_candidates") == 1)
            .then(pl.lit("attributed"))
            .when(pl.col("n_candidates") == 0)
            .then(pl.lit("unattributed"))
            .otherwise(pl.lit("ambiguous"))
            .alias("status"),
            pl.lit(kind).alias("kind"),
            pl.lit("counter_delta").alias("evidence"),
        )
        out.append(grouped.select(list(ATTRIBUTION_SCHEMA)).cast(ATTRIBUTION_SCHEMA))  # type: ignore[arg-type]
    if not out:
        return pl.DataFrame(schema=ATTRIBUTION_SCHEMA)
    return pl.concat(out).sort(["tick", "kind", "victim_id"])


def fill_event_identity(
    events: pl.DataFrame, attributions: pl.DataFrame, frame_ticks: np.ndarray
) -> tuple[pl.DataFrame, dict[str, Any]]:
    """Fill null ``user_id`` (victim) / ``attacker_id`` of death/hurt events from counter attributions.

    The attribution frame is the first recorded frame at or after the event tick. A field is only
    filled when the frame offers exactly one candidate (consistent with any id already known).
    """
    stats: dict[str, Any] = {"filled_victim": 0, "filled_attacker": 0, "ambiguous": 0, "unresolved": 0}
    if events.height == 0 or attributions.height == 0 or frame_ticks.size == 0:
        return events, stats
    by_frame: dict[tuple[int, str], list[dict[str, Any]]] = {}
    for a in attributions.to_dicts():
        by_frame.setdefault((int(a["tick"]), str(a["kind"])), []).append(a)
    kind_of = {"player_death": "kill", "player_hurt": "damage"}
    rows = events.to_dicts()
    for row in rows:
        kind = kind_of.get(row["event_type"])
        if kind is None:
            continue
        if row.get("user_id") is not None and (row.get("attacker_id") is not None or row.get("attacker_evidence") == "event"):
            continue
        i = int(np.searchsorted(frame_ticks, int(row["tick"]), side="left"))
        if i >= frame_ticks.size:
            stats["unresolved"] += 1
            continue
        cands = by_frame.get((int(frame_ticks[i]), kind), [])
        if row.get("user_id") is not None:
            cands = [c for c in cands if c["victim_id"] == row["user_id"]]
        victims = {c["victim_id"] for c in cands}
        if row.get("user_id") is None:
            if len(victims) == 1:
                row["user_id"] = next(iter(victims))
                row["user_evidence"] = "counter_delta"
                stats["filled_victim"] += 1
            elif len(victims) > 1:
                stats["ambiguous"] += 1
                row["user_evidence"] = "ambiguous"
                continue
            else:
                stats["unresolved"] += 1
                continue
        if row.get("attacker_id") is None:
            attackers = {c["attacker_id"] for c in cands if c["victim_id"] == row["user_id"] and c["status"] == "attributed"}
            if len(attackers) == 1:
                row["attacker_id"] = next(iter(attackers))
                row["attacker_evidence"] = "counter_delta"
                stats["filled_attacker"] += 1
            elif any(c["status"] == "ambiguous" for c in cands):
                row["attacker_evidence"] = "ambiguous"
                stats["ambiguous"] += 1
    return pl.DataFrame(rows, schema=events.schema), stats


def identity_crosscheck(events: pl.DataFrame, attributions: pl.DataFrame, frame_ticks: np.ndarray) -> dict[str, Any]:
    """Validate counter-delta recovery on events whose ids the parser *did* resolve.

    Ids are blanked, recovered, and compared with the parser values. Reported per event type as
    ``compared`` (recovered rows) and ``agree`` (both ids identical).
    """
    out: dict[str, Any] = {}
    for name in ("player_death", "player_hurt"):
        known = events.filter(
            (pl.col("event_type") == name) & pl.col("user_id").is_not_null() & pl.col("attacker_id").is_not_null()
        )
        if known.height == 0:
            continue
        blank = known.with_columns(
            pl.lit(None, dtype=pl.Utf8).alias("user_id"),
            pl.lit(None, dtype=pl.Utf8).alias("attacker_id"),
            pl.lit(None, dtype=pl.Utf8).alias("user_evidence"),
            pl.lit(None, dtype=pl.Utf8).alias("attacker_evidence"),
        )
        recovered, _ = fill_event_identity(blank, attributions, frame_ticks)
        both = [
            (a, b)
            for a, b in zip(known.select("user_id", "attacker_id").rows(), recovered.select("user_id", "attacker_id").rows(), strict=True)
            if b[0] is not None and b[1] is not None
        ]
        out[name] = {
            "parser_identified": known.height,
            "recovered": len(both),
            "agree": sum(1 for a, b in both if a == b),
        }
    return out
