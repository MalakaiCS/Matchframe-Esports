"""Tick-rate derivation and the sampled-state policy for the ``ticks`` table.

* The simulation tick rate is derived from the data (``game_time`` slope over ticks), never assumed.
* Demos record frames at their own interval (SourceTV 2023 demos: every 3 ticks ≈ 21.3 Hz at 64
  tick; client POV demos: every tick). The uniform grid uses an as-of (latest frame at or before
  each grid tick) selection so no sample ever looks ahead.
* Event-centred windows keep every recorded frame within ±window of deaths and utility moments.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import polars as pl

COMMON_TICK_RATES = (32.0, 64.0, 128.0)


@dataclass(frozen=True)
class TickTiming:
    tick_rate: float
    tick_rate_evidence: str
    recorded_frame_interval_ticks: float
    recorded_frame_hz: float
    first_tick: int
    last_tick: int
    n_frames: int


def derive_timing(ticks: pl.DataFrame) -> TickTiming:
    """Derive tick rate from ``game_time`` vs ``tick`` and the recorded frame interval."""
    frames = (
        ticks.filter(pl.col("game_time").is_not_null() & pl.col("game_time").is_not_nan())
        .group_by("tick")
        .agg(pl.col("game_time").first())
        .sort("tick")
        if "game_time" in ticks.columns
        else pl.DataFrame({"tick": [], "game_time": []})
    )
    all_ticks = np.sort(ticks["tick"].unique().to_numpy())
    if all_ticks.size == 0:
        raise ValueError("no recorded frames")
    spacing = np.diff(all_ticks)
    interval = float(np.median(spacing)) if spacing.size else 1.0
    rate: float | None = None
    evidence = "assumed_default_64"
    if frames.height >= 10:
        t = frames["tick"].to_numpy().astype(np.float64)
        g = frames["game_time"].to_numpy().astype(np.float64)
        dt = np.diff(t)
        dg = np.diff(g)
        ok = (dt > 0) & (dg > 0)
        if ok.sum() >= 5:
            per_tick = float(np.median(dg[ok] / dt[ok]))
            if per_tick > 0:
                rate = 1.0 / per_tick
                evidence = "game_time_slope"
    if rate is None or not (8.0 <= rate <= 512.0):
        rate = 64.0
        evidence = "assumed_default_64"
    for common in COMMON_TICK_RATES:
        if abs(rate - common) / common < 0.005:
            rate = common
            break
    return TickTiming(
        tick_rate=round(rate, 4),
        tick_rate_evidence=evidence,
        recorded_frame_interval_ticks=interval,
        recorded_frame_hz=round(rate / interval, 4),
        first_tick=int(all_ticks[0]),
        last_tick=int(all_ticks[-1]),
        n_frames=int(all_ticks.size),
    )


def grid_frame_ticks(frame_ticks: np.ndarray, tick_rate: float, sample_hz: float) -> np.ndarray:
    """Frames selected for a uniform grid at ``sample_hz`` (latest frame at or before each grid tick)."""
    if frame_ticks.size == 0:
        return frame_ticks
    stride = tick_rate / sample_hz
    first, last = float(frame_ticks[0]), float(frame_ticks[-1])
    grid = first + np.arange(0, int((last - first) / stride) + 1) * stride
    idx = np.searchsorted(frame_ticks, grid, side="right") - 1
    idx = idx[idx >= 0]
    return np.unique(frame_ticks[idx])


def window_frame_ticks(frame_ticks: np.ndarray, anchors: np.ndarray, half_window_ticks: float) -> np.ndarray:
    """All frames within ±half_window of any anchor tick."""
    if frame_ticks.size == 0 or anchors.size == 0:
        return np.array([], dtype=frame_ticks.dtype)
    a = np.sort(anchors.astype(np.float64))
    lo = a - half_window_ticks
    hi = a + half_window_ticks
    # merge intervals
    merged_lo = [lo[0]]
    merged_hi = [hi[0]]
    for a_lo, a_hi in zip(lo[1:], hi[1:], strict=True):
        if a_lo <= merged_hi[-1]:
            merged_hi[-1] = max(merged_hi[-1], a_hi)
        else:
            merged_lo.append(a_lo)
            merged_hi.append(a_hi)
    mask = np.zeros(frame_ticks.size, dtype=bool)
    for a_lo, a_hi in zip(merged_lo, merged_hi, strict=True):
        i0 = np.searchsorted(frame_ticks, a_lo, side="left")
        i1 = np.searchsorted(frame_ticks, a_hi, side="right")
        mask[i0:i1] = True
    return frame_ticks[mask]


def add_motion(ticks: pl.DataFrame, tick_rate: float, max_gap_s: float = 0.5, max_speed: float = 1500.0) -> pl.DataFrame:
    """Backward-difference velocity from the previous *recorded* frame of the same player (causal)."""
    df = ticks.sort(["player_id", "tick"])
    prev_tick = pl.col("tick").shift(1).over("player_id")
    frame_dt = ((pl.col("tick") - prev_tick) / tick_rate).alias("frame_dt")
    df = df.with_columns(frame_dt)
    comps = []
    for axis in ("x", "y", "z"):
        comps.append(((pl.col(axis) - pl.col(axis).shift(1).over("player_id")) / pl.col("frame_dt")).alias(f"v{axis}"))
    df = df.with_columns(comps)
    speed = (pl.col("vx") ** 2 + pl.col("vy") ** 2).sqrt()
    valid = (pl.col("frame_dt") <= max_gap_s) & (speed <= max_speed) & pl.col("is_alive").fill_null(False)
    df = df.with_columns([pl.when(valid).then(pl.col(c)).otherwise(None).cast(pl.Float32).alias(c) for c in ("vx", "vy", "vz")])
    return df.with_columns(pl.col("frame_dt").cast(pl.Float32))


def select_samples(
    ticks: pl.DataFrame,
    grid: np.ndarray,
    windows: np.ndarray,
    tick_rate: float,
    sample_hz: float,
) -> pl.DataFrame:
    """Keep grid ∪ window frames, add sampling-policy columns and per-player ``dt``."""
    grid_s = pl.Series("tick", grid.astype(np.int64))
    win_s = pl.Series("tick", windows.astype(np.int64))
    df = ticks.filter(pl.col("tick").is_in(grid_s.implode()) | pl.col("tick").is_in(win_s.implode()))
    grid_label = f"grid_{sample_hz:g}hz"
    df = df.with_columns(
        pl.col("tick").is_in(grid_s.implode()).alias("in_grid"),
        pl.col("tick").is_in(win_s.implode()).alias("in_event_window"),
    )
    df = df.with_columns(
        pl.when(pl.col("in_grid") & pl.col("in_event_window"))
        .then(pl.lit(f"{grid_label}+event_window"))
        .when(pl.col("in_grid"))
        .then(pl.lit(grid_label))
        .otherwise(pl.lit("event_window"))
        .alias("sampling_policy")
    )
    df = df.sort(["player_id", "tick"]).with_columns(
        ((pl.col("tick") - pl.col("tick").shift(1).over("player_id")) / tick_rate).cast(pl.Float32).alias("dt")
    )
    return df.sort(["tick", "player_id"])
