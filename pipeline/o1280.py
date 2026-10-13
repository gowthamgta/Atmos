"""Geometry of ECMWF's O1280 reduced Gaussian grid (~9 km) and window extraction.

Open-Meteo's `.om` files store each variable as one flat array of 6,599,680 points,
ordered north to south, west to east within each latitude row.
"""
from __future__ import annotations
import numpy as np

N = 1280                                    # Gaussian number: N latitude rows per hemisphere
NPOINTS = 6_599_680


def row_lengths() -> np.ndarray:
    """Points per latitude row, north to south (20, 24, ... 5136, 5136 ... 24, 20)."""
    north = 4 * np.arange(1, N + 1) + 16
    return np.concatenate([north, north[::-1]])


def row_latitudes() -> np.ndarray:
    """Gaussian latitudes in degrees, north to south."""
    x, _ = np.polynomial.legendre.leggauss(2 * N)
    return np.degrees(np.arcsin(x))[::-1]


LENGTHS = row_lengths()
LATS = row_latitudes()
OFFSETS = np.concatenate([[0], np.cumsum(LENGTHS)])
assert OFFSETS[-1] == NPOINTS


def band_rows(lat_min: float, lat_max: float, pad: int = 1) -> tuple[int, int]:
    """Row index range [r0, r1) covering lat_min..lat_max (plus `pad` rows each side)."""
    inside = np.where((LATS <= lat_max) & (LATS >= lat_min))[0]
    return max(inside[0] - pad, 0), min(inside[-1] + 1 + pad, len(LATS))


def regrid_band(flat: np.ndarray, r0: int, r1: int, lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
    """Bilinear-resample a flat band (rows r0..r1) to a regular lat/lon grid.

    `lats` is descending (north to south). Longitude wraps within each Gaussian row.
    Returns float32 [len(lats), len(lons)].
    """
    band_lat = LATS[r0:r1]
    rows = []
    for k in range(r1 - r0):
        a, b = OFFSETS[r0 + k] - OFFSETS[r0], OFFSETS[r0 + k + 1] - OFFSETS[r0]
        row = flat[a:b]
        n = len(row)
        x = lons / 360.0 * n
        i0 = np.floor(x).astype(int)
        f = (x - i0).astype(np.float32)
        rows.append(row[i0 % n] * (1 - f) + row[(i0 + 1) % n] * f)
    rows = np.stack(rows)                         # [band rows, lons], lat descending
    out = np.empty((len(lats), len(lons)), np.float32)
    # linear interpolation between neighbouring Gaussian rows
    idx = np.searchsorted(-band_lat, -lats)       # band_lat is descending
    idx = np.clip(idx, 1, len(band_lat) - 1)
    la, lb = band_lat[idx - 1], band_lat[idx]
    w = ((la - lats) / (la - lb)).astype(np.float32)[:, None]
    out[:] = rows[idx - 1] * (1 - w) + rows[idx] * w
    return out
