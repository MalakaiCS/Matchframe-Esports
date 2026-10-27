"""Assemble the ``grenades`` and ``grenade_samples`` tables from raw entity samples + events."""

from __future__ import annotations

from collections import Counter
from typing import Any

import polars as pl

from mf_common.frames import asof_backward

from .grenades import (
    ENTITY_ACTIVATION_EVENTS,
    ENTITY_EXPIRE_EVENTS,
    FIRE_TYPES,
    WEAPON_TO_TYPE,
    candidates_for_class,
    decimate_indices,
    link_entity_events,
    link_expire_events,
    link_infernos,
    link_weapon_fire,
    resolve_type,
    segment_projectiles,
    summarize_segments,
)

GRENADES_SCHEMA: dict[str, pl.DataType] = {
    "grenade_id": pl.Utf8(),
    "entity_id": pl.Int64(),
    "raw_class": pl.Utf8(),
    "type": pl.Utf8(),
    "type_confidence": pl.Float64(),
    "type_evidence": pl.Utf8(),
    "candidate_types": pl.List(pl.Utf8()),
    "owner_id": pl.Utf8(),
    "owner_evidence": pl.Utf8(),
    "team_num": pl.Int64(),
    "first_seen_tick": pl.Int64(),
    "throw_tick": pl.Int64(),
    "throw_tick_evidence": pl.Utf8(),
    "throw_x": pl.Float64(),
    "throw_y": pl.Float64(),
    "throw_z": pl.Float64(),
    "activation_tick": pl.Int64(),
    "activation_x": pl.Float64(),
    "activation_y": pl.Float64(),
    "activation_z": pl.Float64(),
    "activation_event": pl.Utf8(),
    "activation_evidence": pl.Utf8(),
    "expire_tick": pl.Int64(),
    "expire_event": pl.Utf8(),
    "last_seen_tick": pl.Int64(),
    "last_x": pl.Float64(),
    "last_y": pl.Float64(),
    "last_z": pl.Float64(),
    "n_samples": pl.Int64(),
    "bounces_max": pl.Int64(),
    "affected_count": pl.Int64(),
    "affected_ids": pl.List(pl.Utf8()),
    "affected_damage_hp": pl.Int64(),
    "affected_blind_s": pl.Float64(),
    "affected_evidence": pl.Utf8(),
    "traj_tick": pl.List(pl.Int64()),
    "traj_x": pl.List(pl.Float32()),
    "traj_y": pl.List(pl.Float32()),
    "traj_z": pl.List(pl.Float32()),
}

SAMPLES_SCHEMA: dict[str, pl.DataType] = {
    "grenade_id": pl.Utf8(),
    "tick": pl.Int64(),
    "x": pl.Float32(),
    "y": pl.Float32(),
    "z": pl.Float32(),
    "bounces": pl.Int64(),
}


def build_grenade_tables(
    raw: pl.DataFrame,
    events: dict[str, pl.DataFrame],
    team_lookup: pl.DataFrame,
    *,
    max_gap_ticks: int,
    trajectory_points: int,
) -> tuple[pl.DataFrame, pl.DataFrame, dict[str, Any]]:
    """Return ``(grenades, grenade_samples, qa)``.

    ``team_lookup`` has ``tick, player_id, team_num`` (full-rate) for owner team at throw time.
    """
    proj, seg_stats = segment_projectiles(raw, max_gap_ticks=max_gap_ticks)
    segments = summarize_segments(proj)
    by_id = {s["grenade_id"]: s for s in segments}

    activation: dict[str, tuple[str, dict[str, Any]]] = {}
    for ev_name in ENTITY_ACTIVATION_EVENTS:
        for gid, ev in link_entity_events(segments, events.get(ev_name)).items():
            activation.setdefault(gid, (ev_name, ev))
    inferno_links = link_infernos([s for s in segments if s["grenade_id"] not in activation], events.get("inferno_startburn"))
    for gid, ev in inferno_links.items():
        activation.setdefault(gid, ("inferno_startburn", ev))
    wf_links, wf_ambiguous = link_weapon_fire(segments, events.get("weapon_fire"))

    expire: dict[str, tuple[str, dict[str, Any]]] = {}
    for act_name, exp_name in ENTITY_EXPIRE_EVENTS.items():
        acts = {gid: ev for gid, (n, ev) in activation.items() if n == act_name}
        for gid, ev in link_expire_events(acts, by_id, events.get(exp_name), max_after_ticks=64 * 40).items():
            expire[gid] = (exp_name, ev)
    # inferno_expire carries the inferno entity id from inferno_startburn
    inf_exp = events.get("inferno_expire")
    if inf_exp is not None and inf_exp.height:
        exp_rows = inf_exp.sort("tick").to_dicts()
        used: set[int] = set()
        for gid, (n, ev) in sorted(activation.items(), key=lambda kv: kv[1][1]["tick"]):
            if n != "inferno_startburn" or ev.get("entityid") is None:
                continue
            for i, row in enumerate(exp_rows):
                if i in used or row.get("entityid") != ev["entityid"]:
                    continue
                if ev["tick"] < row["tick"] <= ev["tick"] + 64 * 30:
                    expire[gid] = ("inferno_expire", row)
                    used.add(i)
                    break

    has_entity_events = any(events.get(n) is not None and events[n].height > 0 for n in ENTITY_ACTIVATION_EVENTS)
    blind = events.get("player_blind")
    hurt = events.get("player_hurt")
    blind_rows = [] if blind is None or blind.height == 0 else blind.to_dicts()
    he_hurt_rows = [] if hurt is None or hurt.height == 0 else hurt.filter(pl.col("weapon") == "hegrenade").to_dicts()

    rows: list[dict[str, Any]] = []
    crosscheck: Counter[str] = Counter()
    for seg in segments:
        gid = seg["grenade_id"]
        act = activation.get(gid)
        act_type = None
        act_source = None
        if act is not None and act[0] in ENTITY_ACTIVATION_EVENTS:
            act_type = ENTITY_ACTIVATION_EVENTS[act[0]]
            act_source = f"event:{act[0]}(entityid)"
        wf = wf_links.get(gid)
        wf_type = WEAPON_TO_TYPE.get(wf["weapon"]) if wf is not None else None
        res = resolve_type(
            seg["raw_class"],
            event_type=act_type,
            event_source=act_source,
            is_inc_grenade=seg["is_inc_grenade"],
            dmg_radius=seg["dmg_radius"],
            damage=seg["damage"],
            weapon_fire_type=wf_type,
        )
        # cross-check of entity-prop evidence against event evidence where both exist
        if act_type is not None and seg["dmg_radius"] is not None and set(candidates_for_class(seg["raw_class"])) == {"he", "flashbang"}:
            prop_only = resolve_type(seg["raw_class"], dmg_radius=seg["dmg_radius"], damage=seg["damage"])
            crosscheck["prop_vs_event_agree" if prop_only.type == act_type else "prop_vs_event_disagree"] += 1
        if wf_type is not None and res.type in FIRE_TYPES and seg["is_inc_grenade"] is not None:
            crosscheck["weapon_fire_vs_isinc_agree" if wf_type == res.type else "weapon_fire_vs_isinc_disagree"] += 1

        act_tick = act_x = act_y = act_z = None
        act_event = act_evidence = None
        if act is not None:
            ev = act[1]
            act_tick, act_x, act_y, act_z = ev["tick"], ev.get("x"), ev.get("y"), ev.get("z")
            act_event = act[0]
            act_evidence = "event_entityid" if act[0] in ENTITY_ACTIVATION_EVENTS else "event_time_position"
        elif not has_entity_events and res.type in ("he", "flashbang"):
            # No lifecycle events in this demo: HE/flash projectiles vanish within one frame of detonation.
            act_tick, act_x, act_y, act_z = seg["t1"], seg["x1"], seg["y1"], seg["z1"]
            act_event, act_evidence = None, "derived:projectile_entity_end(±1 frame)"
        exp = expire.get(gid)
        throw_tick, throw_ev = (wf["tick"], "event:weapon_fire") if wf is not None else (seg["t0"], "projectile_first_seen")

        affected_count = affected_hp = None
        affected_ids: list[str] | None = None
        affected_blind = None
        affected_evidence = "not_attributed"
        if res.type == "flashbang" and act_tick is not None and act_evidence == "event_entityid" and blind is not None:
            hits = [b for b in blind_rows if b.get("entityid") == seg["entity_id"] and abs(b["tick"] - act_tick) <= 2]
            affected_count = len(hits)
            affected_ids = sorted({b["user_steamid"] for b in hits if b.get("user_steamid")})
            affected_blind = round(sum(float(b.get("blind_duration") or 0.0) for b in hits), 4)
            affected_evidence = "event:player_blind(entityid)"
        elif res.type == "he" and act_tick is not None and act_evidence == "event_entityid" and hurt is not None:
            same_tick_he = [g for g, (n, e) in activation.items() if n == "hegrenade_detonate" and abs(e["tick"] - act_tick) <= 1]
            if len(same_tick_he) == 1:
                hits = [h for h in he_hurt_rows if abs(h["tick"] - act_tick) <= 1]
                affected_count = len(hits)
                affected_ids = sorted({h["user_steamid"] for h in hits if h.get("user_steamid")})
                affected_hp = int(sum(int(h.get("dmg_health") or 0) for h in hits))
                affected_evidence = "event:player_hurt(weapon=hegrenade,same_tick_unique_detonation)"
            else:
                affected_evidence = "ambiguous:simultaneous_he_detonations"
        rows.append(
            {
                "grenade_id": gid,
                "entity_id": seg["entity_id"],
                "raw_class": seg["raw_class"],
                "type": res.type,
                "type_confidence": res.confidence,
                "type_evidence": res.evidence,
                "candidate_types": list(res.candidates),
                "owner_id": seg["owner_id"],
                "owner_evidence": "entity_thrower" if seg["owner_id"] is not None else None,
                "team_num": None,
                "first_seen_tick": seg["t0"],
                "throw_tick": throw_tick,
                "throw_tick_evidence": throw_ev,
                "throw_x": seg["x0"],
                "throw_y": seg["y0"],
                "throw_z": seg["z0"],
                "activation_tick": act_tick,
                "activation_x": act_x,
                "activation_y": act_y,
                "activation_z": act_z,
                "activation_event": act_event,
                "activation_evidence": act_evidence,
                "expire_tick": exp[1]["tick"] if exp else None,
                "expire_event": exp[0] if exp else None,
                "last_seen_tick": seg["t1"],
                "last_x": seg["x1"],
                "last_y": seg["y1"],
                "last_z": seg["z1"],
                "n_samples": seg["n_samples"],
                "bounces_max": int(seg["bounces_max"]) if seg["bounces_max"] is not None else None,
                "affected_count": affected_count,
                "affected_ids": affected_ids,
                "affected_damage_hp": affected_hp,
                "affected_blind_s": affected_blind,
                "affected_evidence": affected_evidence,
            }
        )

    # trajectories
    traj: dict[str, dict[str, list[Any]]] = {}
    samples = pl.DataFrame(schema=SAMPLES_SCHEMA)
    if proj.height:
        samples = proj.select(
            "grenade_id",
            "tick",
            pl.col("x").cast(pl.Float32),
            pl.col("y").cast(pl.Float32),
            pl.col("z").cast(pl.Float32),
            pl.col("bounces").cast(pl.Int64, strict=False),
        ).sort(["grenade_id", "tick"])
        for gid, part in samples.group_by("grenade_id", maintain_order=True):
            key = gid[0] if isinstance(gid, tuple) else gid
            n = part.height
            idx = decimate_indices(n, trajectory_points)
            sub = part[idx]
            traj[str(key)] = {
                "traj_tick": sub["tick"].to_list(),
                "traj_x": sub["x"].to_list(),
                "traj_y": sub["y"].to_list(),
                "traj_z": sub["z"].to_list(),
            }
    for row in rows:
        row.update(traj.get(row["grenade_id"], {"traj_tick": [], "traj_x": [], "traj_y": [], "traj_z": []}))

    grenades = pl.DataFrame(rows, schema=GRENADES_SCHEMA) if rows else pl.DataFrame(schema=GRENADES_SCHEMA)
    if grenades.height and team_lookup.height:
        lookup = team_lookup.select(
            pl.col("player_id").alias("owner_id"), pl.col("tick").alias("first_seen_tick"), pl.col("team_num").alias("_team")
        ).sort("first_seen_tick")
        joined = asof_backward(grenades, lookup, on="first_seen_tick", by="owner_id")
        grenades = joined.with_columns(pl.col("_team").cast(pl.Int64).alias("team_num")).drop("_team")

    type_counts = Counter(r["type"] for r in rows)
    evidence_counts: Counter[str] = Counter()
    for r in rows:
        for part in r["type_evidence"].split("; "):
            evidence_counts[part.split("->")[0].split("(")[0].split("=")[0]] += 1
    qa = {
        "raw_rows": seg_stats.total_rows,
        "raw_classes": seg_stats.classes,
        "projectile_rows": seg_stats.projectile_rows,
        "held_weapon_rows_excluded": seg_stats.held_weapon_rows,
        "held_weapon_rows_with_position": seg_stats.held_weapon_rows_with_position,
        "other_rows_excluded": seg_stats.other_rows,
        "projectiles": len(rows),
        "by_raw_class": dict(Counter(r["raw_class"] for r in rows)),
        "by_type": dict(type_counts),
        "unknown_by_raw_class": dict(Counter(r["raw_class"] for r in rows if r["type"] == "unknown")),
        "evidence_sources": dict(evidence_counts),
        "activation_linked": sum(1 for r in rows if r["activation_evidence"] in ("event_entityid", "event_time_position")),
        "activation_derived": sum(1 for r in rows if (r["activation_evidence"] or "").startswith("derived")),
        "expire_linked": sum(1 for r in rows if r["expire_tick"] is not None),
        "weapon_fire_linked": len(wf_links),
        "weapon_fire_ambiguous": wf_ambiguous,
        "type_crosscheck": dict(crosscheck),
        "is_inc_conflicts": sum(1 for s in segments if s["is_inc_conflict"]),
    }
    return grenades, samples, qa
