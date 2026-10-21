"""The corrections learned from the airports and the AtmosIQ Blend: the rules shared by verify.py, verify_gauges.py and learn_bias.py
(and mirrored in the app, src/app/core/meteogram/blend.ts, which reads the same corrections file).

A correction is a model's usual error at an airport by hour of the day (UTC), for temperature (C) and humidity (%), learned by
learn_bias.py and kept only where it lowered the error on days held back from the learning. At a place it is the airports' corrections
weighted by distance: in full within FULL_KM, fading to nothing at FADE_KM, averaged where airports overlap (the same rule as the map's
correction, correction.py).

The Blend is the corrected models' weighted mean, each model weighted by how small its recent error was (weights in the corrections file).
Its chance of rain is the weighted share of models with rain at the place, each model's rain counted from its own threshold (the amount at
which it forecasts rain as often as the airports report it).
"""
from __future__ import annotations
import json, math

FULL_KM = 100.0
FADE_KM = 200.0
CORRECTED = ("temp", "rh")


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def distance_weight(km: float) -> float:
    if km <= FULL_KM:
        return 1.0
    if km >= FADE_KM:
        return 0.0
    return (FADE_KM - km) / (FADE_KM - FULL_KM)


def load(path: str) -> dict:
    """The corrections file, or an empty one (no corrections, no blend weights) when it is missing or unreadable."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def correction_at(corr: dict, model: str, var: str, lat: float, lon: float, hour_utc: int) -> float:
    """What to take off `model`'s forecast of `var` at a place at that hour of the day (0 where no airport near it has a correction)."""
    by_airport = corr.get("models", {}).get(model, {}).get(var) or {}
    airports = corr.get("airports", {})
    num = den = 0.0
    for icao, hours in by_airport.items():
        pos = airports.get(icao)
        if not pos:
            continue
        w = distance_weight(haversine_km(lat, lon, pos[0], pos[1]))
        if w <= 0:
            continue
        num += w * hours[hour_utc]
        den += w
    # one airport far away is a partial correction; several near each other are averaged, never added up
    return num / max(den, 1.0)


def dew_point(temp_c: float, rh_pct: float) -> float:
    """Dew point (C) from air temperature and humidity (Magnus)."""
    a, b = 17.625, 243.04
    g = math.log(max(rh_pct, 1.0) / 100.0) + a * temp_c / (b + temp_c)
    return b * g / (a - g)


def corrected(corr: dict, model: str, var: str, value: float | None, lat: float, lon: float, hour_utc: int) -> float | None:
    """A forecast value with its correction taken off (temperature and humidity; other variables as they are)."""
    if value is None or var not in CORRECTED:
        return value
    v = value - correction_at(corr, model, var, lat, lon, hour_utc)
    return min(100.0, max(1.0, v)) if var == "rh" else v


def weights(corr: dict, group: str, available: dict[str, object]) -> dict[str, float]:
    """The blend weights of the models of `group` ('temp' for temperature, humidity and wind; 'rain') that have a value, summing to 1."""
    w = {m: x for m, x in (corr.get("blend", {}).get(group) or {}).items() if available.get(m) is not None}
    total = sum(w.values())
    return {m: x / total for m, x in w.items()} if total > 0 else {}


def blend_value(corr: dict, group: str, values: dict[str, float | None]) -> float | None:
    """The weighted mean of the models' (already corrected) values; None when no blended model has one."""
    w = weights(corr, group, values)
    if not w:
        return None
    return sum(w[m] * values[m] for m in w)  # type: ignore[operator]


def rain_threshold(corr: dict, model: str, default: float = 0.2) -> float:
    return float(corr.get("models", {}).get(model, {}).get("rain_threshold_mm", default))


def rain_cutoff(corr: dict) -> float:
    """The chance of rain from which the Blend says it rains (learned so it says so as often as the airports report rain)."""
    return float(corr.get("blend", {}).get("rain_cutoff", 0.5))


def rain_chance(corr: dict, amounts: dict[str, float | None]) -> float | None:
    """The weighted share (0-1) of the blended models with rain, each from its own threshold."""
    w = weights(corr, "rain", amounts)
    if not w:
        return None
    return sum(w[m] for m in w if amounts[m] >= rain_threshold(corr, m))  # type: ignore[operator]
