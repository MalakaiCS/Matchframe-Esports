"""Grenade type resolution, segmentation and event linking on small synthetic frames."""

from __future__ import annotations

import polars as pl

from mf_demo_parser.grenades import (
    link_entity_events,
    link_infernos,
    link_weapon_fire,
    resolve_type,
    segment_projectiles,
    summarize_segments,
)


def test_single_type_classes_resolve_from_class_name() -> None:
    r = resolve_type("CHEGrenadeProjectile")
    assert r.type == "he" and r.confidence >= 0.95
    assert resolve_type("CFlashbangProjectile").type == "flashbang"
    assert resolve_type("CSmokeGrenadeProjectile").type == "smoke"
    assert resolve_type("CDecoyProjectile").type == "decoy"


def test_shared_he_flash_class_needs_evidence() -> None:
    r = resolve_type("CBaseCSGrenadeProjectile")
    assert r.type == "unknown" and set(r.candidates) == {"he", "flashbang"}
    assert resolve_type("CBaseCSGrenadeProjectile", event_type="flashbang", event_source="event:flashbang_detonate").type == "flashbang"
    assert resolve_type("CBaseCSGrenadeProjectile", dmg_radius=350.0, damage=99.0).type == "he"
    assert resolve_type("CBaseCSGrenadeProjectile", dmg_radius=100.0, damage=100.0).type == "flashbang"
    # unrecognised signature narrows nothing
    assert resolve_type("CBaseCSGrenadeProjectile", dmg_radius=123.0, damage=1.0).type == "unknown"


def test_fire_class_uses_inc_property_then_weapon_fire() -> None:
    assert resolve_type("CMolotovProjectile").type == "unknown"
    assert resolve_type("CMolotovProjectile", is_inc_grenade=True).type == "incendiary"
    assert resolve_type("CMolotovProjectile", is_inc_grenade=False).type == "molotov"
    weak = resolve_type("CMolotovProjectile", weapon_fire_type="incendiary")
    assert weak.type == "incendiary" and weak.confidence == 0.8


def test_conflicts_never_guess() -> None:
    # two strong signals disagree
    r = resolve_type("CBaseCSGrenadeProjectile", event_type="he", event_source="event:hegrenade_detonate", dmg_radius=100.0, damage=100.0)
    assert r.type == "unknown" and "conflict" in r.evidence
    # event contradicts the class family
    r2 = resolve_type("CSmokeGrenadeProjectile", event_type="he", event_source="event:hegrenade_detonate")
    assert r2.type == "unknown"
    # weak signal disagreeing with strong evidence is recorded, strong wins with reduced confidence
    r3 = resolve_type("CMolotovProjectile", is_inc_grenade=True, weapon_fire_type="molotov")
    assert r3.type == "incendiary" and r3.confidence < 0.95 and "disagreed" in r3.evidence


def _samples(rows: list[tuple[str, int, int, float | None, str | None]]) -> pl.DataFrame:
    return pl.DataFrame(
        {
            "raw_class": [r[0] for r in rows],
            "entity_id": [r[1] for r in rows],
            "tick": [r[2] for r in rows],
            "x": [r[3] for r in rows],
            "y": [0.0 if r[3] is not None else None for r in rows],
            "z": [0.0 if r[3] is not None else None for r in rows],
            "owner_id": [r[4] for r in rows],
            "is_inc_grenade": [None] * len(rows),
            "dmg_radius": [None] * len(rows),
            "damage": [None] * len(rows),
            "bounces": [None] * len(rows),
        },
        schema_overrides={"is_inc_grenade": pl.Boolean, "dmg_radius": pl.Float64, "damage": pl.Float64, "bounces": pl.Float64},
    )


def test_entity_reuse_is_split_and_held_weapons_dropped() -> None:
    rows = [("CSmokeGrenadeProjectile", 7, t, float(t), "1") for t in range(100, 130, 3)]
    rows += [("CSmokeGrenadeProjectile", 7, t, float(t), "2") for t in range(5000, 5030, 3)]  # reused id, new owner
    rows += [("CFlashbang", 9, t, None, "1") for t in range(0, 30, 3)]
    proj, stats = segment_projectiles(_samples(rows))
    segs = summarize_segments(proj)
    assert len(segs) == 2
    assert {s["owner_id"] for s in segs} == {"1", "2"}
    assert stats.held_weapon_rows == 10 and stats.held_weapon_rows_with_position == 0


def test_entity_event_links_respect_time_window() -> None:
    rows = [("CBaseCSGrenadeProjectile", 5, t, 1.0, "1") for t in range(100, 205, 3)]
    rows += [("CBaseCSGrenadeProjectile", 5, t, 1.0, "1") for t in range(9000, 9105, 3)]
    proj, _ = segment_projectiles(_samples(rows))
    segs = summarize_segments(proj)
    ev = pl.DataFrame({"tick": [9105], "entityid": [5]})
    links = link_entity_events(segs, ev)
    assert list(links) == [segs[1]["grenade_id"]]


def test_inferno_link_by_time_and_place() -> None:
    rows = [("CMolotovProjectile", 11, t, float(t), "1") for t in range(1000, 1090, 3)]
    rows += [("CMolotovProjectile", 12, t, 5000.0, "2") for t in range(1000, 1090, 3)]
    proj, _ = segment_projectiles(_samples(rows))
    segs = summarize_segments(proj)
    startburn = pl.DataFrame({"tick": [1090], "entityid": [400], "x": [1087.0 + 5], "y": [0.0], "z": [0.0]})
    links = link_infernos(segs, startburn)
    assert len(links) == 1
    gid = next(iter(links))
    assert next(s for s in segs if s["grenade_id"] == gid)["entity_id"] == 11


def test_weapon_fire_ambiguity_yields_no_link() -> None:
    rows = [("CMolotovProjectile", 11, t, 1.0, None) for t in range(1000, 1060, 3)]
    proj, _ = segment_projectiles(_samples(rows))
    segs = summarize_segments(proj)
    wf = pl.DataFrame(
        {"tick": [994, 995], "weapon": ["weapon_molotov", "weapon_incgrenade"], "user_steamid": [None, None]},
        schema_overrides={"user_steamid": pl.Utf8},
    )
    links, amb = link_weapon_fire(segs, wf)
    assert links == {} and amb == 1
    wf2 = pl.DataFrame({"tick": [994], "weapon": ["weapon_incgrenade"], "user_steamid": [None]}, schema_overrides={"user_steamid": pl.Utf8})
    links2, amb2 = link_weapon_fire(segs, wf2)
    assert len(links2) == 1 and amb2 == 0
