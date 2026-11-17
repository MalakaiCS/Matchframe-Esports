#!/usr/bin/env python3
"""Every round's buy from CS2 demos, for the buy-type tests (ADR-080).

For each round of each demo, per player: the money and equipment value at the start of freeze time
(money then = what they hold at the end of freeze time plus what they spent this round; equipment
then = the round's starting equipment value), and one second into the live round (what they
bought: equipment value, money left, their main weapon's class). Per team: its side, the round's
loss count as CS2 keeps it (1 at the start of each half, +1 for a loss up to 5, -1 for a win) and
whether it lost the round before. That is what the game data (GSI) gives the director live.

Usage (demoparser2, run with python -I on downloaded demos):
    python -I scripts/export-buy-rounds.py --out packages/director-policy/test/fixtures/buy-rounds.json demo1.dem ...

The demos are not committed; only the numbers derived from them are.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    from demoparser2 import DemoParser
except ImportError:  # pragma: no cover
    sys.exit("demoparser2 is required: pip install demoparser2")

TICKRATE = 64
RIFLES = {"AK-47", "M4A4", "M4A1-S", "Galil AR", "FAMAS", "AUG", "SG 553", "AWP", "SSG 08", "SCAR-20", "G3SG1"}
SMGS = {"MAC-10", "MP9", "MP7", "MP5-SD", "UMP-45", "P90", "PP-Bizon", "Nova", "XM1014", "Sawed-Off", "MAG-7", "M249", "Negev"}


def weapon_class(inventory: list[str]) -> str:
    """r: a rifle or sniper rifle; s: an SMG, shotgun or machine gun; p: pistols only."""
    names = set(inventory or [])
    if names & RIFLES:
        return "r"
    if names & SMGS:
        return "s"
    return "p"


def export(path: Path) -> dict:
    p = DemoParser(str(path))
    header = p.parse_header()
    freeze_end = [int(t) for t in p.parse_event("round_freeze_end")["tick"].tolist()]
    ends = p.parse_event("round_end")
    # round_end numbers the round after the one that ended (rounds played so far).
    winners = {int(r) - 1: str(w) for r, w in zip(ends["round"].tolist(), ends["winner"].tolist()) if str(w) in ("T", "CT")}
    wanted = ["team_num", "balance", "current_equip_value", "round_start_equip_value", "cash_spent_this_round", "inventory", "total_rounds_played"]
    ticks = sorted({t + TICKRATE for t in freeze_end})
    df = p.parse_ticks(wanted, ticks=ticks)
    rounds = []
    losses = {"T": 1, "CT": 1}
    for t in freeze_end:
        rows = df[df["tick"] == t + TICKRATE]
        if rows.empty:
            continue
        played = int(rows["total_rounds_played"].max())
        number = played + 1
        # A new half (regulation halves of 12, overtime halves of 3): the loss count starts at 1 again.
        if number == 1 or number == 13 or (number > 24 and (number - 25) % 3 == 0):
            losses = {"T": 1, "CT": 1}
        prev = winners.get(played) if played >= 1 else None
        teams = {}
        for side, num in (("T", 2), ("CT", 3)):
            team = rows[rows["team_num"] == num]
            if team.empty:
                continue
            players = []
            for _, r in team.iterrows():
                money = int(r["balance"])
                spent = int(r["cash_spent_this_round"])
                players.append([money + spent, int(r["round_start_equip_value"]), money, int(r["current_equip_value"]), weapon_class(list(r["inventory"]))])
            teams[side] = {"losses": losses[side], "lostLast": None if prev is None else prev != side, "players": players}
        rounds.append({"round": number, **teams})
        winner = winners.get(number)
        for side in ("T", "CT"):
            if winner is None:
                continue
            losses[side] = max(0, losses[side] - 1) if winner == side else min(5, losses[side] + 1)
    return {"map": header.get("map_name"), "rounds": rounds}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", required=True)
    ap.add_argument("demos", nargs="+")
    a = ap.parse_args()
    matches = [export(Path(d)) for d in a.demos]
    with open(a.out, "w") as f:
        f.write("{\n")
        f.write('  "source": "Seven pro matches (one per map in the pool), read with scripts/export-buy-rounds.py. Per player: [money and equipment at the start of freeze time, money and equipment one second into the live round, main weapon: r rifle, s SMG or shotgun, p pistol].",\n')
        f.write('  "matches": [\n')
        for i, m in enumerate(matches):
            f.write('    {"map": ' + json.dumps(m["map"]) + ', "rounds": [\n')
            for j, r in enumerate(m["rounds"]):
                f.write("      " + json.dumps(r, separators=(",", ":")) + ("," if j < len(m["rounds"]) - 1 else "") + "\n")
            f.write("    ]}" + ("," if i < len(matches) - 1 else "") + "\n")
        f.write("  ]\n}\n")
    print(f"{a.out}: {sum(len(m['rounds']) for m in matches)} rounds from {len(matches)} demos")


if __name__ == "__main__":
    main()
