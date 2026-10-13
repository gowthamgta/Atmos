"""Where the IMD radars can see rain near the ground: the beam geometry, as pure functions (see build_radar_coverage.py, which bakes the map).

A radar beam leaves the antenna at a small angle above the horizontal and the Earth curves away below it, so with distance the beam is
higher above the ground and sees less of the low rain. Mountains between the radar and a place can also block part of the beam. Both are worked
out from the terrain; nothing here needs the radar data itself.

Assumptions (the IMD does not publish them for each radar, so these are typical values, written into the output so the app can say so):
  lowest sweep 0.5 degrees above the horizontal, half-power beam width 1.0 degree (1.5 for the X-band radar), antenna 30 m above its ground,
  4/3 effective Earth radius (the standard atmosphere's bending of the beam).
"""
from __future__ import annotations

import math

import numpy as np

EARTH_KM = 6371.0
K_EFFECTIVE = 4.0 / 3.0
R_EFFECTIVE_KM = EARTH_KM * K_EFFECTIVE

SWEEP_DEG = 0.5
ANTENNA_M = 30.0
BEAM_DEG = {"S-Band": 1.0, "C-Band": 1.0, "X-Band": 1.5}
MAX_RANGE_KM = 300.0

# Classes of the baked map: what a radar sees of rain close to the ground at a place
NONE, POOR, LIMITED, GOOD = 0, 1, 2, 3
GOOD_AGL_KM, GOOD_BLOCK = 2.0, 0.10
LIMITED_AGL_KM, LIMITED_BLOCK = 4.0, 0.50


def beam_height_km(ground_range_km: np.ndarray | float) -> np.ndarray | float:
    """Height of the beam centre above the antenna at a ground distance (km): the climb of the beam plus the drop of the curved Earth."""
    r = np.asarray(ground_range_km, dtype=np.float64)
    out = r * math.tan(math.radians(SWEEP_DEG)) + r * r / (2.0 * R_EFFECTIVE_KM)
    return float(out) if np.ndim(out) == 0 else out


def blocked_fraction(obstacle_deg: np.ndarray | float, sweep_deg: float = SWEEP_DEG, beam_deg: float = 1.0) -> np.ndarray | float:
    """Share of the beam's power below an obstacle seen at `obstacle_deg` above the horizontal (a Gaussian beam of half-power width `beam_deg`)."""
    sigma = beam_deg / 2.3548
    z = (np.asarray(obstacle_deg, dtype=np.float64) - sweep_deg) / sigma
    out = 0.5 * (1.0 + _erf(z / math.sqrt(2.0)))
    return float(out) if np.ndim(out) == 0 else out


def _erf(x: np.ndarray) -> np.ndarray:
    """The error function (Abramowitz and Stegun 7.1.26, absolute error under 1.5e-7), so that numpy is all that is needed."""
    x = np.asarray(x, dtype=np.float64)
    s = np.sign(x)
    a = np.abs(x)
    t = 1.0 / (1.0 + 0.3275911 * a)
    poly = ((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592
    return s * (1.0 - poly * t * np.exp(-a * a))


def destination(lat_deg: float, lon_deg: float, bearing_deg: np.ndarray, distance_km: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Latitude and longitude reached from a point going `distance_km` along `bearing_deg` (great circle). Arrays broadcast together."""
    lat1 = math.radians(lat_deg)
    lon1 = math.radians(lon_deg)
    brg = np.radians(bearing_deg)
    d = np.asarray(distance_km, dtype=np.float64) / EARTH_KM
    sin_lat2 = math.sin(lat1) * np.cos(d) + math.cos(lat1) * np.sin(d) * np.cos(brg)
    lat2 = np.arcsin(np.clip(sin_lat2, -1.0, 1.0))
    lon2 = lon1 + np.arctan2(np.sin(brg) * np.sin(d) * math.cos(lat1), np.cos(d) - math.sin(lat1) * sin_lat2)
    return np.degrees(lat2), np.degrees(lon2)


def trace_rays(terrain_m, lat_deg: float, lon_deg: float, beam_deg: float, azimuths: int = 720, gates: int = int(MAX_RANGE_KM)) -> dict[str, np.ndarray]:
    """
    What the beam of one radar meets along rays every 360/azimuths degrees, one gate per km out to `gates` km.

    `terrain_m(lat, lon)` gives the ground height (m above sea level) for arrays of latitude and longitude.
    Returns arrays of shape (azimuths, gates): the height of the beam centre above the ground (`agl_km`) and the share of the beam that the
    terrain between the radar and the gate blocks, beyond what flat ground would (`blocked`).
    """
    az = np.arange(azimuths, dtype=np.float64) * (360.0 / azimuths)
    rng = np.arange(1, gates + 1, dtype=np.float64)
    lat, lon = destination(lat_deg, lon_deg, az[:, None], rng[None, :])
    ground = np.asarray(terrain_m(lat, lon), dtype=np.float64)
    antenna = float(np.asarray(terrain_m(np.array([lat_deg]), np.array([lon_deg])))[0]) + ANTENNA_M
    drop = rng * rng / (2.0 * R_EFFECTIVE_KM)
    # the angle at which each point of the ground is seen from the antenna, above the horizontal there (the Earth's curve lowers far ground)
    seen = np.degrees(np.arctan2((ground - antenna) / 1000.0 - drop[None, :], rng[None, :]))
    worst = np.maximum.accumulate(seen, axis=1)
    centre_km = antenna / 1000.0 + beam_height_km(rng)[None, :]
    # even flat ground at the radar's own level is grazed by the lower tail of the beam (a wide beam more than a narrow one); that is the same
    # everywhere and is not blockage, so only what the terrain adds to it is counted
    flat_seen = np.degrees(np.arctan2(-ANTENNA_M / 1000.0 - drop, rng))
    flat = blocked_fraction(np.maximum.accumulate(flat_seen), beam_deg=beam_deg)
    blocked = np.maximum(0.0, blocked_fraction(worst, beam_deg=beam_deg) - flat[None, :])
    return {"agl_km": centre_km - ground / 1000.0, "blocked": blocked}


def classify(agl_km: np.ndarray, blocked: np.ndarray) -> np.ndarray:
    """Class (POOR, LIMITED or GOOD) of rain seen near the ground, from the beam's height above it and the share of the beam that is blocked."""
    out = np.full(np.shape(agl_km), POOR, dtype=np.uint8)
    out[(agl_km <= LIMITED_AGL_KM) & (blocked <= LIMITED_BLOCK)] = LIMITED
    out[(agl_km <= GOOD_AGL_KM) & (blocked <= GOOD_BLOCK)] = GOOD
    return out
