"""Domain, variables and quantisation ranges for the AtmosIQ forecast pipeline."""
from __future__ import annotations
from dataclasses import dataclass

BUCKET_URL = "https://openmeteo.s3.amazonaws.com"
LATEST_URL = f"{BUCKET_URL}/data_spatial/ecmwf_ifs/latest.json"  # IFS; GFS builds its own in fetch_gfs.py

# South India + seas; regular lat/lon grid at 0.1 degrees (~11 km, close to IFS's native ~9 km)
LAT_MAX, LAT_MIN = 22.0, 4.0
LON_MIN, LON_MAX = 68.0, 90.0
STEP_DEG = 0.1
NY = round((LAT_MAX - LAT_MIN) / STEP_DEG) + 1      # 181 rows, north to south
NX = round((LON_MAX - LON_MIN) / STEP_DEG) + 1      # 221 columns, west to east

# Each model module (fetch_ifs.py, fetch_gfs.py) declares its own MODEL_ID, RUN_HOURS, STEP_HOURS and rain semantics.


@dataclass(frozen=True)
class Var:
    id: str
    unit: str
    lo: float          # value at encoded 0
    hi: float          # value at encoded 65535
    bits: int = 16     # precision actually stored: smooth upper-air fields keep 12 bits, which compresses ~25% better


# Pressure levels offered as "altitude" (hPa) and roughly how high they are
LEVELS = (925, 850, 700, 500, 300, 200)
LEVEL_KM = {925: 0.8, 850: 1.5, 700: 3.0, 500: 5.6, 300: 9.2, 200: 12.0}

# Encoding ranges per level: temperature (degC) and geopotential height (m). Generous, so no value can clip.
_LEVEL_T = {925: (8, 36), 850: (4, 32), 700: (-8, 22), 500: (-28, 2), 300: (-58, -18), 200: (-78, -38)}
_LEVEL_GH = {925: (400, 1100), 850: (1100, 1800), 700: (2600, 3300), 500: (5500, 6100), 300: (9000, 10000), 200: (11800, 12800)}


def _level_vars() -> list[Var]:
    out: list[Var] = []
    for lvl in LEVELS:
        out += [
            Var(f"u{lvl}", "m/s", -90, 90, 12),
            Var(f"v{lvl}", "m/s", -90, 90, 12),
            Var(f"t{lvl}", "°C", *_LEVEL_T[lvl], 12),
            Var(f"rh{lvl}", "%", 0, 100, 12),
            Var(f"gh{lvl}", "m", *_LEVEL_GH[lvl], 12),
        ]
    return out


VARS: dict[str, Var] = {v.id: v for v in [
    Var("t2m", "°C", -10, 50),
    Var("rh", "%", 0, 100),
    Var("feels", "°C", -10, 60),
    Var("dew", "°C", -20, 40),
    Var("u10", "m/s", -60, 60),
    Var("v10", "m/s", -60, 60),
    Var("gust", "m/s", 0, 80),
    Var("msl", "hPa", 950, 1050),
    Var("precip", "mm", 0, 100),
    Var("cloud", "%", 0, 100),
    Var("cloud_low", "%", 0, 100, 12),
    Var("cloud_mid", "%", 0, 100, 12),
    Var("cloud_high", "%", 0, 100, 12),
    Var("vis", "km", 0, 60, 12),
    Var("solar", "W/m²", 0, 1400, 12),
    Var("cape", "J/kg", 0, 6000),
    Var("tcwv", "kg/m²", 0, 80),
    Var("li", "°C", -15, 25, 12),         # lifted index: negative means unstable air
    Var("cin", "J/kg", 0, 1000, 12),      # convective inhibition (magnitude)
    Var("px2", "%", 0, 100, 12),          # chance (%) of >= 2.5 mm in the next 24 h (rain); from the ECMWF ensemble (ens.py), attached to every model by attach.py
    Var("px16", "%", 0, 100, 12),         # >= 15.6 mm (moderate)
    Var("px65", "%", 0, 100, 12),         # >= 64.5 mm (heavy)
    Var("px115", "%", 0, 100, 12),        # >= 115.6 mm (very heavy)
    Var("tmin24", "°C", -10, 50),        # lowest and highest temperature in the next 24 hours from this step (derived across steps,
    Var("tmax24", "°C", -10, 50),        # see derive.forward_extreme)
    Var("rain24", "mm", 0, 600),          # rain over the next 24 hours from this step (derived across steps, see derive.forward_accumulation)
    *_level_vars(),
]}

# Variables read from the 9 km IFS surface file (pressure levels come from the 0.25 degree IFS dataset)
SOURCE_VARS = [
    "temperature_2m", "dew_point_2m", "wind_u_component_10m", "wind_v_component_10m",
    "wind_gusts_10m", "pressure_msl", "precipitation", "cloud_cover", "cape",
    "total_column_integrated_water_vapour",
    "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high", "visibility", "shortwave_radiation",
    "convective_inhibition",
]
