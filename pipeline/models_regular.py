"""Descriptions of the regular-grid models (see fetch_regular.py). Adding another model of this kind is one entry here.

Each entry lists, per dataset, the raw variables to read (keys are Open-Meteo's names). What a model cannot supply is
worked out from what it lists (derive.unavailable_for), so nothing is declared twice.
"""
from __future__ import annotations
from config import LEVELS
from fetch_regular import WORLD, RegularModel, Source

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
        _SAME(SURFACE_CORE + GUST_CAPE + CIN + CLOUD_LAYERS + ["visibility"] + level_scalars() + level_w()),
        winds=(speed_dir("10m", "wind_u_component_10m", "wind_v_component_10m"), *level_speed_dir()),
    )],
)


# ECMWF IFS for the whole globe, on a 1 degree grid (the open 0.25 degree dataset, resampled; a quarter of the size of 0.5 degrees). Surface fields only, so
# the file set stays small enough for the free hosting (every 6 hours to +144 h, about 25 MB a run); it is the app's world view.
WORLD_IFS = RegularModel(
    model_id="world_ifs", label="ECMWF IFS (world)", run_hours=(0, 12), step_hours=list(range(0, 145, 6)), grid=WORLD,
    sources=[Source("ecmwf_ifs025", _SAME(SURFACE_CORE + SURFACE_UV + GUST_CAPE + CLOUD_LAYERS))],
)

ALL: tuple[RegularModel, ...] = (ICON, UKMO, WORLD_IFS)
