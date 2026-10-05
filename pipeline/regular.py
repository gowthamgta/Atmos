"""Bilinear resampling of regular latitude/longitude grids (such as GFS) onto the pipeline's 0.1 degree grid."""
from __future__ import annotations
import math
import numpy as np


def window_indices(first: float, step: float, count: int, lo: float, hi: float, pad: int = 2) -> tuple[int, int]:
    """Index range [i0, i1) of a regular axis (centre of element 0 at `first`) that covers lo..hi plus `pad` elements."""
    i0 = max(math.floor((lo - first) / step) - pad, 0)
    i1 = min(math.ceil((hi - first) / step) + pad + 1, count)
    return i0, i1


def regrid_regular(
    window: np.ndarray,
    lat_first: float,
    dlat: float,
    lon_first: float,
    dlon: float,
    lats: np.ndarray,
    lons: np.ndarray,
) -> np.ndarray:
    """Bilinear-resample `window` to the lats x lons grid.

    `window` is a [rows, cols] block whose rows go from south to north (ascending latitude) and whose columns go
    west to east; element [0, 0] is centred on (lat_first, lon_first). Targets outside the window are clamped to
    its edge. NaN inputs propagate. Returns float32 [len(lats), len(lons)].
    """
    fy = (np.asarray(lats, np.float64) - lat_first) / dlat
    fx = (np.asarray(lons, np.float64) - lon_first) / dlon
    y0 = np.clip(np.floor(fy).astype(int), 0, window.shape[0] - 2)
    x0 = np.clip(np.floor(fx).astype(int), 0, window.shape[1] - 2)
    wy = np.clip(fy - y0, 0, 1).astype(np.float32)[:, None]
    wx = np.clip(fx - x0, 0, 1).astype(np.float32)[None, :]
    rows0 = window[y0]
    rows1 = window[y0 + 1]
    top = rows0[:, x0] * (1 - wx) + rows0[:, x0 + 1] * wx
    bottom = rows1[:, x0] * (1 - wx) + rows1[:, x0 + 1] * wx
    return (top * (1 - wy) + bottom * wy).astype(np.float32)
