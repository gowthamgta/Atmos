"""Descriptions of the regular-grid models (see fetch_regular.py). Adding another model of this kind is one entry here.

Each entry lists, per dataset, the raw variables to read (keys are Open-Meteo's names). What a model cannot supply is
worked out from what it lists (derive.unavailable_for), so nothing is declared twice.
"""
from __future__ import annotations
from config import LEVELS
from fetch_regular import RegularModel, Source

_SAME = lambda names: {n: n for n in names}  # noqa: E731 - raw key and dataset variable share a name

SURFACE_CORE = ["temperature_2m", "relative_humidity_2m", "pressure_msl", "precipitation", "cloud_cover"]
SURFACE_UV = ["wind_u_component_10m", "wind_v_component_10m"]
GUST_CAPE = ["wind_gusts_10m", "cape"]
CLOUD_LAYERS = ["cloud_cover_low", "cloud_cover_mid", "cloud_cover_high"]


def level_scalars(skip: tuple[str, ...] = ()) -> list[str]:
    """Temperature, humidity and height at every pressure level (minus any the dataset lacks)."""
    names = [f"{kind}_{lvl}hPa" for lvl in LEVELS for kind in ("temperature", "relative_humidity", "geopotential_height")]
    return [n for n in names if n not in skip]


def level_uv() -> list[str]:
    return [f"wind_{c}_component_{lvl}hPa" for lvl in LEVELS for c in ("u", "v")]


def speed_dir(level: str, u_key: str, v_key: str) -> tuple[str, str, str, str]:
    """A wind published as speed and direction in the dataset (converted to u/v when read)."""
    return (u_key, v_key, f"wind_speed_{level}", f"wind_direction_{level}")


def level_speed_dir() -> tuple[tuple[str, str, str, str], ...]:
    return tuple(speed_dir(f"{lvl}hPa", f"wind_u_component_{lvl}hPa", f"wind_v_component_{lvl}hPa") for lvl in LEVELS)


STEPS_3H_144 = list(range(0, 145, 3))

# DWD ICON global (13 km). 00Z and 12Z runs reach furthest.
ICON = RegularModel(
    model_id="dwd_icon", label="DWD ICON", run_hours=(0, 12), step_hours=STEPS_3H_144,
    sources=[Source("dwd_icon", _SAME(SURFACE_CORE + SURFACE_UV + GUST_CAPE + CLOUD_LAYERS + level_uv() + level_scalars()))],
)

# UK Met Office global deterministic, ~10 km. Short range (about 2.5 days) and big files, so two runs a day.
UKMO = RegularModel(
    model_id="ukmo", label="UK Met Office", run_hours=(0, 12), step_hours=list(range(0, 61, 3)),
    sources=[Source(
        "ukmo_global_deterministic_10km",
        _SAME(SURFACE_CORE + GUST_CAPE + CLOUD_LAYERS + ["visibility"] + level_scalars()),
        winds=(speed_dir("10m", "wind_u_component_10m", "wind_v_component_10m"), *level_speed_dir()),
    )],
)

# Meteo-France ARPEGE world 0.25 degrees.
ARPEGE = RegularModel(
    model_id="arpege", label="Meteo-France ARPEGE", run_hours=(0, 6, 12, 18), step_hours=list(range(0, 103, 3)),
    sources=[Source("meteofrance_arpege_world025",
                    _SAME(SURFACE_CORE + SURFACE_UV + GUST_CAPE + CLOUD_LAYERS + ["shortwave_radiation"] + level_uv() + level_scalars()))],
)

# Environment Canada GDPS ~15 km: surface fields and the pressure levels are separate datasets, winds as speed + direction.
GDPS = RegularModel(
    model_id="gdps", label="Canada GDPS", run_hours=(0, 12), step_hours=STEPS_3H_144,
    sources=[
        Source("cmc_gem_gdps_15km", _SAME(SURFACE_CORE + ["wind_gusts_10m", "shortwave_radiation"]),
               winds=(speed_dir("10m", "wind_u_component_10m", "wind_v_component_10m"),)),
        Source("cmc_gem_gdps_15km_upper_level", _SAME(level_scalars()), winds=level_speed_dir()),
    ],
)

# JMA GSM (about 55 km), 6-hourly. Small files, no gusts or CAPE, and no humidity at 200 hPa.
JMA = RegularModel(
    model_id="jma_gsm", label="JMA GSM", run_hours=(0, 6, 12, 18), step_hours=list(range(0, 133, 6)),
    sources=[Source("jma_gsm", _SAME(SURFACE_CORE + SURFACE_UV + CLOUD_LAYERS + level_uv()
                                     + level_scalars(skip=("relative_humidity_200hPa",))))],
)

# China Meteorological Administration GRAPES global (~15 km). Large files, so every other output step and two runs a day.
GRAPES = RegularModel(
    model_id="cma_grapes", label="CMA GRAPES", run_hours=(0, 12), step_hours=list(range(0, 121, 6)),
    sources=[Source("cma_grapes_global",
                    _SAME(SURFACE_CORE + SURFACE_UV + GUST_CAPE + CLOUD_LAYERS + ["visibility", "shortwave_radiation"]
                          + level_uv() + level_scalars()))],
)

# NCEP AI-GFS (AI model, 0.25 degrees), 6-hourly. No surface humidity, gusts or CAPE.
AIGFS = RegularModel(
    model_id="aigfs", label="NCEP AI-GFS", run_hours=(0, 6, 12, 18), step_hours=list(range(0, 145, 6)),
    sources=[Source("ncep_aigfs025",
                    _SAME(["temperature_2m", "pressure_msl", "precipitation", "cloud_cover"] + SURFACE_UV + CLOUD_LAYERS
                          + level_uv() + level_scalars()))],
)

ALL: tuple[RegularModel, ...] = (ICON, UKMO, ARPEGE, GDPS, JMA, GRAPES, AIGFS)
