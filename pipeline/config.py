"""Domain, variables and quantisation ranges for the AtmosIQ forecast pipeline."""
from __future__ import annotations
from dataclasses import dataclass

BUCKET_URL = "https://openmeteo.s3.amazonaws.com"
LATEST_URL = f"{BUCKET_URL}/data_spatial/ecmwf_ifs/latest.json"  # ECMWF IFS

# The region the app covers: South India, Sri Lanka and the seas around them. Every data set (model fields, terrain,
# satellite overlays) is cut to this box. A regular lat/lon grid at 0.1 degrees (~11 km).
LAT_MAX, LAT_MIN = 14.5, 5.5
LON_MIN, LON_MAX = 73.0, 89.5
# Changing the domain (or anything that makes the published grids differ) changes this id: every live model is then built again
DOMAIN = "south-india-5.5-14.5N-73-89.5E"
STEP_DEG = 0.1
NY = round((LAT_MAX - LAT_MIN) / STEP_DEG) + 1      # 91 rows, north to south
NX = round((LON_MAX - LON_MIN) / STEP_DEG) + 1      # 166 columns, west to east

# Global 0.25-degree grid (~25 km) covering the entire world, used by all published forecast models on Backblaze B2.
GLOBAL_LAT_MAX, GLOBAL_LAT_MIN = 90.0, -90.0
GLOBAL_LON_MIN, GLOBAL_LON_MAX = -180.0, 180.0
GLOBAL_STEP_DEG = 0.25
GLOBAL_DOMAIN = "global-0.25"
GLOBAL_NY = round((GLOBAL_LAT_MAX - GLOBAL_LAT_MIN) / GLOBAL_STEP_DEG) + 1   # 721 rows, north to south
GLOBAL_NX = round((GLOBAL_LON_MAX - GLOBAL_LON_MIN) / GLOBAL_STEP_DEG) + 1   # 1441 columns, west to east

# ECMWF IFS and regular models share the global 0.25 degree lattice (the 90 m India terrain still sits inside it).
IFS_LAT_MAX, IFS_LAT_MIN = GLOBAL_LAT_MAX, GLOBAL_LAT_MIN
IFS_LON_MIN, IFS_LON_MAX = GLOBAL_LON_MIN, GLOBAL_LON_MAX
IFS_STEP_DEG = GLOBAL_STEP_DEG
IFS_DOMAIN = GLOBAL_DOMAIN
IFS_NY = GLOBAL_NY
IFS_NX = GLOBAL_NX

# Each model module (fetch_ifs.py) declares its own MODEL_ID, RUN_HOURS, STEP_HOURS and rain semantics.


@dataclass(frozen=True)
class Var:
    id: str
    unit: str
    lo: float          # value at encoded 0
    hi: float          # value at encoded 65535
    bits: int = 16     # precision actually stored: smooth upper-air fields keep 12 bits, which compresses ~25% better


# Pressure levels offered as "altitude" (hPa) and how high they are in the standard atmosphere, to 100 m (the app has the same table in forecast-layers.ts)
LEVELS = (925, 850, 800, 700, 600, 500, 300, 250, 200)
LEVEL_KM = {925: 0.8, 850: 1.5, 800: 2.0, 700: 3.0, 600: 4.2, 500: 5.6, 300: 9.2, 250: 10.4, 200: 11.8}

# Encoding ranges per level: temperature (degC) and geopotential height (m). Generous across all latitudes, so no value can clip.
_LEVEL_T = {925: (-45, 40), 850: (-50, 36), 800: (-52, 32), 700: (-55, 24), 600: (-60, 14), 500: (-65, 5), 300: (-75, -15), 250: (-80, -25), 200: (-85, -35)}
_LEVEL_GH = {925: (200, 1100), 850: (900, 1800), 800: (1400, 2400), 700: (2300, 3300), 600: (3500, 4700), 500: (4700, 6100), 300: (8000, 10000), 250: (9100, 11200), 200: (10600, 12800)}


def _level_vars() -> list[Var]:
    out: list[Var] = []
    for lvl in LEVELS:
        out += [
            Var(f"u{lvl}", "m/s", -90, 90, 12),
            Var(f"v{lvl}", "m/s", -90, 90, 12),
            Var(f"t{lvl}", "°C", *_LEVEL_T[lvl], 12),
            Var(f"rh{lvl}", "%", 0, 100, 12),
            Var(f"gh{lvl}", "m", *_LEVEL_GH[lvl], 12),
            Var(f"w{lvl}", "m/s", -2, 2, 12),          # vertical velocity, positive upwards (the models that publish it)
            Var(f"vo{lvl}", "10⁻⁵ s⁻¹", -60, 60, 12),  # relative vorticity, positive = anticlockwise (cyclonic in the north); derived from u and v
            Var(f"dv{lvl}", "10⁻⁵ s⁻¹", -40, 40, 12),  # horizontal divergence, positive = air spreading out; derived from u and v
        ]
    return out


VARS: dict[str, Var] = {v.id: v for v in [
    Var("t2m", "°C", -60, 55),
    Var("rh", "%", 0, 100),
    Var("feels", "°C", -70, 60),
    Var("dew", "°C", -65, 40),
    Var("u10", "m/s", -60, 60),
    Var("v10", "m/s", -60, 60),
    Var("gust", "m/s", 0, 80),
    Var("msl", "hPa", 920, 1070),
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
    Var("tmin24", "°C", -60, 55),         # lowest and highest temperature in the next 24 hours from this step (derived across steps,
    Var("tmax24", "°C", -60, 55),         # see derive.forward_extreme)
    Var("rain24", "mm", 0, 600),          # rain over the next 24 hours from this step (derived across steps, see derive.forward_accumulation)
    Var("extreme", "%", 0, 100),          # multi-model probability of rain over the next 24 hours (0 to 100 %, derived from rain24 across models)
    Var("raintot", "mm", 0, 1500),        # rain from the start of the run to this step (derived across steps, see derive.cumulative_accumulation)
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
