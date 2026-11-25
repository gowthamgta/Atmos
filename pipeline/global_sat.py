"""Global IR Brightness Temperature Mosaic (bt-global): stitches GOES-East (19/16), GOES-West (18),
Meteosat (bt/), and Himawari-9 (bt-h9/) onto a compact 0.25 deg global equirectangular grid (-80..+80 lat).

Writes bt-global/<timestamp>.png and bt-global/index.json (last 6 frames) in the site folder.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timedelta, timezone
import json
import math
import os
import tempfile
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image
import requests

import satellite_bt as S

LAT_MAX, LAT_MIN = 80.0, -80.0
LON_MIN, LON_MAX = -180.0, 179.75
STEP_DEG = 0.25
NY = round((LAT_MAX - LAT_MIN) / STEP_DEG) + 1
NX = round((LON_MAX - LON_MIN) / STEP_DEG) + 1
MAX_FRAMES = 6

GOES_BUCKETS = (
    ("goes-east", ("noaa-goes19", "noaa-goes16")),
    ("goes-west", ("noaa-goes18",)),
)


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


def reproject_goes_to_global(
    cmi_k: np.ndarray,
    x_rad: np.ndarray,
    y_rad: np.ndarray,
    lon_0_deg: float,
    h_m: float,
    r_eq: float,
    r_pol: float,
) -> np.ndarray:
    """Projects GOES ABI fixed-grid (x, y radians) brightness temperature onto the 0.25 deg global grid."""
    lats = np.radians(LAT_MAX - STEP_DEG * np.arange(NY))[:, None]
    lons = np.radians(LON_MIN + STEP_DEG * np.arange(NX))[None, :]
    lon_0 = math.radians(lon_0_deg)
    dlon = np.arctan2(np.sin(lons - lon_0), np.cos(lons - lon_0))

    # Geodetic -> Geocentric latitude
    e2 = 1.0 - (r_pol / r_eq) ** 2
    phi_c = np.arctan((r_pol / r_eq) ** 2 * np.tan(lats))
    r_c = r_pol / np.sqrt(1.0 - e2 * (np.cos(phi_c) ** 2))

    H_total = r_eq + h_m
    sx = H_total - r_c * np.cos(phi_c) * np.cos(dlon)
    sy = -r_c * np.cos(phi_c) * np.sin(dlon)
    sz = r_c * np.sin(phi_c)

    # Visibility check: satellite must see the front side of the Earth
    visible = (H_total * (H_total - sx)) >= (sy ** 2 + (r_eq / r_pol) ** 2 * sz ** 2)
    dist = np.sqrt(np.maximum(sx ** 2 + sy ** 2 + sz ** 2, 1e-6))

    x_out = np.arcsin(np.clip(-sy / dist, -1.0, 1.0))
    y_out = np.arctan(sz / np.where(np.abs(sx) > 1e-6, sx, 1e-6))

    dx = float(x_rad[1] - x_rad[0])
    dy = float(y_rad[1] - y_rad[0])
    ix = np.round((x_out - float(x_rad[0])) / dx).astype(int)
    iy = np.round((y_out - float(y_rad[0])) / dy).astype(int)

    in_bounds = visible & (ix >= 0) & (ix < len(x_rad)) & (iy >= 0) & (iy < len(y_rad))
    ix_c = np.clip(ix, 0, len(x_rad) - 1)
    iy_c = np.clip(iy, 0, len(y_rad) - 1)

    sampled = np.where(in_bounds, cmi_k[iy_c, ix_c], np.nan)
    return sampled.astype(np.float32)


def _read_goes_nc(bucket: str, key: str) -> np.ndarray | None:
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
        )
    except Exception as e:
        print(f"global_sat: failed reading {bucket}/{key}: {e}", flush=True)
        return None
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def _overlay_regional_bt(global_k: np.ndarray, folder: str) -> None:
    idx_path = os.path.join(folder, "index.json")
    if not os.path.exists(idx_path):
        return
    try:
        with open(idx_path, "r", encoding="utf-8") as f:
            idx = json.load(f)
        frames = idx.get("frames", [])
        if not frames:
            return
        latest = frames[-1]
        png_path = os.path.join(folder, latest["file"])
        if not os.path.exists(png_path):
            return
        b = idx["bounds"]
        byte = np.array(Image.open(png_path).convert("L"))
        reg_k = S.decode_bt(byte)
        r_ny, r_nx = reg_k.shape
        lats = LAT_MAX - STEP_DEG * np.arange(NY)
        lons = LON_MIN + STEP_DEG * np.arange(NX)
        r_mask = (lats <= b["north"]) & (lats >= b["south"])
        c_mask = (lons >= b["west"]) & (lons <= b["east"])
        if not r_mask.any() or not c_mask.any():
            return
        sub_lats = lats[r_mask][:, None]
        sub_lons = lons[c_mask][None, :]
        iy = np.clip(np.round((b["north"] - sub_lats) / (b["north"] - b["south"]) * (r_ny - 1)).astype(int), 0, r_ny - 1)
        ix = np.clip(np.round((sub_lons - b["west"]) / (b["east"] - b["west"]) * (r_nx - 1)).astype(int), 0, r_nx - 1)
        patch = reg_k[iy, ix]
        valid = np.isfinite(patch)
        sub = global_k[np.ix_(r_mask, c_mask)]
        global_k[np.ix_(r_mask, c_mask)] = np.where(valid, patch, sub)
    except Exception:
        pass


def build_global_ir(out_dir: str, now_utc: datetime | None = None) -> str | None:
    now_utc = now_utc or datetime.now(timezone.utc)
    global_k = np.full((NY, NX), np.nan, dtype=np.float32)
    any_data = False

    for _name, buckets in GOES_BUCKETS:
        for bucket in buckets:
            key = _latest_goes_key(bucket, now_utc)
            if not key:
                continue
            arr = _read_goes_nc(bucket, key)
            if arr is not None and np.isfinite(arr).any():
                valid = np.isfinite(arr)
                global_k = np.where(valid, arr, global_k)
                any_data = True
                break

    for sub in ("bt", "bt-h9"):
        p = os.path.join(out_dir, sub)
        if os.path.exists(os.path.join(p, "index.json")):
            _overlay_regional_bt(global_k, p)
            any_data = True

    if not any_data or not np.isfinite(global_k).any():
        print("global_sat: no satellite IR data available", flush=True)
        return None

    bt_dir = os.path.join(out_dir, "bt-global")
    os.makedirs(bt_dir, exist_ok=True)
    ts_iso = now_utc.strftime("%Y-%m-%dT%H:%M:00Z")
    fname = f"{now_utc:%Y%m%dT%H%M}Z.png"
    Image.fromarray(S.encode_bt(global_k), "L").save(os.path.join(bt_dir, fname), "PNG", optimize=True)

    idx_path = os.path.join(bt_dir, "index.json")
    frames = []
    if os.path.exists(idx_path):
        try:
            with open(idx_path, "r", encoding="utf-8") as f:
                frames = json.load(f).get("frames", [])
        except Exception:
            frames = []
    frames = [fr for fr in frames if fr.get("file") != fname]
    frames.append({"time": ts_iso, "file": fname})
    frames = frames[-MAX_FRAMES:]
    keep = {fr["file"] for fr in frames}
    for old in os.listdir(bt_dir):
        if old.endswith(".png") and old not in keep:
            try:
                os.remove(os.path.join(bt_dir, old))
            except OSError:
                pass

    index_doc = {
        "bounds": {"west": LON_MIN, "south": LAT_MIN, "east": 180.0, "north": LAT_MAX},
        "offsetK": S.OFFSET_K,
        "stepK": S.STEP_K,
        "frames": frames,
    }
    with open(idx_path, "w", encoding="utf-8") as f:
        json.dump(index_doc, f, indent=2)
    print(f"global_sat: wrote {fname} ({len(frames)} frames in bt-global/index.json)", flush=True)
    return idx_path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    build_global_ir(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
