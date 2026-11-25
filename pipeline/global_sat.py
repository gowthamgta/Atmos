"""Global Best-View-Angle Satellite Mosaics (bt-global and rgb-global):
Stitches GOES-West (-137.2), GOES-East (-75.2), Meteosat-0 (0.0), Meteosat-9 (+45.5),
and Himawari-9 (+140.7) onto a Web Mercator (EPSG:3857) global grid (-72.5..+72.5 lat).

Every overlapping pixel selects (with soft zenith feathering) the satellite with the
smallest viewing zenith angle (best viewing geometry). Writes:
  - bt-global/<timestamp>.png + index.json (calibrated Kelvin IR, last 6 frames)
  - rgb-global/<timestamp>.webp + index.json (GeoColor RGB day+night, last 6 frames)
"""
from __future__ import annotations

import argparse
import concurrent.futures
from datetime import datetime, timedelta, timezone
import io
import json
import math
import os
import re
import tempfile
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image
import requests

import satellite_bt as S

WEST, EAST = -180.0, 180.0
SOUTH, NORTH = -72.5, 72.5
MAX_VIEW_DEG = 80.5
FEATHER_DEG = 1.8
MAX_FRAMES = 6

R_EARTH_M = 6378137.0
EARTH_R_KM = 6378.137
GEO_R_KM = 42164.0

GRID_W = 2400


def _merc_y(lat: np.ndarray | float) -> np.ndarray | float:
    return np.log(np.tan(np.pi / 4.0 + np.radians(lat) / 2.0))


_Y_NORTH = float(_merc_y(NORTH))
_Y_SOUTH = float(_merc_y(SOUTH))
GRID_H = round(GRID_W * (_Y_NORTH - _Y_SOUTH) / (2.0 * math.pi))

GOES_BUCKETS = (
    ("goes-east", -75.2, ("noaa-goes19", "noaa-goes16")),
    ("goes-west", -137.2, ("noaa-goes18",)),
)

# Compatibility constants for downstream / test inspection
LAT_MAX, LAT_MIN = NORTH, SOUTH
LON_MIN, LON_MAX = WEST, EAST
STEP_DEG = 0.25


def mercator_lat_lon(w: int = GRID_W, h: int = GRID_H) -> tuple[np.ndarray, np.ndarray]:
    """Return 2-D broadcastable (LAT (h,1), LON (1,w)) arrays for the Web Mercator grid."""
    xs = np.linspace(-math.pi, math.pi, w, endpoint=False) + (math.pi / w)
    ys = _Y_NORTH + (np.arange(h) + 0.5) * ((_Y_SOUTH - _Y_NORTH) / h)
    lon = np.degrees(xs)[None, :]
    lat = np.degrees(2.0 * np.arctan(np.exp(ys)) - math.pi / 2.0)[:, None]
    return lat.astype(np.float64), lon.astype(np.float64)


def sat_zenith(lat: np.ndarray, lon: np.ndarray, sub_lon: float) -> np.ndarray:
    """Geostationary viewing zenith angle (degrees) at each (lat, lon) for sub-satellite longitude `sub_lon`."""
    phi = np.radians(lat)
    dl = np.radians(sub_lon - lon)
    cos_g = np.cos(phi) * np.cos(dl)
    g = np.arccos(np.clip(cos_g, -1.0, 1.0))
    d = np.sqrt(EARTH_R_KM ** 2 + GEO_R_KM ** 2 - 2.0 * EARTH_R_KM * GEO_R_KM * cos_g)
    return np.degrees(np.arcsin(np.clip(GEO_R_KM * np.sin(g) / d, -1.0, 1.0)))


def sun_zenith(t_utc: datetime, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """Solar zenith angle (degrees) for UTC datetime `t_utc`."""
    doy = t_utc.timetuple().tm_yday
    g = 2.0 * math.pi / 365.0 * (doy - 1 + (t_utc.hour - 12.0) / 24.0)
    decl = (
        0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g)
        - 0.006758 * math.cos(2 * g) + 0.000907 * math.sin(2 * g)
    )
    eqt = 229.18 * (
        0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g)
        - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g)
    )
    mins = t_utc.hour * 60.0 + t_utc.minute + eqt + 4.0 * lon
    ha = np.radians(mins / 4.0 - 180.0)
    phi = np.radians(lat)
    cos_z = np.sin(phi) * np.sin(decl) + np.cos(phi) * np.cos(decl) * np.cos(ha)
    return np.degrees(np.arccos(np.clip(cos_z, -1.0, 1.0)))


def mosaic_best_view(
    arrays: list[np.ndarray],
    zeniths: list[np.ndarray],
    max_view: float = MAX_VIEW_DEG,
    feather_deg: float = FEATHER_DEG,
) -> tuple[np.ndarray, np.ndarray]:
    """Blend overlapping satellite images favoring the smallest satellite viewing zenith angle.

    For scalar arrays (H, W) or multi-channel arrays (H, W, C), returns (blended, valid_mask).
    """
    if not arrays:
        raise ValueError("arrays must not be empty")
    zen_stack = np.stack(zeniths, axis=0)
    arr_stack = np.stack(arrays, axis=0)
    is_rgb = arr_stack.ndim == 4
    finite = np.isfinite(arr_stack).all(axis=-1) if is_rgb else np.isfinite(arr_stack)
    valid = (zen_stack <= max_view) & finite
    eff_zen = np.where(valid, zen_stack, 999.0)
    min_zen = np.min(eff_zen, axis=0)
    weights = np.where(valid, np.exp(-np.maximum(eff_zen - min_zen[None, ...], 0.0) / feather_deg), 0.0)
    w_sum = np.sum(weights, axis=0)
    has_data = w_sum > 1e-6
    safe_sum = np.maximum(w_sum, 1e-6)
    safe_arr = np.nan_to_num(arr_stack, nan=0.0)
    if is_rgb:
        blended = np.sum(safe_arr * weights[..., None], axis=0) / safe_sum[..., None]
        blended[~has_data] = 0.0
    else:
        blended = np.sum(safe_arr * weights, axis=0) / safe_sum
        blended[~has_data] = np.nan
    return blended.astype(np.float32), has_data


def _geostationary_xy(
    lat: np.ndarray,
    lon: np.ndarray,
    lon_0_deg: float,
    h_m: float,
    r_eq: float,
    r_pol: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (visible_mask, x_rad, y_rad) for geostationary fixed-grid projection."""
    lats = np.radians(lat)
    lons = np.radians(lon)
    lon_0 = math.radians(lon_0_deg)
    dlon = np.arctan2(np.sin(lons - lon_0), np.cos(lons - lon_0))
    e2 = 1.0 - (r_pol / r_eq) ** 2
    phi_c = np.arctan((r_pol / r_eq) ** 2 * np.tan(lats))
    r_c = r_pol / np.sqrt(1.0 - e2 * (np.cos(phi_c) ** 2))
    h_total = r_eq + h_m
    sx = h_total - r_c * np.cos(phi_c) * np.cos(dlon)
    sy = -r_c * np.cos(phi_c) * np.sin(dlon)
    sz = r_c * np.sin(phi_c)
    visible = (h_total * (h_total - sx)) >= (sy ** 2 + (r_eq / r_pol) ** 2 * sz ** 2)
    dist = np.sqrt(np.maximum(sx ** 2 + sy ** 2 + sz ** 2, 1e-6))
    x_out = np.arcsin(np.clip(-sy / dist, -1.0, 1.0))
    y_out = np.arctan(sz / np.where(np.abs(sx) > 1e-6, sx, 1e-6))
    return visible, x_out, y_out


def reproject_goes_to_global(
    cmi_k: np.ndarray,
    x_rad: np.ndarray,
    y_rad: np.ndarray,
    lon_0_deg: float,
    h_m: float,
    r_eq: float,
    r_pol: float,
    lat: np.ndarray | None = None,
    lon: np.ndarray | None = None,
    max_view: float = MAX_VIEW_DEG,
) -> np.ndarray:
    """Project GOES ABI fixed-grid brightness temperature onto the Web Mercator global grid."""
    if lat is None or lon is None:
        lat, lon = mercator_lat_lon()
    visible, x_out, y_out = _geostationary_xy(lat, lon, lon_0_deg, h_m, r_eq, r_pol)
    zen = sat_zenith(lat, lon, lon_0_deg)
    dx = float(x_rad[1] - x_rad[0])
    dy = float(y_rad[1] - y_rad[0])
    ix = np.round((x_out - float(x_rad[0])) / dx).astype(int)
    iy = np.round((y_out - float(y_rad[0])) / dy).astype(int)
    in_bounds = visible & (zen <= max_view) & (ix >= 0) & (ix < len(x_rad)) & (iy >= 0) & (iy < len(y_rad))
    ix_c = np.clip(ix, 0, len(x_rad) - 1)
    iy_c = np.clip(iy, 0, len(y_rad) - 1)
    sampled = np.where(in_bounds, cmi_k[iy_c, ix_c], np.nan)
    return sampled.astype(np.float32)


def reproject_disk_rgb(
    img_rgb: np.ndarray,
    sub_lon: float,
    disk_radius_frac: float,
    lat: np.ndarray,
    lon: np.ndarray,
    x_span: float = 0.15187,
    h_m: float = 35786023.0,
    r_eq: float = 6378137.0,
    r_pol: float = 6356752.31414,
    max_view: float = MAX_VIEW_DEG,
) -> tuple[np.ndarray, np.ndarray]:
    """Reproject a geostationary full-disk RGB image onto the Mercator grid with its zenith mask."""
    visible, x_out, y_out = _geostationary_xy(lat, lon, sub_lon, h_m, r_eq, r_pol)
    zen = sat_zenith(lat, lon, sub_lon)
    ny, nx, _ = img_rgb.shape
    cx, cy = (nx - 1) / 2.0, (ny - 1) / 2.0
    radius_px = disk_radius_frac * nx
    fx = cx + (x_out / x_span) * radius_px
    fy = cy - (y_out / x_span) * radius_px
    ok = visible & (zen <= max_view) & (fx >= 0) & (fx < nx - 1) & (fy >= 0) & (fy < ny - 1)
    ix = np.clip(np.round(fx).astype(int), 0, nx - 1)
    iy = np.clip(np.round(fy).astype(int), 0, ny - 1)
    sampled = img_rgb[iy, ix]
    ok = ok & (sampled.sum(axis=-1) > 8.0)
    out = np.zeros((lat.shape[0], lon.shape[1], 3), dtype=np.float32)
    out[ok] = sampled[ok]
    return out, np.where(ok, zen, 999.0).astype(np.float32)


def _latest_goes_key(bucket: str, now_utc: datetime) -> str | None:
    for delta_h in (0, 1, 2):
        dt = now_utc - timedelta(hours=delta_h)
        prefix = f"ABI-L2-CMIPF/{dt:%Y/%j/%H}/OR_ABI-L2-CMIPF-M6C13_"
        try:
            r = requests.get(f"https://{bucket}.s3.amazonaws.com/", params={"list-type": "2", "prefix": prefix}, timeout=15)
            if not r.ok:
                continue
            root = ET.fromstring(r.text)
            keys = [el.text for el in root.findall(".//{http://s3.amazonaws.com/doc/2006-03-01/}Key") if el.text]
            if keys:
                return sorted(keys)[-1]
        except Exception:
            continue
    return None


def _read_goes_nc(bucket: str, key: str, lat: np.ndarray, lon: np.ndarray) -> np.ndarray | None:
    try:
        import xarray as xr
    except ImportError:
        return None
    url = f"https://{bucket}.s3.amazonaws.com/{key}"
    with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as tf:
        tmp_path = tf.name
    try:
        r = requests.get(url, timeout=60)
        if not r.ok:
            return None
        with open(tmp_path, "wb") as f:
            f.write(r.content)
        ds = xr.open_dataset(tmp_path)
        proj = ds["goes_imager_projection"].attrs
        cmi = ds["CMI"].values.astype(np.float32)
        x_rad = ds["x"].values.astype(np.float64)
        y_rad = ds["y"].values.astype(np.float64)
        ds.close()
        return reproject_goes_to_global(
            cmi, x_rad, y_rad,
            lon_0_deg=float(proj["longitude_of_projection_origin"]),
            h_m=float(proj["perspective_point_height"]),
            r_eq=float(proj["semi_major_axis"]),
            r_pol=float(proj["semi_minor_axis"]),
            lat=lat, lon=lon,
        )
    except Exception as e:
        print(f"global_sat: failed reading {bucket}/{key}: {e}", flush=True)
        return None
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def _fetch_gmgsi_ir(now_utc: datetime, lat: np.ndarray, lon: np.ndarray) -> np.ndarray | None:
    """Fetch NOAA GMGSI_LW 5-satellite calibrated IR blend onto the Mercator grid (NaN outside)."""
    try:
        import xarray as xr
    except ImportError:
        return None
    for delta_d in (0, 1):
        dt = now_utc - timedelta(days=delta_d)
        try:
            r = requests.get(
                "https://noaa-gmgsi-pds.s3.amazonaws.com/",
                params={"list-type": "2", "prefix": f"GMGSI_LW/{dt:%Y/%m/%d}/"},
                timeout=15,
            )
            if not r.ok:
                continue
            keys = sorted([el.text for el in ET.fromstring(r.text).findall(".//{http://s3.amazonaws.com/doc/2006-03-01/}Key") if el.text])
            if not keys:
                continue
            r2 = requests.get(f"https://noaa-gmgsi-pds.s3.amazonaws.com/{keys[-1]}", timeout=45)
            if not r2.ok:
                continue
            with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as tf:
                tf.write(r2.content)
                tmp = tf.name
            try:
                ds = xr.open_dataset(tmp)
                raw = ds["data"].values[0]
                gm_lat = ds["lat"].values[:, 0]
                gm_lon = ds["lon"].values[0, :]
                ds.close()
            finally:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
            bt = np.where(raw <= 176.0, 330.0 - 0.5 * raw, 418.0 - raw).astype(np.float32)
            bt[raw <= 0] = np.nan
            iy = np.clip(np.searchsorted(-gm_lat, -lat[:, 0]), 0, len(gm_lat) - 1)
            ix = np.clip(np.searchsorted(gm_lon, lon[0, :]), 0, len(gm_lon) - 1)
            out = bt[iy[:, None], ix[None, :]]
            lat_ok = (lat[:, 0] <= float(np.max(gm_lat))) & (lat[:, 0] >= float(np.min(gm_lat)))
            out[~lat_ok, :] = np.nan
            return out
        except Exception as e:
            print(f"global_sat: GMGSI_LW fallback failed: {e}", flush=True)
    return None


def _read_regional_bt(folder: str, lat: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, np.ndarray] | None:
    """Read regional calibrated BT (bt/ or bt-h9/) into (global_k, valid_mask) on the Mercator grid."""
    idx_path = os.path.join(folder, "index.json")
    if not os.path.exists(idx_path):
        return None
    try:
        with open(idx_path, "r", encoding="utf-8") as f:
            idx = json.load(f)
        frames = idx.get("frames", [])
        if not frames:
            return None
        png_path = os.path.join(folder, frames[-1]["file"])
        if not os.path.exists(png_path):
            return None
        b = idx["bounds"]
        byte = np.array(Image.open(png_path).convert("RGB"))[..., 0]
        reg_k = S.decode_bt(byte)
        r_ny, r_nx = reg_k.shape
        lats_1d = lat[:, 0]
        lons_1d = lon[0, :]
        r_mask = (lats_1d <= b["north"]) & (lats_1d >= b["south"])
        c_mask = (lons_1d >= b["west"]) & (lons_1d <= b["east"])
        if not r_mask.any() or not c_mask.any():
            return None
        sub_lats = lats_1d[r_mask][:, None]
        sub_lons = lons_1d[c_mask][None, :]
        iy = np.clip(np.round((b["north"] - sub_lats) / (b["north"] - b["south"]) * (r_ny - 1)).astype(int), 0, r_ny - 1)
        ix = np.clip(np.round((sub_lons - b["west"]) / (b["east"] - b["west"]) * (r_nx - 1)).astype(int), 0, r_nx - 1)
        patch = reg_k[iy, ix]
        out = np.full((lat.shape[0], lon.shape[1]), np.nan, dtype=np.float32)
        out[np.ix_(r_mask, c_mask)] = patch
        return out, np.isfinite(out)
    except Exception:
        return None


def _update_index(folder_dir: str, fname: str, ts_iso: str, extra: dict) -> str:
    idx_path = os.path.join(folder_dir, "index.json")
    frames = []
    if os.path.exists(idx_path):
        try:
            with open(idx_path, "r", encoding="utf-8") as f:
                old_doc = json.load(f)
            # Reset old pre-Mercator loops so stale grids are not mixed
            if old_doc.get("projection") == "EPSG:3857" and old_doc.get("bounds") == extra["bounds"]:
                frames = old_doc.get("frames", [])
        except Exception:
            frames = []
    frames = [fr for fr in frames if fr.get("file") != fname]
    frames.append({"time": ts_iso, "file": fname})
    frames = frames[-MAX_FRAMES:]
    keep = {fr["file"] for fr in frames}
    ext = os.path.splitext(fname)[1]
    for old in os.listdir(folder_dir):
        if old.endswith((".png", ".webp")) and old not in keep:
            try:
                os.remove(os.path.join(folder_dir, old))
            except OSError:
                pass
    index_doc = {**extra, "frames": frames}
    with open(idx_path, "w", encoding="utf-8") as f:
        json.dump(index_doc, f, indent=2)
    return idx_path


def build_global_ir(out_dir: str, now_utc: datetime | None = None) -> str | None:
    """Build calibrated global IR mosaic in bt-global/ on the Web Mercator grid using best view angles."""
    now_utc = now_utc or datetime.now(timezone.utc)
    lat, lon = mercator_lat_lon()

    arrays: list[np.ndarray] = []
    zeniths: list[np.ndarray] = []

    def fetch_goes_sector(name_sub_buckets):
        _name, sub_lon, buckets = name_sub_buckets
        for bucket in buckets:
            key = _latest_goes_key(bucket, now_utc)
            if not key:
                continue
            arr = _read_goes_nc(bucket, key, lat, lon)
            if arr is not None and np.isfinite(arr).any():
                return arr, np.where(np.isfinite(arr), sat_zenith(lat, lon, sub_lon), 999.0)
        return None

    with concurrent.futures.ThreadPoolExecutor(4) as ex:
        f_gmgsi = ex.submit(_fetch_gmgsi_ir, now_utc, lat, lon)
        f_goes = [ex.submit(fetch_goes_sector, g) for g in GOES_BUCKETS]
        gmgsi = f_gmgsi.result()
        for fg in f_goes:
            res = fg.result()
            if res is not None:
                arrays.append(res[0])
                zeniths.append(res[1])

    if gmgsi is not None and np.isfinite(gmgsi).any():
        # Give GMGSI fallback higher effective zenith so fresher GOES/regional feeds win when present
        arrays.append(gmgsi)
        zeniths.append(np.where(np.isfinite(gmgsi), 78.0, 999.0))

    for sub, sub_lon in (("bt", 45.5), ("bt-h9", 140.7)):
        p = os.path.join(out_dir, sub)
        if os.path.exists(os.path.join(p, "index.json")):
            res = _read_regional_bt(p, lat, lon)
            if res is not None:
                arr_r, mask_r = res
                arrays.append(arr_r)
                zeniths.append(np.where(mask_r, sat_zenith(lat, lon, sub_lon), 999.0))

    if not arrays:
        print("global_sat: no satellite IR data available", flush=True)
        return None

    global_k, valid = mosaic_best_view(arrays, zeniths)
    if not valid.any():
        print("global_sat: no valid IR pixels", flush=True)
        return None

    bt_dir = os.path.join(out_dir, "bt-global")
    os.makedirs(bt_dir, exist_ok=True)
    ts_iso = now_utc.strftime("%Y-%m-%dT%H:%M:00Z")
    fname = f"{now_utc:%Y%m%dT%H%M}Z.png"
    Image.fromarray(S.encode_bt(global_k), "L").save(os.path.join(bt_dir, fname), "PNG", optimize=True)

    bounds = {"west": WEST, "south": SOUTH, "east": EAST, "north": NORTH}
    idx_path = _update_index(bt_dir, fname, ts_iso, {
        "version": 2,
        "projection": "EPSG:3857",
        "bounds": bounds,
        "offsetK": S.OFFSET_K,
        "stepK": S.STEP_K,
    })
    print(f"global_sat: wrote bt-global/{fname} ({GRID_W}x{GRID_H})", flush=True)
    return idx_path


def _fetch_slider_disk(sat: str, session: requests.Session | None = None) -> np.ndarray | None:
    s = session or requests.Session()
    try:
        r = s.get(f"https://rammb-slider.cira.colostate.edu/data/json/{sat}/full_disk/geocolor/latest_times.json", timeout=10)
        if not r.ok:
            return None
        ts = str(r.json()["timestamps_int"][0])
        y, m, d = ts[:4], ts[4:6], ts[6:8]
        tiles: dict[tuple[int, int], np.ndarray] = {}

        def get_t(rc: tuple[int, int]) -> None:
            row, col = rc
            u = f"https://rammb-slider.cira.colostate.edu/data/imagery/{y}/{m}/{d}/{sat}---full_disk/geocolor/{ts}/02/{row:03d}_{col:03d}.png"
            rt = s.get(u, timeout=15)
            rt.raise_for_status()
            tiles[(row, col)] = np.array(Image.open(io.BytesIO(rt.content)).convert("RGB"), dtype=np.float32)

        with concurrent.futures.ThreadPoolExecutor(8) as ex:
            list(ex.map(get_t, [(r_, c_) for r_ in range(4) for c_ in range(4)]))
        th, tw, _ = tiles[(0, 0)].shape
        full = np.zeros((4 * th, 4 * tw, 3), dtype=np.float32)
        for (r_, c_), arr in tiles.items():
            full[r_ * th:(r_ + 1) * th, c_ * tw:(c_ + 1) * tw] = arr
        return full
    except Exception as e:
        print(f"global_sat: slider {sat} failed: {e}", flush=True)
        return None


def _eumet_latest_times(session: requests.Session, layers: tuple[str, ...]) -> dict[str, str | None]:
    out: dict[str, str | None] = {la: None for la in layers}
    try:
        r = session.get("https://view.eumetsat.int/geoserver/wms?service=WMS&version=1.3.0&request=GetCapabilities", timeout=25)
        if not r.ok:
            return out
        txt = r.text
        for la in layers:
            m = re.search(rf"<Name>{re.escape(la)}</Name>.*?<Dimension name=\"time\"[^>]*>([^<]+)</Dimension>", txt, re.S)
            if m:
                parts = m.group(1).strip().split("/")
                out[la] = parts[1] if len(parts) >= 2 else parts[-1]
    except Exception:
        pass
    return out


def _fetch_eumet_cropped(
    session: requests.Session,
    layer: str,
    w_lon: float,
    e_lon: float,
    time_iso: str | None = None,
    w_px: int = 720,
    h_px: int = 860,
) -> np.ndarray | None:
    mx0, mx1 = math.radians(w_lon) * R_EARTH_M, math.radians(e_lon) * R_EARTH_M
    my0, my1 = _Y_SOUTH * R_EARTH_M, _Y_NORTH * R_EARTH_M
    params = {
        "service": "WMS", "version": "1.3.0", "request": "GetMap", "layers": layer,
        "styles": "", "crs": "EPSG:3857", "bbox": f"{mx0},{my0},{mx1},{my1}",
        "width": str(w_px), "height": str(h_px), "format": "image/png", "transparent": "true",
    }
    if time_iso:
        params["time"] = time_iso
    for _ in range(2):
        try:
            r = session.get("https://view.eumetsat.int/geoserver/wms", params=params, timeout=45)
            if r.ok:
                rgba = np.array(Image.open(io.BytesIO(r.content)).convert("RGBA"), dtype=np.float32)
                c0 = int(round((w_lon + 180.0) / 360.0 * GRID_W))
                c1 = int(round((e_lon + 180.0) / 360.0 * GRID_W))
                sub = np.array(Image.fromarray(rgba.astype(np.uint8)).resize((c1 - c0, GRID_H), Image.Resampling.BILINEAR), dtype=np.float32)
                out = np.zeros((GRID_H, GRID_W, 4), dtype=np.float32)
                out[:, c0:c1] = sub
                return out
        except Exception:
            pass
    return None


def build_global_rgb(out_dir: str, now_utc: datetime | None = None) -> str | None:
    """Build global day+night GeoColor RGB mosaic in rgb-global/ on the Web Mercator grid using best view angles."""
    now_utc = now_utc or datetime.now(timezone.utc)
    lat, lon = mercator_lat_lon()
    s = requests.Session()
    times = _eumet_latest_times(s, ("mtg_fd:rgb_geocolour", "msg_iodc:ir108"))

    with concurrent.futures.ThreadPoolExecutor(6) as ex:
        f_g18 = ex.submit(_fetch_slider_disk, "goes-18", s)
        f_g19 = ex.submit(_fetch_slider_disk, "goes-19", s)
        f_h9 = ex.submit(_fetch_slider_disk, "himawari", s)
        f_mtg = ex.submit(_fetch_eumet_cropped, s, "mtg_fd:rgb_geocolour", -82.0, 82.0, times["mtg_fd:rgb_geocolour"])
        f_iodc_vis = ex.submit(_fetch_eumet_cropped, s, "msg_iodc:vis006", -25.0, 128.0, times["msg_iodc:ir108"])
        f_iodc_ir = ex.submit(_fetch_eumet_cropped, s, "msg_iodc:ir108", -25.0, 128.0, times["msg_iodc:ir108"])

    g18, g19, h9 = f_g18.result(), f_g19.result(), f_h9.result()
    mtg_full = f_mtg.result()
    vis_full = f_iodc_vis.result()
    ir_full = f_iodc_ir.result()

    arrays: list[np.ndarray] = []
    zeniths: list[np.ndarray] = []

    if g18 is not None:
        p, z = reproject_disk_rgb(g18, -137.2, 1352.0 / 2712.0, lat, lon, x_span=0.15187)
        arrays.append(p); zeniths.append(z)
    if g19 is not None:
        p, z = reproject_disk_rgb(g19, -75.2, 1352.0 / 2712.0, lat, lon, x_span=0.15187)
        arrays.append(p); zeniths.append(z)
    if h9 is not None:
        p, z = reproject_disk_rgb(h9, 140.7, 1354.0 / 2752.0, lat, lon, x_span=0.151844, h_m=35785863.0)
        arrays.append(p); zeniths.append(z)
    if mtg_full is not None:
        z_geo = sat_zenith(lat, lon, 0.0)
        arrays.append(mtg_full[..., :3])
        zeniths.append(np.where((mtg_full[..., 3] > 20) & (z_geo <= MAX_VIEW_DEG), z_geo, 999.0).astype(np.float32))
    if vis_full is not None and ir_full is not None:
        sza = sun_zenith(now_utc, lat, lon)
        day_w = 1.0 - np.clip((sza - 78.0) / 10.0, 0.0, 1.0)
        day_w = day_w * day_w * (3.0 - 2.0 * day_w)
        # Sun-normalize daytime visible reflectance and blend smoothly into GeoColor night IR clouds
        cos_z = np.cos(np.radians(np.minimum(sza, 75.0)))
        vis_v = np.clip((vis_full[..., 0] / 255.0) / np.maximum(cos_z, 0.25) * 0.82, 0.0, 1.0)
        ir_v = np.clip((ir_full[..., 0] - 45.0) / 200.0, 0.0, 1.0)
        day_rgb = np.stack([18.0 + vis_v * 230.0, 32.0 + vis_v * 218.0, 52.0 + vis_v * 200.0], axis=-1)
        night_rgb = np.stack([12.0 + ir_v * 205.0, 16.0 + ir_v * 215.0, 28.0 + ir_v * 210.0], axis=-1)
        eff_day = np.where(vis_full[..., 3] > 20, day_w, 0.0)
        p_iodc = (eff_day[..., None] * day_rgb + (1.0 - eff_day[..., None]) * night_rgb).astype(np.float32)
        z_iodc_geo = sat_zenith(lat, lon, 45.5)
        zeniths.append(np.where((ir_full[..., 3] > 20) & (z_iodc_geo <= MAX_VIEW_DEG), z_iodc_geo + 6.0, 999.0).astype(np.float32))
        arrays.append(p_iodc)

    if not arrays:
        print("global_sat: no satellite RGB data available", flush=True)
        return None

    mosaic, valid = mosaic_best_view(arrays, zeniths)
    if not valid.any():
        print("global_sat: no valid RGB pixels", flush=True)
        return None

    rgb_dir = os.path.join(out_dir, "rgb-global")
    os.makedirs(rgb_dir, exist_ok=True)
    ts_iso = now_utc.strftime("%Y-%m-%dT%H:%M:00Z")
    fname = f"{now_utc:%Y%m%dT%H%M}Z.webp"
    alpha = np.where(valid, 255, 0).astype(np.uint8)
    rgba = np.dstack([np.clip(mosaic, 0, 255).astype(np.uint8), alpha])
    Image.fromarray(rgba, "RGBA").save(os.path.join(rgb_dir, fname), "WEBP", quality=85, method=4)

    bounds = {"west": WEST, "south": SOUTH, "east": EAST, "north": NORTH}
    idx_path = _update_index(rgb_dir, fname, ts_iso, {
        "version": 1,
        "projection": "EPSG:3857",
        "bounds": bounds,
    })
    print(f"global_sat: wrote rgb-global/{fname} ({GRID_W}x{GRID_H})", flush=True)
    return idx_path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    with concurrent.futures.ThreadPoolExecutor(2) as ex:
        f_ir = ex.submit(build_global_ir, args.out)
        f_rgb = ex.submit(build_global_rgb, args.out)
        f_ir.result()
        f_rgb.result()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
