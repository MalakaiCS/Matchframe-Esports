"""Parquet table IO shared by all stages (zstd, checksums, row counts)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import polars as pl
import pyarrow.parquet as pq

from .fsutil import sha256_file


@dataclass(frozen=True)
class WrittenTable:
    name: str
    file: str
    rows: int
    bytes: int
    sha256: str
    columns: list[str]

    def as_manifest_entry(self) -> dict[str, object]:
        return {
            "file": self.file,
            "rows": self.rows,
            "bytes": self.bytes,
            "sha256": self.sha256,
            "columns": self.columns,
        }


def write_table(df: pl.DataFrame, directory: Path, name: str) -> WrittenTable:
    """Write ``df`` as ``<name>.parquet`` (zstd) and return checksum metadata."""
    path = directory / f"{name}.parquet"
    df.write_parquet(path, compression="zstd", compression_level=6, statistics=True)
    return WrittenTable(
        name=name,
        file=path.name,
        rows=df.height,
        bytes=path.stat().st_size,
        sha256=sha256_file(path),
        columns=list(df.columns),
    )


def parquet_row_count(path: Path) -> int:
    return int(pq.read_metadata(path).num_rows)


def read_table(directory: Path, name: str, columns: list[str] | None = None) -> pl.DataFrame:
    return pl.read_parquet(directory / f"{name}.parquet", columns=columns)
