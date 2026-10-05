"""Download hourly IFS .om files from Open-Meteo's public bucket and cut out the South India window."""
from __future__ import annotations
import os, tempfile, time
from datetime import datetime, timedelta, timezone
import numpy as np
import omfiles
import requests
from config import BUCKET_URL, LATEST_URL, LAT_MAX, LAT_MIN, LON_MIN, NX, NY, SOURCE_VARS, STEP_DEG
from o1280 import OFFSETS, band_rows, regrid_band

MODEL_ID = "ecmwf_ifs"
LABEL = "ECMWF IFS"
RUN_HOURS = (0, 12)                      # 00Z and 12Z runs only (they reach +240 h; we use +144 h)
STEP_HOURS = list(range(0, 145, 3))      # 3-hourly: the 1-hourly part is subsampled to keep downloads small
# IFS precipitation is mm in the preceding hour up to +90 h, then mm in the preceding 3 h (verified against
# Open-Meteo's hourly API, which divides the 3 h totals by 3). We publish mm/h throughout.
PRECIP_3H_AFTER_H: int | None = 90
PRECIP_NOTE = "mm/h: rain in the hour before the valid time (<= +90 h) or the mean rate over the 3 h before it (> +90 h)"

LATS = LAT_MAX - STEP_DEG * np.arange(NY)
LONS = LON_MIN + STEP_DEG * np.arange(NX)
R0, R1 = band_rows(LAT_MIN, LAT_MAX)
A, B = int(OFFSETS[R0]), int(OFFSETS[R1])


def latest_run() -> datetime:
    """Reference time of the newest fully published run."""
    j = requests.get(LATEST_URL, timeout=30).json()
    if not j.get("completed"):
        raise RuntimeError("latest run is still in progress")
    return datetime.strptime(j["reference_time"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def file_url(run: datetime, step_h: int) -> str:
    valid = run + timedelta(hours=step_h)
    return f"{BUCKET_URL}/data_spatial/ecmwf_ifs/{run:%Y/%m/%d/%H}00Z/{valid:%Y-%m-%dT%H}00.om"


def download(url: str, dest: str, retries: int = 4) -> None:
    for attempt in range(retries):
        try:
            with requests.get(url, stream=True, timeout=60) as r:
                r.raise_for_status()
                with open(dest, "wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
            return
        except requests.RequestException:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt * 3)


def read_step(run: datetime, step_h: int, workdir: str | None = None) -> dict[str, np.ndarray]:
    """Download one forecast hour, return {source_var: float32 [NY, NX]} on the 0.1-degree grid."""
    with tempfile.TemporaryDirectory(dir=workdir) as tmp:
        path = os.path.join(tmp, "step.om")
        download(file_url(run, step_h), path)
        reader = omfiles.OmFileReader(path)
        out = {}
        for name in SOURCE_VARS:
            try:
                flat = reader.get_child_by_name(name)[0, A:B]
            except ValueError:  # e.g. gusts, precipitation and CAPE are absent at the analysis hour
                out[name] = np.full((NY, NX), np.nan, np.float32)
                continue
            out[name] = regrid_band(np.asarray(flat, np.float32), R0, R1, LATS, LONS)
        del reader
        return out
