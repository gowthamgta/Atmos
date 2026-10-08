"""Download hourly IFS .om files from Open-Meteo's public bucket and cut out the India window."""
from __future__ import annotations
import os, tempfile
from datetime import datetime, timedelta, timezone
import numpy as np
import omfiles
import requests
from config import BUCKET_URL, LATEST_URL, IFS_DOMAIN, IFS_LAT_MAX, IFS_LAT_MIN, IFS_LON_MAX, IFS_LON_MIN, IFS_NX, IFS_NY, SOURCE_VARS, STEP_DEG
from net import download
import fetch_regular
from derive import LEVEL_RAW_KEYS, unavailable_for
from o1280 import OFFSETS, band_rows, regrid_band

MODEL_ID = "ecmwf_ifs"
LABEL = "ECMWF IFS"
RUN_HOURS = (0, 12)                      # 00Z and 12Z runs only (they reach +240 h; we use +144 h)
STEP_HOURS = list(range(0, 145, 3))      # 3-hourly: the 1-hourly part is subsampled to keep downloads small
# IFS precipitation is mm in the preceding hour up to +90 h, then mm in the preceding 3 h (verified against
# Open-Meteo's hourly API, which divides the 3 h totals by 3). We publish mm/h throughout.
PRECIP_NOTE = "mm/h: rain in the hour before the valid time (<= +90 h) or the mean rate over the 3 h before it (> +90 h)"

# the 9 km surface file plus every pressure-level field from the 0.25 degree IFS dataset (see _levels_aloft)
PROVIDES = frozenset(SOURCE_VARS) | frozenset(LEVEL_RAW_KEYS)
UNAVAILABLE_VARS: frozenset[str] = unavailable_for(PROVIDES)
_ifs025_bbox: tuple[float, float, float, float] | None = None
# Bump when the way a run is built changes so that a run already live under the old way is rebuilt: v2 = the pressure levels
# are published only with the 0.25 degree data (a run that went out with empty levels is rebuilt); v3 = the 250 hPa level and vertical velocity.
LIVE_FORMAT = 3
# Steps whose pressure levels could not be read in this process. A run with any of them is published as incomplete, so the
# next scheduled run builds it again (see run.py) instead of the empty levels staying live for twelve hours.
_level_gaps: set[int] = set()
_level_error = ""       # the first reason a step's levels could not be read (published in latest.json, for diagnosis)


def precip_window_hours(step_h: int) -> int:
    """Hours covered by the source precipitation value at this forecast hour."""
    return 3 if step_h > 90 else 1


NX, NY = IFS_NX, IFS_NY
LATS = IFS_LAT_MAX - STEP_DEG * np.arange(NY)
LONS = IFS_LON_MIN + STEP_DEG * np.arange(NX)
R0, R1 = band_rows(IFS_LAT_MIN, IFS_LAT_MAX)
# the output grid of this model (its manifest and live-run check; see run.py)
GRID = fetch_regular.Grid(IFS_LAT_MIN, IFS_LAT_MAX, IFS_LON_MIN, IFS_LON_MAX, STEP_DEG, IFS_DOMAIN)
A, B = int(OFFSETS[R0]), int(OFFSETS[R1])


def latest_run() -> datetime:
    """Reference time of the newest fully published run of the hours this model uses (RUN_HOURS).

    Open-Meteo reports the newest run, which is often a 06Z or 18Z run this model does not use: then the run before it (00Z or
    12Z) is the one to build, not nothing.
    """
    j = requests.get(LATEST_URL, timeout=30).json()
    if not j.get("completed"):
        raise RuntimeError("latest run is still in progress")
    run = datetime.strptime(j["reference_time"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    while run.hour not in RUN_HOURS:
        run -= timedelta(hours=1)
    if not _levels_published(run):
        raise RuntimeError(f"the 0.25 degree pressure-level data of run {run:%Y%m%dT%HZ} is not published yet")
    return run


def _levels_published(run: datetime) -> bool:
    """Whether Open-Meteo already has the last step of this run in the 0.25 degree dataset (where the pressure levels are).
    The 9 km surface dataset is published earlier than that one, and a run built before it would have empty levels."""
    try:
        url = fetch_regular.RegularModel.file_url("ecmwf_ifs025", run, STEP_HOURS[-1])
        return requests.head(url, timeout=30).status_code == 200
    except requests.RequestException:
        return False


def incomplete_reason() -> str:
    return _level_error


def incomplete_steps() -> list[int]:
    """Steps of the run just built whose pressure levels are empty (none when everything was read)."""
    return sorted(_level_gaps)


def file_url(run: datetime, step_h: int) -> str:
    valid = run + timedelta(hours=step_h)
    return f"{BUCKET_URL}/data_spatial/ecmwf_ifs/{run:%Y/%m/%d/%H}00Z/{valid:%Y-%m-%dT%H}00.om"


def _levels_aloft(run: datetime, step_h: int, tmp: str) -> dict[str, np.ndarray]:
    """Pressure-level fields from the 0.25 degree IFS dataset (the 9 km one has surface fields only).

    Best effort: if a step cannot be read the fields are empty (no data), which the app shows as such, rather than failing
    the whole run; the step is noted in `_level_gaps` and the run is then published as incomplete and built again later.
    """
    global _ifs025_bbox
    empty = {name: np.full((NY, NX), np.nan, np.float32) for name in LEVEL_RAW_KEYS}
    try:
        if _ifs025_bbox is None:
            _ifs025_bbox = fetch_regular.dataset_info("ecmwf_ifs025").bbox
        path = os.path.join(tmp, "aloft.om")
        download(fetch_regular.RegularModel.file_url("ecmwf_ifs025", run, step_h), path)
        return fetch_regular.read_dataset_vars(path, list(LEVEL_RAW_KEYS), _ifs025_bbox, GRID)
    except Exception as e:  # noqa: BLE001 - a missing optional dataset must not stop the run
        print(f"  pressure levels unavailable for +{step_h} h: {e}")
        global _level_error
        _level_gaps.add(step_h)
        _level_error = _level_error or f"+{step_h} h: {type(e).__name__}: {e}"[:300]
        return empty


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
        out.update(_levels_aloft(run, step_h, tmp))
        return out
