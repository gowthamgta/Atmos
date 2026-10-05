"""NOAA GFS from Open-Meteo's public bucket: surface fields from the 0.11 degree set and pressure, gusts and CAPE
from the 0.25 degree set, both resampled onto the pipeline's 0.1 degree grid.

Both datasets are regular latitude/longitude grids with row 0 at the southern edge. Values are returned with the same
keys and units as fetch_ifs.read_step (pressure in Pa), plus relative_humidity_2m (GFS has no dew point), so derive.py
treats every model alike.
"""
from __future__ import annotations
import os, tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import numpy as np
import omfiles
import requests
from config import BUCKET_URL, LAT_MAX, LAT_MIN, LON_MIN, LON_MAX, NX, NY, STEP_DEG
from fetch_ifs import download
from regular import regrid_regular, window_indices

MODEL_ID = "gfs"
LABEL = "NOAA GFS"
RUN_HOURS = (0, 6, 12, 18)
STEP_HOURS = list(range(0, 145, 3))
# Checked against Open-Meteo's hourly API: rain is mm in the preceding hour up to +120 h, then mm in the preceding 3 h
# (+126 h: file 7.65 mm vs 2.7 mm/h in the API), so it is divided by 3 after +120 h, like IFS after +90 h.
PRECIP_3H_AFTER_H: int | None = 120
PRECIP_NOTE = "mm/h: rain in the hour before the valid time (<= +120 h) or the mean rate over the 3 h before it (> +120 h)"

FINE = "ncep_gfs013"   # ~0.117 degree: temperature, humidity, wind, rain, cloud, moisture
COARSE = "ncep_gfs025"  # 0.25 degree: pressure, gusts, CAPE

# (dataset, source variable) -> key used by derive.py
FINE_VARS = ["temperature_2m", "relative_humidity_2m", "wind_u_component_10m", "wind_v_component_10m",
             "cloud_cover", "precipitation", "total_column_integrated_water_vapour"]
COARSE_VARS = ["pressure_msl", "wind_gusts_10m", "cape"]

# regular grid geometry of the two datasets (row 0 = south, column 0 = -180 degrees)
FINE_GRID = dict(rows=1536, cols=3072, lat_first=-89.912125, dlat=2 * 89.912125 / 1535, lon_first=-180.0, dlon=360 / 3072)
COARSE_GRID = dict(rows=721, cols=1440, lat_first=-90.0, dlat=0.25, lon_first=-180.0, dlon=0.25)

LATS = LAT_MAX - STEP_DEG * np.arange(NY)
LONS = LON_MIN + STEP_DEG * np.arange(NX)


def _latest(dataset: str) -> datetime:
    j = requests.get(f"{BUCKET_URL}/data_spatial/{dataset}/latest.json", timeout=30).json()
    if not j.get("completed"):
        raise RuntimeError(f"{dataset}: latest run is still in progress")
    return datetime.strptime(j["reference_time"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def latest_run() -> datetime:
    """Newest run that both datasets have finished (the older of their two latest runs)."""
    return min(_latest(FINE), _latest(COARSE))


def file_url(dataset: str, run: datetime, step_h: int) -> str:
    valid = run + timedelta(hours=step_h)
    return f"{BUCKET_URL}/data_spatial/{dataset}/{run:%Y/%m/%d/%H}00Z/{valid:%Y-%m-%dT%H}00.om"


def _read_vars(path: str, names: list[str], g: dict) -> dict[str, np.ndarray]:
    r0, r1 = window_indices(g["lat_first"], g["dlat"], g["rows"], LAT_MIN, LAT_MAX)
    c0, c1 = window_indices(g["lon_first"], g["dlon"], g["cols"], LON_MIN, LON_MAX)
    reader = omfiles.OmFileReader(path)
    out = {}
    for name in names:
        try:
            block = np.asarray(reader.get_child_by_name(name)[r0:r1, c0:c1], np.float32)
        except ValueError:  # some fields do not exist at the analysis hour
            out[name] = np.full((NY, NX), np.nan, np.float32)
            continue
        out[name] = regrid_regular(block, g["lat_first"] + r0 * g["dlat"], g["dlat"],
                                   g["lon_first"] + c0 * g["dlon"], g["dlon"], LATS, LONS)
    del reader
    return out


def read_step(run: datetime, step_h: int, workdir: str | None = None) -> dict[str, np.ndarray]:
    """Download one forecast hour of both datasets, return {variable: float32 [NY, NX]} on the 0.1 degree grid."""
    with tempfile.TemporaryDirectory(dir=workdir) as tmp:
        paths = {FINE: os.path.join(tmp, "fine.om"), COARSE: os.path.join(tmp, "coarse.om")}
        with ThreadPoolExecutor(2) as pool:
            list(pool.map(lambda d: download(file_url(d, run, step_h), paths[d]), paths))
        out = _read_vars(paths[FINE], FINE_VARS, FINE_GRID)
        coarse = _read_vars(paths[COARSE], COARSE_VARS, COARSE_GRID)
        out.update(coarse)
        out["pressure_msl"] = out["pressure_msl"] * 100.0  # hPa -> Pa, the unit derive.py expects
        return out
