"""Turn raw IFS fields (SI-ish units from the .om files) into the published variables."""
from __future__ import annotations
import numpy as np


def relative_humidity(t_c: np.ndarray, td_c: np.ndarray) -> np.ndarray:
    """RH % from air and dew-point temperature (Magnus formula)."""
    a, b = 17.625, 243.04
    rh = 100.0 * np.exp(a * td_c / (b + td_c)) / np.exp(a * t_c / (b + t_c))
    return np.clip(rh, 0, 100)


def apparent_temperature(t_c: np.ndarray, rh: np.ndarray, wind_ms: np.ndarray) -> np.ndarray:
    """Feels-like temperature (Steadman / Australian BoM apparent temperature)."""
    e = rh / 100.0 * 6.105 * np.exp(17.27 * t_c / (237.7 + t_c))
    return t_c + 0.33 * e - 0.70 * wind_ms - 4.00


def derive(raw: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    t, td = raw["temperature_2m"], raw["dew_point_2m"]
    u, v = raw["wind_u_component_10m"], raw["wind_v_component_10m"]
    rh = relative_humidity(t, td)
    return {
        "t2m": t,
        "rh": rh,
        "feels": apparent_temperature(t, rh, np.hypot(u, v)),
        "u10": u,
        "v10": v,
        "gust": raw["wind_gusts_10m"],
        "msl": raw["pressure_msl"] / 100.0,
        "precip": raw["precipitation"],
        "cloud": raw["cloud_cover"],
        "cape": raw["cape"],
        "tcwv": raw["total_column_integrated_water_vapour"],
    }
