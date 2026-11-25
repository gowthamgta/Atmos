"""Worldwide real-time METAR station observations and global 2D Barnes objective analysis.

Fetches hourly surface reports from NOAA Aviation Weather (aviationweather.gov, no API key)
across a 36-tile global grid, and assimilates temperature and relative humidity into the
0.25-degree global forecast background.
"""
from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import math
import numpy as np
import requests

from obs_metar import API as METAR_API, KT_TO_MS, _number, relative_humidity


def fetch_worldwide_metars(hours: int = 2, timeout: int = 15, max_workers: int = 8) -> list[dict]:
    """Fetches unique, recent METAR observations across the globe using tiled bounding boxes."""
    bboxes = [
        (lat0, lon0, min(80, lat0 + 30), lon0 + 45)
        for lat0 in range(-60, 75, 30)
        for lon0 in range(-180, 180, 45)
    ]

    def _fetch_tile(b: tuple[int, int, int, int]) -> list[dict]:
        try:
            r = requests.get(
                METAR_API,
                params={"bbox": f"{b[0]},{b[1]},{b[2]},{b[3]}", "format": "json", "hours": hours},
                timeout=timeout,
            )
            return r.json() if r.ok else []
        except Exception:
            return []

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        results = list(pool.map(_fetch_tile, bboxes))

    by_id: dict[str, dict] = {}
    for tile_records in results:
        for rec in tile_records:
            code = rec.get("icaoId")
            obs_time = rec.get("obsTime")
            lat = rec.get("lat")
            lon = rec.get("lon")
            temp = _number(rec.get("temp"))
            if not code or obs_time is None or lat is None or lon is None or temp is None:
                continue
            prev = by_id.get(code)
            if prev is not None and prev.get("obsTime", 0) >= obs_time:
                continue
            dewp = _number(rec.get("dewp"))
            wspd = _number(rec.get("wspd"))
            by_id[code] = {
                "station": code,
                "obsTime": obs_time,
                "lat": float(lat),
                "lon": float(lon),
                "temp_c": temp,
                "rh_pct": relative_humidity(temp, dewp) if dewp is not None else None,
                "wind_ms": round(wspd * KT_TO_MS, 2) if wspd is not None else None,
                "wind_dir": rec.get("wdir"),
            }
    return list(by_id.values())


def barnes_global_2d(
    background: np.ndarray,
    observations: list[tuple[float, float, float]],
    lat_max: float,
    lat_min: float,
    lon_min: float,
    step: float,
    radius_km: float = 120.0,
    max_adj: float = 4.5,
) -> np.ndarray:
    """2D Barnes objective analysis on a global regular grid with longitude wrap-around."""
    if not observations:
        return background

    ny, nx = background.shape
    out = background.astype(np.float32, copy=True)
    num = np.zeros((ny, nx), dtype=np.float32)
    den = np.zeros((ny, nx), dtype=np.float32)

    lat_deg_km = 111.2
    sigma2 = 2.0 * (radius_km ** 2)
    r_cells_lat = int(math.ceil((radius_km * 3.0) / (lat_deg_km * step)))

    for lat_obs, lon_obs, val_obs in observations:
        if not np.isfinite(val_obs):
            continue
        r_obs = int(round((lat_max - lat_obs) / step))
        c_obs = int(round(((lon_obs - lon_min) % 360.0) / step)) % nx
        if not (0 <= r_obs < ny):
            continue

        bg_val = float(background[r_obs, c_obs])
        if not np.isfinite(bg_val):
            continue
        innov = float(np.clip(val_obs - bg_val, -max_adj, max_adj))
        if abs(innov) < 0.05:
            continue

        cos_lat = max(0.15, math.cos(math.radians(lat_obs)))
        lon_deg_km = lat_deg_km * cos_lat
        r_cells_lon = min(nx // 2, int(math.ceil((radius_km * 3.0) / (lon_deg_km * step))))

        r0 = max(0, r_obs - r_cells_lat)
        r1 = min(ny, r_obs + r_cells_lat + 1)
        rs = np.arange(r0, r1)[:, None]
        lats_sub = lat_max - rs * step
        dy_km = (lats_sub - lat_obs) * lat_deg_km

        c_offsets = np.arange(-r_cells_lon, r_cells_lon + 1)
        cs = (c_obs + c_offsets) % nx
        dlon = ((lon_min + cs * step - lon_obs + 180.0) % 360.0) - 180.0
        dx_km = dlon[None, :] * lon_deg_km

        dist2 = dx_km ** 2 + dy_km ** 2
        w = np.exp(-dist2 / sigma2).astype(np.float32)
        w[dist2 > (radius_km * 3.0) ** 2] = 0.0

        num[r0:r1, cs] += w * innov
        den[r0:r1, cs] += w

    correction = np.where(den > 1e-4, num / (den + 0.15), 0.0)
    correction = np.clip(correction, -max_adj, max_adj)
    return (out + correction).astype(np.float32)


def assimilate_global_metars(
    fields_now: dict[str, np.ndarray],
    lat_max: float,
    lat_min: float,
    lon_min: float,
    step: float,
    stations: list[dict] | None = None,
) -> dict[str, np.ndarray]:
    """Computes real-time observation deltas (t2m, rh) at now_wall from worldwide METARs."""
    if stations is None:
        stations = fetch_worldwide_metars(hours=2)
    if not stations:
        return {}

    t_obs = [(s["lat"], s["lon"], float(s["temp_c"])) for s in stations if s.get("temp_c") is not None]
    rh_obs = [(s["lat"], s["lon"], float(np.clip(s["rh_pct"], 5.0, 100.0))) for s in stations if s.get("rh_pct") is not None]

    deltas: dict[str, np.ndarray] = {}
    if t_obs and "t2m" in fields_now:
        nudged_t = barnes_global_2d(fields_now["t2m"], t_obs, lat_max, lat_min, lon_min, step, radius_km=120.0, max_adj=4.5)
        deltas["t2m"] = (nudged_t - fields_now["t2m"]).astype(np.float32)
    if rh_obs and "rh" in fields_now:
        nudged_rh = barnes_global_2d(fields_now["rh"], rh_obs, lat_max, lat_min, lon_min, step, radius_km=120.0, max_adj=18.0)
        deltas["rh"] = (np.clip(nudged_rh, 5.0, 100.0) - fields_now["rh"]).astype(np.float32)

    print(f"obs_global_metar: Assimilated {len(t_obs)} worldwide stations (t2m={len(t_obs)}, rh={len(rh_obs)}).", flush=True)
    return deltas
