"""Grenade projectile reconstruction and type resolution.

Findings on the 2023 test corpus (builds 13914–14000) that shaped this module:

* ``parse_grenades`` returns both thrown projectiles (classes ending in ``Projectile``) and held
  inventory weapons (``CFlashbang``, ``CHEGrenade``, ``CSmokeGrenade`` …). Held-weapon rows carry no
  position (x is null on 100 % of rows) and are excluded; QA reports how many rows were dropped and
  whether any of them had a position.
* Entity indices are reused across throws, so samples are split into segments on tick gaps, class
  changes and owner changes.
* Older builds share ``CBaseCSGrenadeProjectile`` between HE and flashbang and ``CMolotovProjectile``
  between molotov and incendiary. Resolution uses (in order of strength) detonate events linked by
  entity id, the ``m_bIsIncGrenade`` entity property, the damage/radius entity-property signature,
  and tick-matched ``weapon_fire`` weapon names. Without narrowing evidence the type stays
  ``unknown`` and ``candidate_types`` lists the possibilities — nothing is guessed.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import polars as pl

GRENADE_TYPES: tuple[str, ...] = ("he", "flashbang", "smoke", "molotov", "incendiary", "decoy")
FIRE_TYPES = ("molotov", "incendiary")

#: Which grenade types a projectile entity class may represent.
CLASS_CANDIDATES: dict[str, tuple[str, ...]] = {
    "CHEGrenadeProjectile": ("he",),
    "CFlashbangProjectile": ("flashbang",),
    "CSmokeGrenadeProjectile": ("smoke",),
    "CDecoyProjectile": ("decoy",),
    "CMolotovProjectile": FIRE_TYPES,
    "CIncendiaryGrenadeProjectile": ("incendiary",),
    "CBaseCSGrenadeProjectile": ("he", "flashbang"),
}

#: Inventory (held) grenade weapon entities — not thrown projectiles.
HELD_WEAPON_CLASSES = frozenset(
    {"CHEGrenade", "CFlashbang", "CSmokeGrenade", "CMolotovGrenade", "CIncendiaryGrenade", "CDecoyGrenade"}
)

#: Activation events that carry the projectile entity id.
ENTITY_ACTIVATION_EVENTS: dict[str, str] = {
    "hegrenade_detonate": "he",
    "flashbang_detonate": "flashbang",
    "smokegrenade_detonate": "smoke",
    "decoy_started": "decoy",
}

#: End-of-effect events keyed by the activation event they follow (same entity id).
ENTITY_EXPIRE_EVENTS: dict[str, str] = {
    "smokegrenade_detonate": "smokegrenade_expired",
    "decoy_started": "decoy_detonate",
}

WEAPON_TO_TYPE: dict[str, str] = {
    "weapon_hegrenade": "he",
    "weapon_flashbang": "flashbang",
    "weapon_smokegrenade": "smoke",
    "weapon_molotov": "molotov",
    "weapon_incgrenade": "incendiary",
    "weapon_decoy": "decoy",
}

#: (m_DmgRadius, m_flDamage) → type for the shared HE/flash class. Observed on builds 13914–13926;
#: every segment that also had a detonate event agreed (115/115 on the Inferno demo). The QA report
#: re-checks agreement on each extracted demo (``type_crosscheck``).
DAMAGE_SIGNATURES: dict[tuple[float, float], str] = {(350.0, 99.0): "he", (100.0, 100.0): "flashbang"}

STRONG = 0.9


@dataclass(frozen=True)
class Evidence:
    type: str
    source: str
    confidence: float


@dataclass(frozen=True)
class Resolution:
    type: str
    confidence: float
    evidence: str
    candidates: tuple[str, ...]


def candidates_for_class(raw_class: str) -> tuple[str, ...]:
    return CLASS_CANDIDATES.get(raw_class, GRENADE_TYPES)


def resolve_type(
    raw_class: str,
    *,
    event_type: str | None = None,
    event_source: str | None = None,
    is_inc_grenade: bool | None = None,
    dmg_radius: float | None = None,
    damage: float | None = None,
    weapon_fire_type: str | None = None,
) -> Resolution:
    """Resolve a projectile's grenade type from all available evidence (pure function).

    Strong evidence (≥ 0.9) must agree; a disagreeing weak signal is recorded and lowers confidence.
    Any disagreement between strong signals — or between weak signals with no strong one — yields
    ``unknown``.
    """
    candidates = candidates_for_class(raw_class)
    ev: list[Evidence] = []
    if raw_class in CLASS_CANDIDATES and len(candidates) == 1:
        ev.append(Evidence(candidates[0], f"class:{raw_class}", 0.95))
    if event_type is not None:
        ev.append(Evidence(event_type, event_source or "event", 0.99))
    if is_inc_grenade is not None and set(FIRE_TYPES) <= set(candidates):
        ev.append(Evidence("incendiary" if is_inc_grenade else "molotov", "entity_prop:m_bIsIncGrenade", 0.95))
    if dmg_radius is not None and damage is not None and set(candidates) == {"he", "flashbang"}:
        sig = DAMAGE_SIGNATURES.get((round(float(dmg_radius), 1), round(float(damage), 1)))
        if sig is not None:
            ev.append(Evidence(sig, f"entity_prop:dmg_radius={dmg_radius:g},damage={damage:g}", 0.9))
    if weapon_fire_type is not None:
        ev.append(Evidence(weapon_fire_type, "event:weapon_fire(tick_match)", 0.8))

    if not ev:
        return Resolution("unknown", 0.0, f"class:{raw_class} ambiguous; no narrowing evidence", candidates)

    outside = [e for e in ev if e.type not in candidates]
    strong = [e for e in ev if e.confidence >= STRONG and e.type in candidates]
    weak = [e for e in ev if e.confidence < STRONG and e.type in candidates]
    described = "; ".join(f"{e.source}->{e.type}" for e in ev)
    if outside and any(e.confidence >= STRONG for e in outside):
        return Resolution("unknown", 0.0, f"conflict with class {raw_class}: {described}", candidates)
    strong_types = {e.type for e in strong}
    if len(strong_types) > 1:
        return Resolution("unknown", 0.0, f"conflict: {described}", candidates)
    if strong_types:
        chosen = next(iter(strong_types))
        agreeing = [e for e in ev if e.type == chosen]
        conf = 1.0 - math.prod(1.0 - e.confidence for e in agreeing)
        disagreeing_weak = [e for e in weak + outside if e.type != chosen]
        if disagreeing_weak:
            conf -= 0.1
            described += " (weak signal disagreed; ignored)"
        return Resolution(chosen, round(min(conf, 0.999), 3), described, candidates)
    weak_types = {e.type for e in weak}
    if len(weak_types) == 1 and not outside:
        chosen = next(iter(weak_types))
        return Resolution(chosen, round(max(e.confidence for e in weak), 3), described, candidates)
    return Resolution("unknown", 0.0, f"conflict: {described}", candidates)


# --------------------------------------------------------------------------------------------
# Segmentation
# --------------------------------------------------------------------------------------------


@dataclass
class SegmentationStats:
    total_rows: int = 0
    projectile_rows: int = 0
    held_weapon_rows: int = 0
    held_weapon_rows_with_position: int = 0
    other_rows: int = 0
    classes: dict[str, int] = field(default_factory=dict)


def segment_projectiles(samples: pl.DataFrame, max_gap_ticks: int = 16) -> tuple[pl.DataFrame, SegmentationStats]:
    """Split projectile samples into per-throw segments; returns samples with ``grenade_id``."""
    stats = SegmentationStats(total_rows=samples.height)
    if samples.height:
        vc = samples.group_by("raw_class").len().sort("raw_class")
        stats.classes = {str(r["raw_class"]): int(r["len"]) for r in vc.to_dicts()}
    is_proj = pl.col("raw_class").str.ends_with("Projectile")
    held = samples.filter(pl.col("raw_class").is_in(list(HELD_WEAPON_CLASSES)))
    stats.held_weapon_rows = held.height
    stats.held_weapon_rows_with_position = held.filter(pl.col("x").is_not_null() & pl.col("x").is_not_nan()).height
    proj = samples.filter(is_proj)
    stats.projectile_rows = proj.height
    stats.other_rows = samples.height - proj.height - held.height
    if proj.height == 0:
        return proj.with_columns(pl.lit(None, dtype=pl.Utf8).alias("grenade_id")), stats
    proj = proj.sort(["entity_id", "tick"])
    new_seg = (
        (pl.col("entity_id") != pl.col("entity_id").shift(1))
        | ((pl.col("tick") - pl.col("tick").shift(1)) > max_gap_ticks)
        | (pl.col("raw_class") != pl.col("raw_class").shift(1))
        | (pl.col("owner_id").fill_null("") != pl.col("owner_id").shift(1).fill_null(""))
    ).fill_null(True)
    proj = proj.with_columns(new_seg.cum_sum().alias("_seg"))
    first_tick = pl.col("tick").min().over("_seg")
    proj = proj.with_columns(
        pl.format("g{}_{}", pl.col("entity_id"), first_tick).alias("grenade_id")
    ).drop("_seg")
    return proj, stats


def summarize_segments(proj: pl.DataFrame) -> list[dict[str, Any]]:
    """One dict per segment with first/last sample and aggregated entity properties."""
    if proj.height == 0:
        return []
    agg = (
        proj.sort("tick")
        .group_by("grenade_id", maintain_order=True)
        .agg(
            pl.col("entity_id").first(),
            pl.col("raw_class").first(),
            pl.col("owner_id").drop_nulls().first().alias("owner_id"),
            pl.col("tick").min().alias("t0"),
            pl.col("tick").max().alias("t1"),
            pl.len().alias("n_samples"),
            pl.col("x").drop_nulls().first().alias("x0"),
            pl.col("y").drop_nulls().first().alias("y0"),
            pl.col("z").drop_nulls().first().alias("z0"),
            pl.col("x").drop_nulls().last().alias("x1"),
            pl.col("y").drop_nulls().last().alias("y1"),
            pl.col("z").drop_nulls().last().alias("z1"),
            pl.col("x").is_null().sum().alias("n_missing_position"),
            pl.col("is_inc_grenade").drop_nulls().unique().alias("is_inc_values"),
            pl.col("dmg_radius").max().alias("dmg_radius"),
            pl.col("damage").max().alias("damage"),
            pl.col("bounces").max().alias("bounces_max"),
        )
        .sort("t0")
    )
    out = agg.to_dicts()
    for seg in out:
        vals = seg.pop("is_inc_values") or []
        seg["is_inc_grenade"] = vals[0] if len(vals) == 1 else None
        seg["is_inc_conflict"] = len(vals) > 1
    return out


# --------------------------------------------------------------------------------------------
# Event linking
# --------------------------------------------------------------------------------------------


def _rows(df: pl.DataFrame | None) -> list[dict[str, Any]]:
    return [] if df is None or df.height == 0 else df.sort("tick").to_dicts()


def link_entity_events(
    segments: Sequence[dict[str, Any]], events: pl.DataFrame | None, *, slack_after: int = 8
) -> dict[str, dict[str, Any]]:
    """Link events carrying ``entityid`` to the segment of that entity alive at the event tick.

    Returns ``grenade_id → first matching event row``. Each event links at most one segment.
    """
    by_entity: dict[int, list[dict[str, Any]]] = {}
    for seg in segments:
        by_entity.setdefault(int(seg["entity_id"]), []).append(seg)
    links: dict[str, dict[str, Any]] = {}
    for ev in _rows(events):
        if ev.get("entityid") is None:
            continue
        cands = [s for s in by_entity.get(int(ev["entityid"]), []) if s["t0"] <= ev["tick"] <= s["t1"] + slack_after]
        if not cands:
            continue
        seg = max(cands, key=lambda s: s["t0"])
        links.setdefault(seg["grenade_id"], ev)
    return links


def link_expire_events(
    activations: dict[str, dict[str, Any]],
    segments_by_id: dict[str, dict[str, Any]],
    events: pl.DataFrame | None,
    *,
    max_after_ticks: int,
) -> dict[str, dict[str, Any]]:
    """Link an end-of-effect event (same entity id) occurring after the activation."""
    rows = _rows(events)
    out: dict[str, dict[str, Any]] = {}
    used: set[int] = set()
    for gid, act in sorted(activations.items(), key=lambda kv: kv[1]["tick"]):
        eid = int(segments_by_id[gid]["entity_id"])
        for i, ev in enumerate(rows):
            if i in used or ev.get("entityid") is None or int(ev["entityid"]) != eid:
                continue
            if act["tick"] < ev["tick"] <= act["tick"] + max_after_ticks:
                out[gid] = ev
                used.add(i)
                break
    return out


def link_infernos(
    segments: Sequence[dict[str, Any]],
    startburn: pl.DataFrame | None,
    *,
    before_ticks: int = 16,
    after_ticks: int = 4,
    max_dist: float = 128.0,
) -> dict[str, dict[str, Any]]:
    """Link ``inferno_startburn`` (which carries the *inferno* entity id, not the projectile's) to a
    fire-family projectile ending just before it at the same place. One-to-one, nearest first."""
    fire = [s for s in segments if set(candidates_for_class(s["raw_class"])) & set(FIRE_TYPES)]
    pairs: list[tuple[float, int, str]] = []
    rows = _rows(startburn)
    for i, ev in enumerate(rows):
        for s in fire:
            if not (ev["tick"] - before_ticks <= s["t1"] <= ev["tick"] + after_ticks):
                continue
            if s["x1"] is None or s["y1"] is None or ev.get("x") is None or ev.get("y") is None:
                continue
            d = math.hypot(float(ev["x"]) - float(s["x1"]), float(ev["y"]) - float(s["y1"]))
            if d <= max_dist:
                pairs.append((d, i, s["grenade_id"]))
    links: dict[str, dict[str, Any]] = {}
    used_ev: set[int] = set()
    for _d, i, gid in sorted(pairs):
        if i in used_ev or gid in links:
            continue
        links[gid] = rows[i]
        used_ev.add(i)
    return links


def link_weapon_fire(
    segments: Sequence[dict[str, Any]],
    weapon_fire: pl.DataFrame | None,
    *,
    window_ticks: int = 24,
) -> tuple[dict[str, dict[str, Any]], int]:
    """Match grenade ``weapon_fire`` events to projectiles first seen 0..window ticks later.

    Returns ``(links, ambiguous_count)``. A link is only made when exactly one compatible event
    (type within the class candidates; same owner when both owners are known) is unclaimed in the
    window, or when all compatible events in the window name the same weapon type.
    """
    rows = [r for r in _rows(weapon_fire) if r.get("weapon") in WEAPON_TO_TYPE]
    links: dict[str, dict[str, Any]] = {}
    used: set[int] = set()
    ambiguous = 0
    for seg in sorted(segments, key=lambda s: s["t0"]):
        cands = candidates_for_class(seg["raw_class"])
        compat: list[tuple[int, dict[str, Any]]] = []
        for i, r in enumerate(rows):
            if i in used or not (seg["t0"] - window_ticks <= r["tick"] <= seg["t0"]):
                continue
            if WEAPON_TO_TYPE[r["weapon"]] not in cands:
                continue
            owner = r.get("user_steamid")
            if owner is not None and seg.get("owner_id") is not None and owner != seg["owner_id"]:
                continue
            compat.append((i, r))
        if not compat:
            continue
        types = {WEAPON_TO_TYPE[r["weapon"]] for _, r in compat}
        if len(types) > 1:
            ambiguous += 1
            continue
        i, r = max(compat, key=lambda ir: ir[1]["tick"])  # closest preceding throw
        used.add(i)
        links[seg["grenade_id"]] = r
    return links, ambiguous


def decimate_indices(n: int, max_points: int) -> list[int]:
    """Evenly spaced indices including first and last."""
    if n <= max_points:
        return list(range(n))
    step = (n - 1) / (max_points - 1)
    return sorted({round(i * step) for i in range(max_points)})
