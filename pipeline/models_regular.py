"""Descriptions of the regular-grid models (see fetch_regular.py). Adding another model of this kind is one entry here.

Each entry lists, per dataset, the raw variables to read (keys are Open-Meteo's names). What a model cannot supply is
worked out from what it lists (derive.unavailable_for), so nothing is declared twice.
"""
from __future__ import annotations
import config as C
from config import LEVELS
from fetch_regular import Grid, RegularModel, Source

_SAME = lambda names: {n: n for n in names}  # noqa: E731 - raw key and dataset variable share a name

SURFACE_CORE = ["temperature_2m", "relative_humidity_2m", "pressure_msl", "precipitation", "cloud_cover"]
SURFACE_UV = ["wind_u_component_10m", "wind_v_component_10m"]
GUST_CAPE = ["wind_gusts_10m", "cape"]
CIN = ["convective_inhibition"]                 # published as its magnitude (the UK Met Office stores it as a negative number)
CIN_LI = ["convective_inhibition", "lifted_index"]
CLOUD_LAYERS = ["cloud_cover_low", "cloud_cover_mid", "cloud_cover_high"]


def level_scalars(skip: tuple[str, ...] = ()) -> list[str]:
    """Temperature, humidity and height at every pressure level (minus any the dataset lacks)."""
    names = [f"{kind}_{lvl}hPa" for lvl in LEVELS for kind in ("temperature", "relative_humidity", "geopotential_height")]
    return [n for n in names if n not in skip]


def level_w() -> list[str]:
    return [f"vertical_velocity_{lvl}hPa" for lvl in LEVELS]


def level_uv() -> list[str]:
    return [f"wind_{c}_component_{lvl}hPa" for lvl in LEVELS for c in ("u", "v")]


def speed_dir(level: str, u_key: str, v_key: str) -> tuple[str, str, str, str]:
    """A wind published as speed and direction in the dataset (converted to u/v when read)."""
    return (u_key, v_key, f"wind_speed_{level}", f"wind_direction_{level}")


def level_speed_dir() -> tuple[tuple[str, str, str, str], ...]:
    return tuple(speed_dir(f"{lvl}hPa", f"wind_u_component_{lvl}hPa", f"wind_v_component_{lvl}hPa") for lvl in LEVELS)


STEPS_3H_144 = list(range(0, 145, 3))

# all of India on the 0.1 degree grid (the same box as ECMWF IFS, so the two models line up and share the terrain's model ground)
INDIA_GRID = Grid(C.IFS_LAT_MIN, C.IFS_LAT_MAX, C.IFS_LON_MIN, C.IFS_LON_MAX, C.STEP_DEG, C.IFS_DOMAIN)

# UK Met Office global deterministic, ~10 km. Short range (about 2.5 days) and big files, so two runs a day.
UKMO = RegularModel(
    model_id="ukmo", label="UK Met Office", run_hours=(0, 6, 12, 18), step_hours=list(range(0, 61, 3)), grid=INDIA_GRID,
    sources=[Source(
        "ukmo_global_deterministic_10km",
        _SAME(SURFACE_CORE + GUST_CAPE + CIN + CLOUD_LAYERS + ["visibility"] + level_scalars() + level_w()),
        winds=(speed_dir("10m", "wind_u_component_10m", "wind_v_component_10m"), *level_speed_dir()),
    )],
)


# the three forecasts added for a five-day view: they are coarser (25 km), so they are drawn on a 0.25 degree grid of the same
# box (about 15 thousand cells instead of 96 thousand: their five days of pictures stay small on the site)
COARSE_GRID = Grid(C.IFS_LAT_MIN, C.IFS_LAT_MAX, C.IFS_LON_MIN, C.IFS_LON_MAX, 0.25, "india-0.25-5-37.5N-68-97.5E")
# every step each forecast publishes (Open-Meteo): GFS hourly to +120 h then 3-hourly to +384 h, of which every 3 h to +120 h and every
# 6 h after; AIGFS every 6 h to +384 h; AIFS every 6 h to +360 h. A run built shorter than this just publishes the steps it has.
GFS_STEPS = list(range(0, 121, 3)) + list(range(126, 385, 6))
AIGFS_STEPS = list(range(0, 385, 6))
AIFS_STEPS = list(range(0, 361, 6))
LEVEL_SCALARS = level_scalars()                  # temperature, humidity and height at every pressure level

# NOAA GFS: 13 km surface fields (ncep_gfs013) and the pressure levels, gusts, CAPE and pressure at 25 km (ncep_gfs025).
# The 00Z and 12Z runs, every 3 hours to +120 h.
GFS = RegularModel(
    model_id="gfs", label="NOAA GFS", run_hours=(0, 6, 12, 18), step_hours=GFS_STEPS, grid=COARSE_GRID,
    sources=[
        Source("ncep_gfs013", _SAME(["temperature_2m", "relative_humidity_2m", "precipitation", "cloud_cover", "shortwave_radiation"] + SURFACE_UV)),
        Source("ncep_gfs025", _SAME(["pressure_msl", "wind_gusts_10m", "cape", "convective_inhibition", "lifted_index", "visibility"]
                                    + LEVEL_SCALARS + level_w() + level_uv())),
    ],
)

# NOAA AIGFS (AI forecast of NOAA): 25 km, every 6 hours to +384 h.
AIGFS = RegularModel(
    model_id="aigfs", label="NOAA AIGFS", run_hours=(0, 6, 12, 18), step_hours=AIGFS_STEPS, grid=COARSE_GRID,
    sources=[Source(
        "ncep_aigfs025",
        _SAME(["temperature_2m", "precipitation", "cloud_cover", "pressure_msl", "wind_gusts_10m"] + SURFACE_UV + LEVEL_SCALARS + level_w() + level_uv()),
    )],
)

# ECMWF AIFS (single level, the open AI model): 25 km, every 6 hours to +360 h.
AIFS = RegularModel(
    model_id="aifs", label="ECMWF AIFS", run_hours=(0, 6, 12, 18), step_hours=AIFS_STEPS, grid=COARSE_GRID,
    sources=[Source(
        "ecmwf_aifs025_single",
        _SAME(["temperature_2m", "relative_humidity_2m", "pressure_msl", "precipitation", "cloud_cover", "shortwave_radiation"]
              + CLOUD_LAYERS + SURFACE_UV + LEVEL_SCALARS + level_w() + level_uv()),
    )],
)


# DWD ICON global (13 km): among the best at the South Indian airports and the Tamil Nadu gauges (verify.py, verify_gauges.py). Each output
# hour is a 171 MB file of the whole globe, so only the 00Z and 12Z runs, every 3 hours to +120 h (about 7 GB read a run), drawn on the
# 0.25 degree grid (about 80 MB published: the site stays under GitHub Pages' 1 GB). It has no vertical velocity, CIN, lifted index,
# visibility or sunshine: those layers are greyed out for it.
ICON_STEPS = list(range(0, 121, 3))
ICON = RegularModel(
    model_id="icon", label="DWD ICON", run_hours=(0, 12), step_hours=ICON_STEPS, grid=COARSE_GRID,
    sources=[Source("dwd_icon", _SAME(SURFACE_CORE + SURFACE_UV + GUST_CAPE + CLOUD_LAYERS + LEVEL_SCALARS + level_uv()))],
)


ALL: tuple[RegularModel, ...] = (UKMO, GFS, AIGFS, AIFS, ICON)
