"""ECMWF AIFS (the AI forecast model) from Open-Meteo's public bucket: a 0.25 degree regular grid, 6-hourly to +360 h.

Same conventions as fetch_gfs (row 0 = south). AIFS has no gusts, CAPE or column moisture, so those variables are not
published for this model (UNAVAILABLE_VARS) and the app greys the matching layers out.
"""
from __future__ import annotations
import os, tempfile
from datetime import datetime, timedelta, timezone
import numpy as np
import requests
from config import BUCKET_URL, NX, NY
from fetch_gfs import COARSE_GRID, read_regular_vars
from fetch_ifs import download

MODEL_ID = "ecmwf_aifs"
LABEL = "ECMWF AIFS"
DATASET = "ecmwf_aifs025_single"
RUN_HOURS = (0, 6, 12, 18)
STEP_HOURS = list(range(0, 145, 6))
# Checked against Open-Meteo's hourly API: each value is the total of the 6 hours before the valid time
# (file 5.1 mm vs six hourly API values summing to 5.4 mm), so it is divided by 6.
PRECIP_NOTE = "mm/h: mean rate over the 6 h before the valid time"
UNAVAILABLE_VARS: frozenset[str] = frozenset({"gust", "cape", "tcwv"})

VARS = ["temperature_2m", "relative_humidity_2m", "wind_u_component_10m", "wind_v_component_10m",
        "pressure_msl", "precipitation", "cloud_cover"]


def precip_window_hours(step_h: int) -> int:
    """Hours covered by the source precipitation value at this forecast hour."""
    return 6


def latest_run() -> datetime:
    j = requests.get(f"{BUCKET_URL}/data_spatial/{DATASET}/latest.json", timeout=30).json()
    if not j.get("completed"):
        raise RuntimeError("AIFS: latest run is still in progress")
    return datetime.strptime(j["reference_time"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def file_url(run: datetime, step_h: int) -> str:
    valid = run + timedelta(hours=step_h)
    return f"{BUCKET_URL}/data_spatial/{DATASET}/{run:%Y/%m/%d/%H}00Z/{valid:%Y-%m-%dT%H}00.om"


def read_step(run: datetime, step_h: int, workdir: str | None = None) -> dict[str, np.ndarray]:
    """Download one forecast hour, return {variable: float32 [NY, NX]} on the pipeline's 0.1 degree grid."""
    with tempfile.TemporaryDirectory(dir=workdir) as tmp:
        path = os.path.join(tmp, "step.om")
        download(file_url(run, step_h), path)
        out = read_regular_vars(path, VARS, COARSE_GRID)
    out["pressure_msl"] = out["pressure_msl"] * 100.0  # hPa -> Pa, the unit derive.py expects
    # not provided by AIFS: present as empty fields so derive() works; they are never published
    for name in ("wind_gusts_10m", "cape", "total_column_integrated_water_vapour"):
        out[name] = np.full((NY, NX), np.nan, np.float32)
    return out
