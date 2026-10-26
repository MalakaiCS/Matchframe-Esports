"""Discovery of committed per-demo datasets on disk.

Layout: ``<root>/map=<map>/build=<build>/demo=<sha256[:16]>/`` containing ``manifest.json`` with
``status == "COMMITTED"``. Anything under ``.staging`` or without a committed manifest is ignored.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import errors
from .fsutil import read_json

MANIFEST = "manifest.json"
VALIDATION = "validation.json"
FEATURES_MANIFEST = "features_manifest.json"


@dataclass(frozen=True)
class DatasetRef:
    path: Path
    manifest: dict[str, Any]

    @property
    def dataset_id(self) -> str:
        return str(self.manifest["dataset_id"])

    @property
    def sha256(self) -> str:
        return str(self.manifest["source"]["sha256"])

    @property
    def map_name(self) -> str:
        return str(self.manifest["map"])

    @property
    def build(self) -> str:
        return str(self.manifest["build"])

    @property
    def tick_rate(self) -> float:
        return float(self.manifest["timing"]["tick_rate"])

    def validation(self) -> dict[str, Any] | None:
        p = self.path / VALIDATION
        return read_json(p) if p.exists() else None

    def verdict(self) -> str | None:
        v = self.validation()
        return None if v is None else str(v.get("verdict"))

    def has_features(self) -> bool:
        return (self.path / FEATURES_MANIFEST).exists()


def load_dataset(path: Path) -> DatasetRef:
    manifest_path = path / MANIFEST
    if not manifest_path.exists():
        raise errors.MfError(errors.DATASET_NOT_FOUND, f"no manifest.json in {path}", path=str(path))
    manifest = read_json(manifest_path)
    if manifest.get("status") != "COMMITTED":
        raise errors.MfError(
            errors.DATASET_INVALID, f"dataset {path} is not COMMITTED", path=str(path), status=manifest.get("status")
        )
    return DatasetRef(path=path, manifest=manifest)


def discover(paths: Iterable[Path], map_name: str | None = None) -> list[DatasetRef]:
    """Resolve dataset directories or roots into committed datasets (sorted, de-duplicated by hash)."""
    found: dict[str, DatasetRef] = {}
    for base in paths:
        base = Path(base)
        if not base.exists():
            raise errors.MfError(errors.DATASET_NOT_FOUND, f"path does not exist: {base}", path=str(base))
        candidates = [base] if (base / MANIFEST).exists() else sorted(base.glob("**/demo=*"))
        for cand in candidates:
            if ".staging" in cand.parts or not (cand / MANIFEST).exists():
                continue
            try:
                ref = load_dataset(cand)
            except errors.MfError:
                continue
            if map_name is not None and ref.map_name != map_name:
                continue
            found.setdefault(ref.sha256, ref)
    return sorted(found.values(), key=lambda r: (r.map_name, r.build, r.dataset_id))


def require_usable(refs: list[DatasetRef], allow_unvalidated: bool) -> tuple[list[DatasetRef], list[dict[str, str]]]:
    """Keep datasets whose validation verdict is ``usable`` (or unvalidated when allowed)."""
    kept: list[DatasetRef] = []
    skipped: list[dict[str, str]] = []
    for ref in refs:
        verdict = ref.verdict()
        if verdict == "usable" or (verdict is None and allow_unvalidated):
            kept.append(ref)
        else:
            skipped.append({"dataset_id": ref.dataset_id, "reason": f"verdict={verdict}"})
    return kept, skipped
