"""Descriptions of the regular-grid models (see fetch_regular.py). Adding another model of this kind is one entry here."""
from __future__ import annotations
from fetch_regular import RegularModel, Source

# the names Open-Meteo uses for the same quantities in most datasets (keys are what derive.py reads)
_SURFACE = {
    "temperature_2m": "temperature_2m",
    "relative_humidity_2m": "relative_humidity_2m",
    "wind_u_component_10m": "wind_u_component_10m",
    "wind_v_component_10m": "wind_v_component_10m",
    "wind_gusts_10m": "wind_gusts_10m",
    "pressure_msl": "pressure_msl",
    "precipitation": "precipitation",
    "cloud_cover": "cloud_cover",
    "cape": "cape",
}
_ALOFT = {f"wind_{c}_component_{p}hPa": f"wind_{c}_component_{p}hPa" for c in ("u", "v") for p in (850, 500)}
_ALL_UV = {**_SURFACE, **_ALOFT}


def _speed_dir(level: str, u_key: str, v_key: str) -> tuple[str, str, str, str]:
    return (u_key, v_key, f"wind_speed_{level}", f"wind_direction_{level}")


def _without(d: dict[str, str], *keys: str) -> dict[str, str]:
    return {k: v for k, v in d.items() if k not in keys}


STEPS_3H_144 = list(range(0, 145, 3))

# DWD ICON global (13 km). 00Z and 12Z runs reach furthest.
ICON = RegularModel(
    model_id="dwd_icon", label="DWD ICON", run_hours=(0, 12), step_hours=STEPS_3H_144,
    sources=[Source("dwd_icon", _ALL_UV)],
    unavailable={"tcwv"},
)

# UK Met Office global deterministic, ~10 km. Short range (about 2.5 days) and big files, so two runs a day.
UKMO = RegularModel(
    model_id="ukmo", label="UK Met Office", run_hours=(0, 12), step_hours=list(range(0, 61, 3)),
    sources=[Source(
        "ukmo_global_deterministic_10km",
        _without(_SURFACE, "wind_u_component_10m", "wind_v_component_10m"),
        winds=(_speed_dir("10m", "wind_u_component_10m", "wind_v_component_10m"),
               _speed_dir("850hPa", "wind_u_component_850hPa", "wind_v_component_850hPa"),
               _speed_dir("500hPa", "wind_u_component_500hPa", "wind_v_component_500hPa")),
    )],
    unavailable={"tcwv"},
)

# Meteo-France ARPEGE world 0.25 degrees.
ARPEGE = RegularModel(
    model_id="arpege", label="Meteo-France ARPEGE", run_hours=(0, 6, 12, 18), step_hours=list(range(0, 103, 3)),
    sources=[Source("meteofrance_arpege_world025", _ALL_UV)],
    unavailable={"tcwv"},
)

# Environment Canada GDPS ~15 km: surface fields and the pressure levels are separate datasets, both as speed + direction.
GDPS = RegularModel(
    model_id="gdps", label="Canada GDPS", run_hours=(0, 12), step_hours=STEPS_3H_144,
    sources=[
        Source("cmc_gem_gdps_15km", _without(_SURFACE, "wind_u_component_10m", "wind_v_component_10m", "cape"),
               winds=(_speed_dir("10m", "wind_u_component_10m", "wind_v_component_10m"),)),
        Source("cmc_gem_gdps_15km_upper_level", {},
               winds=(_speed_dir("850hPa", "wind_u_component_850hPa", "wind_v_component_850hPa"),
                      _speed_dir("500hPa", "wind_u_component_500hPa", "wind_v_component_500hPa"))),
    ],
    unavailable={"cape", "tcwv"},
)

# JMA GSM (about 55 km), 6-hourly. Small files, no gusts or CAPE.
JMA = RegularModel(
    model_id="jma_gsm", label="JMA GSM", run_hours=(0, 6, 12, 18), step_hours=list(range(0, 133, 6)),
    sources=[Source("jma_gsm", _without(_ALL_UV, "wind_gusts_10m", "cape"))],
    unavailable={"gust", "cape", "tcwv"},
)

# China Meteorological Administration GRAPES global (~15 km). Large files, so every other output step and two runs a day.
GRAPES = RegularModel(
    model_id="cma_grapes", label="CMA GRAPES", run_hours=(0, 12), step_hours=list(range(0, 121, 6)),
    sources=[Source("cma_grapes_global", _ALL_UV)],
    unavailable={"tcwv"},
)

# NCEP AI-GFS (AI model, 0.25 degrees), 6-hourly. No humidity, gusts or CAPE.
AIGFS = RegularModel(
    model_id="aigfs", label="NCEP AI-GFS", run_hours=(0, 6, 12, 18), step_hours=list(range(0, 145, 6)),
    sources=[Source("ncep_aigfs025", _without(_ALL_UV, "relative_humidity_2m", "wind_gusts_10m", "cape"))],
    unavailable={"rh", "feels", "gust", "cape", "tcwv"},
)

ALL: tuple[RegularModel, ...] = (ICON, UKMO, ARPEGE, GDPS, JMA, GRAPES, AIGFS)
