"""``freeze-dataset`` and ``audit-split`` (spec acceptance A43).

* The split unit is a complete match (one demo). Byte-identical demos are de-duplicated by
  sha256; *related* demos (same map and ≥ 60 % overlapping non-bot player sets — e.g. a POV and
  a SourceTV recording of one match) are grouped and always share a split.
* Time-based holdout: demo headers carry no match date, so the game build number is used as a
  coarse time proxy — the newest-build groups become the final test set, the next newest
  validation, the rest training.
* ``audit-split`` fails if any dataset id, sha256 or group appears in more than one split, if the
  manifest content hash does not match, or if recomputed relations cross splits.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import polars as pl

from mf_common import errors
from mf_common.datasets import DatasetRef, discover, require_usable
from mf_common.emit import Emitter
from mf_common.fsutil import canonical_json, read_json, sha256_bytes, utc_now, write_json_atomic

SPLITS = ("train", "val", "test")
RELATED_JACCARD = 0.6


def player_set(ref: DatasetRef) -> set[str]:
    p = pl.read_parquet(ref.path / "players.parquet", columns=["player_id", "team_num"])
    return {pid for pid, team in p.iter_rows() if team in (2, 3) and not str(pid).startswith("bot:")}


def related_groups(refs: list[DatasetRef], players: dict[str, set[str]] | None = None) -> dict[str, str]:
    """Union-find over datasets: same map and player-set Jaccard ≥ RELATED_JACCARD."""
    players = players or {r.dataset_id: player_set(r) for r in refs}
    parent = {r.dataset_id: r.dataset_id for r in refs}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i, a in enumerate(refs):
        for b in refs[i + 1 :]:
            if a.map_name != b.map_name:
                continue
            pa, pb = players[a.dataset_id], players[b.dataset_id]
            if pa and pb and len(pa & pb) / len(pa | pb) >= RELATED_JACCARD:
                parent[find(a.dataset_id)] = find(b.dataset_id)
    members: dict[str, list[str]] = {}
    for r in refs:
        members.setdefault(find(r.dataset_id), []).append(r.sha256)
    gid_of_root = {root: "g-" + sha256_bytes(",".join(sorted(shas)).encode())[:12] for root, shas in members.items()}
    return {r.dataset_id: gid_of_root[find(r.dataset_id)] for r in refs}


def assign_splits(group_builds: dict[str, int], val_fraction: float, test_fraction: float, seed: int = 0) -> dict[str, str]:
    """Newest build groups → test, next → val, rest → train (ties broken by a seeded hash)."""
    order = sorted(group_builds, key=lambda g: (-group_builds[g], sha256_bytes(f"{seed}:{g}".encode())))
    n = len(order)
    n_test = max(1, math.ceil(n * test_fraction)) if n >= 3 else 0
    n_val = max(1, math.ceil(n * val_fraction)) if n >= 3 else 0
    out: dict[str, str] = {}
    for i, g in enumerate(order):
        out[g] = "test" if i < n_test else ("val" if i < n_test + n_val else "train")
    return out


def content_hash(doc: dict[str, Any]) -> str:
    payload = {
        "policy": doc["policy"],
        "members": [{k: v for k, v in m.items() if k != "path"} for m in doc["members"]],
        "splits": doc["splits"],
    }
    return sha256_bytes(canonical_json(payload).encode())


def freeze_dataset(
    paths: list[Path],
    out: Path,
    emitter: Emitter,
    *,
    seed: int = 20231,
    val_fraction: float = 0.2,
    test_fraction: float = 0.2,
    allow_unvalidated: bool = False,
) -> dict[str, Any]:
    refs, skipped = require_usable(discover(paths), allow_unvalidated)
    if not refs:
        raise errors.MfError(errors.INSUFFICIENT_DATA, "no usable datasets to freeze", skipped=skipped)
    emitter.progress("grouping", 0.3, datasets=len(refs))
    groups = related_groups(refs)
    builds: dict[str, int] = {}
    for r in refs:
        b = int(r.build) if r.build.isdigit() else 0
        builds[groups[r.dataset_id]] = max(builds.get(groups[r.dataset_id], 0), b)
    split_of_group = assign_splits(builds, val_fraction, test_fraction, seed)
    members = []
    for r in refs:
        fm = r.path / "features_manifest.json"
        frows = read_json(fm)["files"] if fm.exists() else {}
        members.append(
            {
                "dataset_id": r.dataset_id,
                "sha256": r.sha256,
                "map": r.map_name,
                "build": r.build,
                "path": str(r.path),
                "group_id": groups[r.dataset_id],
                "split": split_of_group[groups[r.dataset_id]],
                "verdict": r.verdict(),
                "has_features": fm.exists(),
                "feature_rows": frows.get("features", {}).get("rows"),
            }
        )
    splits = {s: sorted(m["dataset_id"] for m in members if m["split"] == s) for s in SPLITS}
    doc: dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "frozen_dataset_manifest",
        "created_at": utc_now(),
        "policy": {
            "unit": "complete_match",
            "dedupe": "sha256",
            "related_grouping": f"same map and non-bot player-set Jaccard >= {RELATED_JACCARD}",
            "time_holdout": {
                "applied": True,
                "proxy": "game build number (no match dates in demo headers)",
                "order": "newest builds -> test, next -> val, rest -> train",
            },
            "val_fraction": val_fraction,
            "test_fraction": test_fraction,
            "seed": seed,
        },
        "members": members,
        "splits": splits,
        "skipped": skipped,
    }
    doc["content_hash"] = content_hash(doc)
    write_json_atomic(Path(out), doc)
    warnings = []
    if not splits["test"]:
        warnings.append("fewer than 3 match groups: no held-out test set")
    return {
        "out": str(out),
        "content_hash": doc["content_hash"],
        "splits": splits,
        "groups": len(set(groups.values())),
        "skipped": skipped,
        "warnings": warnings,
    }


def audit_split(manifest_path: Path, emitter: Emitter, datasets: list[Path] | None = None) -> dict[str, Any]:
    doc = read_json(Path(manifest_path))
    violations: list[str] = []
    members = doc.get("members", [])
    splits = doc.get("splits", {})
    listed: dict[str, list[str]] = {}
    for s, ids in splits.items():
        for i in ids:
            listed.setdefault(i, []).append(s)
    for i, names in listed.items():
        if len(names) > 1:
            violations.append(f"dataset {i} listed in splits {names}")
    for key in ("dataset_id", "sha256", "group_id"):
        seen: dict[str, set[str]] = {}
        for m in members:
            seen.setdefault(str(m[key]), set()).add(m["split"])
        for val, ss in seen.items():
            if len(ss) > 1:
                violations.append(f"{key} {val[:16]} appears in splits {sorted(ss)}")
    for m in members:
        if m["split"] not in splits or m["dataset_id"] not in splits.get(m["split"], []):
            violations.append(f"member {m['dataset_id']} split field disagrees with split lists")
    if doc.get("content_hash") != content_hash(doc):
        violations.append("content_hash mismatch (manifest edited after freezing)")
    recomputed = False
    paths = datasets if datasets else [Path(m["path"]) for m in members if Path(m["path"]).exists()]
    if paths:
        refs = [r for r in discover(paths) if r.sha256 in {m["sha256"] for m in members}]
        if len(refs) >= 2:
            groups = related_groups(refs)
            split_of = {m["sha256"]: m["split"] for m in members}
            by_group: dict[str, set[str]] = {}
            for r in refs:
                by_group.setdefault(groups[r.dataset_id], set()).add(split_of[r.sha256])
            for g, ss in by_group.items():
                if len(ss) > 1:
                    violations.append(f"related demos (group {g}) span splits {sorted(ss)}")
            recomputed = True
    warnings = [] if splits.get("test") else ["no held-out test split"]
    return {
        "manifest": str(manifest_path),
        "passed": not violations,
        "violations": violations,
        "warnings": warnings,
        "relations_recomputed": recomputed,
        "members": len(members),
    }
