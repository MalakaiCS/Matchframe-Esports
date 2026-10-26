"""Round-attempt reconstruction from per-frame game-rule state plus round events.

Boundaries are freeze-period starts (``is_freeze_period`` False→True). Exact event ticks
(``round_end``, ``round_freeze_end``) are used when the demo has them; otherwise the frame-level
``round_win_status`` transition is used and labelled as such. Unusual but legitimate rounds
(restarts, warm-up, very long rounds, missing results) are flagged, never dropped.
"""

from __future__ import annotations

from bisect import bisect_left
from typing import Any

import polars as pl

from mf_common.frames import asof_backward

#: CS round-end reason codes (game ``RoundEndReason`` enum).
ROUND_END_REASONS: dict[int, str] = {
    1: "target_bombed",
    2: "vip_escaped",
    3: "vip_assassinated",
    4: "terrorists_escaped",
    5: "cts_prevent_escape",
    6: "escaping_terrorists_neutralized",
    7: "bomb_defused",
    8: "cts_win",
    9: "terrorists_win",
    10: "round_draw",
    11: "all_hostages_rescued",
    12: "target_saved",
    13: "hostages_not_rescued",
    14: "terrorists_not_escaped",
    15: "vip_not_escaped",
    16: "game_start",
    17: "terrorists_surrender",
    18: "cts_surrender",
    19: "terrorists_planted",
    20: "cts_reached_hostage",
}

SIDE_BY_TEAM = {2: "T", 3: "CT"}

ROUNDS_SCHEMA: dict[str, pl.DataType] = {
    "round_index": pl.Int32(),
    "round_number": pl.Int32(),
    "start_tick": pl.Int64(),
    "freeze_end_tick": pl.Int64(),
    "freeze_end_evidence": pl.Utf8(),
    "end_tick": pl.Int64(),
    "end_evidence": pl.Utf8(),
    "official_end_tick": pl.Int64(),
    "winner_team_num": pl.Int32(),
    "winner_side": pl.Utf8(),
    "reason_code": pl.Int32(),
    "reason": pl.Utf8(),
    "is_warmup": pl.Boolean(),
    "live_duration_s": pl.Float64(),
    "flags": pl.List(pl.Utf8()),
}


def frame_state(ticks: pl.DataFrame) -> pl.DataFrame:
    """Collapse per-player rows to one game-rule state row per recorded frame."""
    cols = ["total_rounds_played", "is_freeze_period", "is_warmup_period", "round_win_status", "round_win_reason"]
    present = [c for c in cols if c in ticks.columns]
    return (
        ticks.group_by("tick")
        .agg([pl.col(c).drop_nulls().first().alias(c) for c in present])
        .sort("tick")
    )


def _first_event(events: list[dict[str, Any]], lo: int, hi: int) -> dict[str, Any] | None:
    for ev in events:
        if lo < ev["tick"] <= hi:
            return ev
    return None


def build_rounds(
    frames: pl.DataFrame,
    tick_rate: float,
    round_end: pl.DataFrame | None = None,
    freeze_end: pl.DataFrame | None = None,
) -> pl.DataFrame:
    if frames.height == 0:
        return pl.DataFrame(schema=ROUNDS_SCHEMA)
    frames = frames.sort("tick")
    ticks: list[int] = frames["tick"].to_list()
    first_tick, last_tick = ticks[0], ticks[-1]

    def col(name: str) -> list[Any]:
        return frames[name].to_list() if name in frames.columns else [None] * len(ticks)

    freeze_raw = col("is_freeze_period")
    has_freeze = any(v is not None for v in freeze_raw)
    freeze: list[bool] = []
    last = False
    for v in freeze_raw:
        last = bool(v) if v is not None else last
        freeze.append(last)
    warmup = [bool(v) if v is not None else False for v in col("is_warmup_period")]
    trp = col("total_rounds_played")
    win_status = col("round_win_status")
    win_reason = col("round_win_reason")

    end_rows = [] if round_end is None or round_end.height == 0 else round_end.sort("tick").to_dicts()
    freeze_rows = [] if freeze_end is None or freeze_end.height == 0 else freeze_end.sort("tick").to_dicts()

    if has_freeze:
        starts = [first_tick] + [ticks[i] for i in range(1, len(ticks)) if freeze[i] and not freeze[i - 1]]
        boundary_source = "tick_prop:is_freeze_period"
    else:
        starts = [first_tick] + [int(e["tick"]) + 1 for e in end_rows if first_tick < int(e["tick"]) + 1 <= last_tick]
        boundary_source = "event:round_end"
    starts = sorted(set(starts))

    rows: list[dict[str, Any]] = []
    prev_number: int | None = None
    for ri, start in enumerate(starts):
        nxt = starts[ri + 1] if ri + 1 < len(starts) else None
        seg_end = (nxt - 1) if nxt is not None else last_tick
        assign_hi = nxt if nxt is not None else last_tick
        i0 = min(bisect_left(ticks, start), len(ticks) - 1)
        i1 = len(ticks) if nxt is None else bisect_left(ticks, nxt)
        idx = range(i0, i1)
        flags: list[str] = []

        # freeze end
        fe_tick: int | None = None
        fe_evidence: str | None = None
        ev = _first_event(freeze_rows, start - 1, seg_end)
        if ev is not None:
            fe_tick, fe_evidence = int(ev["tick"]), "event:round_freeze_end"
        elif has_freeze and freeze[i0]:
            for i in idx:
                if not freeze[i]:
                    fe_tick, fe_evidence = ticks[i], "tick_prop:is_freeze_period"
                    break
        if has_freeze and not freeze[i0]:
            flags.append("no_freeze_period")

        # result
        end_tick: int | None = None
        end_evidence: str | None = None
        winner: int | None = None
        reason: int | None = None
        ev = _first_event(end_rows, start, assign_hi)
        if ev is not None:
            end_tick, end_evidence = int(ev["tick"]), "event:round_end"
            winner = int(ev["winner"]) if ev.get("winner") is not None else None
            reason = int(ev["reason"]) if ev.get("reason") is not None else None
        else:
            for i in idx:
                # only a 0 → non-zero transition inside the segment counts (status carries over)
                if i == i0 or win_status[i] in (None, 0) or win_status[i - 1] not in (None, 0):
                    continue
                end_tick, end_evidence = ticks[i], "tick_prop:round_win_status"
                winner = int(win_status[i])
                reason = int(win_reason[i]) if win_reason[i] not in (None, 0) else None
                break
        if end_tick is None:
            flags.append("no_result")

        is_warmup = sum(1 for i in idx if warmup[i]) > max(1, len(idx)) / 2
        if is_warmup:
            flags.append("warmup")
        number = int(trp[i0]) + 1 if trp[i0] is not None else None
        if number is not None and not is_warmup and end_tick is not None:
            if prev_number is not None and number <= prev_number:
                flags.append("restart_or_repeated_round_number")
            prev_number = number
        live_s: float | None = None
        if fe_tick is not None and end_tick is not None:
            live_s = round((end_tick - fe_tick) / tick_rate, 3)
            if live_s < 5:
                flags.append("very_short_live_phase")
            elif live_s > 180:
                flags.append("long_live_phase")
        if ri == len(starts) - 1 and end_tick is None:
            flags.append("trailing_segment")
        if ri == 0 and has_freeze and not freeze[i0]:
            flags.append("pre_first_freeze")
        rows.append(
            {
                "round_index": ri,
                "round_number": number,
                "start_tick": start,
                "freeze_end_tick": fe_tick,
                "freeze_end_evidence": fe_evidence,
                "end_tick": end_tick,
                "end_evidence": end_evidence,
                "official_end_tick": max(seg_end, end_tick) if end_tick is not None else seg_end,
                "winner_team_num": winner,
                "winner_side": SIDE_BY_TEAM.get(winner) if winner is not None else None,
                "reason_code": reason,
                "reason": ROUND_END_REASONS.get(reason, f"code_{reason}") if reason is not None else None,
                "is_warmup": is_warmup,
                "live_duration_s": live_s,
                "flags": flags,
            }
        )
    out = pl.DataFrame(rows, schema=ROUNDS_SCHEMA)
    return out.with_columns(pl.lit(boundary_source).alias("boundary_evidence"))


def assign_round_index(df: pl.DataFrame, rounds: pl.DataFrame, tick_col: str = "tick") -> pl.DataFrame:
    """Attach ``round_index`` (last round attempt starting at or before the tick)."""
    if df.height == 0 or rounds.height == 0:
        return df.with_columns(pl.lit(None, dtype=pl.Int32).alias("round_index"))
    starts = rounds.select(pl.col("start_tick").cast(pl.Int64).alias("_rt"), "round_index")
    tmp = df.drop("round_index", strict=False).with_columns(pl.col(tick_col).cast(pl.Int64).alias("_rt"))
    return asof_backward(tmp, starts, on="_rt").drop("_rt")


def live_mask_expr(rounds: pl.DataFrame) -> list[tuple[int, int, int]]:
    """(round_index, live_start, live_end) for rounds with a freeze end and result."""
    out: list[tuple[int, int, int]] = []
    for r in rounds.to_dicts():
        if r["freeze_end_tick"] is not None and r["end_tick"] is not None and not r["is_warmup"]:
            out.append((int(r["round_index"]), int(r["freeze_end_tick"]), int(r["end_tick"])))
    return out
