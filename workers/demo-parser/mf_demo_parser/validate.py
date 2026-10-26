"""``validate`` / ``verify``: dataset checks (spec §15.5).

``validate`` runs every check and writes ``validation.json`` (verdict ``usable`` | ``quarantine``).
Unusual but legitimate content (restarts, warm-up, partial demos, long rounds) produces *flags*;
only integrity failures, implausible structure or insufficient coverage quarantine a dataset.
``verify`` is the cheap re-check the engine runs before any raw-demo retention action.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import duckdb
import polars as pl
import pyarrow.parquet as pq

from mf_common import DATASET_SCHEMA_VERSION
from mf_common.datasets import FEATURES_MANIFEST, MANIFEST, VALIDATION
from mf_common.emit import Emitter
from mf_common.fsutil import read_json, sha256_file, utc_now, write_json_atomic

WORLD_LIMIT = 16384.0
REQUIRED_TABLES = ("rounds", "players", "ticks", "events", "grenades")

#: (field, minimum alive-row coverage for pass, minimum before the check fails).
COVERAGE_THRESHOLDS: tuple[tuple[str, float, float], ...] = (
    ("x", 0.99, 0.95),
    ("y", 0.99, 0.95),
    ("z", 0.99, 0.95),
    ("health", 0.99, 0.95),
    ("team_num", 0.99, 0.95),
    ("pitch", 0.98, 0.90),
    ("yaw", 0.98, 0.90),
    ("place", 0.95, 0.80),
    ("active_weapon", 0.95, 0.50),
)


@dataclass
class Check:
    name: str
    status: str  # pass | warn | fail | skip
    severity: str  # critical | major | minor
    message: str
    details: dict[str, Any] = field(default_factory=dict)


def _sql_path(p: Path) -> str:
    return str(p).replace("'", "''")


def check_manifest(path: Path) -> tuple[Check, dict[str, Any] | None]:
    mpath = path / MANIFEST
    if not mpath.exists():
        return Check("manifest", "fail", "critical", "manifest.json missing"), None
    try:
        manifest = read_json(mpath)
    except (OSError, ValueError) as exc:
        return Check("manifest", "fail", "critical", f"manifest unreadable: {exc}"), None
    problems = []
    if manifest.get("status") != "COMMITTED":
        problems.append(f"status={manifest.get('status')}")
    if manifest.get("schema_version") != DATASET_SCHEMA_VERSION:
        problems.append(f"schema_version={manifest.get('schema_version')}")
    for key in ("source", "map", "build", "parser", "files", "timing"):
        if key not in manifest:
            problems.append(f"missing {key}")
    missing_tables = [t for t in REQUIRED_TABLES if t not in manifest.get("files", {})]
    if missing_tables:
        problems.append(f"missing tables {missing_tables}")
    if problems:
        return Check("manifest", "fail", "critical", "; ".join(problems)), manifest
    return Check("manifest", "pass", "critical", "committed manifest present"), manifest


def check_checksums(path: Path, manifest: dict[str, Any]) -> Check:
    mismatches: list[dict[str, Any]] = []
    for name, entry in manifest.get("files", {}).items():
        fpath = path / entry["file"]
        if not fpath.exists():
            mismatches.append({"table": name, "problem": "missing"})
            continue
        digest = sha256_file(fpath)
        if digest != entry["sha256"]:
            mismatches.append({"table": name, "problem": "sha256", "expected": entry["sha256"], "actual": digest})
            continue
        try:
            rows = int(pq.read_metadata(fpath).num_rows)
        except Exception as exc:  # noqa: BLE001
            mismatches.append({"table": name, "problem": f"metadata unreadable: {exc!r}"[:200]})
            continue
        if rows != entry["rows"]:
            mismatches.append({"table": name, "problem": "rows", "expected": entry["rows"], "actual": rows})
    if mismatches:
        return Check("checksums", "fail", "critical", f"{len(mismatches)} file(s) do not match the manifest", {"mismatches": mismatches})
    return Check("checksums", "pass", "critical", f"{len(manifest.get('files', {}))} files match sha256 and row counts")


def check_readable(path: Path, manifest: dict[str, Any]) -> tuple[Check, dict[str, pl.DataFrame]]:
    tables: dict[str, pl.DataFrame] = {}
    errors_: dict[str, str] = {}
    for name, entry in manifest.get("files", {}).items():
        try:
            tables[name] = pl.read_parquet(path / entry["file"])
        except Exception as exc:  # noqa: BLE001
            errors_[name] = repr(exc)[:200]
    if errors_:
        return Check("parquet_readable", "fail", "critical", "unreadable tables", {"errors": errors_}), tables
    return Check("parquet_readable", "pass", "critical", f"{len(tables)} tables readable"), tables


def check_nonempty(t: dict[str, pl.DataFrame]) -> Check:
    ticks = t.get("ticks")
    rounds = t.get("rounds")
    events = t.get("events")
    problems = []
    if ticks is None or ticks.height == 0:
        problems.append("no tick rows")
    if rounds is None or rounds.filter(pl.col("end_tick").is_not_null()).height == 0:
        problems.append("no round with a result")
    kills = 0 if events is None else events.filter(pl.col("event_type") == "player_death").height
    if kills == 0:
        problems.append("no player_death events")
    if problems:
        return Check("nonempty_parse", "fail", "critical", "parser output is empty or degenerate: " + "; ".join(problems))
    return Check("nonempty_parse", "pass", "critical", f"{ticks.height} tick rows, {kills} deaths")  # type: ignore[union-attr]


def check_expected_map(path: Path, manifest: dict[str, Any], t: dict[str, pl.DataFrame], expected: str | None) -> Check:
    m = manifest.get("map")
    header_map = str(manifest.get("header", {}).get("map_name", "")).lower()
    problems = []
    if header_map and header_map != m:
        problems.append(f"header map {header_map!r} != manifest map {m!r}")
    if f"map={m}" not in str(path):
        problems.append("dataset path does not carry the manifest map")
    if expected is not None and expected != m:
        problems.append(f"expected {expected!r}, dataset is {m!r}")
    ticks = t.get("ticks")
    place_frac = None
    if ticks is not None and ticks.height:
        alive = ticks.filter(pl.col("is_alive").fill_null(False))
        if alive.height:
            place_frac = float((alive["place"].fill_null("") != "").sum()) / alive.height
            if place_frac < 0.5:
                problems.append(f"only {place_frac:.2f} of alive samples carry a place name (map/navmesh mismatch?)")
    if problems:
        return Check("expected_map", "fail", "critical", "; ".join(problems), {"map": m, "place_fraction": place_frac})
    return Check("expected_map", "pass", "critical", f"map {m}", {"map": m, "place_fraction": place_frac})


def check_round_structure(t: dict[str, pl.DataFrame]) -> tuple[Check, list[str]]:
    rounds = t["rounds"]
    flags: list[str] = []
    live = rounds.filter(~pl.col("is_warmup"))
    with_result = live.filter(pl.col("end_tick").is_not_null())
    n = with_result.height
    problems = []
    if n == 0:
        problems.append("no non-warm-up round with a result")
    if n > 60:
        problems.append(f"{n} rounds with results (> 60 is implausible)")
    order_bad = 0
    for r in rounds.to_dicts():
        ticks = [r["start_tick"], r["freeze_end_tick"], r["end_tick"], r["official_end_tick"]]
        seq = [x for x in ticks if x is not None]
        if any(b < a for a, b in zip(seq, seq[1:], strict=False)):
            order_bad += 1
        for f in r["flags"]:
            flags.append(f"round {r['round_index']}: {f}")
    if order_bad:
        problems.append(f"{order_bad} round(s) with non-monotonic start/freeze-end/end ticks")
    starts = rounds["start_tick"].to_list()
    if any(b <= a for a, b in zip(starts, starts[1:], strict=False)):
        problems.append("round start ticks are not strictly increasing")
    numbers = [x for x in with_result["round_number"].to_list() if x is not None]
    if numbers and numbers[0] > 1:
        flags.append(f"demo starts mid-match (first round number {numbers[0]})")
    no_result_mid = live.filter(pl.col("end_tick").is_null() & ~pl.col("flags").list.contains("trailing_segment")).height
    details = {"rounds_with_result": n, "attempts": rounds.height, "no_result_non_trailing": no_result_mid}
    if problems:
        return Check("round_structure", "fail", "major", "; ".join(problems), details), flags
    status = "warn" if no_result_mid > 2 else "pass"
    return Check("round_structure", status, "major", f"{n} rounds with results", details), flags


def check_identity(t: dict[str, pl.DataFrame]) -> Check:
    ticks = t["ticks"]
    players = t["players"]
    problems = []
    warns = []
    null_ids = int(ticks["player_id"].is_null().sum())
    if null_ids:
        problems.append(f"{null_ids} tick rows without player_id")
    sid = players["steamid"].drop_nulls()
    bad_sid = int((~sid.str.contains(r"^\d{1,20}$")).sum())
    if bad_sid:
        problems.append(f"{bad_sid} steamids are not decimal strings")
    bad_pid = int((~players["player_id"].str.contains(r"^(\d{1,20}|bot:[0-9a-f]{10})$")).sum())
    if bad_pid:
        problems.append(f"{bad_pid} malformed player ids")
    multi = players.group_by("player_id").agg(pl.col("steamid").drop_nulls().n_unique().alias("n")).filter(pl.col("n") > 1).height
    if multi:
        problems.append(f"{multi} player ids map to several steamids")
    distinct = players["player_id"].n_unique()
    if distinct > 40:
        problems.append(f"{distinct} distinct players (> 40)")
    on_team = players.filter(pl.col("team_num").is_in([2, 3]))
    per_team = on_team.group_by(["round_index", "team_num"]).len()
    max_team = int(per_team["len"].max() or 0) if per_team.height else 0
    if max_team > 12:
        problems.append(f"up to {max_team} players on one team in a round")
    switchers = players.filter(pl.col("team_values") > 1).height
    frac_switch = switchers / max(players.height, 1)
    if frac_switch > 0.05:
        warns.append(f"{switchers} player-rounds with team changes inside the round")
    details = {"distinct_players": distinct, "max_players_per_team_round": max_team, "team_change_player_rounds": switchers}
    if problems:
        return Check("identity_continuity", "fail", "major", "; ".join(problems), details)
    if warns:
        return Check("identity_continuity", "warn", "major", "; ".join(warns), details)
    return Check("identity_continuity", "pass", "major", f"{distinct} stable player ids", details)


def check_ordering(t: dict[str, pl.DataFrame], manifest: dict[str, Any]) -> Check:
    ticks = t["ticks"]
    problems = []
    dup = ticks.height - ticks.select("player_id", "tick").unique().height
    if dup:
        problems.append(f"{dup} duplicate (player, tick) rows")
    tk = ticks["tick"]
    if tk.len() > 1 and not bool((tk.diff().drop_nulls() >= 0).all()):
        problems.append("ticks table not ordered by tick")
    first = int(manifest["timing"]["first_tick"])
    last = int(manifest["timing"]["last_tick"])
    ev = t["events"]
    out_of_range = ev.filter((pl.col("tick") < first - 64) | (pl.col("tick") > last + 64)).height
    if out_of_range:
        problems.append(f"{out_of_range} events outside the demo tick range")
    g = t["grenades"]
    bad_g = 0
    if g.height:
        bad_g = g.filter(
            (pl.col("throw_tick") > pl.col("first_seen_tick"))
            | (pl.col("activation_tick").is_not_null() & (pl.col("activation_tick") < pl.col("throw_tick")))
            | (pl.col("expire_tick").is_not_null() & (pl.col("expire_tick") < pl.col("activation_tick")))
        ).height
        if bad_g:
            problems.append(f"{bad_g} grenades with throw/activation/expire out of order")
    neg_dt = int((ticks["dt"].drop_nulls() <= 0).sum())
    if neg_dt:
        problems.append(f"{neg_dt} non-positive dt values")
    if problems:
        return Check("timestamp_ordering", "fail", "major", "; ".join(problems))
    return Check("timestamp_ordering", "pass", "major", "ticks, events, rounds and grenade lifecycles ordered")


def check_bounds(t: dict[str, pl.DataFrame]) -> Check:
    alive = t["ticks"].filter(pl.col("is_alive").fill_null(False))
    if alive.height == 0:
        return Check("map_bounds", "fail", "major", "no alive samples")
    outside = alive.filter(
        (pl.col("x").abs() > WORLD_LIMIT) | (pl.col("y").abs() > WORLD_LIMIT) | (pl.col("z").abs() > WORLD_LIMIT)
    ).height
    pos = alive.filter(pl.col("x").is_not_null() & pl.col("y").is_not_null() & pl.col("z").is_not_null())
    outliers = 0
    box: dict[str, list[float]] = {}
    for axis in ("x", "y", "z"):
        lo = float(pos[axis].quantile(0.005) or 0.0)
        hi = float(pos[axis].quantile(0.995) or 0.0)
        box[axis] = [round(lo, 1), round(hi, 1)]
        outliers += pos.filter((pl.col(axis) < lo - 1500) | (pl.col(axis) > hi + 1500)).height
    frac_out = outliers / max(pos.height, 1)
    details = {"world_limit_violations": outside, "robust_box": box, "outlier_fraction": round(frac_out, 6)}
    if outside / alive.height > 0.001:
        return Check("map_bounds", "fail", "major", f"{outside} alive samples beyond world limits", details)
    if frac_out > 0.005:
        return Check("map_bounds", "warn", "major", f"{frac_out:.4f} of samples far outside the robust map box", details)
    return Check("map_bounds", "pass", "major", "positions within world limits and robust map box", details)


def check_reconciliation(t: dict[str, pl.DataFrame], tick_rate: float) -> Check:
    rounds = t["rounds"].filter(pl.col("end_tick").is_not_null() & pl.col("winner_team_num").is_in([2, 3]))
    scores = t.get("team_scores")
    if scores is None or scores.height == 0 or rounds.height == 0:
        return Check("round_result_reconciliation", "skip", "minor", "no team score data or no results")
    srows = scores.sort("tick").to_dicts()
    window = int(tick_rate * 2)
    reconciled = 0
    compared = 0
    mismatched: list[int] = []
    for r in rounds.to_dicts():
        team = int(r["winner_team_num"])
        end = int(r["end_tick"])
        before = [s["score"] for s in srows if s["team_num"] == team and s["tick"] < end - 3]
        after = [s["score"] for s in srows if s["team_num"] == team and s["tick"] <= end + window]
        if not after:
            continue
        compared += 1
        b = before[-1] if before else 0
        if after[-1] == b + 1:
            reconciled += 1
        else:
            mismatched.append(int(r["round_index"]))
    if compared == 0:
        return Check("round_result_reconciliation", "skip", "minor", "no comparable rounds")
    frac = reconciled / compared
    details = {"compared": compared, "reconciled": reconciled, "mismatched_round_indexes": mismatched[:20]}
    if frac >= 0.9:
        return Check("round_result_reconciliation", "pass", "major", f"{reconciled}/{compared} winners match score increments", details)
    if frac >= 0.6:
        return Check("round_result_reconciliation", "warn", "major", f"only {reconciled}/{compared} winners reconcile", details)
    return Check("round_result_reconciliation", "fail", "major", f"only {reconciled}/{compared} winners reconcile", details)


def check_coverage(t: dict[str, pl.DataFrame]) -> Check:
    alive = t["ticks"].filter(pl.col("is_alive").fill_null(False))
    cov: dict[str, float] = {}
    fails: list[str] = []
    warns: list[str] = []
    for f, good, minimum in COVERAGE_THRESHOLDS:
        col = alive[f]
        ok = col.is_not_null()
        if col.dtype in (pl.Float32, pl.Float64):
            ok = ok & col.is_not_nan()
        if col.dtype == pl.Utf8:
            ok = ok & (col != "")
        c = float(ok.sum()) / max(alive.height, 1)
        cov[f] = round(c, 4)
        if c < minimum:
            fails.append(f"{f} coverage {c:.3f} < {minimum}")
        elif c < good:
            warns.append(f"{f} coverage {c:.3f} < {good}")
    ev = t["events"]
    deaths = ev.filter(pl.col("event_type") == "player_death")
    if deaths.height:
        victim_known = float(deaths["user_id"].is_not_null().sum()) / deaths.height
        cov["death_victim_known"] = round(victim_known, 4)
        if victim_known < 0.8:
            warns.append(f"death victim identity known for {victim_known:.2f}")
    if fails:
        return Check("field_coverage", "fail", "major", "; ".join(fails + warns), {"coverage": cov})
    if warns:
        return Check("field_coverage", "warn", "major", "; ".join(warns), {"coverage": cov})
    return Check("field_coverage", "pass", "major", "required fields above thresholds", {"coverage": cov})


def check_causal_features(path: Path) -> Check:
    fm_path = path / FEATURES_MANIFEST
    if not fm_path.exists():
        return Check("causal_features", "skip", "major", "no features built")
    fm = read_json(fm_path)
    problems = []
    for name, entry in fm.get("files", {}).items():
        fpath = path / entry["file"]
        if not fpath.exists() or sha256_file(fpath) != entry["sha256"]:
            problems.append(f"{name} checksum mismatch")
    if problems:
        return Check("causal_features", "fail", "major", "; ".join(problems))
    feats = pl.read_parquet(path / "features.parquet")
    labels = pl.read_parquet(path / "labels.parquet")
    future = feats.filter(pl.col("max_input_tick") > pl.col("tick")).height
    if future:
        problems.append(f"{future} feature rows use inputs after their sample tick")
    keys = set(fm.get("key_columns", []))
    overlap = (set(feats.columns) & set(labels.columns)) - keys
    if overlap:
        problems.append(f"label columns present in features: {sorted(overlap)}")
    leak = fm.get("leakage_check", {})
    if not leak.get("passed", False):
        problems.append("recorded leakage check did not pass")
    if problems:
        return Check("causal_features", "fail", "major", "; ".join(problems))
    return Check("causal_features", "pass", "major", f"{feats.height} feature rows causal; labels separate", {"leakage_check": leak})


def check_queries(path: Path, t: dict[str, pl.DataFrame]) -> Check:
    rounds = t["rounds"].filter(~pl.col("is_warmup") & pl.col("end_tick").is_not_null()).sort("round_index")
    if rounds.height == 0:
        return Check("duckdb_queries", "fail", "major", "no rounds to query")
    idx = rounds["round_index"].to_list()
    picks = {"opening": idx[0], "middle": idx[len(idx) // 2], "closing": idx[-1]}
    out: dict[str, Any] = {}
    con = duckdb.connect()
    try:
        ticks_p = _sql_path(path / "ticks.parquet")
        events_p = _sql_path(path / "events.parquet")
        for label, ri in picks.items():
            n_ticks, n_players = con.execute(
                f"SELECT count(*), count(DISTINCT player_id) FROM read_parquet('{ticks_p}') WHERE round_index = ?", [ri]
            ).fetchone()  # type: ignore[misc]
            n_deaths = con.execute(
                f"SELECT count(*) FROM read_parquet('{events_p}') WHERE round_index = ? AND event_type = 'player_death'", [ri]
            ).fetchone()[0]  # type: ignore[index]
            out[label] = {"round_index": ri, "tick_rows": int(n_ticks), "players": int(n_players), "deaths": int(n_deaths)}
    except duckdb.Error as exc:
        return Check("duckdb_queries", "fail", "major", f"query failed: {exc}"[:300])
    finally:
        con.close()
    empty = [k for k, v in out.items() if v["tick_rows"] == 0]
    if empty:
        return Check("duckdb_queries", "fail", "major", f"no tick rows for {empty} rounds", out)
    return Check("duckdb_queries", "pass", "major", "opening/middle/closing rounds queryable", out)


def validate_dataset(path: Path, emitter: Emitter, expected_map: str | None = None, write: bool = True) -> dict[str, Any]:
    path = Path(path)
    checks: list[Check] = []
    flags: list[str] = []
    mcheck, manifest = check_manifest(path)
    checks.append(mcheck)
    if manifest is not None and mcheck.status == "pass":
        emitter.progress("checksums", 0.1)
        checks.append(check_checksums(path, manifest))
        rcheck, tables = check_readable(path, manifest)
        checks.append(rcheck)
        if rcheck.status == "pass":
            emitter.progress("content", 0.4)
            checks.append(check_nonempty(tables))
            checks.append(check_expected_map(path, manifest, tables, expected_map))
            rs, rflags = check_round_structure(tables)
            checks.append(rs)
            flags.extend(rflags)
            checks.append(check_identity(tables))
            checks.append(check_ordering(tables, manifest))
            checks.append(check_bounds(tables))
            checks.append(check_reconciliation(tables, float(manifest["timing"]["tick_rate"])))
            checks.append(check_coverage(tables))
            checks.append(check_causal_features(path))
            emitter.progress("queries", 0.9)
            checks.append(check_queries(path, tables))
    failing = [c for c in checks if c.status == "fail" and c.severity in ("critical", "major")]
    verdict = "quarantine" if failing or manifest is None else "usable"
    flags.extend(f"{c.name}: {c.message}" for c in checks if c.status == "warn")
    result = {
        "dataset": str(path),
        "dataset_id": manifest.get("dataset_id") if manifest else None,
        "verdict": verdict,
        "reasons": [f"{c.name}: {c.message}" for c in failing],
        "flags": flags,
        "checks": [asdict(c) for c in checks],
        "validated_at": utc_now(),
    }
    if write and manifest is not None and path.exists():
        write_json_atomic(path / VALIDATION, result)
    return result


def verify_dataset(path: Path, emitter: Emitter) -> dict[str, Any]:
    """Checksums + a sample DuckDB query; used before raw-demo retention actions."""
    path = Path(path)
    mcheck, manifest = check_manifest(path)
    checks = [mcheck]
    if manifest is not None and mcheck.status == "pass":
        checks.append(check_checksums(path, manifest))
        con = duckdb.connect()
        try:
            n = con.execute(f"SELECT count(*), count(DISTINCT round_index) FROM read_parquet('{_sql_path(path / 'ticks.parquet')}')").fetchone()
            checks.append(Check("sample_query", "pass" if n and n[0] > 0 else "fail", "critical", f"ticks rows={n[0] if n else 0}", {"rows": n[0] if n else 0, "rounds": n[1] if n else 0}))
        except duckdb.Error as exc:
            checks.append(Check("sample_query", "fail", "critical", f"query failed: {exc}"[:300]))
        finally:
            con.close()
    ok = all(c.status == "pass" for c in checks)
    return {
        "dataset": str(path),
        "dataset_id": manifest.get("dataset_id") if manifest else None,
        "source_sha256": manifest.get("source", {}).get("sha256") if manifest else None,
        "ok": ok,
        "checks": [asdict(c) for c in checks],
        "verified_at": utc_now(),
    }
