"""Round reconstruction and counter-delta identity recovery on synthetic frames."""

from __future__ import annotations

import numpy as np
import polars as pl

from mf_demo_parser.identity import counter_attributions, fill_event_identity
from mf_demo_parser.rounds import build_rounds


def _frames(spec: list[tuple[int, bool, int, int]]) -> pl.DataFrame:
    """(tick, freeze, total_rounds_played, win_status)"""
    return pl.DataFrame(
        {
            "tick": [s[0] for s in spec],
            "is_freeze_period": [s[1] for s in spec],
            "is_warmup_period": [False] * len(spec),
            "total_rounds_played": [s[2] for s in spec],
            "round_win_status": [s[3] for s in spec],
            "round_win_reason": [9 if s[3] else 0 for s in spec],
        }
    )


def test_rounds_from_tick_props_without_events() -> None:
    spec = []
    for t in range(0, 3000, 10):
        r = t // 1000
        local = t % 1000
        freeze = local < 200
        status = 2 if local >= 800 else 0
        spec.append((t, freeze, r + (1 if local >= 800 else 0), status))
    rounds = build_rounds(_frames(spec), 64.0)
    assert rounds.height == 3
    assert rounds["end_evidence"].to_list() == ["tick_prop:round_win_status"] * 3
    assert rounds["round_number"].to_list() == [1, 2, 3]
    assert rounds["winner_side"].to_list() == ["T", "T", "T"]
    assert rounds["freeze_end_tick"].to_list() == [200, 1200, 2200]


def test_round_end_event_preferred_and_status_carry_over_ignored() -> None:
    spec = [(t, (t % 1000) < 200, t // 1000, 2 if (t % 1000) >= 800 or t >= 2000 else 0) for t in range(0, 2400, 10)]
    rounds = build_rounds(_frames(spec), 64.0, round_end=pl.DataFrame({"tick": [805, 1805], "winner": [3, 3], "reason": [8, 8]}))
    assert rounds["end_tick"].to_list()[:2] == [805, 1805]
    assert rounds["end_evidence"].to_list()[:2] == ["event:round_end", "event:round_end"]
    # third segment: status already non-zero at its start (game over) → no fabricated result
    assert rounds["end_tick"].to_list()[2] is None
    assert "trailing_segment" in rounds["flags"].to_list()[2]


def _player_frames(rows: list[tuple[int, str, int, int, bool, int, int, int]]) -> pl.DataFrame:
    """(tick, player, team, health, alive, kills, deaths, round_damage)"""
    return pl.DataFrame(
        {
            "tick": [r[0] for r in rows],
            "player_id": [r[1] for r in rows],
            "team_num": [r[2] for r in rows],
            "health": [r[3] for r in rows],
            "is_alive": [r[4] for r in rows],
            "kills_total": [r[5] for r in rows],
            "deaths_total": [r[6] for r in rows],
            "round_damage_dealt": [r[7] for r in rows],
        }
    )


def test_counter_delta_attribution_and_ambiguity() -> None:
    rows = []
    for t in (0, 3, 6):
        # A (T) shoots V (CT) at t=3; at t=6 both A and B (T) deal damage to W (CT) → ambiguous
        rows.append((t, "A", 2, 100, True, 0, 0, 0 if t < 3 else (30 if t < 6 else 50)))
        rows.append((t, "B", 2, 100, True, 0, 0, 0 if t < 6 else 20))
        rows.append((t, "V", 3, 100 if t < 3 else 70, True, 0, 0, 0))
        rows.append((t, "W", 3, 100 if t < 6 else 60, True, 0, 0, 0))
    att = counter_attributions(_player_frames(rows))
    d3 = att.filter((pl.col("tick") == 3) & (pl.col("kind") == "damage")).to_dicts()
    assert d3 == [{"tick": 3, "kind": "damage", "victim_id": "V", "attacker_id": "A", "amount": 30, "status": "attributed", "n_candidates": 1, "evidence": "counter_delta"}]
    d6 = att.filter((pl.col("tick") == 6) & (pl.col("kind") == "damage")).to_dicts()
    assert d6[0]["status"] == "ambiguous" and d6[0]["attacker_id"] is None


def test_team_constraint_resolves_simultaneous_trades() -> None:
    rows = []
    for t in (0, 3):
        rows.append((t, "T1", 2, 100 if t == 0 else 80, True, 0, 0, 0 if t == 0 else 25))
        rows.append((t, "C1", 3, 100 if t == 0 else 75, True, 0, 0, 0 if t == 0 else 20))
    att = counter_attributions(_player_frames(rows)).filter(pl.col("kind") == "damage")
    pairs = {(r["victim_id"], r["attacker_id"]) for r in att.to_dicts()}
    assert pairs == {("T1", "C1"), ("C1", "T1")}


def test_fill_event_identity_only_when_unique() -> None:
    rows = []
    for t in (0, 3):
        rows.append((t, "K", 2, 100, True, 0 if t == 0 else 1, 0, 0))
        rows.append((t, "D", 3, 100 if t == 0 else 0, t == 0, 0, 0 if t == 0 else 1, 0))
    att = counter_attributions(_player_frames(rows))
    events = pl.DataFrame(
        {"event_type": ["player_death"], "tick": [2], "user_id": [None], "user_evidence": [None], "attacker_id": [None], "attacker_evidence": [None]},
        schema={"event_type": pl.Utf8, "tick": pl.Int64, "user_id": pl.Utf8, "user_evidence": pl.Utf8, "attacker_id": pl.Utf8, "attacker_evidence": pl.Utf8},
    )
    filled, stats = fill_event_identity(events, att, np.array([0, 3]))
    row = filled.to_dicts()[0]
    assert row["user_id"] == "D" and row["attacker_id"] == "K"
    assert row["user_evidence"] == row["attacker_evidence"] == "counter_delta"
    assert stats["filled_victim"] == 1 and stats["filled_attacker"] == 1
