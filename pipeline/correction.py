"""Corrects the ECMWF IFS forecast near the airports that the bias table (bias.py) was measured at.

Only the variables that improved on the held-out days are corrected (temperature and humidity, see the table); wind is not.
Each airport's correction (by hour of day, UTC) applies in full within FULL_KM of the airport, fades out linearly to nothing
at FADE_KM, and is not applied beyond that. Kallakurichi is about 80 km from Tiruchirappalli airport, so it gets the full
correction from that airport.
"""
from __future__ import annotations
import json, math
from datetime import datetime

import numpy as np

FULL_KM = 100.0
FADE_KM = 200.0
CORRECTED = {"temp_c": ("t2m", 0.0, 60.0), "rh_pct": ("rh", 0.0, 100.0)}   # bias key -> (field name, min, max)
# a correction is used only when the held-out days are enough to trust it, and it clearly lowers the error there
MIN_TEST_POINTS = 50
MIN_GAIN = 0.05


def haversine_km(lat1, lon1, lat2, lon2):
    """Distance on the ground (km) between two points, given in degrees."""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def weight(distance_km: float) -> float:
    """1 within FULL_KM, 0 beyond FADE_KM, straight line in between."""
    if distance_km <= FULL_KM:
        return 1.0
    if distance_km >= FADE_KM:
        return 0.0
    return (FADE_KM - distance_km) / (FADE_KM - FULL_KM)


def load_table(path: str) -> dict:
    """The corrections to apply: for each airport, its position and the hourly correction of each corrected variable that
    was measured on enough held-out points and clearly improved there. Empty when the table is missing."""
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError):
        return {}
    out = {}
    for station, a in doc.get("airports", {}).items():
        lat, lon = a.get("lat"), a.get("lon")
        if lat is None or lon is None:
            continue
        variables = {}
        for key in CORRECTED:
            v = a.get("variables", {}).get(key)
            if not v or v.get("mae_after") is None or v.get("mae_before") is None:
                continue
            enough = v.get("n_test", 0) >= MIN_TEST_POINTS
            clear = v["mae_after"] <= v["mae_before"] * (1 - MIN_GAIN)
            if enough and clear:
                variables[key] = {int(h): float(c) for h, c in v["correction_by_hour_utc"].items()}
        if variables:
            out[station] = {"lat": lat, "lon": lon, "variables": variables}
    return out


def _distance_km(lat: float, lon: float, lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
    """Distance (km) from one point to every grid cell, as a [lats, lons] array."""
    r = 6371.0
    p1 = np.radians(lat)
    p2 = np.radians(lats)[:, None]
    dl = np.radians(lons - lon)[None, :]
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * r * np.arcsin(np.minimum(1.0, np.sqrt(a)))


def apply(fields: dict[str, np.ndarray], lats: np.ndarray, lons: np.ndarray, valid: datetime, table: dict) -> dict[str, np.ndarray]:
    """The fields with the corrections applied for this valid time (UTC). Returns new arrays; the input is not changed.

    Where two airports overlap, each variable's correction is the average of the airports' corrections, weighted by how
    near each one is (so the two never add up).
    """
    if not table:
        return fields
    hour = valid.hour
    num: dict[str, np.ndarray] = {}
    den: dict[str, np.ndarray] = {}
    for a in table.values():
        w = np.clip((FADE_KM - _distance_km(a["lat"], a["lon"], lats, lons)) / (FADE_KM - FULL_KM), 0.0, 1.0).astype(np.float32)
        for key, by_hour in a["variables"].items():
            name = CORRECTED[key][0]
            num[name] = num.get(name, 0) + w * np.float32(by_hour.get(hour, 0.0))
            den[name] = den.get(name, 0) + w
    out = dict(fields)
    for key, (name, lo, hi) in CORRECTED.items():
        if name in out and name in num:
            safe = np.where(den[name] > 0, den[name], 1.0)
            corr = np.where(den[name] > 0, num[name] / safe, 0.0).astype(np.float32)
            out[name] = np.clip(out[name] - corr, lo, hi).astype(np.float32)
    return out
