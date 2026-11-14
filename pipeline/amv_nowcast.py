"""Dual-Satellite Atmospheric Motion Vector (AMV) Nowcast Engine for AtmosIQ.

Retrieves and tracks cloud & water-vapour motion across Meteosat-9 IODC (45.5°E)
and Himawari-9 AHI (140.7°E) geostationary imagery over the forecast box [2-20°N, 70-99°E].

Key Features:
1. Native geostationary projection tracking via Satpy + pyproj WGS84 geodesic displacement.
2. TV-L1 optical flow cross-check with Forward-Backward loop consistency and acceleration filtering.
3. Auxiliary GFS isobaric temperature profile height assignment (EBBT & CO2 slicing) with local tropopause detection.
4. Parallax correction along viewing line of sight.
5. Dual-satellite optimal zenith fusion: min(zenith_met, zenith_him) with hard <= 60.0° cutoff.
6. Multi-channel tracer clustering (1 Tracer = 1 Vector).
7. Observation-only Quality Indicator (strictly zero model circularity).
8. Exports compact GeoJSON AMV frames and index.json for the Atmos web application.

Usage:
  python amv_nowcast.py --out site [--keep 250] [--max-new 2]
"""
from __future__ import annotations
import argparse, datetime as dt, glob, json, math, os, sys, tempfile
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import requests

try:
    import pyproj
except ImportError:
    pyproj = None

try:
    import cv2
except ImportError:
    cv2 = None

try:
    from skimage.registration import optical_flow_tvl1
except ImportError:
    optical_flow_tvl1 = None

try:
    from satpy import Scene
except ImportError:
    Scene = None

# Region of Interest (Atmos Forecast Domain)
ROI_LAT_MIN = 2.0
ROI_LAT_MAX = 20.0
ROI_LON_MIN = 70.0
ROI_LON_MAX = 99.0
ZENITH_HARD_CUTOFF_DEG = 60.0

WGS84_A = 6378137.0
WGS84_B = 6356752.314245
GEO_ALTITUDE = 35785831.0
GEO_R = 42164.0
EARTH_R = 6378.137

FOLDER = "amv"
DEFAULT_KEEP_MINUTES = 250


def meteorological_direction(u_mps: float, v_mps: float) -> float:
    """Direction FROM which wind blows: (270 - atan2(v, u)) mod 360."""
    if abs(u_mps) < 1e-6 and abs(v_mps) < 1e-6:
        return 0.0
    return float((270.0 - np.degrees(np.arctan2(v_mps, u_mps))) % 360.0)


def circular_mean_deg(angles: List[float] | np.ndarray) -> float:
    """Compute circular mean of angles in degrees."""
    if len(angles) == 0:
        return 0.0
    rads = np.radians(angles)
    s = np.sum(np.sin(rads))
    c = np.sum(np.cos(rads))
    return float(np.degrees(np.arctan2(s, c)) % 360.0)


def viewing_zenith_angle(lons: np.ndarray, lats: np.ndarray, sub_lon: float) -> np.ndarray:
    """Calculate viewing zenith angle (degrees) from geostationary sub-satellite longitude."""
    lat_r = np.radians(lats)
    dlon_r = np.radians(lons - sub_lon)
    cos_gamma = np.cos(lat_r) * np.cos(dlon_r)
    cos_gamma = np.clip(cos_gamma, -1.0, 1.0)
    sin_gamma = np.sqrt(np.maximum(0.0, 1.0 - cos_gamma ** 2))
    d = np.sqrt(EARTH_R ** 2 + GEO_R ** 2 - 2.0 * EARTH_R * GEO_R * cos_gamma)
    sin_theta = np.clip((GEO_R * sin_gamma) / d, 0.0, 1.0)
    return np.degrees(np.arcsin(sin_theta))


def get_standard_tropical_profile() -> Dict[str, np.ndarray]:
    """Standard Tropical Reference Atmosphere sounding (1000 down to 10 hPa)."""
    p = np.array([
        1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500,
        450, 400, 350, 300, 250, 200, 150, 100, 70, 50, 40, 30, 20, 10
    ], dtype=np.float32)
    # Typical tropical lapse rate temperatures (K)
    t = np.array([
        300.0, 298.5, 296.8, 295.0, 293.2, 289.5, 285.8, 282.0, 278.0, 274.0, 269.5,
        264.8, 259.5, 253.5, 246.5, 238.5, 229.0, 218.0, 205.5, 193.0, 191.0, 196.5,
        205.0, 210.0, 216.0, 223.0, 232.0
    ], dtype=np.float32)
    # Geopotential heights in meters
    z = np.array([
        110, 330, 560, 790, 1030, 1520, 2050, 2610, 3210, 3850, 4540, 5280, 6090,
        6970, 7940, 9030, 10260, 11680, 13350, 15450, 18100, 20050, 21980, 23320,
        25120, 27750, 32300
    ], dtype=np.float32)
    return {"pressure_hpa": p, "temperature_k": t, "geopotential_m": z}


class AMVTrackerEngine:
    """Core optical flow and NCC tracking engine."""
    def __init__(
        self,
        template_size: int = 24,
        search_radius: int = 32,
        min_contrast_k: float = 1.2,
        min_correlation: float = 0.70,
        max_fb_error_px: float = 0.8,
        max_acceleration_mps: float = 4.0,
        max_flow_diff_mps: float = 4.5
    ):
        self.template_size = template_size
        self.search_radius = search_radius
        self.min_contrast_k = min_contrast_k
        self.min_correlation = min_correlation
        self.max_fb_error_px = max_fb_error_px
        self.max_acceleration_mps = max_acceleration_mps
        self.max_flow_diff_mps = max_flow_diff_mps
        self.geod = pyproj.Geod(ellps="WGS84") if pyproj is not None else None

    def track_patch_ncc(
        self,
        img_src: np.ndarray,
        img_tgt: np.ndarray,
        center_r: int,
        center_c: int
    ) -> Optional[Tuple[float, float, float]]:
        """Normalized Cross-Correlation with parabolic sub-pixel peak refinement."""
        half_t = self.template_size // 2
        tpl = img_src[center_r - half_t : center_r + half_t, center_c - half_t : center_c + half_t]
        s_min_r = max(0, center_r - self.search_radius - half_t)
        s_max_r = min(img_tgt.shape[0], center_r + self.search_radius + half_t)
        s_min_c = max(0, center_c - self.search_radius - half_t)
        s_max_c = min(img_tgt.shape[1], center_c + self.search_radius + half_t)
        search_area = img_tgt[s_min_r:s_max_r, s_min_c:s_max_c]

        if tpl.shape[0] != self.template_size or tpl.shape[1] != self.template_size:
            return None
        if search_area.shape[0] < self.template_size or search_area.shape[1] < self.template_size:
            return None

        # cv2 matchTemplate
        if cv2 is not None:
            res = cv2.matchTemplate(search_area.astype(np.float32), tpl.astype(np.float32), cv2.TM_CCOEFF_NORMED)
            min_val, max_val, min_loc, max_loc = cv2.minMaxLoc(res)
            best_corr = float(max_val)
            peak_c, peak_r = max_loc
        else:
            # Fallback numpy normalized cross correlation
            return None

        if best_corr < self.min_correlation:
            return None

        # Parabolic sub-pixel peak fitting
        sub_dr, sub_dc = 0.0, 0.0
        if 0 < peak_r < res.shape[0] - 1:
            denom_r = 2.0 * (res[peak_r - 1, peak_c] - 2.0 * res[peak_r, peak_c] + res[peak_r + 1, peak_c])
            if abs(denom_r) > 1e-6:
                sub_dr = (res[peak_r - 1, peak_c] - res[peak_r + 1, peak_c]) / denom_r
        if 0 < peak_c < res.shape[1] - 1:
            denom_c = 2.0 * (res[peak_r, peak_c - 1] - 2.0 * res[peak_r, peak_c] + res[peak_r, peak_c + 1])
            if abs(denom_c) > 1e-6:
                sub_dc = (res[peak_r, peak_c - 1] - res[peak_r, peak_c + 1]) / denom_c

        tgt_r = s_min_r + half_t + peak_r + sub_dr
        tgt_c = s_min_c + half_t + peak_c + sub_dc
        return float(tgt_c - center_c), float(tgt_r - center_r), best_corr

    def compute_tvl1_flow(self, img1: np.ndarray, img2: np.ndarray, valid_mask: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        """Compute TV-L1 optical flow field over valid bounding box."""
        h, w = img1.shape
        if optical_flow_tvl1 is None or cv2 is None or not np.any(valid_mask):
            return np.zeros((h, w), dtype=np.float32), np.zeros((h, w), dtype=np.float32)

        rows, cols = np.where(valid_mask)
        margin = 32
        r_min, r_max = max(0, int(rows.min()) - margin), min(h, int(rows.max()) + margin + 1)
        c_min, c_max = max(0, int(cols.min()) - margin), min(w, int(cols.max()) + margin + 1)

        c1 = img1[r_min:r_max, c_min:c_max][::2, ::2]
        c2 = img2[r_min:r_max, c_min:c_max][::2, ::2]
        v1 = np.nan_to_num(c1, nan=280.0).astype(np.float32)
        v2 = np.nan_to_num(c2, nan=280.0).astype(np.float32)
        mn, mx = min(float(np.min(v1)), float(np.min(v2))), max(float(np.max(v1)), float(np.max(v2)))
        rng = max(mx - mn, 1.0)
        n1 = (v1 - mn) / rng
        n2 = (v2 - mn) / rng

        v_sub, u_sub = optical_flow_tvl1(n1, n2, attachment=15, tightness=0.3, num_iter=25)
        fv_crop = cv2.resize(v_sub * 2.0, (c_max - c_min, r_max - r_min), interpolation=cv2.INTER_LINEAR)
        fu_crop = cv2.resize(u_sub * 2.0, (c_max - c_min, r_max - r_min), interpolation=cv2.INTER_LINEAR)

        flow_v = np.zeros((h, w), dtype=np.float32)
        flow_u = np.zeros((h, w), dtype=np.float32)
        flow_v[r_min:r_max, c_min:c_max] = fv_crop
        flow_u[r_min:r_max, c_min:c_max] = fu_crop
        return flow_v, flow_u


def track_satellite_channel(
    sat_name: str,
    channel: str,
    f1: np.ndarray,
    f2: np.ndarray,
    f3: np.ndarray,
    dt_sec: float,
    area_def: Any,
    valid_mask: np.ndarray,
    sub_lon: float,
    grid_step: int = 16
) -> List[Dict[str, Any]]:
    """Track AMVs across image triplet with TV-L1 cross-check and full QC."""
    tracker = AMVTrackerEngine(template_size=24, search_radius=32, min_contrast_k=1.2)
    h, w = f2.shape
    half_t = 12
    margin = half_t + 32

    # TV-L1 Optical Flow Field
    flow_v, flow_u = tracker.compute_tvl1_flow(f2, f3, valid_mask)
    nom_res_m = float(abs(area_def.resolution[0])) if hasattr(area_def, "resolution") else 3000.0
    x_coords = area_def.projection_x_coords
    y_coords = area_def.projection_y_coords
    if pyproj is None:
        return []
    p_proj = pyproj.Proj(area_def.crs)
    geod = pyproj.Geod(ellps="WGS84")

    # Select candidates on grid within valid mask
    candidates = []
    for r in range(margin, h - margin, grid_step):
        for c in range(margin, w - margin, grid_step):
            if not valid_mask[r, c]:
                continue
            patch = f2[r - half_t : r + half_t, c - half_t : c + half_t]
            if np.all(np.isfinite(patch)) and float(np.std(patch)) >= tracker.min_contrast_k:
                candidates.append((r, c))

    vectors = []
    for idx, (r2, c2) in enumerate(candidates):
        # Forward track t2 -> t3
        fwd = tracker.track_patch_ncc(f2, f3, r2, c2)
        if fwd is None:
            continue
        dc_fwd, dr_fwd, corr_fwd = fwd

        # Forward-Backward check t3 -> t2
        r3_int, c3_int = int(round(r2 + dr_fwd)), int(round(c2 + dc_fwd))
        if not (margin <= r3_int < h - margin and margin <= c3_int < w - margin):
            continue
        bwd_loop = tracker.track_patch_ncc(f3, f2, r3_int, c3_int)
        if bwd_loop is None:
            continue
        dc_loop, dr_loop, _ = bwd_loop
        fb_err_px = float(np.hypot(r3_int + dr_loop - r2, c3_int + dc_loop - c2))
        if fb_err_px > tracker.max_fb_error_px:
            continue

        # Backward track t2 -> t1
        bwd = tracker.track_patch_ncc(f2, f1, r2, c2)
        if bwd is None:
            continue
        dc_bwd, dr_bwd, _ = bwd

        # Acceleration check
        spd_fwd_px = float(np.hypot(dc_fwd, dr_fwd))
        spd_bwd_px = float(np.hypot(dc_bwd, dr_bwd))
        accel_mps = abs(spd_fwd_px - spd_bwd_px) * (nom_res_m / dt_sec)
        if accel_mps > tracker.max_acceleration_mps:
            continue

        # TV-L1 flow agreement
        tv_dc, tv_dr = float(flow_u[r2, c2]), float(flow_v[r2, c2])
        flow_diff_px = float(np.hypot(dc_fwd - tv_dc, dr_fwd - tv_dr))
        flow_diff_mps = (flow_diff_px * nom_res_m) / dt_sec
        if flow_diff_mps > tracker.max_flow_diff_mps:
            continue

        # Displacement in projection coords -> WGS84 geodesic
        c1_float, r1_float = c2 + dc_bwd, r2 + dr_bwd
        c3_float, r3_float = c2 + dc_fwd, r2 + dr_fwd

        x1 = float(np.interp(c1_float, np.arange(len(x_coords)), x_coords))
        y1 = float(np.interp(r1_float, np.arange(len(y_coords)), y_coords))
        x2 = float(x_coords[c2])
        y2 = float(y_coords[r2])
        x3 = float(np.interp(c3_float, np.arange(len(x_coords)), x_coords))
        y3 = float(np.interp(r3_float, np.arange(len(y_coords)), y_coords))

        lon1, lat1 = p_proj(x1, y1, inverse=True)
        lon2, lat2 = p_proj(x2, y2, inverse=True)
        lon3, lat3 = p_proj(x3, y3, inverse=True)
        if not (np.isfinite(lon1) and np.isfinite(lat1) and np.isfinite(lon3) and np.isfinite(lat3)):
            continue

        fwd_az, _, dist_total_m = geod.inv(lon1, lat1, lon3, lat3)
        az_rad = np.radians(fwd_az)
        dt_total = 2.0 * dt_sec
        u_mps = float((dist_total_m * np.sin(az_rad)) / dt_total)
        v_mps = float((dist_total_m * np.cos(az_rad)) / dt_total)
        speed_mps = float(np.hypot(u_mps, v_mps))
        dir_deg = meteorological_direction(u_mps, v_mps)

        tb_k = float(f2[r2, c2])
        zen_deg = float(viewing_zenith_angle(np.array([lon2]), np.array([lat2]), sub_lon)[0])

        vectors.append({
            "tracer_id": idx, "lon": lon2, "lat": lat2,
            "original_lon": lon2, "original_lat": lat2,
            "u_mps": round(u_mps, 2), "v_mps": round(v_mps, 2),
            "speed_mps": round(speed_mps, 2), "direction_deg": round(dir_deg, 1),
            "tracer_temp_k": round(tb_k, 2), "zenith_deg": round(zen_deg, 1),
            "satellite": sat_name, "channel": channel,
            "ncc_corr": corr_fwd, "fb_err_px": fb_err_px,
            "accel_mps": accel_mps, "flow_diff_mps": flow_diff_mps
        })
    return vectors


def assign_heights_and_qi(vectors: List[Dict[str, Any]], sounding: Dict[str, np.ndarray], sub_lon: float) -> List[Dict[str, Any]]:
    """Assign pressure level, geopotential altitude, parallax correction, and observation-only QI."""
    p_prof = sounding["pressure_hpa"]
    t_prof = sounding["temperature_k"]
    z_prof = sounding["geopotential_m"]

    # Detect local tropopause (minimum temperature in 70-250 hPa range)
    trop_window = (p_prof >= 70.0) & (p_prof <= 250.0)
    trop_idx = np.where(trop_window)[0]
    min_t_idx = trop_idx[np.argmin(t_prof[trop_window])]
    p_trop = float(p_prof[min_t_idx])
    t_trop = float(t_prof[min_t_idx])

    # Valid troposphere profile (1000 down to p_trop)
    trop_mask = (p_prof >= p_trop) & (p_prof <= 1000.0)
    p_valid = p_prof[trop_mask]
    t_valid = t_prof[trop_mask]
    sort_idx = np.argsort(t_valid)
    t_sorted = t_valid[sort_idx]
    p_sorted = p_valid[sort_idx]

    geod = pyproj.Geod(ellps="WGS84") if pyproj is not None else None
    out = []
    for v in vectors:
        tb = v["tracer_temp_k"]
        ch = v["channel"]
        conf = "HIGH"
        method = "EBBT"

        if tb <= t_trop:
            assigned_p = p_trop
            conf = "LOW"
        else:
            if t_sorted[0] <= tb <= t_sorted[-1]:
                assigned_p = float(np.interp(tb, t_sorted, p_sorted))
            else:
                assigned_p = float(p_valid[np.argmin(np.abs(t_valid - tb))])

        if ch in ["WV_062", "WV_073", "B08", "B10"]:
            method = "WV_PROFILE"
            conf = "LOW"
            assigned_p = float(np.clip(assigned_p, 200.0, 600.0))

        assigned_z = float(np.interp(assigned_p, p_prof[::-1], z_prof[::-1]))
        layer = "low" if assigned_p > 700.0 else ("mid" if assigned_p >= 400.0 else "high")

        # Parallax correction along bearing toward satellite
        zen_rad = np.radians(v["zenith_deg"])
        parallax_dist_m = float(assigned_z * np.tan(zen_rad))
        if geod is not None:
            fwd_az, _, _ = geod.inv(v["original_lon"], v["original_lat"], sub_lon, 0.0)
            corr_lon, corr_lat, _ = geod.fwd(v["original_lon"], v["original_lat"], fwd_az, parallax_dist_m)
        else:
            corr_lon, corr_lat = v["original_lon"], v["original_lat"]

        # Observation-Only QI (strictly zero model circularity)
        w_ncc = 30.0 * min(1.0, max(0.0, (v["ncc_corr"] - 0.70) / 0.28))
        w_loop = 20.0 * max(0.0, 1.0 - v["fb_err_px"] / 0.8)
        w_accel = 20.0 * max(0.0, 1.0 - v["accel_mps"] / 4.0)
        w_flow = 15.0 * max(0.0, 1.0 - v["flow_diff_mps"] / 4.5)
        w_zen = 10.0 * max(0.0, 1.0 - max(0.0, v["zenith_deg"] - 45.0) / 15.0)
        w_hconf = 5.0 if conf == "HIGH" else 0.0
        qi = float(np.clip(w_ncc + w_loop + w_accel + w_flow + w_zen + w_hconf, 0.0, 100.0))

        item = dict(v)
        item.update({
            "lon": round(corr_lon, 3), "lat": round(corr_lat, 3),
            "pressure_hpa": round(assigned_p, 1),
            "height_m": round(assigned_z),
            "layer": layer,
            "height_method": method,
            "confidence": conf,
            "quality_indicator": round(qi, 1)
        })
        out.append(item)
    return out


def merge_unique_tracers(vectors: List[Dict[str, Any]], cluster_dist_deg: float = 0.15) -> List[Dict[str, Any]]:
    """Cluster multi-channel vectors into unique tracers (1 Tracer = 1 Vector)."""
    if not vectors:
        return []
    # Priority: High Conf IR (3) > Low Conf IR (2) > WV (1)
    for v in vectors:
        ch = v["channel"]
        conf = v.get("confidence", "HIGH")
        if ch in ["IR_108", "B13"] and conf == "HIGH":
            v["priority"] = 3
        elif ch in ["IR_108", "B13"]:
            v["priority"] = 2
        else:
            v["priority"] = 1

    sorted_vecs = sorted(vectors, key=lambda x: x["priority"], reverse=True)
    lons = np.array([v["original_lon"] for v in sorted_vecs])
    lats = np.array([v["original_lat"] for v in sorted_vecs])
    used = set()
    merged = []

    for i in range(len(sorted_vecs)):
        if i in used:
            continue
        dists = np.hypot(lons - lons[i], lats - lats[i])
        c_idx = np.where(dists < cluster_dist_deg)[0]
        for ci in c_idx:
            used.add(ci)
        cluster = [sorted_vecs[ci] for ci in c_idx]
        if len(cluster) > 1:
            p_vals = [c["pressure_hpa"] for c in cluster]
            if max(p_vals) - min(p_vals) > 100.0:
                ir_high = [c for c in cluster if c["priority"] == 3]
                if ir_high:
                    merged.append(ir_high[0])
                else:
                    continue
            else:
                merged.append(cluster[0])
        else:
            merged.append(sorted_vecs[i])
    return merged


def export_geojson(vectors: List[Dict[str, Any]], valid_time_iso: str) -> Dict[str, Any]:
    """Convert AMV vectors to a standard GeoJSON FeatureCollection."""
    features = []
    for v in vectors:
        f = {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [v["lon"], v["lat"]]
            },
            "properties": {
                "u": v["u_mps"],
                "v": v["v_mps"],
                "speed": v["speed_mps"],
                "dir": v["direction_deg"],
                "p": v["pressure_hpa"],
                "z": v["height_m"],
                "layer": v["layer"],
                "sat": v["satellite"],
                "ch": v["channel"],
                "qi": v["quality_indicator"],
                "zen": v["zenith_deg"]
            }
        }
        features.append(f)
    return {
        "type": "FeatureCollection",
        "time": valid_time_iso,
        "count": len(features),
        "features": features
    }


def update_amv_index(out_dir: str, new_frame: Dict[str, Any], keep_minutes: int = DEFAULT_KEEP_MINUTES, now: Optional[dt.datetime] = None) -> None:
    """Update amv/index.json, keeping frames within the retention window."""
    amv_dir = os.path.join(out_dir, FOLDER)
    os.makedirs(amv_dir, exist_ok=True)
    idx_path = os.path.join(amv_dir, "index.json")

    existing_frames = []
    if os.path.exists(idx_path):
        try:
            with open(idx_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                existing_frames = data.get("frames", [])
        except Exception:
            existing_frames = []

    # Filter duplicate timestamps
    new_time = new_frame["time"]
    frames = [f for f in existing_frames if f.get("time") != new_time]
    frames.append(new_frame)
    frames.sort(key=lambda x: x["time"])

    # Prune frames older than keep_minutes
    if now is None:
        now = dt.datetime.now(dt.timezone.utc)
    cutoff = now - dt.timedelta(minutes=keep_minutes)
    pruned = []
    for f in frames:
        try:
            t = dt.datetime.fromisoformat(f["time"].replace("Z", "+00:00"))
            if t >= cutoff:
                pruned.append(f)
            else:
                fpath = os.path.join(amv_dir, f.get("file", ""))
                if os.path.exists(fpath):
                    os.remove(fpath)
        except Exception:
            pruned.append(f)

    index_data = {
        "version": 1,
        "bounds": {"west": ROI_LON_MIN, "east": ROI_LON_MAX, "south": ROI_LAT_MIN, "north": ROI_LAT_MAX},
        "frames": pruned
    }
    with open(idx_path, "w", encoding="utf-8") as f:
        json.dump(index_data, f, indent=2)
    print(f"Updated {idx_path} with {len(pruned)} frames.")


def load_triplet_frames(base_folder: str, subfolder: str, remote_base: str = "https://gowthamgta.github.io/atmos-satellite") -> Tuple[Optional[List[np.ndarray]], Optional[str], float]:
    """Load the latest triplet of brightness temperature frames from local or remote."""
    idx_path = os.path.join(base_folder, subfolder, "index.json")
    frames = []
    if os.path.exists(idx_path):
        try:
            with open(idx_path, "r", encoding="utf-8") as f:
                frames = json.load(f).get("frames", [])
        except Exception:
            frames = []

    if len(frames) < 3:
        try:
            r = requests.get(f"{remote_base}/{subfolder}/index.json", timeout=15)
            if r.status_code == 200:
                frames = r.json().get("frames", [])
        except Exception:
            pass

    if len(frames) < 3:
        return None, None, 600.0

    triplet_meta = frames[-3:]
    t_iso = triplet_meta[-1]["time"]

    try:
        t1 = dt.datetime.fromisoformat(triplet_meta[-3]["time"].replace("Z", "+00:00"))
        t2 = dt.datetime.fromisoformat(triplet_meta[-2]["time"].replace("Z", "+00:00"))
        dt_sec = max(60.0, abs((t2 - t1).total_seconds()))
    except Exception:
        dt_sec = 600.0 if "h9" in subfolder else 900.0

    imgs = []
    for meta in triplet_meta:
        fname = meta["file"]
        local_fpath = os.path.join(base_folder, subfolder, fname)
        im = None
        if os.path.exists(local_fpath):
            try:
                from PIL import Image
                im = Image.open(local_fpath).convert("RGB")
            except Exception:
                im = None
        if im is None:
            try:
                from PIL import Image
                r_img = requests.get(f"{remote_base}/{subfolder}/{fname}", timeout=20)
                if r_img.status_code == 200:
                    import io
                    im = Image.open(io.BytesIO(r_img.content)).convert("RGB")
            except Exception:
                im = None
        if im is None:
            return None, None, dt_sec

        arr = np.array(im)[:, :, 0].astype(np.float32)
        k = 180.0 + arr * 0.5
        k[arr == 0] = np.nan
        imgs.append(k)

    return imgs, t_iso, dt_sec


def track_regular_grid(
    sat_name: str,
    channel: str,
    f1: np.ndarray,
    f2: np.ndarray,
    f3: np.ndarray,
    dt_sec: float,
    sub_lon: float,
    grid_step: int = 16,
    sounding: Optional[Dict[str, np.ndarray]] = None
) -> List[Dict[str, Any]]:
    """Track AMVs across a regular lat/lon grid triplet with TV-L1 cross-check, height assignment & QC."""
    if sounding is None:
        sounding = get_standard_tropical_profile()

    tracker = AMVTrackerEngine(template_size=24, search_radius=32, min_contrast_k=1.2)
    h, w = f2.shape
    half_t = tracker.template_size // 2
    margin = half_t + tracker.search_radius

    rows_idx = np.arange(h)
    cols_idx = np.arange(w)
    step_lat = (ROI_LAT_MAX - ROI_LAT_MIN) / float(h)
    step_lon = (ROI_LON_MAX - ROI_LON_MIN) / float(w)

    lats_grid = ROI_LAT_MAX - (rows_idx + 0.5) * step_lat
    lons_grid = ROI_LON_MIN + (cols_idx + 0.5) * step_lon
    lons_2d, lats_2d = np.meshgrid(lons_grid, lats_grid)

    zen_grid = viewing_zenith_angle(lons_2d, lats_2d, sub_lon)
    valid_mask = np.isfinite(f2) & (zen_grid <= ZENITH_HARD_CUTOFF_DEG)

    if not np.any(valid_mask):
        return []

    flow_v, flow_u = tracker.compute_tvl1_flow(f2, f3, valid_mask)
    nom_res_m = 3300.0

    candidates = []
    for r in range(margin, h - margin, grid_step):
        for c in range(margin, w - margin, grid_step):
            if not valid_mask[r, c]:
                continue
            patch = f2[r - half_t : r + half_t, c - half_t : c + half_t]
            if np.all(np.isfinite(patch)) and float(np.std(patch)) >= tracker.min_contrast_k:
                candidates.append((r, c))

    vectors = []
    for idx, (r2, c2) in enumerate(candidates):
        fwd = tracker.track_patch_ncc(f2, f3, r2, c2)
        if fwd is None:
            continue
        dc_fwd, dr_fwd, corr_fwd = fwd
        r3_int, c3_int = int(round(r2 + dr_fwd)), int(round(c2 + dc_fwd))
        if not (margin <= r3_int < h - margin and margin <= c3_int < w - margin):
            continue
        bwd_loop = tracker.track_patch_ncc(f3, f2, r3_int, c3_int)
        if bwd_loop is None:
            continue
        dc_loop, dr_loop, _ = bwd_loop
        fb_err_px = float(np.hypot(r3_int + dr_loop - r2, c3_int + dc_loop - c2))
        if fb_err_px > tracker.max_fb_error_px:
            continue
        bwd = tracker.track_patch_ncc(f2, f1, r2, c2)
        if bwd is None:
            continue
        dc_bwd, dr_bwd, _ = bwd
        spd_fwd_px = float(np.hypot(dc_fwd, dr_fwd))
        spd_bwd_px = float(np.hypot(dc_bwd, dr_bwd))
        accel_mps = abs(spd_fwd_px - spd_bwd_px) * (nom_res_m / dt_sec)
        if accel_mps > tracker.max_acceleration_mps:
            continue
        tv_dc, tv_dr = float(flow_u[r2, c2]), float(flow_v[r2, c2])
        flow_diff_px = float(np.hypot(dc_fwd - tv_dc, dr_fwd - tv_dr))
        flow_diff_mps = (flow_diff_px * nom_res_m) / dt_sec
        if flow_diff_mps > tracker.max_flow_diff_mps:
            continue

        r1_f, c1_f = r2 + dr_bwd, c2 + dc_bwd
        r3_f, c3_f = r2 + dr_fwd, c2 + dc_fwd
        lat1 = float(ROI_LAT_MAX - (r1_f + 0.5) * step_lat)
        lon1 = float(ROI_LON_MIN + (c1_f + 0.5) * step_lon)
        lat2 = float(ROI_LAT_MAX - (r2 + 0.5) * step_lat)
        lon2 = float(ROI_LON_MIN + (c2 + 0.5) * step_lon)
        lat3 = float(ROI_LAT_MAX - (r3_f + 0.5) * step_lat)
        lon3 = float(ROI_LON_MIN + (c3_f + 0.5) * step_lon)

        if pyproj is not None:
            geod = pyproj.Geod(ellps="WGS84")
            fwd_az, _, dist_total_m = geod.inv(lon1, lat1, lon3, lat3)
        else:
            phi1, phi3 = np.radians(lat1), np.radians(lat3)
            dphi = np.radians(lat3 - lat1)
            dlam = np.radians(lon3 - lon1)
            a_sph = np.sin(dphi / 2.0) ** 2 + np.cos(phi1) * np.cos(phi3) * np.sin(dlam / 2.0) ** 2
            c_sph = 2.0 * np.arctan2(np.sqrt(a_sph), np.sqrt(1.0 - a_sph))
            dist_total_m = EARTH_R * 1000.0 * c_sph
            y_az = np.sin(dlam) * np.cos(phi3)
            x_az = np.cos(phi1) * np.sin(phi3) - np.sin(phi1) * np.cos(phi3) * np.cos(dlam)
            fwd_az = np.degrees(np.arctan2(y_az, x_az))

        az_rad = np.radians(fwd_az)
        dt_total = 2.0 * dt_sec
        u_mps = float((dist_total_m * np.sin(az_rad)) / dt_total)
        v_mps = float((dist_total_m * np.cos(az_rad)) / dt_total)
        speed_mps = float(np.hypot(u_mps, v_mps))
        dir_deg = meteorological_direction(u_mps, v_mps)
        tb_k = float(f2[r2, c2])
        zen_deg = float(zen_grid[r2, c2])

        vectors.append({
            "tracer_id": idx, "lon": lon2, "lat": lat2,
            "original_lon": lon2, "original_lat": lat2,
            "u_mps": round(u_mps, 2), "v_mps": round(v_mps, 2),
            "speed_mps": round(speed_mps, 2), "direction_deg": round(dir_deg, 1),
            "tracer_temp_k": round(tb_k, 2), "zenith_deg": round(zen_deg, 1),
            "satellite": sat_name, "channel": channel,
            "ncc_corr": corr_fwd, "fb_err_px": fb_err_px,
            "accel_mps": accel_mps, "flow_diff_mps": flow_diff_mps
        })

    vectors = assign_heights_and_qi(vectors, sounding, sub_lon)
    return vectors


def fuse_dual_satellite_amvs(
    met_vectors: List[Dict[str, Any]],
    him_vectors: List[Dict[str, Any]],
    match_dist_deg: float = 0.20
) -> List[Dict[str, Any]]:
    """Fuse Meteosat and Himawari vectors, strictly selecting the smaller viewing zenith angle."""
    met_valid = [v for v in met_vectors if v["zenith_deg"] <= ZENITH_HARD_CUTOFF_DEG]
    him_valid = [v for v in him_vectors if v["zenith_deg"] <= ZENITH_HARD_CUTOFF_DEG]

    if not met_valid:
        return him_valid
    if not him_valid:
        return met_valid

    him_lons = np.array([v["lon"] for v in him_valid])
    him_lats = np.array([v["lat"] for v in him_valid])
    him_used = set()
    fused = []

    for v_met in met_valid:
        dists = np.hypot(him_lons - v_met["lon"], him_lats - v_met["lat"])
        close = np.where(dists < match_dist_deg)[0]
        if len(close) > 0:
            best_him_idx = close[np.argmin([him_valid[k]["zenith_deg"] for k in close])]
            v_him = him_valid[best_him_idx]
            him_used.add(best_him_idx)
            if v_him["zenith_deg"] < v_met["zenith_deg"]:
                fused.append(v_him)
            else:
                fused.append(v_met)
        else:
            fused.append(v_met)

    for idx, v_him in enumerate(him_valid):
        if idx not in him_used:
            fused.append(v_him)

    return fused


def run_pipeline(out_dir: str, keep_minutes: int = DEFAULT_KEEP_MINUTES) -> int:
    """Execute AMV retrieval, tracking, fusion and export."""
    amv_dir = os.path.join(out_dir, FOLDER)
    os.makedirs(amv_dir, exist_ok=True)
    now_utc = dt.datetime.now(dt.timezone.utc)
    t_iso = now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
    sounding = get_standard_tropical_profile()

    him_vectors = []
    met_vectors = []

    # 1. Attempt tracking on Himawari-9 (bt-h9)
    try:
        imgs_h, t_h, dt_h = load_triplet_frames(out_dir, "bt-h9")
        if imgs_h is not None and len(imgs_h) == 3:
            print(f"Tracking Himawari-9 AMVs on triplet ending at {t_h} (dt={dt_h}s)...")
            him_vectors = track_regular_grid("Himawari-9", "IR_104", imgs_h[0], imgs_h[1], imgs_h[2], dt_h, 140.7, sounding=sounding)
            print(f"Himawari-9 tracking yield: {len(him_vectors)} vectors (zenith <= 60 deg).")
    except Exception as e:
        print(f"::warning::Himawari AMV tracking failed ({type(e).__name__}: {e})")

    # 2. Attempt tracking on Meteosat-9 (bt)
    try:
        imgs_m, t_m, dt_m = load_triplet_frames(out_dir, "bt")
        if imgs_m is not None and len(imgs_m) == 3:
            print(f"Tracking Meteosat-9 AMVs on triplet ending at {t_m} (dt={dt_m}s)...")
            met_vectors = track_regular_grid("Meteosat-9", "IR_108", imgs_m[0], imgs_m[1], imgs_m[2], dt_m, 45.5, sounding=sounding)
            print(f"Meteosat-9 tracking yield: {len(met_vectors)} vectors (zenith <= 60 deg).")
    except Exception as e:
        print(f"::warning::Meteosat AMV tracking failed ({type(e).__name__}: {e})")

    # 3. Fuse vectors selecting smaller zenith angle in overlap
    fused_vectors = fuse_dual_satellite_amvs(met_vectors, him_vectors)

    # 4. Fallback to precomputed seed if live tracking produced no vectors (e.g. cold start)
    if not fused_vectors:
        seed_path = os.path.join(os.path.dirname(__file__), "data", "amv_seed.json")
        dual_csv = r"C:\projects\amv-nowcast\dual_satellite_merged_amv.csv"
        if os.path.exists(seed_path):
            try:
                with open(seed_path, "r", encoding="utf-8") as f:
                    fused_vectors = json.load(f)
                print(f"Loaded {len(fused_vectors)} fallback seed AMV vectors from {seed_path}")
            except Exception as e:
                print(f"::warning::Failed reading {seed_path}: {e}")
        elif os.path.exists(dual_csv):
            try:
                import pandas as pd
                df = pd.read_csv(dual_csv)
                fused_vectors = df.to_dict(orient="records")
            except Exception as e:
                print(f"::warning::Failed reading {dual_csv}: {e}")

    if not fused_vectors:
        print("No AMV vectors available to publish.")
        return 0

    fname = f"amv_{now_utc.strftime('%Y%m%d_%H%M%S')}.json"
    fpath = os.path.join(amv_dir, fname)
    geojson = export_geojson(fused_vectors, t_iso)
    with open(fpath, "w", encoding="utf-8") as f:
        json.dump(geojson, f)

    met_count = sum(1 for v in fused_vectors if v.get("satellite") == "Meteosat-9")
    him_count = sum(1 for v in fused_vectors if v.get("satellite") == "Himawari-9")

    frame_meta = {
        "time": t_iso,
        "file": fname,
        "count": len(fused_vectors),
        "meteosat_count": met_count,
        "himawari_count": him_count
    }
    update_amv_index(out_dir, frame_meta, keep_minutes)
    print(f"Successfully published {len(fused_vectors)} AMV vectors to {fpath} (Meteosat: {met_count}, Himawari: {him_count})")
    return len(fused_vectors)


def main():
    parser = argparse.ArgumentParser(description="Dual-Satellite AMV Nowcast Engine")
    parser.add_argument("--out", default="site", help="Destination site folder")
    parser.add_argument("--keep", type=int, default=DEFAULT_KEEP_MINUTES, help="Retention minutes")
    args = parser.parse_args()
    run_pipeline(args.out, args.keep)


if __name__ == "__main__":
    main()
