"""Global Best-View-Angle High-Definition Satellite Mosaics (rgb-global & bt-global).

Uses calibrated full-disk visible + 10.x um IR observations across GOES-West (-137.2),
GOES-East (-75.2), Meteosat-0 (0.0), Meteosat-9 (+45.5), and Himawari-9 (+140.7),
applying the exact South India `hrv_clouds_rgb` formula everywhere across the globe and
rendering both a fast global Web Mercator overview (2400x1430) and 4x2 HD sector tiles
(2560x3052 per 90°x72.5° quadrant = 10,240x6,104 px worldwide, ~3.9 km/px).
"""
from __future__ import annotations

import argparse
import concurrent.futures
from dataclasses import dataclass
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

from himawari_rgb import SUN_CAP_ZENITH, hrv_clouds_rgb
import satellite_bt as S

WEST, EAST = -180.0, 180.0
SOUTH, NORTH = -72.5, 72.5
MAX_VIEW_DEG = 80.5
FEATHER_DEG = 2.2
MAX_FRAMES = 4

R_EARTH_M = 6378137.0
EARTH_R_KM = 6378.137
GEO_R_KM = 42164.0

GRID_W = 2400
TILE_COLS = 12
TILE_ROWS = 6
RGB_TILE_W = 2560
IR_TILE_W = 1920


def _merc_y(lat: np.ndarray | float) -> np.ndarray | float:
    return np.log(np.tan(np.pi / 4.0 + np.radians(lat) / 2.0))


_Y_NORTH = float(_merc_y(NORTH))
_Y_SOUTH = float(_merc_y(SOUTH))
GRID_H = round(GRID_W * (_Y_NORTH - _Y_SOUTH) / (2.0 * math.pi))

GOES_BUCKETS = (
    ("goes-east", -75.2, ("noaa-goes19", "noaa-goes16")),
    ("goes-west", -137.2, ("noaa-goes18",)),
)
HIMAWARI_BUCKET = "https://noaa-himawari9.s3.amazonaws.com"
HIMAWARI_SEGMENTS = tuple(f"{i:02d}" for i in range(1, 11))

# Compatibility constants for downstream / test inspection
LAT_MAX, LAT_MIN = NORTH, SOUTH
LON_MIN, LON_MAX = WEST, EAST
STEP_DEG = 0.25


@dataclass
class SatDisk:
    """Calibrated geostationary full-disk scan in ascending x_rad (W->E), descending y_rad (N->S)."""

    name: str
    sub_lon: float
    vis: np.ndarray | None   # fraction [0..1.3], raw TOA reflectance (not yet cos(sza)-divided)
    bt: np.ndarray           # Kelvin brightness temperature
    x_rad: np.ndarray
    y_rad: np.ndarray
    h_m: float
    r_eq: float
    r_pol: float
    vis_x_rad: np.ndarray | None = None
    vis_y_rad: np.ndarray | None = None


def mercator_lat_lon_box(west: float, south: float, east: float, north: float, w: int, h: int) -> tuple[np.ndarray, np.ndarray]:
    """Return broadcastable (LAT (h,1), LON (1,w)) arrays for a Web Mercator bounding box."""
    x0, x1 = math.radians(west), math.radians(east)
    y0, y1 = float(_merc_y(north)), float(_merc_y(south))
    xs = np.linspace(x0, x1, w, endpoint=False) + ((x1 - x0) / (2.0 * w))
    ys = y0 + (np.arange(h) + 0.5) * ((y1 - y0) / h)
    lon = np.degrees(xs)[None, :]
    lat = np.degrees(2.0 * np.arctan(np.exp(ys)) - math.pi / 2.0)[:, None]
    return lat.astype(np.float64), lon.astype(np.float64)


def mercator_lat_lon(w: int = GRID_W, h: int = GRID_H) -> tuple[np.ndarray, np.ndarray]:
    """Return 2-D broadcastable (LAT (h,1), LON (1,w)) arrays for the global Web Mercator grid."""
    return mercator_lat_lon_box(WEST, SOUTH, EAST, NORTH, w, h)


def _tile_specs(tile_w: int) -> list[tuple[str, dict[str, float], int, int]]:
    """Return [(id, bounds_dict, w, h), ...] for the 12x6 global Web Mercator HD tiles."""
    specs = []
    lon_step = (EAST - WEST) / TILE_COLS
    lat_splits = np.linspace(NORTH, SOUTH, TILE_ROWS + 1)
    for row in range(TILE_ROWS):
        n_lat, s_lat = float(lat_splits[row]), float(lat_splits[row + 1])
        dy = float(_merc_y(n_lat)) - float(_merc_y(s_lat))
        dx = math.radians(lon_step)
        th = round(tile_w * dy / dx)
        for col in range(TILE_COLS):
            w_lon = WEST + col * lon_step
            e_lon = w_lon + lon_step
            specs.append((f"{row}_{col}", {"west": w_lon, "south": s_lat, "east": e_lon, "north": n_lat}, tile_w, th))
    return specs


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
    """Blend overlapping satellite images favoring the smallest satellite viewing zenith angle."""
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
    """Project any geostationary fixed-grid array onto a target (lat, lon) Web Mercator patch."""
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
    """Reproject a geostationary full-disk RGB image onto a Mercator grid with its zenith mask."""
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


def _hrv_patch(vis: np.ndarray | None, bt: np.ndarray, sza: np.ndarray, twilight: np.ndarray) -> np.ndarray:
    """Apply South India's exact `hrv_clouds_rgb` formula with a smooth sunset twilight transition."""
    if vis is not None:
        cos_z = np.cos(np.radians(np.minimum(sza, SUN_CAP_ZENITH)))
        vis_norm = np.where((sza < 89.0) & np.isfinite(vis), vis / cos_z, np.nan)
    else:
        vis_norm = np.full_like(bt, np.nan, dtype=np.float32)
    rgb = hrv_clouds_rgb(vis_norm, bt).astype(np.float32)
    # Taper VIS highlight smoothly near terminator so EVIEW_OUT[0]=40 doesn't jump at sza=89°
    rgb[..., 0] = np.round(rgb[..., 0] * twilight)
    rgb[..., 1] = np.round(rgb[..., 1] * twilight)
    valid = np.isfinite(bt)
    rgb[~valid] = np.nan
    return rgb


def _latest_goes_key(bucket: str, now_utc: datetime, band: str = "C13") -> str | None:
    for delta_h in (0, 1, 2):
        dt = now_utc - timedelta(hours=delta_h)
        prefix = f"ABI-L2-CMIPF/{dt:%Y/%j/%H}/OR_ABI-L2-CMIPF-M6{band}_"
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


def _download_goes_nc(bucket: str, key: str, stride: int = 1) -> tuple[np.ndarray, np.ndarray, np.ndarray, float, float, float, float] | None:
    try:
        import xarray as xr
    except ImportError:
        return None
    url = f"https://{bucket}.s3.amazonaws.com/{key}"
    with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as tf:
        tmp_path = tf.name
    try:
        r = requests.get(url, timeout=90)
        if not r.ok:
            return None
        with open(tmp_path, "wb") as f:
            f.write(r.content)
        ds = xr.open_dataset(tmp_path)
        proj = ds["goes_imager_projection"].attrs
        arr = ds["CMI"].values[::stride, ::stride].astype(np.float32)
        x_rad = ds["x"].values[::stride].astype(np.float64)
        y_rad = ds["y"].values[::stride].astype(np.float64)
        ds.close()
        if x_rad[0] > x_rad[-1]:
            x_rad = x_rad[::-1]
            arr = arr[:, ::-1]
        if y_rad[0] < y_rad[-1]:
            y_rad = y_rad[::-1]
            arr = arr[::-1, :]
        return (
            arr,
            x_rad,
            y_rad,
            float(proj["longitude_of_projection_origin"]),
            float(proj["perspective_point_height"]),
            float(proj["semi_major_axis"]),
            float(proj["semi_minor_axis"]),
        )
    except Exception as e:
        print(f"global_sat: failed reading {bucket}/{key}: {e}", flush=True)
        return None
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def _read_goes_nc(bucket: str, key: str, lat: np.ndarray, lon: np.ndarray) -> np.ndarray | None:
    """Compatibility helper projecting one GOES IR file onto (lat, lon)."""
    got = _download_goes_nc(bucket, key, stride=1)
    if got is None:
        return None
    arr, x_rad, y_rad, lon_0, h_m, r_eq, r_pol = got
    return reproject_goes_to_global(arr, x_rad, y_rad, lon_0, h_m, r_eq, r_pol, lat=lat, lon=lon)


def _load_goes_disk(name: str, sub_lon: float, buckets: tuple[str, ...], now_utc: datetime) -> SatDisk | None:
    for bucket in buckets:
        k13 = _latest_goes_key(bucket, now_utc, "C13")
        if not k13:
            continue
        k01 = _latest_goes_key(bucket, now_utc, "C01")
        with concurrent.futures.ThreadPoolExecutor(2) as ex:
            f_ir = ex.submit(_download_goes_nc, bucket, k13, 1)
            f_vis = ex.submit(_download_goes_nc, bucket, k01, 1) if k01 else None
            ir_res = f_ir.result()
            vis_res = f_vis.result() if f_vis else None
        if ir_res is None:
            continue
        bt, x_rad, y_rad, lon_0, h_m, r_eq, r_pol = ir_res
        vis = None
        vx, vy = None, None
        if vis_res is not None:
            vis = np.clip(vis_res[0], 0.0, 1.5).astype(np.float16)
            vx, vy = vis_res[1], vis_res[2]
        return SatDisk(name, lon_0, vis, bt.astype(np.float16), x_rad, y_rad, h_m, r_eq, r_pol, vx, vy)
    return None


def _load_msg_cache(msg_cache: str | None) -> SatDisk | None:
    if not msg_cache or not os.path.exists(msg_cache):
        return None
    try:
        z = np.load(msg_cache)
        vis = np.clip(z["vis"].astype(np.float32) / 100.0, 0.0, 1.5).astype(np.float16)
        bt = z["ir"].astype(np.float16)
        return SatDisk(
            name="meteosat-9",
            sub_lon=float(z["sub_lon"]),
            vis=vis,
            bt=bt,
            x_rad=z["x_rad"].astype(np.float64),
            y_rad=z["y_rad"].astype(np.float64),
            h_m=float(z["h_m"]),
            r_eq=float(z["r_eq"]),
            r_pol=float(z["r_pol"]),
        )
    except Exception as e:
        print(f"global_sat: msg cache load failed: {e}", flush=True)
        return None


def _load_himawari_disk(now_utc: datetime) -> SatDisk | None:
    """Download all 10 full-disk Himawari-9 B03 (vis, strided to 2 km) + B13 (2 km IR) segments."""
    try:
        from net import download_parallel
        from satpy import Scene
    except ImportError:
        return None
    start_t = now_utc - timedelta(minutes=15)
    t = start_t.replace(minute=start_t.minute - start_t.minute % 10, second=0, microsecond=0)
    for step in range(4):
        slot = t - timedelta(minutes=10 * step)
        prefix = f"AHI-L1b-FLDK/{slot:%Y/%m/%d/%H%M}/"
        try:
            r = requests.get(f"{HIMAWARI_BUCKET}/", params={"list-type": "2", "prefix": prefix}, timeout=15)
            if not r.ok:
                continue
            keys = [el.text for el in ET.fromstring(r.text).findall(".//{http://s3.amazonaws.com/doc/2006-03-01/}Key") if el.text]
            k13 = sorted([k for k in keys if "_B13_FLDK_" in k and any(f"_S{s}10" in k for s in HIMAWARI_SEGMENTS)])
            k03 = sorted([k for k in keys if "_B03_FLDK_" in k and any(f"_S{s}10" in k for s in HIMAWARI_SEGMENTS)])
            if len(k13) != 10:
                continue
            with tempfile.TemporaryDirectory() as tmp:
                items = [(f"{HIMAWARI_BUCKET}/{k}", os.path.join(tmp, os.path.basename(k))) for k in (k13 + k03)]
                download_parallel(items, max_workers=12)
                p13 = [os.path.join(tmp, os.path.basename(k)) for k in k13]
                scn13 = Scene(reader="ahi_hsd", filenames=p13)
                scn13.load(["B13"])
                area = scn13["B13"].attrs["area"]
                crs = area.crs.to_dict()
                h_m = float(crs.get("h", 35785863.0))
                sub_lon = float(crs.get("lon_0", 140.7))
                r_eq = float(crs.get("a", 6378137.0))
                r_pol = float(crs.get("b", 6356752.3))
                x_m, y_m = area.get_proj_coords()
                x_rad = np.asarray(x_m[0, :], dtype=np.float64) / h_m
                y_rad = np.asarray(y_m[:, 0], dtype=np.float64) / h_m
                bt = np.asarray(scn13["B13"].values, dtype=np.float32)
                del scn13

                vis = None
                vx, vy = None, None
                if len(k03) == 10:
                    p03 = [os.path.join(tmp, os.path.basename(k)) for k in k03]
                    scn03 = Scene(reader="ahi_hsd", filenames=p03)
                    scn03.load(["B03"])
                    b3 = np.asarray(scn03["B03"].values, dtype=np.float32)
                    area03 = scn03["B03"].attrs["area"]
                    xm3, ym3 = area03.get_proj_coords()
                    del scn03
                    # Stride 0.5 km B03 by 2x -> 1 km native visible (~11000x11000)
                    stride = max(1, b3.shape[0] // (bt.shape[0] * 2))
                    b3_1k = b3[stride // 2::stride, stride // 2::stride]
                    vx = np.asarray(xm3[0, stride // 2::stride], dtype=np.float64) / h_m
                    vy = np.asarray(ym3[stride // 2::stride, 0], dtype=np.float64) / h_m
                    if vx[0] > vx[-1]:
                        vx = vx[::-1]
                        b3_1k = b3_1k[:, ::-1]
                    if vy[0] < vy[-1]:
                        vy = vy[::-1]
                        b3_1k = b3_1k[::-1, :]
                    vis = np.clip(b3_1k / 100.0, 0.0, 1.5).astype(np.float16)

                if x_rad[0] > x_rad[-1]:
                    x_rad = x_rad[::-1]
                    bt = bt[:, ::-1]
                if y_rad[0] < y_rad[-1]:
                    y_rad = y_rad[::-1]
                    bt = bt[::-1, :]
                print(f"global_sat: loaded Himawari-9 full disk {slot:%H:%MZ} (vis={'yes' if vis is not None else 'no'})", flush=True)
                return SatDisk("himawari-9", sub_lon, vis, bt.astype(np.float16), x_rad, y_rad, h_m, r_eq, r_pol, vx, vy)
        except Exception as e:
            print(f"global_sat: Himawari-9 full-disk {slot:%H:%MZ} failed ({type(e).__name__}: {e})", flush=True)
    return None


def _fetch_gmgsi_ir(now_utc: datetime, lat: np.ndarray, lon: np.ndarray) -> np.ndarray | None:
    """Fetch NOAA GMGSI_LW 5-satellite calibrated IR blend onto the target Mercator grid (NaN outside)."""
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
    """Read regional calibrated BT (bt/ or bt-h9/) into (global_k, valid_mask) on the target grid."""
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
        full = np.full((lat.shape[0], lon.shape[1]), np.nan, dtype=np.float32)
        rows = np.where(r_mask)[0][:, None]
        cols = np.where(c_mask)[0][None, :]
        full[rows, cols] = patch
        return full, np.isfinite(full)
    except Exception:
        return None


def _eumet_latest_times(session: requests.Session, layers: tuple[str, ...]) -> dict[str, str | None]:
    out = {layer: None for layer in layers}
    try:
        r = session.get("https://view.eumetsat.int/geoserver/wms?service=WMS&version=1.3.0&request=GetCapabilities", timeout=30)
        if not r.ok:
            return out
        for layer in layers:
            m = re.search(rf"<Name>{re.escape(layer)}</Name>.*?<Dimension[^>]*name=\"time\"[^>]*>([^<]+)</Dimension>", r.text, re.DOTALL)
            if not m:
                continue
            val = m.group(1).strip().split(",")[-1]
            out[layer] = val.split("/")[1] if "/" in val else val
    except Exception:
        pass
    return out


def _fetch_eumet_cropped(
    session: requests.Session,
    layer: str,
    w_lon: float,
    e_lon: float,
    time_iso: str | None = None,
    req_w: int = 1800,
    req_h: int = 1400,
) -> tuple[np.ndarray, float, float] | None:
    """Fetch high-res EUMETView WMS EPSG:3857 RGBA over (w_lon..e_lon, SOUTH..NORTH)."""
    mx0 = R_EARTH_M * math.radians(w_lon)
    mx1 = R_EARTH_M * math.radians(e_lon)
    my0 = R_EARTH_M * _Y_SOUTH
    my1 = R_EARTH_M * _Y_NORTH
    params = {
        "SERVICE": "WMS",
        "VERSION": "1.3.0",
        "REQUEST": "GetMap",
        "LAYERS": layer,
        "CRS": "EPSG:3857",
        "BBOX": f"{mx0:.2f},{my0:.2f},{mx1:.2f},{my1:.2f}",
        "WIDTH": str(req_w),
        "HEIGHT": str(req_h),
        "FORMAT": "image/png",
        "TRANSPARENT": "TRUE",
    }
    if time_iso:
        params["TIME"] = time_iso
    for _ in range(2):
        try:
            r = session.get("https://view.eumetsat.int/geoserver/wms", params=params, timeout=45)
            if r.ok:
                rgba = np.array(Image.open(io.BytesIO(r.content)).convert("RGBA"), dtype=np.float32)
                return rgba, w_lon, e_lon
        except Exception:
            pass
    return None


def _sample_wms_onto_grid(wms: tuple[np.ndarray, float, float] | None, lat: np.ndarray, lon: np.ndarray) -> np.ndarray | None:
    if wms is None:
        return None
    rgba, w_lon, e_lon = wms
    wh, ww, _ = rgba.shape
    lons = lon[0, :]
    lats = lat[:, 0]
    in_lon = (lons >= w_lon) & (lons <= e_lon)
    if not in_lon.any():
        return None
    u_x = (lons[in_lon] - w_lon) / (e_lon - w_lon)
    y_norm = (_Y_NORTH - _merc_y(lats)) / (_Y_NORTH - _Y_SOUTH)
    ix = np.clip(np.round(u_x * (ww - 1)).astype(int), 0, ww - 1)[None, :]
    iy = np.clip(np.round(y_norm * (wh - 1)).astype(int), 0, wh - 1)[:, None]
    out = np.zeros((lat.shape[0], lon.shape[1], 4), dtype=np.float32)
    cols = np.where(in_lon)[0][None, :]
    rows = np.arange(lat.shape[0])[:, None]
    out[rows, cols] = rgba[iy, ix]
    return out


def _fetch_slider_disk(sat: str, session: requests.Session | None = None) -> np.ndarray | None:
    """Fallback RAMMB SLIDER GeoColor 1356x1356 disk if S3 C01/C13 is unavailable."""
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
            tiles[rc] = np.array(Image.open(io.BytesIO(rt.content)).convert("RGB"), dtype=np.float32)

        with concurrent.futures.ThreadPoolExecutor(8) as ex:
            list(ex.map(get_t, [(row, col) for row in range(4) for col in range(4)]))
        return np.vstack([np.hstack([tiles[(row, col)] for col in range(4)]) for row in range(4)])
    except Exception:
        return None


def _update_index(folder_dir: str, fname: str, ts_iso: str, extra: dict, tiles: list[dict] | None = None) -> str:
    idx_path = os.path.join(folder_dir, "index.json")
    frames = []
    if os.path.exists(idx_path):
        try:
            with open(idx_path, "r", encoding="utf-8") as f:
                frames = json.load(f).get("frames", [])
        except Exception:
            frames = []
    frames = [fr for fr in frames if fr.get("time") != ts_iso]
    entry: dict = {"time": ts_iso, "file": fname}
    if tiles:
        entry["tiles"] = tiles
    frames.append(entry)
    frames = frames[-MAX_FRAMES:]
    keep = {fr["file"] for fr in frames}
    for fr in frames:
        for t in fr.get("tiles", []):
            if t.get("file"):
                keep.add(t["file"])
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


def _eumet_to_disk_inputs(
    vis_wms: tuple[np.ndarray, float, float] | None,
    ir_wms: tuple[np.ndarray, float, float] | None,
    sub_lon: float,
    lat: np.ndarray,
    lon: np.ndarray,
    sza: np.ndarray,
    twilight: np.ndarray,
) -> tuple[np.ndarray | None, np.ndarray | None, np.ndarray]:
    """Convert EUMETView vis006 + ir108 WMS fallback into (hrv_rgb, bt_k, zenith)."""
    ir_rgba = _sample_wms_onto_grid(ir_wms, lat, lon)
    if ir_rgba is None:
        return None, None, np.full((lat.shape[0], lon.shape[1]), 999.0, dtype=np.float32)
    ok_ir = ir_rgba[..., 3] > 20
    bt_k = np.where(ok_ir, 190.0 + (1.0 - ir_rgba[..., 0] / 255.0) * 125.0, np.nan).astype(np.float32)
    vis_arr = None
    vis_rgba = _sample_wms_onto_grid(vis_wms, lat, lon)
    if vis_rgba is not None:
        cos_z = np.cos(np.radians(np.minimum(sza, SUN_CAP_ZENITH)))
        ok_v = vis_rgba[..., 3] > 20
        vis_arr = np.where(ok_v, (vis_rgba[..., 0] / 255.0) / cos_z * 0.90, np.nan)
    zen = np.where(ok_ir, sat_zenith(lat, lon, sub_lon), 999.0).astype(np.float32)
    return _hrv_patch(vis_arr, bt_k, sza, twilight), bt_k, zen


def _render_patch(
    lat: np.ndarray,
    lon: np.ndarray,
    now_utc: datetime,
    disks: list[SatDisk],
    eumet_layers: list[tuple[float, tuple[np.ndarray, float, float] | None, tuple[np.ndarray, float, float] | None]],
    regional_dirs: list[tuple[str, float]],
    slider_fallbacks: list[tuple[np.ndarray, float, float]],
    want_rgb: bool = True,
    want_ir: bool = True,
    gmgsi: np.ndarray | None = None,
) -> tuple[np.ndarray | None, np.ndarray, np.ndarray | None, np.ndarray]:
    """Render both `hrv_clouds_rgb` mosaic and calibrated Kelvin IR for one (lat, lon) grid."""
    sza = sun_zenith(now_utc, lat, lon)
    twilight = np.clip((89.0 - sza) / 5.0, 0.0, 1.0).astype(np.float32)

    rgb_arrays: list[np.ndarray] = []
    rgb_zeniths: list[np.ndarray] = []
    ir_arrays: list[np.ndarray] = []
    ir_zeniths: list[np.ndarray] = []

    for d in disks:
        zen = sat_zenith(lat, lon, d.sub_lon).astype(np.float32)
        bt = reproject_goes_to_global(d.bt.astype(np.float32), d.x_rad, d.y_rad, d.sub_lon, d.h_m, d.r_eq, d.r_pol, lat=lat, lon=lon)
        ok_bt = np.isfinite(bt) & (zen <= MAX_VIEW_DEG)
        if not ok_bt.any():
            continue
        z_bt = np.where(ok_bt, zen, 999.0).astype(np.float32)
        if want_ir:
            ir_arrays.append(bt)
            ir_zeniths.append(z_bt)
        if want_rgb:
            vx = d.vis_x_rad if d.vis_x_rad is not None else d.x_rad
            vy = d.vis_y_rad if d.vis_y_rad is not None else d.y_rad
            vis = (
                reproject_goes_to_global(d.vis.astype(np.float32), vx, vy, d.sub_lon, d.h_m, d.r_eq, d.r_pol, lat=lat, lon=lon)
                if d.vis is not None else None
            )
            rgb = _hrv_patch(vis, bt, sza, twilight)
            rgb_arrays.append(rgb)
            rgb_zeniths.append(z_bt)

    for sub_lon, vis_wms, ir_wms in eumet_layers:
        rgb_e, bt_e, z_e = _eumet_to_disk_inputs(vis_wms, ir_wms, sub_lon, lat, lon, sza, twilight)
        if rgb_e is not None and want_rgb:
            rgb_arrays.append(rgb_e)
            rgb_zeniths.append(z_e + (4.0 if any(d.sub_lon == 45.5 for d in disks) else 0.0))
        if bt_e is not None and want_ir and not any(d.sub_lon == sub_lon for d in disks):
            ir_arrays.append(bt_e)
            ir_zeniths.append(z_e + 5.0)

    if want_ir:
        if not ir_arrays:
            # Regional fallbacks only when no full-disk or EUMETView satellite observations were found
            for reg_dir, sub_lon in regional_dirs:
                res = _read_regional_bt(reg_dir, lat, lon)
                if res is not None:
                    arr_r, mask_r = res
                    ir_arrays.append(arr_r)
                    ir_zeniths.append(np.where(mask_r, sat_zenith(lat, lon, sub_lon), 999.0).astype(np.float32))
        if gmgsi is not None and np.isfinite(gmgsi).any():
            ir_arrays.append(gmgsi)
            ir_zeniths.append(np.where(np.isfinite(gmgsi), 78.0, 999.0).astype(np.float32))

    if want_rgb and slider_fallbacks:
        for disk_img, sub_lon, frac in slider_fallbacks:
            p, z = reproject_disk_rgb(disk_img, sub_lon, frac, lat, lon, h_m=(35785863.0 if sub_lon > 100 else 35786023.0))
            # Convert GeoColor brightness gently when raw visible+IR aren't loaded (fallback only)
            rgb_arrays.append(p)
            rgb_zeniths.append(np.where(z <= MAX_VIEW_DEG, z + 10.0, 999.0).astype(np.float32))

    rgb_out, rgb_valid = mosaic_best_view(rgb_arrays, rgb_zeniths) if (want_rgb and rgb_arrays) else (None, np.zeros(lat.shape[:1] + lon.shape[1:], dtype=bool))
    ir_out, ir_valid = mosaic_best_view(ir_arrays, ir_zeniths) if (want_ir and ir_arrays) else (None, np.zeros(lat.shape[:1] + lon.shape[1:], dtype=bool))
    return rgb_out, rgb_valid, ir_out, ir_valid


def _gather_inputs(out_dir: str, now_utc: datetime, msg_cache: str | None = None):
    """Download calibrated full-disk visible + IR across GOES-18/19, Meteosat-9, Himawari-9, and Meteosat-0°."""
    s = requests.Session()
    times = _eumet_latest_times(s, ("msg_fes:ir108", "msg_iodc:ir108"))

    msg_disk = _load_msg_cache(msg_cache)
    with concurrent.futures.ThreadPoolExecutor(6) as ex:
        f_g19 = ex.submit(_load_goes_disk, "goes-east", -75.2, ("noaa-goes19", "noaa-goes16"), now_utc)
        f_g18 = ex.submit(_load_goes_disk, "goes-west", -137.2, ("noaa-goes18",), now_utc)
        f_h9 = ex.submit(_load_himawari_disk, now_utc)
        f_fes_vis = ex.submit(_fetch_eumet_cropped, s, "msg_fes:vis006", -76.0, 26.0, times["msg_fes:ir108"], 2000, 1400)
        f_fes_ir = ex.submit(_fetch_eumet_cropped, s, "msg_fes:ir108", -76.0, 26.0, times["msg_fes:ir108"], 2000, 1400)
        f_iodc_vis = None if msg_disk else ex.submit(_fetch_eumet_cropped, s, "msg_iodc:vis006", -25.0, 128.0, times["msg_iodc:ir108"], 2000, 1400)
        f_iodc_ir = None if msg_disk else ex.submit(_fetch_eumet_cropped, s, "msg_iodc:ir108", -25.0, 128.0, times["msg_iodc:ir108"], 2000, 1400)

    disks = [d for d in (msg_disk, f_g19.result(), f_g18.result(), f_h9.result()) if d is not None]
    eumet_layers = [(0.0, f_fes_vis.result(), f_fes_ir.result())]
    if f_iodc_vis and f_iodc_ir:
        eumet_layers.append((45.5, f_iodc_vis.result(), f_iodc_ir.result()))

    regional_dirs = [(os.path.join(out_dir, sub), lon0) for sub, lon0 in (("bt", 45.5), ("bt-h9", 140.7)) if os.path.exists(os.path.join(out_dir, sub, "index.json"))]
    slider_fallbacks: list[tuple[np.ndarray, float, float]] = []
    if not any(d.name == "himawari-9" for d in disks):
        h9s = _fetch_slider_disk("himawari", s)
        if h9s is not None:
            slider_fallbacks.append((h9s, 140.7, 1354.0 / 2752.0))
    return disks, eumet_layers, regional_dirs, slider_fallbacks


def _save_rgb_webp(path: str, rgb: np.ndarray, valid: np.ndarray) -> None:
    alpha = np.where(valid, 255, 0).astype(np.uint8)
    rgba = np.dstack([np.clip(rgb, 0, 255).astype(np.uint8), alpha])
    Image.fromarray(rgba, "RGBA").save(path, "WEBP", quality=88, method=4)


def build_global_mosaics(
    out_dir: str,
    now_utc: datetime | None = None,
    msg_cache: str | None = None,
    hd_tiles: bool = True,
) -> tuple[str | None, str | None]:
    """Build synchronized global overview + 4x2 HD Web Mercator tiles for both rgb-global/ and bt-global/."""
    now_utc = now_utc or datetime.now(timezone.utc)
    disks, eumet_layers, regional_dirs, slider_fallbacks = _gather_inputs(out_dir, now_utc, msg_cache=msg_cache)

    lat, lon = mercator_lat_lon(GRID_W, GRID_H)
    gmgsi = _fetch_gmgsi_ir(now_utc, lat, lon) if len(disks) < 3 else None
    rgb_ov, rgb_ok, ir_ov, ir_ok = _render_patch(lat, lon, now_utc, disks, eumet_layers, regional_dirs, slider_fallbacks, want_rgb=True, want_ir=True, gmgsi=gmgsi)

    ts_iso = now_utc.strftime("%Y-%m-%dT%H:%M:00Z")
    stamp = f"{now_utc:%Y%m%dT%H%M}Z"
    bounds = {"west": WEST, "south": SOUTH, "east": EAST, "north": NORTH}
    rgb_idx_path = None
    ir_idx_path = None

    rgb_tiles_meta: list[dict] = []
    ir_tiles_meta: list[dict] = []
    if hd_tiles and (rgb_ok.any() or ir_ok.any()):
        rgb_dir = os.path.join(out_dir, "rgb-global")
        bt_dir = os.path.join(out_dir, "bt-global")
        os.makedirs(rgb_dir, exist_ok=True)
        os.makedirs(bt_dir, exist_ok=True)
        for tid, tb, tw, th in _tile_specs(RGB_TILE_W):
            t_lat, t_lon = mercator_lat_lon_box(tb["west"], tb["south"], tb["east"], tb["north"], tw, th)
            t_rgb, t_rgb_ok, _, _ = _render_patch(t_lat, t_lon, now_utc, disks, eumet_layers, regional_dirs, slider_fallbacks, want_rgb=True, want_ir=False)
            if t_rgb is not None and t_rgb_ok.any():
                fn = f"{stamp}_{tid}.webp"
                _save_rgb_webp(os.path.join(rgb_dir, fn), t_rgb, t_rgb_ok)
                rgb_tiles_meta.append({"id": tid, "bounds": tb, "file": fn})
        for tid, tb, tw, th in _tile_specs(IR_TILE_W):
            t_lat, t_lon = mercator_lat_lon_box(tb["west"], tb["south"], tb["east"], tb["north"], tw, th)
            _, _, t_ir, t_ir_ok = _render_patch(t_lat, t_lon, now_utc, disks, eumet_layers, regional_dirs, slider_fallbacks, want_rgb=False, want_ir=True)
            if t_ir is not None and t_ir_ok.any():
                fn = f"{stamp}_{tid}.png"
                Image.fromarray(S.encode_bt(t_ir), "L").save(os.path.join(bt_dir, fn), "PNG", optimize=True)
                ir_tiles_meta.append({"id": tid, "bounds": tb, "file": fn})

    if rgb_ov is not None and rgb_ok.any():
        rgb_dir = os.path.join(out_dir, "rgb-global")
        os.makedirs(rgb_dir, exist_ok=True)
        fname = f"{stamp}.webp"
        _save_rgb_webp(os.path.join(rgb_dir, fname), rgb_ov, rgb_ok)
        rgb_idx_path = _update_index(rgb_dir, fname, ts_iso, {"version": 2, "projection": "EPSG:3857", "bounds": bounds}, tiles=rgb_tiles_meta)
        print(f"global_sat: wrote rgb-global/{fname} ({GRID_W}x{GRID_H}) + {len(rgb_tiles_meta)} HD tiles", flush=True)

    if ir_ov is not None and ir_ok.any():
        bt_dir = os.path.join(out_dir, "bt-global")
        os.makedirs(bt_dir, exist_ok=True)
        fname = f"{stamp}.png"
        Image.fromarray(S.encode_bt(ir_ov), "L").save(os.path.join(bt_dir, fname), "PNG", optimize=True)
        ir_idx_path = _update_index(bt_dir, fname, ts_iso, {"version": 2, "projection": "EPSG:3857", "bounds": bounds, "offsetK": S.OFFSET_K, "stepK": S.STEP_K}, tiles=ir_tiles_meta)
        print(f"global_sat: wrote bt-global/{fname} ({GRID_W}x{GRID_H}) + {len(ir_tiles_meta)} HD tiles", flush=True)

    return rgb_idx_path, ir_idx_path


def build_global_ir(out_dir: str, now_utc: datetime | None = None) -> str | None:
    """Build calibrated global IR mosaic in bt-global/ on the Web Mercator grid (overview path)."""
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
        arrays.append(gmgsi)
        zeniths.append(np.where(np.isfinite(gmgsi), 78.0, 999.0))
    if not arrays:
        for sub, sub_lon in (("bt", 45.5), ("bt-h9", 140.7)):
            p = os.path.join(out_dir, sub)
            if os.path.exists(os.path.join(p, "index.json")):
                res = _read_regional_bt(p, lat, lon)
                if res is not None:
                    arr_r, mask_r = res
                    arrays.append(arr_r)
                    zeniths.append(np.where(mask_r, sat_zenith(lat, lon, sub_lon), 999.0))
    if not arrays:
        return None
    global_k, valid = mosaic_best_view(arrays, zeniths)
    if not valid.any():
        return None
    bt_dir = os.path.join(out_dir, "bt-global")
    os.makedirs(bt_dir, exist_ok=True)
    ts_iso = now_utc.strftime("%Y-%m-%dT%H:%M:00Z")
    fname = f"{now_utc:%Y%m%dT%H%M}Z.png"
    Image.fromarray(S.encode_bt(global_k), "L").save(os.path.join(bt_dir, fname), "PNG", optimize=True)
    return _update_index(bt_dir, fname, ts_iso, {
        "version": 2, "projection": "EPSG:3857",
        "bounds": {"west": WEST, "south": SOUTH, "east": EAST, "north": NORTH},
        "offsetK": S.OFFSET_K, "stepK": S.STEP_K,
    })


def build_global_rgb(out_dir: str, now_utc: datetime | None = None) -> str | None:
    """Build global HRV Cloud RGB mosaic in rgb-global/ on the Web Mercator grid (overview path)."""
    now_utc = now_utc or datetime.now(timezone.utc)
    lat, lon = mercator_lat_lon()
    s = requests.Session()
    times = _eumet_latest_times(s, ("msg_fes:ir108", "msg_iodc:ir108"))
    with concurrent.futures.ThreadPoolExecutor(6) as ex:
        f_g18 = ex.submit(_fetch_slider_disk, "goes-18", s)
        f_g19 = ex.submit(_fetch_slider_disk, "goes-19", s)
        f_h9 = ex.submit(_fetch_slider_disk, "himawari", s)
        f_fes_v = ex.submit(_fetch_eumet_cropped, s, "msg_fes:vis006", -76.0, 26.0, times["msg_fes:ir108"])
        f_fes_i = ex.submit(_fetch_eumet_cropped, s, "msg_fes:ir108", -76.0, 26.0, times["msg_fes:ir108"])
        f_iodc_v = ex.submit(_fetch_eumet_cropped, s, "msg_iodc:vis006", -25.0, 128.0, times["msg_iodc:ir108"])
        f_iodc_i = ex.submit(_fetch_eumet_cropped, s, "msg_iodc:ir108", -25.0, 128.0, times["msg_iodc:ir108"])
    sliders = [(d, lon0, f) for d, lon0, f in (
        (f_g18.result(), -137.2, 1352.0 / 2712.0),
        (f_g19.result(), -75.2, 1352.0 / 2712.0),
        (f_h9.result(), 140.7, 1354.0 / 2752.0),
    ) if d is not None]
    eum = [(0.0, f_fes_v.result(), f_fes_i.result()), (45.5, f_iodc_v.result(), f_iodc_i.result())]
    rgb_ov, rgb_ok, _, _ = _render_patch(lat, lon, now_utc, [], eum, [], sliders, want_rgb=True, want_ir=False)
    if rgb_ov is None or not rgb_ok.any():
        return None
    rgb_dir = os.path.join(out_dir, "rgb-global")
    os.makedirs(rgb_dir, exist_ok=True)
    ts_iso = now_utc.strftime("%Y-%m-%dT%H:%M:00Z")
    fname = f"{now_utc:%Y%m%dT%H%M}Z.webp"
    _save_rgb_webp(os.path.join(rgb_dir, fname), rgb_ov, rgb_ok)
    return _update_index(rgb_dir, fname, ts_iso, {
        "version": 2, "projection": "EPSG:3857",
        "bounds": {"west": WEST, "south": SOUTH, "east": EAST, "north": NORTH},
    })


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--msg-cache", default=None, help="full-disk Meteosat-9 npz exported by satellite_bt.py")
    ap.add_argument("--no-tiles", action="store_true", help="skip generating 4x2 HD regional tiles")
    args = ap.parse_args()
    rgb_idx, ir_idx = build_global_mosaics(args.out, msg_cache=args.msg_cache, hd_tiles=not args.no_tiles)
    return 0 if (rgb_idx or ir_idx) else 1


if __name__ == "__main__":
    raise SystemExit(main())
