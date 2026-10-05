"""Turn a model's raw fields (Open-Meteo names and units, SI-ish) into the published variables.

Raw keys are Open-Meteo's variable names (temperature_2m, wind_u_component_850hPa, cloud_cover_low ...). Which published
variables a model can supply follows from which raw keys it has: see `unavailable_for`.
"""
from __future__ import annotations
from typing import Iterable

import numpy as np

from config import LEVELS

_A, _B = 17.625, 243.04  # Magnus formula constants


def relative_humidity(t_c: np.ndarray, td_c: np.ndarray) -> np.ndarray:
    """RH % from air and dew-point temperature (Magnus formula)."""
    rh = 100.0 * np.exp(_A * td_c / (_B + td_c)) / np.exp(_A * t_c / (_B + t_c))
    return np.clip(rh, 0, 100)


def dew_point(t_c: np.ndarray, rh: np.ndarray) -> np.ndarray:
    """Dew point (degC) from air temperature and relative humidity (inverse Magnus formula)."""
    with np.errstate(divide="ignore", invalid="ignore"):
        gamma = np.log(np.clip(rh, 0.5, 100) / 100.0) + _A * t_c / (_B + t_c)
        return (_B * gamma / (_A - gamma)).astype(np.float32)


def apparent_temperature(t_c: np.ndarray, rh: np.ndarray, wind_ms: np.ndarray) -> np.ndarray:
    """Feels-like temperature (Steadman / Australian BoM apparent temperature)."""
    e = rh / 100.0 * 6.105 * np.exp(17.27 * t_c / (237.7 + t_c))
    return t_c + 0.33 * e - 0.70 * wind_ms - 4.00


def derive(raw: dict[str, np.ndarray], precip_window_h: int = 1) -> dict[str, np.ndarray]:
    """Published variables from one model step.

    `precip_window_h`: the source precipitation is a total over this many hours (the model's accumulation window at this
    step) and is divided by it to get mm/h. Variables a model does not have come out as NaN and are not published.
    """
    t = raw["temperature_2m"]
    missing = np.full_like(t, np.nan)
    u, v = raw["wind_u_component_10m"], raw["wind_v_component_10m"]
    if "relative_humidity_2m" in raw:
        rh = np.clip(raw["relative_humidity_2m"], 0, 100)
    elif "dew_point_2m" in raw:
        rh = relative_humidity(t, raw["dew_point_2m"])
    else:
        rh = missing  # a model without humidity: rh, dew point and feels-like are not published
    dew = raw["dew_point_2m"] if "dew_point_2m" in raw else dew_point(t, rh)

    out = {
        "t2m": t,
        "rh": rh,
        "feels": apparent_temperature(t, rh, np.hypot(u, v)),
        "dew": dew,
        "u10": u,
        "v10": v,
        "gust": raw["wind_gusts_10m"],
        "msl": raw["pressure_msl"] / 100.0,
        "precip": raw["precipitation"] / float(precip_window_h),  # mm/h
        "cloud": raw["cloud_cover"],
        "cloud_low": raw.get("cloud_cover_low", missing),
        "cloud_mid": raw.get("cloud_cover_mid", missing),
        "cloud_high": raw.get("cloud_cover_high", missing),
        "vis": raw["visibility"] / 1000.0 if "visibility" in raw else missing,  # m to km
        "solar": raw.get("shortwave_radiation", missing),
        "cape": raw["cape"],
        "tcwv": raw["total_column_integrated_water_vapour"],
    }
    for lvl in LEVELS:
        out[f"u{lvl}"] = raw.get(f"wind_u_component_{lvl}hPa", missing)
        out[f"v{lvl}"] = raw.get(f"wind_v_component_{lvl}hPa", missing)
        out[f"t{lvl}"] = raw.get(f"temperature_{lvl}hPa", missing)
        out[f"rh{lvl}"] = raw.get(f"relative_humidity_{lvl}hPa", missing)
        out[f"gh{lvl}"] = raw.get(f"geopotential_height_{lvl}hPa", missing)
    return out


# --- which raw fields each published variable needs --------------------------------------------------------------
_UV10 = {"wind_u_component_10m", "wind_v_component_10m"}


def _needs() -> dict[str, list[set[str]]]:
    """Published variable -> alternative sets of raw keys; any one complete set is enough."""
    rh_sources = [{"relative_humidity_2m"}, {"temperature_2m", "dew_point_2m"}]
    needs: dict[str, list[set[str]]] = {
        "t2m": [{"temperature_2m"}],
        "rh": rh_sources,
        "feels": [{"temperature_2m", "relative_humidity_2m"} | _UV10, {"temperature_2m", "dew_point_2m"} | _UV10],
        "dew": [{"dew_point_2m"}, {"temperature_2m", "relative_humidity_2m"}],
        "u10": [{"wind_u_component_10m"}],
        "v10": [{"wind_v_component_10m"}],
        "gust": [{"wind_gusts_10m"}],
        "msl": [{"pressure_msl"}],
        "precip": [{"precipitation"}],
        "cloud": [{"cloud_cover"}],
        "cloud_low": [{"cloud_cover_low"}],
        "cloud_mid": [{"cloud_cover_mid"}],
        "cloud_high": [{"cloud_cover_high"}],
        "vis": [{"visibility"}],
        "solar": [{"shortwave_radiation"}],
        "cape": [{"cape"}],
        "tcwv": [{"total_column_integrated_water_vapour"}],
    }
    for lvl in LEVELS:
        needs[f"u{lvl}"] = [{f"wind_u_component_{lvl}hPa"}]
        needs[f"v{lvl}"] = [{f"wind_v_component_{lvl}hPa"}]
        needs[f"t{lvl}"] = [{f"temperature_{lvl}hPa"}]
        needs[f"rh{lvl}"] = [{f"relative_humidity_{lvl}hPa"}]
        needs[f"gh{lvl}"] = [{f"geopotential_height_{lvl}hPa"}]
    return needs


NEEDS = _needs()

# every pressure-level raw field a model might provide (wind u/v, temperature, humidity, geopotential height)
LEVEL_RAW_KEYS = tuple(
    key for lvl in LEVELS for key in (
        f"wind_u_component_{lvl}hPa", f"wind_v_component_{lvl}hPa", f"temperature_{lvl}hPa",
        f"relative_humidity_{lvl}hPa", f"geopotential_height_{lvl}hPa",
    )
)


def unavailable_for(provided: Iterable[str]) -> frozenset[str]:
    """Published variables a model cannot supply, given the raw keys it provides."""
    have = set(provided)
    return frozenset(var for var, alternatives in NEEDS.items() if not any(a <= have for a in alternatives))
