"""Turn a model's raw fields (Open-Meteo names and units, SI-ish) into the published variables.

Raw keys are Open-Meteo's variable names (temperature_2m, wind_u_component_850hPa, cloud_cover_low ...). Which published
variables a model can supply follows from which raw keys it has: see `unavailable_for`.
"""
from __future__ import annotations
from typing import Iterable

import numpy as np

from config import LAT_MAX, LEVELS, STEP_DEG

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


def vorticity_divergence(u: np.ndarray, v: np.ndarray, lat_max: float = LAT_MAX) -> tuple[np.ndarray, np.ndarray]:
    """Relative vorticity and horizontal divergence (both in 1e-5 per second) of a wind on the pipeline grid (row 0 = north)."""
    earth_radius = 6.371e6
    lat = np.radians(lat_max - STEP_DEG * np.arange(u.shape[0]))[:, None]
    step = np.radians(STEP_DEG)
    dx = earth_radius * np.cos(lat) * step
    dy = earth_radius * step
    dv_dx = np.gradient(v, axis=1) / dx
    du_dx = np.gradient(u, axis=1) / dx
    du_dy = -np.gradient(u, axis=0) / dy                  # rows go southwards
    dv_dy = -np.gradient(v, axis=0) / dy
    # the du/dy term with the metric: vorticity = dv/dx - du/dy + u tan(lat) / R, divergence = du/dx + dv/dy - v tan(lat) / R
    tan_term = np.tan(lat) / earth_radius
    vo = dv_dx - du_dy + u * tan_term
    dv = du_dx + dv_dy - v * tan_term
    return (vo * 1e5).astype(np.float32), (dv * 1e5).astype(np.float32)


def derive(raw: dict[str, np.ndarray], precip_window_h: int = 1, lat_max: float = LAT_MAX) -> dict[str, np.ndarray]:
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
        "li": raw.get("lifted_index", missing),
        # sources disagree on the sign (the UK Met Office stores CIN as a negative number): publish the magnitude
        "cin": np.abs(raw["convective_inhibition"]) if "convective_inhibition" in raw else missing,
    }
    for lvl in LEVELS:
        out[f"u{lvl}"] = raw.get(f"wind_u_component_{lvl}hPa", missing)
        out[f"v{lvl}"] = raw.get(f"wind_v_component_{lvl}hPa", missing)
        out[f"t{lvl}"] = raw.get(f"temperature_{lvl}hPa", missing)
        out[f"rh{lvl}"] = raw.get(f"relative_humidity_{lvl}hPa", missing)
        out[f"gh{lvl}"] = raw.get(f"geopotential_height_{lvl}hPa", missing)
        out[f"w{lvl}"] = raw.get(f"vertical_velocity_{lvl}hPa", missing)
        out[f"vo{lvl}"], out[f"dv{lvl}"] = vorticity_divergence(out[f"u{lvl}"], out[f"v{lvl}"], lat_max)
    return out


def forward_accumulation(rates: dict[int, np.ndarray], windows: dict[int, int], hours: int = 24) -> dict[int, np.ndarray]:
    """Rain over the next `hours` hours from each forecast step, in mm (NaN where the run does not reach that far).

    `rates[h]` is the published rain rate (mm/h) at step h and `windows[h]` the hours that rate averages over. Between two
    steps the rain is rate x spacing when the rate covers the whole gap (window >= spacing: exact), otherwise it is
    estimated from the mean of the rates at both ends of the gap (the model was only sampled, e.g. one hour in three).
    """
    steps = sorted(rates)
    gap_rain: dict[int, np.ndarray] = {}   # mm that fell in the gap ending at this step
    for prev, h in zip(steps, steps[1:]):
        spacing = h - prev
        rate = rates[h]
        if windows[h] < spacing and prev in rates:
            before = rates[prev]
            rate = np.where(np.isfinite(before), 0.5 * (before + rate), rate)  # step 0 has no rain field: use the later rate
        gap_rain[h] = np.nan_to_num(rate, nan=0.0) * spacing
    out: dict[int, np.ndarray] = {}
    for s in steps:
        end = s + hours
        needed = [h for h in steps if s < h <= end]
        covered = (needed[-1] == end) if needed else False
        # every gap from s to end must exist, i.e. the run has a step at `end` and none is missing in between
        if covered and sum(h - p for p, h in zip([s] + needed, needed)) == hours:
            out[s] = sum(gap_rain[h] for h in needed).astype(np.float32)
        else:
            out[s] = np.full_like(rates[s], np.nan)
    return out


def forward_extreme(fields: dict[int, np.ndarray], reduce, hours: int = 24) -> dict[int, np.ndarray]:
    """Lowest or highest (`reduce` = np.fmin / np.fmax) of a field over the next `hours` hours from each forecast step.

    The window is the step itself and every step up to `hours` later, so it is as fine as the model's own step (hourly or 3-hourly).
    NaN where the run ends before the window does, so a partial window never passes for a day's extreme.
    """
    steps = sorted(fields)
    out: dict[int, np.ndarray] = {}
    for s in steps:
        window = [h for h in steps if s <= h <= s + hours]
        if window[-1] == s + hours:
            acc = fields[window[0]]
            for h in window[1:]:
                acc = reduce(acc, fields[h])
            out[s] = acc.astype(np.float32)
        else:
            out[s] = np.full_like(fields[s], np.nan)
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
        "tmin24": [{"temperature_2m"}],
        "tmax24": [{"temperature_2m"}],
        "li": [{"lifted_index"}],
        "cin": [{"convective_inhibition"}],
    }
    for lvl in LEVELS:
        needs[f"u{lvl}"] = [{f"wind_u_component_{lvl}hPa"}]
        needs[f"v{lvl}"] = [{f"wind_v_component_{lvl}hPa"}]
        needs[f"t{lvl}"] = [{f"temperature_{lvl}hPa"}]
        needs[f"rh{lvl}"] = [{f"relative_humidity_{lvl}hPa"}]
        needs[f"gh{lvl}"] = [{f"geopotential_height_{lvl}hPa"}]
        needs[f"w{lvl}"] = [{f"vertical_velocity_{lvl}hPa"}]
        needs[f"vo{lvl}"] = needs[f"dv{lvl}"] = [{f"wind_u_component_{lvl}hPa", f"wind_v_component_{lvl}hPa"}]
    return needs


NEEDS = _needs()

# every pressure-level raw field a model might provide (wind u/v, temperature, humidity, geopotential height)
LEVEL_RAW_KEYS = tuple(
    key for lvl in LEVELS for key in (
        f"wind_u_component_{lvl}hPa", f"wind_v_component_{lvl}hPa", f"temperature_{lvl}hPa",
        f"relative_humidity_{lvl}hPa", f"geopotential_height_{lvl}hPa", f"vertical_velocity_{lvl}hPa",
    )
)


def unavailable_for(provided: Iterable[str]) -> frozenset[str]:
    """Published variables a model cannot supply, given the raw keys it provides."""
    have = set(provided)
    return frozenset(var for var, alternatives in NEEDS.items() if not any(a <= have for a in alternatives))
