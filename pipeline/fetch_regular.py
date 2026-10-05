"""Generic fetcher for global models that Open-Meteo's bucket publishes as regular latitude/longitude `.om` datasets.

Everything model-specific lives in a `RegularModel` description (see models_regular.py): which datasets, which
variables, which run hours. The grid of each file is read from the file itself (its shape) and from the BBOX in the
dataset's latest.json, so no grid constants are hard-coded. Units are normalised (Kelvin, km/h, Pa vs hPa...), wind
given as speed and direction is converted to u/v, and the accumulation window of the rain field is taken from the
spacing of the model's own output times.
"""
from __future__ import annotations
import math
import os
import re
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Mapping

import numpy as np
import omfiles
import requests

from config import BUCKET_URL, LAT_MAX, LAT_MIN, LON_MAX, LON_MIN, NX, NY, STEP_DEG
from derive import unavailable_for
from net import download
from regular import regrid_regular, window_indices

LATS = LAT_MAX - STEP_DEG * np.arange(NY)
LONS = LON_MIN + STEP_DEG * np.arange(NX)

_BBOX = re.compile(r"BBOX\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]")

# keys derive.py needs: models that lack one still get an (empty) field so derive() works; it is simply not published
REQUIRED_KEYS = ("temperature_2m", "wind_u_component_10m", "wind_v_component_10m", "wind_gusts_10m", "pressure_msl",
                 "precipitation", "cloud_cover", "cape", "total_column_integrated_water_vapour")


def parse_bbox(crs_wkt: str) -> tuple[float, float, float, float]:
    """(south, west, north, east) of the grid-point centres, from a dataset's latest.json crs_wkt."""
    m = _BBOX.search(crs_wkt)
    if not m:
        raise ValueError("no BBOX in crs_wkt")
    south, west, north, east = (float(x) for x in m.groups())
    return south, west, north, east


@dataclass(frozen=True)
class GridGeometry:
    rows: int
    cols: int
    lat_first: float   # latitude of row 0 (the southern edge)
    dlat: float
    lon_first: float   # longitude of column 0
    dlon: float


def grid_geometry(bbox: tuple[float, float, float, float], rows: int, cols: int) -> GridGeometry:
    south, west, north, east = bbox
    return GridGeometry(rows, cols, south, (north - south) / (rows - 1), west, (east - west) / (cols - 1))


def speed_dir_to_uv(speed: np.ndarray, direction_deg: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Wind speed and the direction it blows FROM (meteorological degrees) to eastward u and northward v."""
    rad = np.radians(direction_deg)
    return (-speed * np.sin(rad)).astype(np.float32), (-speed * np.cos(rad)).astype(np.float32)


def to_si(kind: str, unit: str, arr: np.ndarray) -> np.ndarray:
    """Convert one variable to the units derive.py expects: degC, m/s, Pa, mm."""
    u = unit.replace("°", "").replace("�", "").strip().lower()
    if kind == "temperature":
        return arr - 273.15 if u in ("k", "kelvin") else arr
    if kind == "speed":
        if u in ("km/h", "kmh", "kph"):
            return arr / 3.6
        if u in ("kn", "kt", "kts", "knots"):
            return arr * 0.514444
        return arr
    if kind == "pressure":
        if u == "hpa" or u == "mbar":
            return arr * 100.0
        if u == "kpa":
            return arr * 1000.0
        return arr
    if kind == "precip":
        return arr * 1000.0 if u == "m" else arr
    return arr


def _kind(key: str) -> str | None:
    if key == "temperature_2m":
        return "temperature"
    if key == "pressure_msl":
        return "pressure"
    if key == "precipitation":
        return "precip"
    if key.startswith("wind_"):
        return "speed"
    return None


@dataclass(frozen=True)
class Source:
    """One dataset of a model and the variables to take from it."""
    dataset: str
    vars: Mapping[str, str]                                # derive key -> variable name in the dataset
    winds: tuple[tuple[str, str, str, str], ...] = ()      # (u key, v key, speed variable, direction variable)


@dataclass
class DatasetInfo:
    reference: datetime
    offsets: list[float]   # hours after the reference time at which the dataset has output
    bbox: tuple[float, float, float, float]


def dataset_info(dataset: str) -> DatasetInfo:
    j = requests.get(f"{BUCKET_URL}/data_spatial/{dataset}/latest.json", timeout=30).json()
    if not j.get("completed"):
        raise RuntimeError(f"{dataset}: latest run is still in progress")
    ref = datetime.strptime(j["reference_time"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    offsets = sorted((datetime.strptime(t, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc) - ref).total_seconds() / 3600
                     for t in j["valid_times"])
    return DatasetInfo(ref, offsets, parse_bbox(j["crs_wkt"]))


def accumulation_window(offsets: list[float], step_h: float) -> int:
    """Hours the rain value at `step_h` covers: the gap between that output time and the previous one."""
    prev = [o for o in offsets if o < step_h]
    if not prev:
        return 1
    return max(int(round(step_h - prev[-1])), 1)


def read_dataset_vars(path: str, names: list[str], bbox: tuple[float, float, float, float]) -> dict[str, np.ndarray]:
    """Read variables from one local file and resample them to the pipeline grid; missing ones come back as NaN."""
    reader = omfiles.OmFileReader(path)
    out: dict[str, np.ndarray] = {}
    geom: GridGeometry | None = None
    window: tuple[int, int, int, int] | None = None
    for name in names:
        try:
            var = reader.get_child_by_name(name)
        except ValueError:
            out[name] = np.full((NY, NX), np.nan, np.float32)
            continue
        if geom is None:
            rows, cols = var.shape[-2], var.shape[-1]
            geom = grid_geometry(bbox, rows, cols)
            r0, r1 = window_indices(geom.lat_first, geom.dlat, rows, LAT_MIN, LAT_MAX)
            c0, c1 = window_indices(geom.lon_first, geom.dlon, cols, LON_MIN, LON_MAX)
            window = (r0, r1, c0, c1)
        r0, r1, c0, c1 = window  # type: ignore[misc]
        block = np.asarray(var[r0:r1, c0:c1], np.float32)
        try:
            unit = var.get_child_by_name("unit").read_scalar()
        except Exception:
            unit = ""
        k = _kind(name)
        if k:
            block = to_si(k, str(unit), block)
        out[name] = regrid_regular(block, geom.lat_first + r0 * geom.dlat, geom.dlat,
                                   geom.lon_first + c0 * geom.dlon, geom.dlon, LATS, LONS)
    del reader
    return out


class RegularModel:
    """A model made of one or more regular-grid datasets; offers the same interface as the fetch_*.py modules."""

    def __init__(self, *, model_id: str, label: str, sources: list[Source], run_hours: tuple[int, ...],
                 step_hours: list[int]) -> None:
        self.MODEL_ID = model_id
        self.LABEL = label
        self.sources = sources
        self.RUN_HOURS = run_hours
        self.STEP_HOURS = step_hours
        provided = {k for s in sources for k in s.vars} | {k for s in sources for w in s.winds for k in w[:2]}
        self.PROVIDES = frozenset(provided)
        self.UNAVAILABLE_VARS = unavailable_for(provided)  # published variables this model cannot supply
        self.PRECIP_NOTE = "mm/h: mean rate over the output interval before the valid time (the model's own accumulation window)"
        self._info: dict[str, DatasetInfo] = {}

    # -- run selection -------------------------------------------------------------------------------------------
    def latest_run(self) -> datetime:
        """Newest run that every dataset of the model has finished (the oldest of their latest runs)."""
        self._info = {s.dataset: dataset_info(s.dataset) for s in self.sources}
        return min(i.reference for i in self._info.values())

    def _offsets(self, dataset: str, run: datetime) -> list[float]:
        info = self._info.get(dataset)
        return info.offsets if info else []

    def steps_for(self, run: datetime) -> list[int]:
        """The wanted steps that exist in every dataset (shorter runs publish fewer steps)."""
        have = [set(self._offsets(s.dataset, run)) for s in self.sources]
        return [h for h in self.STEP_HOURS if all(h in o for o in have)]

    def precip_window_hours(self, step_h: int) -> int:
        return accumulation_window(self._offsets(self.sources[0].dataset, datetime.now(timezone.utc)), step_h)

    # -- data ----------------------------------------------------------------------------------------------------
    @staticmethod
    def file_url(dataset: str, run: datetime, step_h: int) -> str:
        valid = run + timedelta(hours=step_h)
        return f"{BUCKET_URL}/data_spatial/{dataset}/{run:%Y/%m/%d/%H}00Z/{valid:%Y-%m-%dT%H}00.om"

    def read_step(self, run: datetime, step_h: int, workdir: str | None = None) -> dict[str, np.ndarray]:
        """Download one forecast hour of every dataset and return the raw fields on the pipeline grid."""
        with tempfile.TemporaryDirectory(dir=workdir) as tmp:
            paths = {s.dataset: os.path.join(tmp, f"{i}.om") for i, s in enumerate(self.sources)}
            with ThreadPoolExecutor(len(paths)) as pool:
                list(pool.map(lambda s: download(self.file_url(s.dataset, run, step_h), paths[s.dataset]), self.sources))
            out: dict[str, np.ndarray] = {}
            for s in self.sources:
                info = self._info[s.dataset]
                wind_vars = [v for w in s.winds for v in w[2:]]
                names = list(dict.fromkeys(list(s.vars.values()) + wind_vars))
                data = read_dataset_vars(paths[s.dataset], names, info.bbox)
                for key, name in s.vars.items():
                    out[key] = data[name]
                for u_key, v_key, speed_name, dir_name in s.winds:
                    out[u_key], out[v_key] = speed_dir_to_uv(data[speed_name], data[dir_name])
        for key in REQUIRED_KEYS:
            out.setdefault(key, np.full((NY, NX), np.nan, np.float32))
        return out
