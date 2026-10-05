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


def derive(raw: dict[str, np.ndarray], step_h: int = 0, precip_3h_after_h: int | None = None) -> dict[str, np.ndarray]:
    """Published variables from one model step.

    `raw` uses Open-Meteo's source names and units (pressure in Pa). Models without a dew point (GFS) supply
    relative_humidity_2m instead. `precip_3h_after_h`: from this forecast hour on, the source precipitation is a
    3-hour total and is divided by 3 to get mm/h (None: always hourly).
    """
    t = raw["temperature_2m"]
    u, v = raw["wind_u_component_10m"], raw["wind_v_component_10m"]
    rh = np.clip(raw["relative_humidity_2m"], 0, 100) if "relative_humidity_2m" in raw else relative_humidity(t, raw["dew_point_2m"])
    three_hourly = precip_3h_after_h is not None and step_h > precip_3h_after_h
    return {
        "t2m": t,
        "rh": rh,
        "feels": apparent_temperature(t, rh, np.hypot(u, v)),
        "u10": u,
        "v10": v,
        "gust": raw["wind_gusts_10m"],
        "msl": raw["pressure_msl"] / 100.0,
        "precip": raw["precipitation"] / (3.0 if three_hourly else 1.0),  # mm/h
        "cloud": raw["cloud_cover"],
        "cape": raw["cape"],
        "tcwv": raw["total_column_integrated_water_vapour"],
    }
