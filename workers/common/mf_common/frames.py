"""Small polars helpers shared across stages."""

from __future__ import annotations

from collections.abc import Sequence

import polars as pl


def asof_backward(
    left: pl.DataFrame,
    right: pl.DataFrame,
    *,
    on: str,
    by: str | Sequence[str] | None = None,
    tolerance: int | float | None = None,
) -> pl.DataFrame:
    """As-of join taking the latest right row with ``right.on <= left.on`` (never a future row).

    Both inputs are sorted globally by ``on`` (which implies per-group order); the original left
    row order is restored.
    """
    l2 = left.with_row_index("__row").sort(on)
    r2 = right.sort(on)
    out = l2.join_asof(r2, on=on, by=by, strategy="backward", tolerance=tolerance, check_sortedness=False)
    return out.sort("__row").drop("__row")
