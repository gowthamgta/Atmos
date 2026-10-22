"""Cloud-top brightness temperatures over India from Himawari-9 (AHI), from NOAA's open copy on AWS (no account, no key).

The same output as satellite_bt.py (Meteosat), in its own folder `bt-h9/`: each scan's 10.4 um (band 13) and 3.9 um (band 7) brightness
temperatures on the app's satellite box, as PNGs with an index of the last hour.

Himawari stands over 140.7 E, so it sees India from far to the east and low down: about 60 degrees from the vertical over the Bay of
Bengal, 70 over Tamil Nadu, more over the Arabian Sea. Two consequences, handled here:
- A cloud's top is seen displaced away from the satellite (westward here) by its height times tan(view angle): about 40 km for a 15 km
  storm top over Chennai. Each cloudy pixel is moved back toward the satellite by that amount (parallax correction), its height taken from
  its temperature with the same tropical lapse rate the app uses; where a storm moved away from, the ground is filled from the warmest
  neighbours.
- Past MAX_VIEW_DEG the view is too slanted to use (pixels many km long, tops hiding each other): those cells are left empty, and the app
  falls back to its own estimate there (most of western India).

Only the four segments of the full disk that cover 5-37.5 N are downloaded (about 25 MB a scan, every 10 minutes).

  python himawari_bt.py --out bt-site [--max-new 2] [--files <local .DAT.bz2 files>]
"""
from __future__ import annotations
import argparse, os, sys, tempfile, xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

import numpy as np

import satellite_bt as S
from net import download

BUCKET = "https://noaa-himawari9.s3.amazonaws.com"
PREFIX = "AHI-L1b-FLDK"
SUB_LON = 140.7
SEGMENTS = ("02", "03", "04", "05")       # the full disk's 10 segments run north to south: 5-37.5 N lies in these
BANDS = {"B13": "IR_108", "B07": "IR_039"}  # Himawari's 10.4 and 3.9 um channels play the parts of SEVIRI's 10.8 and 3.9
MAX_VIEW_DEG = 72.0
FOLDER = "bt-h9"
EARTH_R = 6378.137
GEO_R = 42164.0
KM_PER_DEG = 111.32


def view_geometry(lat: np.ndarray, lon: np.ndarray, sub_lon: float = SUB_LON) -> tuple[np.ndarray, np.ndarray]:
    """The satellite's zenith angle (degrees) and the bearing toward the sub-satellite point (radians from north) at each place."""
    phi = np.radians(lat)
    dl = np.radians(sub_lon - lon)
    cos_g = np.cos(phi) * np.cos(dl)
    g = np.arccos(np.clip(cos_g, -1, 1))
    d = np.sqrt(EARTH_R ** 2 + GEO_R ** 2 - 2 * EARTH_R * GEO_R * cos_g)
    zenith = np.degrees(np.arcsin(np.clip(GEO_R * np.sin(g) / d, -1, 1)))
    bearing = np.arctan2(np.sin(dl), -np.sin(phi) * np.cos(dl))   # toward (0, sub_lon)
    return zenith, bearing


def cloud_height_km(kelvin: np.ndarray) -> np.ndarray:
    """The top's height from its temperature: the app's tropical lapse rate (6.2 C/km from +28 C), 0 for warm ground."""
    t = kelvin - 273.15
    return np.where(np.isfinite(t) & (t < 24), np.clip((28 - t) / 6.2, 0, 17.5), 0.0)


def _shift(a: np.ndarray, d: int, axis: int, fill: float) -> np.ndarray:
    """`a` moved by d cells along an axis, the cells it leaves filled with `fill`."""
    out = np.full_like(a, fill)
    n = a.shape[axis]
    if abs(d) >= n:
        return out
    src = [slice(None)] * a.ndim
    dst = [slice(None)] * a.ndim
    src[axis] = slice(max(0, -d), n - max(0, d))
    dst[axis] = slice(max(0, d), n - max(0, -d))
    out[tuple(dst)] = a[tuple(src)]
    return out


def max_filter(a: np.ndarray, r: int) -> np.ndarray:
    """The maximum over a (2r+1)^2 window (separable; at the edges, over the part of the window inside)."""
    out = a
    for axis in (0, 1):
        m = out.copy()
        for d in range(1, r + 1):
            m = np.maximum(m, _shift(out, d, axis, -np.inf))
            m = np.maximum(m, _shift(out, -d, axis, -np.inf))
        out = m
    return out


def box_mean(a: np.ndarray, r: int) -> np.ndarray:
    """The mean over a (2r+1)^2 window (separable cumulative sums; the edges average what is there)."""
    out = a.astype(float)
    for axis in (0, 1):
        n = out.shape[axis]
        c = np.cumsum(out, axis=axis)
        c = np.concatenate([np.zeros_like(np.take(c, [0], axis=axis)), c], axis=axis)
        idx = np.arange(n)
        hi = np.minimum(idx + r + 1, n)
        lo = np.maximum(idx - r, 0)
        out = (np.take(c, hi, axis=axis) - np.take(c, lo, axis=axis)) / np.expand_dims(hi - lo, 1 - axis).astype(float)
    return out


def bilinear(a: np.ndarray, r: np.ndarray, c: np.ndarray) -> np.ndarray:
    """`a` read at fractional (row, col), NaN outside it."""
    rows, cols = a.shape
    r0 = np.floor(r).astype(int)
    c0 = np.floor(c).astype(int)
    fr, fc = r - r0, c - c0
    inside = (r0 >= 0) & (r0 < rows - 1) & (c0 >= 0) & (c0 < cols - 1)
    r0 = np.clip(r0, 0, rows - 2)
    c0 = np.clip(c0, 0, cols - 2)
    v = (a[r0, c0] * (1 - fr) * (1 - fc) + a[r0, c0 + 1] * (1 - fr) * fc + a[r0 + 1, c0] * fr * (1 - fc) + a[r0 + 1, c0 + 1] * fr * fc)
    return np.where(inside, v, np.nan)


def parallax_correct(ir108: np.ndarray, others: list[np.ndarray], lat: np.ndarray, lon: np.ndarray, to_rc=None,
                     sub_lon: float = SUB_LON, max_view: float = MAX_VIEW_DEG, smooth_km: float = 12.0) -> tuple[np.ndarray, list[np.ndarray]]:
    """Clouds moved back to where they are: a satellite sees a cloud top displaced away from itself by the top's height x tan(view angle).

    The picture is warped backwards: each cell of the result reads the picture where its cloud was seen. The displacement comes from a
    height field first widened (a maximum over `smooth_km`, so a storm's core keeps its full height) and then smoothed over the same
    distance, so a cloud and the ground right around it move together: nothing tears at a cloud's edge, and every cell gets a value (a
    displacement worked out pixel by pixel left holes and rings of specks around storms). Cells seen beyond `max_view` are emptied (NaN).
    `lat`/`lon` are the cells' centres; `to_rc(lat, lon)` gives the (fractional) row and column of a place (for a Mercator grid); by default
    rows and columns are even steps. `sub_lon` is the satellite's longitude (Himawari by default)."""
    rows, cols = ir108.shape
    zenith, bearing = view_geometry(lat, lon, sub_lon)
    if to_rc is None:
        step_lat = lat[0, 0] - lat[1, 0]
        step_lon = lon[0, 1] - lon[0, 0]
        to_rc = lambda la, lo: ((lat[0, 0] - la) / step_lat, (lo - lon[0, 0]) / step_lon)
    # the grid's cell size (km), for the smoothing in cells
    r_mid, c_mid = rows // 2, cols // 2
    cell_km = max(1e-3, abs(lat[min(r_mid + 1, rows - 1), c_mid] - lat[r_mid, c_mid]) * KM_PER_DEG)
    k = max(1, int(round(smooth_km / cell_km)))
    h = cloud_height_km(ir108)
    h = box_mean(max_filter(h, k), k)
    shift = h * np.tan(np.radians(np.minimum(zenith, 85)))
    # where each cell's cloud really is, as a displacement in cells (seen -> true)
    true_r, true_c = to_rc(lat + shift * np.cos(bearing) / KM_PER_DEG, lon + shift * np.sin(bearing) / (KM_PER_DEG * np.cos(np.radians(lat))))
    rr, cc = np.meshgrid(np.arange(rows, dtype=float), np.arange(cols, dtype=float), indexing="ij")
    dr, dc = true_r - rr, true_c - cc
    # backwards: the seen place a of a true place x solves a + d(a) = x (a few fixed-point steps; d is smooth)
    ar, ac = rr - dr, cc - dc
    for _ in range(4):
        ar = rr - np.nan_to_num(bilinear(dr, ar, ac))
        ac = cc - np.nan_to_num(bilinear(dc, ar, ac))
    # a place whose cloud was seen just outside the grid reads the grid's edge
    ar = np.clip(np.nan_to_num(ar, nan=0.0), 0, rows - 1.001)
    ac = np.clip(np.nan_to_num(ac, nan=0.0), 0, cols - 1.001)
    out = bilinear(ir108, ar, ac)
    outs = [bilinear(o, ar, ac) for o in others]
    far = zenith > max_view
    out[far] = np.nan
    for o in outs:
        o[far] = np.nan
    return out, outs


def grid_lat_lon() -> tuple[np.ndarray, np.ndarray]:
    rows, cols = S.grid_shape()
    lat = S.NORTH - (np.arange(rows) + 0.5) * S.STEP_DEG
    lon = S.WEST + (np.arange(cols) + 0.5) * S.STEP_DEG
    return np.meshgrid(lat, lon, indexing="ij")


def read_hsd(files: list[str]) -> tuple[np.ndarray, np.ndarray]:
    """Band 13 and band 7 brightness temperatures (kelvin) of one scan's segment files, on the published grid, parallax-corrected."""
    from satpy import Scene
    from pyresample import create_area_def
    scn = Scene(reader="ahi_hsd", filenames=files)
    scn.load(list(BANDS), calibration="brightness_temperature")
    rows, cols = S.grid_shape()
    area = create_area_def("india_ll", "EPSG:4326", area_extent=[S.WEST, S.SOUTH, S.EAST, S.NORTH], shape=(rows, cols), units="degrees")
    local = scn.resample(area, resampler="nearest", radius_of_influence=8000)
    b13 = np.asarray(local["B13"].values, float)
    b07 = np.asarray(local["B07"].values, float)
    lat, lon = grid_lat_lon()
    b13, (b07,) = parallax_correct(b13, [b07], lat, lon)
    return b13, b07


def list_keys(prefix: str) -> list[str]:
    import requests
    res = requests.get(BUCKET + "/", params={"list-type": "2", "prefix": prefix}, timeout=30)
    res.raise_for_status()
    ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
    return [k.text for k in ET.fromstring(res.content).findall("s3:Contents/s3:Key", ns)]


def scan_files(t: datetime) -> list[str]:
    """The keys of a scan's segments for our bands (empty until all of them are there)."""
    keys = list_keys(f"{PREFIX}/{t:%Y/%m/%d/%H%M}/")
    want = [k for k in keys if any(f"_{b}_FLDK_R20_S{s}10" in k for b in BANDS for s in SEGMENTS)]
    return want if len(want) == len(BANDS) * len(SEGMENTS) else []


def fetch_new(folder: str, max_new: int, now: datetime) -> list[tuple[datetime, str]]:
    done = set(os.listdir(folder))
    new = []
    t = now.replace(minute=now.minute - now.minute % 10, second=0, microsecond=0)
    oldest = now - timedelta(minutes=S.KEEP_MINUTES)
    while t >= oldest and len(new) < max_new:
        if S.frame_name(t) not in done:
            keys = scan_files(t)
            if keys:
                with tempfile.TemporaryDirectory() as tmp:
                    paths = []
                    for k in keys:
                        p = os.path.join(tmp, os.path.basename(k))
                        download(f"{BUCKET}/{k}", p)
                        paths.append(p)
                    b13, b07 = read_hsd(paths)
                new.append((t, S.write_frame(folder, t, b13, b07)))
                print(f"{t:%Y-%m-%d %H:%M}Z: written ({np.nanmin(b13):.0f}-{np.nanmax(b13):.0f} K at 10.4 um)")
        t -= timedelta(minutes=10)
    return new


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-new", type=int, default=2)
    ap.add_argument("--files", nargs="*", help="read these local segment files instead (one scan), for a test")
    args = ap.parse_args()
    folder = os.path.join(args.out, FOLDER)
    os.makedirs(folder, exist_ok=True)
    now = datetime.now(timezone.utc)
    try:
        if args.files:
            name = os.path.basename(args.files[0])               # HS_H09_YYYYMMDD_HHMM_...
            t = datetime.strptime(name[7:20], "%Y%m%d_%H%M").replace(tzinfo=timezone.utc)
            b13, b07 = read_hsd(args.files)
            new = [(t, S.write_frame(folder, t, b13, b07))]
            now = t
        else:
            new = fetch_new(folder, args.max_new, now)
    except Exception as e:
        import traceback
        where = traceback.extract_tb(e.__traceback__)[-1]
        print(f"::error::Himawari: {type(e).__name__}: {e} (at {os.path.basename(where.filename)}:{where.lineno} {where.name})")
        raise
    index = S.update_index(folder, new, now)
    index["source"] = "JMA Himawari-9 AHI (NOAA open data on AWS), brightness temperature, parallax-corrected; empty beyond 72 degrees view angle"
    index["channels"] = {"r": "B13 (10.4 um)", "g": "B07 (3.9 um)"}
    import json
    with open(os.path.join(folder, "index.json"), "w") as f:
        json.dump(index, f, separators=(",", ":"))
    print(f"{len(new)} new, {len(index['frames'])} kept")
    return 0


if __name__ == "__main__":
    sys.exit(main())
