"""``extract``: demo → committed per-demo Parquet dataset (atomic, idempotent by content hash)."""

from __future__ import annotations

import re
import time
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl

from mf_common import DATASET_SCHEMA_VERSION, errors
from mf_common.datasets import MANIFEST
from mf_common.emit import Emitter
from mf_common.fsutil import (
    CommitConflict,
    commit_directory,
    dir_size,
    read_json,
    sha256_file,
    staging_directory,
    utc_now,
    write_json_atomic,
)
from mf_common.runtime import peak_rss_mb
from mf_common.tables import WrittenTable, write_table

from .adapter import GRENADE_EXTRA_FIELDS, TICK_FIELDS, ParsedDemo, ParserAdapter, get_adapter, sniff_format
from .events import EXTRACTED_EVENTS, KEY_EVENTS, identity_coverage, normalize_events
from .grenade_table import build_grenade_tables
from .identity import counter_attributions, fill_event_identity, identity_crosscheck
from .rounds import assign_round_index, build_rounds, frame_state
from .sampling import add_motion, derive_timing, grid_frame_ticks, select_samples, window_frame_ticks

MAP_NAME_RE = re.compile(r"^[a-z0-9_]{1,64}$")

#: Columns kept in the sampled ``ticks`` table.
TICKS_COLUMNS: tuple[str, ...] = (
    "tick",
    "round_index",
    "player_id",
    "team_num",
    "is_alive",
    "health",
    "armor",
    "x",
    "y",
    "z",
    "vx",
    "vy",
    "vz",
    "pitch",
    "yaw",
    "place",
    "active_weapon",
    "flash_duration",
    "balance",
    "in_grid",
    "in_event_window",
    "sampling_policy",
    "dt",
    "frame_dt",
)

TICKS_CASTS: dict[str, pl.DataType] = {
    "tick": pl.Int32(),
    "round_index": pl.Int16(),
    "team_num": pl.Int8(),
    "health": pl.Int16(),
    "armor": pl.Int16(),
    "balance": pl.Int32(),
}


@dataclass(frozen=True)
class ExtractSettings:
    sample_hz: float = 16.0
    event_window_s: float = 2.0
    grenade_gap_ticks: int = 16
    trajectory_points: int = 48


def dataset_dir_for(root: Path, map_name: str, build: str, sha256: str) -> Path:
    return root / f"map={map_name}" / f"build={build}" / f"demo={sha256[:16]}"


def _check_existing(final: Path, sha256: str) -> dict[str, Any] | None:
    """Return the committed manifest if ``final`` holds this exact source; raise on conflicts."""
    if not final.exists():
        return None
    mpath = final / MANIFEST
    if mpath.exists():
        manifest = read_json(mpath)
        if manifest.get("status") == "COMMITTED" and manifest.get("source", {}).get("sha256") == sha256:
            return manifest
    raise errors.MfError(
        errors.DATASET_CONFLICT,
        f"{final} exists but is not a committed dataset of this source",
        path=str(final),
    )


def _guard(stage: str, fn: Any, *args: Any) -> Any:
    """Run a parser call; any parser exception (including Rust panics) becomes PARSER_FAILED."""
    try:
        return fn(*args)
    except (KeyboardInterrupt, SystemExit):
        raise
    except errors.MfError:
        raise
    except BaseException as exc:  # pyo3 PanicException derives from BaseException
        raise errors.MfError(errors.PARSER_FAILED, f"parser failed during {stage}: {exc!r}"[:500], stage=stage) from exc


def compatibility_notes(
    event_names: list[str],
    raw_classes: dict[str, int] | None,
    identity: dict[str, dict[str, float | int]] | None,
    missing_fields: list[str],
    discarded_float_steamids: dict[str, int],
) -> list[dict[str, Any]]:
    """Human/engine readable compatibility findings for a demo."""
    notes: list[dict[str, Any]] = []
    present = set(event_names)
    for capability, names in KEY_EVENTS.items():
        missing = [n for n in names if n not in present]
        if missing:
            notes.append({"code": "missing_events", "capability": capability, "events": missing})
    if raw_classes:
        if "CBaseCSGrenadeProjectile" in raw_classes:
            notes.append(
                {
                    "code": "ambiguous_grenade_class",
                    "class": "CBaseCSGrenadeProjectile",
                    "candidates": ["he", "flashbang"],
                    "resolution": "detonate events by entityid, m_DmgRadius/m_flDamage signature, weapon_fire tick match",
                }
            )
        if "CMolotovProjectile" in raw_classes:
            notes.append(
                {
                    "code": "ambiguous_grenade_class",
                    "class": "CMolotovProjectile",
                    "candidates": ["molotov", "incendiary"],
                    "resolution": "m_bIsIncGrenade entity property, weapon_fire tick match",
                }
            )
        held = sorted(c for c in raw_classes if not c.endswith("Projectile"))
        if held:
            notes.append({"code": "held_weapon_entities_in_grenade_stream", "classes": held, "handling": "excluded"})
    if identity:
        for ev, cov in identity.items():
            if float(cov.get("user_from_event", 1.0)) < 0.5:
                notes.append(
                    {
                        "code": "event_player_identity_missing",
                        "event": ev,
                        "user_from_event": cov.get("user_from_event"),
                        "handling": (
                            "recovered from scoreboard counter deltas where unambiguous"
                            if ev in ("player_death", "player_hurt")
                            else "not recoverable from counters; ids left null"
                        ),
                    }
                )
    if missing_fields:
        notes.append({"code": "missing_fields", "fields": sorted(set(missing_fields))})
    if discarded_float_steamids:
        notes.append({"code": "float_steamids_discarded", "columns": discarded_float_steamids})
    return notes


def run_extraction(
    demo: ParsedDemo,
    settings: ExtractSettings,
    emitter: Emitter,
) -> tuple[dict[str, pl.DataFrame], dict[str, Any], dict[str, Any]]:
    """Parse + transform everything in memory. Returns ``(tables, qa, timing)``."""
    t0 = time.monotonic()
    event_names = _guard("event_list", demo.event_names)
    emitter.progress("parse_ticks", 0.1)
    ticks_full = _guard("ticks", demo.ticks, list(TICK_FIELDS))
    if ticks_full.height == 0:
        raise errors.MfError(errors.EMPTY_PARSE, "parser returned no player frames; refusing to commit an empty match")
    # Some demos (client POV recordings) yield several parser rows for one (player, tick): keep the
    # last state of the tick and count what was dropped.
    n_raw_rows = ticks_full.height
    ticks_full = ticks_full.unique(subset=["player_id", "tick"], keep="last", maintain_order=True).sort(["tick", "player_id"])
    duplicate_rows_dropped = n_raw_rows - ticks_full.height
    timing = derive_timing(ticks_full)
    emitter.progress("parse_events", 0.3)
    parsed = _guard("events", demo.events, [e for e in EXTRACTED_EVENTS if e in set(event_names)])
    emitter.progress("parse_grenades", 0.45)
    raw_grenades = _guard("grenades", demo.grenades, list(GRENADE_EXTRA_FIELDS))
    t_parse = time.monotonic() - t0

    emitter.progress("rounds", 0.55)
    frames = frame_state(ticks_full)
    rounds = build_rounds(frames, timing.tick_rate, parsed.get("round_end"), parsed.get("round_freeze_end"))
    if rounds.height == 0:
        raise errors.MfError(errors.EMPTY_PARSE, "no round structure could be reconstructed")

    emitter.progress("identity", 0.6)
    attributions = counter_attributions(ticks_full)
    events = normalize_events(parsed)
    coverage_before = identity_coverage(events)
    frame_ticks = np.sort(ticks_full["tick"].unique().to_numpy())
    crosscheck = identity_crosscheck(events, attributions, frame_ticks)
    events, fill_stats = fill_event_identity(events, attributions, frame_ticks)
    coverage_after = identity_coverage(events)
    events = assign_round_index(events, rounds)
    attributions = assign_round_index(attributions, rounds)

    emitter.progress("grenades", 0.7)
    team_lookup = ticks_full.select("tick", "player_id", "team_num")
    grenades, grenade_samples, grenade_qa = build_grenade_tables(
        raw_grenades,
        parsed,
        team_lookup,
        max_gap_ticks=settings.grenade_gap_ticks,
        trajectory_points=settings.trajectory_points,
    )
    grenades = assign_round_index(grenades, rounds, tick_col="first_seen_tick")

    emitter.progress("sampling", 0.8)
    anchors: list[int] = events.filter(pl.col("event_type") == "player_death")["tick"].to_list()
    if grenades.height:
        anchors += grenades["throw_tick"].drop_nulls().to_list() + grenades["activation_tick"].drop_nulls().to_list()
    grid = grid_frame_ticks(frame_ticks, timing.tick_rate, settings.sample_hz)
    windows = window_frame_ticks(frame_ticks, np.array(anchors, dtype=np.int64), settings.event_window_s * timing.tick_rate)
    with_motion = add_motion(ticks_full, timing.tick_rate)
    sampled = select_samples(with_motion, grid, windows, timing.tick_rate, settings.sample_hz)
    sampled = assign_round_index(sampled, rounds)
    ticks_table = sampled.select(list(TICKS_COLUMNS)).cast(TICKS_CASTS)  # type: ignore[arg-type]

    players = (
        assign_round_index(ticks_full.select("tick", "player_id", "steamid", "team_num"), rounds)
        .group_by(["round_index", "player_id"], maintain_order=True)
        .agg(
            pl.col("steamid").drop_nulls().first(),
            pl.col("team_num").drop_nulls().mode().first().alias("team_num"),
            pl.col("team_num").drop_nulls().n_unique().alias("team_values"),
            pl.col("tick").min().alias("first_tick"),
            pl.col("tick").max().alias("last_tick"),
            pl.len().alias("frames"),
        )
        .with_columns(
            pl.col("player_id").str.starts_with("bot:").alias("is_bot"),
            pl.col("team_num").replace_strict({2: "T", 3: "CT"}, default=None, return_dtype=pl.Utf8).alias("side"),
        )
        .sort(["round_index", "team_num", "player_id"])
    )
    team_scores = (
        ticks_full.filter(pl.col("team_num").is_in([2, 3]) & pl.col("team_rounds_total").is_not_null())
        .group_by(["tick", "team_num"])
        .agg(pl.col("team_rounds_total").max().alias("score"))
        .sort(["team_num", "tick"])
        .filter((pl.col("score") != pl.col("score").shift(1).over("team_num")).fill_null(True))
        .sort(["tick", "team_num"])
    )
    tables = {
        "rounds": rounds,
        "team_scores": team_scores,
        "players": players,
        "ticks": ticks_table,
        "events": events,
        "attributions": attributions,
        "grenades": grenades,
        "grenade_samples": grenade_samples,
    }

    alive = ticks_full.filter(pl.col("is_alive").fill_null(False))
    field_coverage = {}
    for f in TICK_FIELDS:
        if f in alive.columns and alive.height:
            col = alive[f]
            ok = col.is_not_null()
            if col.dtype in (pl.Float32, pl.Float64):
                ok = ok & col.is_not_nan()
            if col.dtype == pl.Utf8:
                ok = ok & (col != "")
            field_coverage[f] = round(float(ok.sum()) / alive.height, 4)
    notes = demo.notes
    qa = {
        "timing": asdict(timing),
        "event_names": event_names,
        "event_counts": {k: int(v.height) for k, v in sorted(parsed.items())},
        "identity_coverage_parser": coverage_before,
        "identity_coverage_after_recovery": coverage_after,
        "identity_recovery": fill_stats,
        "identity_crosscheck": crosscheck,
        "attributions": {
            f"{k}:{s}": int(n)
            for (k, s), n in Counter(zip(attributions["kind"].to_list(), attributions["status"].to_list(), strict=True)).items()
        },
        "alive_field_coverage": field_coverage,
        "players_distinct": int(ticks_full["player_id"].n_unique()),
        "rounds": {
            "attempts": rounds.height,
            "with_result": int(rounds["end_tick"].is_not_null().sum()),
            "warmup": int(rounds["is_warmup"].sum()),
            "flags": dict(Counter(f for fl in rounds["flags"].to_list() for f in fl)),
        },
        "sampling": {
            "parser_player_rows": n_raw_rows,
            "duplicate_player_tick_rows_dropped": duplicate_rows_dropped,
            "full_rate_player_rows": ticks_full.height,
            "sampled_rows": ticks_table.height,
            "grid_frames": int(grid.size),
            "window_frames": int(windows.size),
            "anchors": len(anchors),
        },
        "grenades": grenade_qa,
        "adapter_notes": asdict(notes),
        "compatibility_notes": compatibility_notes(
            event_names,
            grenade_qa.get("raw_classes"),
            coverage_before,
            notes.missing_tick_fields + notes.missing_grenade_fields,
            notes.discarded_float_steamids,
        ),
    }
    timing_info = {"parse_s": round(t_parse, 3), "transform_s": round(time.monotonic() - t0 - t_parse, 3)}
    return tables, qa, timing_info


def extract_demo(
    input_path: Path,
    dataset_root: Path,
    emitter: Emitter,
    settings: ExtractSettings | None = None,
    adapter: ParserAdapter | None = None,
) -> dict[str, Any]:
    settings = settings or ExtractSettings()
    t_start = time.monotonic()
    input_path = Path(input_path)
    if not input_path.is_file():
        raise errors.MfError(errors.INPUT_NOT_FOUND, f"input not found: {input_path}", path=str(input_path))
    size = input_path.stat().st_size
    if size == 0:
        raise errors.MfError(errors.INPUT_UNREADABLE, "input file is empty", path=str(input_path))
    fmt = sniff_format(input_path)
    if fmt != "cs2":
        raise errors.MfError(errors.UNSUPPORTED_FORMAT, f"not a CS2 demo (detected: {fmt})", detected=fmt)
    emitter.progress("hashing", 0.0, bytes=size)
    sha = sha256_file(input_path)
    adapter = adapter or get_adapter()
    demo = _guard("open", adapter.open, input_path)
    header = _guard("header", demo.header)
    map_name = header.map_name.strip().lower()
    if not MAP_NAME_RE.match(map_name):
        raise errors.MfError(errors.PARSER_FAILED, "demo header has no usable map name", map_name=header.map_name[:80])
    build = header.build if header.build and header.build.isdigit() else "unknown"
    dataset_root = Path(dataset_root)
    final = dataset_dir_for(dataset_root, map_name, build, sha)
    existing = _check_existing(final, sha)
    if existing is not None:
        return {
            "status": "duplicate",
            "dataset": str(final),
            "dataset_id": existing.get("dataset_id"),
            "sha256": sha,
            "map": map_name,
            "build": build,
            "wall_s": round(time.monotonic() - t_start, 3),
        }

    with staging_directory(dataset_root, sha[:16]) as staging:
        tables, qa, timing_info = run_extraction(demo, settings, emitter)
        emitter.progress("write", 0.9)
        written: dict[str, WrittenTable] = {name: write_table(df, staging, name) for name, df in tables.items()}
        write_json_atomic(staging / "qa.json", qa)
        dataset_id = f"{map_name}-{build}-{sha[:16]}"
        manifest = {
            "status": "COMMITTED",
            "schema_version": DATASET_SCHEMA_VERSION,
            "dataset_id": dataset_id,
            "created_at": utc_now(),
            "source": {
                "sha256": sha,
                "size_bytes": size,
                "path_given": str(input_path),
                "file_name": input_path.name,
                "format": fmt,
            },
            "map": map_name,
            "build": build,
            "header": {
                "map_name": header.map_name,
                "patch_version": header.build,
                "server_name": header.server_name,
                "demo_version_name": header.demo_version_name,
                "recorded_by_sourcetv": header.recorded_by_sourcetv,
            },
            "parser": {"name": adapter.name, "version": adapter.version},
            "extraction": asdict(settings),
            "timing": qa["timing"],
            "files": {name: w.as_manifest_entry() for name, w in written.items()},
            "qa_file": "qa.json",
        }
        write_json_atomic(staging / MANIFEST, manifest)
        staging_peak = dir_size(staging)
        try:
            commit_directory(staging, final)
        except CommitConflict:
            existing = _check_existing(final, sha)  # a concurrent run committed the same source
            return {
                "status": "duplicate",
                "dataset": str(final),
                "dataset_id": existing.get("dataset_id") if existing else None,
                "sha256": sha,
                "map": map_name,
                "build": build,
                "wall_s": round(time.monotonic() - t_start, 3),
            }
    wall = time.monotonic() - t_start
    return {
        "status": "committed",
        "dataset": str(final),
        "dataset_id": dataset_id,
        "sha256": sha,
        "size_bytes": size,
        "map": map_name,
        "build": build,
        "tick_rate": qa["timing"]["tick_rate"],
        "recorded_frame_hz": qa["timing"]["recorded_frame_hz"],
        "rows": {name: w.rows for name, w in written.items()},
        "bytes": {name: w.bytes for name, w in written.items()},
        "output_bytes": sum(w.bytes for w in written.values()),
        "staging_peak_bytes": staging_peak,
        "wall_s": round(wall, 3),
        "parse_s": timing_info["parse_s"],
        "transform_s": timing_info["transform_s"],
        "throughput_mb_s": round(size / 1e6 / wall, 3) if wall > 0 else None,
        "peak_rss_mb": peak_rss_mb(),
        "compatibility_notes": qa["compatibility_notes"],
    }
