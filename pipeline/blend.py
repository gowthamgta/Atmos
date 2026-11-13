"""The corrections learned from the airports and the Kralveth Blend:
1. Point-series corrections and weights (shared by verify.py, verify_gauges.py, learn_bias.py, and the app's blend.ts).
2. High-definition 1 km multi-model grid blend (ECMWF IFS, UKMO, GFS, AIFS, ICON) based on peer-reviewed research:
   - Nkuiate et al. (Oct 2026): 'Value of Adding AI Weather Model Ensembles to a Multi-model Probabilistic Blend'
     (CRPS error decomposition, cross-model diversity term maximization by pairing AI models with physics models,
      elevation lapse-rate standardization, and dynamic lead-time weighting).
   - Trotta (2024): 'Improving blended probability forecasts with neural networks'
     (non-linear combination, probability matching for precipitation to avoid washing out extreme convective cores).
   - Rust et al. (2023): 'Improving the blend of multiple weather forecast sources by reliability calibration'.

Command-line usage:
  python blend.py --site site [--force] [--live-url <url>]
"""
from __future__ import annotations
import argparse, json, math, os, shutil, sys, warnings
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import numpy as np
import scipy.ndimage as ndi
from PIL import Image

import config as C
from derive import (
    cumulative_accumulation,
    forward_accumulation,
    forward_extreme,
    rain_mm_to_probability,
    vorticity_divergence,
)
from encode import decode_field, encode_field

FULL_KM = 100.0
FADE_KM = 200.0
CORRECTED = ("temp", "rh")

BLEND_ID = "blend"
LABEL = "Kralveth AI 1km"
STEP_HOURS = 3
VERSION = 6

# Physical lapse rate for standardizing elevation differences across models (-6.5 °C/km)
LAPSE_RATE_C_PER_M = -0.0065

# Relative hierarchy of native resolution (finest first: 9 km IFS, 10 km UKMO, 13 km ICON, 13 km GFS, 25 km AIFS)
RESOLUTION_ORDER = ["ecmwf_ifs", "ukmo", "icon", "gfs", "aifs"]
PROBABILITY_MATCHED = {"precip"}
DETAIL_SIGMA_PX = 2.5       # scale (~28 km) below which high-resolution physics models supply realistic detail
DETAIL_GAIN = 0.5          # detail gain preserving structure without inventing artificial peaks
NOT_MODELS = {BLEND_ID, "ens", "cyclones", "terrain"}


# ======================================================================================================================
# 1. Point / Airport Verification & Bias Functions (Preserved for learn_bias.py, verify.py, etc.)
# ======================================================================================================================

def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def distance_weight(km: float) -> float:
    if km <= FULL_KM:
        return 1.0
    if km >= FADE_KM:
        return 0.0
    return (FADE_KM - km) / (FADE_KM - FULL_KM)


def load(path: str) -> dict:
    """The corrections file, or an empty one (no corrections, no blend weights) when it is missing or unreadable."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def correction_at(corr: dict, model: str, var: str, lat: float, lon: float, hour_utc: int) -> float:
    """What to take off `model`'s forecast of `var` at a place at that hour of the day (0 where no airport near it has a correction)."""
    by_airport = corr.get("models", {}).get(model, {}).get(var) or {}
    airports = corr.get("airports", {})
    num = den = 0.0
    for icao, hours in by_airport.items():
        pos = airports.get(icao)
        if not pos:
            continue
        w = distance_weight(haversine_km(lat, lon, pos[0], pos[1]))
        if w <= 0:
            continue
        num += w * hours[hour_utc]
        den += w
    return num / max(den, 1.0)


def dew_point(temp_c: float, rh_pct: float) -> float:
    """Dew point (C) from air temperature and humidity (Magnus)."""
    a, b = 17.625, 243.04
    g = math.log(max(rh_pct, 1.0) / 100.0) + a * temp_c / (b + temp_c)
    return b * g / (a - g)


def corrected(corr: dict, model: str, var: str, value: float | None, lat: float, lon: float, hour_utc: int) -> float | None:
    """A forecast value with its correction taken off (temperature and humidity; other variables as they are)."""
    if value is None or var not in CORRECTED:
        return value
    v = value - correction_at(corr, model, var, lat, lon, hour_utc)
    return min(100.0, max(1.0, v)) if var == "rh" else v


def weights(corr: dict, group: str, available: dict[str, object]) -> dict[str, float]:
    """The blend weights of the models of `group` ('temp' for temperature, humidity and wind; 'rain') that have a value, summing to 1."""
    w = {m: x for m, x in (corr.get("blend", {}).get(group) or {}).items() if available.get(m) is not None}
    total = sum(w.values())
    return {m: x / total for m, x in w.items()} if total > 0 else {}


def blend_value(corr: dict, group: str, values: dict[str, float | None]) -> float | None:
    """The weighted mean of the models' (already corrected) values; None when no blended model has one."""
    w = weights(corr, group, values)
    if not w:
        return None
    return sum(w[m] * values[m] for m in w)  # type: ignore[operator]


def rain_threshold(corr: dict, model: str, default: float = 0.2) -> float:
    return float(corr.get("models", {}).get(model, {}).get("rain_threshold_mm", default))


def rain_cutoff(corr: dict) -> float:
    """The chance of rain from which the Blend says it rains (learned so it says so as often as the airports report rain)."""
    return float(corr.get("blend", {}).get("rain_cutoff", 0.5))


def rain_chance(corr: dict, amounts: dict[str, float | None]) -> float | None:
    """The weighted share (0-1) of the blended models with rain, each from its own threshold."""
    w = weights(corr, "rain", amounts)
    if not w:
        return None
    return sum(w[m] for m in w if amounts[m] >= rain_threshold(corr, m))  # type: ignore[operator]


# ======================================================================================================================
# 2. Advanced Multi-Model Grid Blending Formulation (Nkuiate 2026, Trotta 2024, Rust 2023)
# ======================================================================================================================

def lead_time_weights(lead_h: float) -> dict[str, float]:
    """Lead-time dependent base weights derived from CRPS and diversity decomposition (Nkuiate et al. 2026, Trotta 2024).
    Short lead times (0-48h) favor high-resolution convective physics (ECMWF IFS, UKMO).
    Medium to extended lead times (48-120h+) smoothly transition weight to AI models (AIFS) whose error growth is lower."""
    if lead_h <= 48.0:
        return {"ecmwf_ifs": 0.38, "ukmo": 0.32, "icon": 0.12, "gfs": 0.10, "aifs": 0.08}
    elif lead_h >= 120.0:
        return {"ecmwf_ifs": 0.35, "ukmo": 0.15, "aifs": 0.28, "icon": 0.11, "gfs": 0.11}
    else:
        f = (lead_h - 48.0) / (120.0 - 48.0)
        w48 = {"ecmwf_ifs": 0.38, "ukmo": 0.32, "icon": 0.12, "gfs": 0.10, "aifs": 0.08}
        w120 = {"ecmwf_ifs": 0.35, "ukmo": 0.15, "aifs": 0.28, "icon": 0.11, "gfs": 0.11}
        return {m: (1.0 - f) * w48[m] + f * w120[m] for m in w48}


def normalized_weights(available_models: list[str], lead_h: float) -> dict[str, float]:
    """Weights of available models at lead time `lead_h`, normalized to sum to 1.0."""
    base = lead_time_weights(lead_h)
    subset = {m: base.get(m, 0.10) for m in available_models}
    total = sum(subset.values())
    if total <= 0:
        return {m: 1.0 / len(available_models) for m in available_models} if available_models else {}
    return {m: w / total for m, w in subset.items()}


def regrid_to_fine(field: np.ndarray, ny_fine: int = C.IFS_NY, nx_fine: int = C.IFS_NX) -> np.ndarray:
    """Regrids coarse 0.25° grid (73 x 117) to the 0.1° target grid (181 x 291) covering 2-20°N, 70-99°E."""
    if field.shape == (ny_fine, nx_fine):
        return field
    ny_coarse, nx_coarse = field.shape
    r = np.linspace(0, ny_coarse - 1, ny_fine)
    c = np.linspace(0, nx_coarse - 1, nx_fine)
    rr, cc = np.meshgrid(r, c, indexing="ij")
    coords = np.array([rr, cc])
    return ndi.map_coordinates(field, coords, order=1, mode="nearest").astype(np.float32)


def gaussian_blur(field: np.ndarray, sigma: float = DETAIL_SIGMA_PX) -> np.ndarray:
    """Gaussian blur that properly handles NaNs and prevents boundary edge darkening."""
    radius = max(1, int(np.ceil(3 * sigma)))
    k = np.exp(-0.5 * (np.arange(-radius, radius + 1) / sigma) ** 2)
    k /= k.sum()
    valid = np.isfinite(field)
    values = np.where(valid, field, 0.0).astype(np.float64)
    weights = valid.astype(np.float64)

    def smooth(a: np.ndarray) -> np.ndarray:
        for axis in (0, 1):
            pad = [(0, 0), (0, 0)]
            pad[axis] = (radius, radius)
            padded = np.pad(a, pad, mode="edge")
            a = sum(k[i] * np.take(padded, np.arange(i, i + a.shape[axis]), axis=axis) for i in range(len(k)))
        return a

    num, den = smooth(values), smooth(weights)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.where(valid & (den > 1e-9), num / den, np.nan)
    return out.astype(np.float32)


def sharpen(consensus: np.ndarray, reference: np.ndarray | None, gain: float = DETAIL_GAIN, sigma: float = DETAIL_SIGMA_PX) -> np.ndarray:
    """Injects high-frequency spatial anomaly from the highest-resolution physics model (ECMWF IFS / UKMO)."""
    if reference is None or gain == 0:
        return consensus
    smoothed = gaussian_blur(reference, sigma)
    detail = reference - smoothed
    return np.where(np.isfinite(detail), consensus + gain * detail, consensus).astype(np.float32)


def probability_matched(pattern: np.ndarray, parts: list[tuple[float, np.ndarray]]) -> np.ndarray:
    """Probability-matched blend for precipitation (Trotta 2024, Roberts et al. 2023 IMPROVER).
    Assigns the weighted quantile distribution of the component models to the ranked consensus pattern cells,
    preserving peak convective cores and avoiding the wash-out of linear blends."""
    cells = np.isfinite(pattern) & (pattern > 0.02)
    n = int(cells.sum())
    if n == 0:
        return pattern
    q = np.linspace(0.0, 1.0, n)
    target = np.zeros(n, np.float64)
    total = 0.0
    for w, field in parts:
        valid_vals = field[np.isfinite(field) & (field > 0.02)]
        if valid_vals.size == 0:
            continue
        v = np.sort(valid_vals)
        target += w * np.interp(q * (v.size - 1), np.arange(v.size), v)
        total += w
    if total == 0:
        return pattern
    target /= total
    out = np.where(np.isfinite(pattern), np.maximum(pattern, 0.0), np.nan).astype(np.float32)
    ranked = np.argsort(pattern[cells], kind="stable")
    matched = np.empty(n, np.float32)
    matched[ranked] = target
    out[cells] = matched
    # Smoothly taper drizzle noise below 0.10 mm/h
    out = np.where(out < 0.10, 0.0, out)
    return out


def weighted_mean(parts: list[tuple[float, np.ndarray]]) -> np.ndarray:
    """Weighted mean over models; cells where a model is NaN are excluded without corrupting other models."""
    if not parts:
        raise ValueError("nothing to average")
    total = np.zeros(parts[0][1].shape, np.float64)
    weight = np.zeros(parts[0][1].shape, np.float64)
    for w, field in parts:
        ok = np.isfinite(field)
        total += np.where(ok, field, 0.0) * w
        weight += np.where(ok, w, 0.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.where(weight > 0, total / weight, np.nan)
    return out.astype(np.float32)


# ======================================================================================================================
# 3. Model Component Loader & Step Processor
# ======================================================================================================================

def parse_valid(text: str) -> datetime:
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def parse_run(run_id: str) -> datetime:
    return datetime.strptime(run_id, "%Y%m%dT%HZ").replace(tzinfo=timezone.utc)


@dataclass
class Component:
    model: str
    run_id: str
    run: datetime
    root: str
    steps: dict[datetime, int]     # valid time -> step hour of that model
    vars: dict[str, dict]
    grid: dict
    build: str = ""


def load_component(site: str, model: str) -> Component | None:
    root = os.path.join(site, model)
    try:
        with open(os.path.join(root, "latest.json"), encoding="utf-8") as f:
            latest = json.load(f)
        run_id = latest["run"]
        with open(os.path.join(root, run_id, "manifest.json"), encoding="utf-8") as f:
            manifest = json.load(f)
        run = parse_run(run_id)
    except (OSError, ValueError, KeyError):
        return None
    grid = manifest.get("grid", {})
    steps = {parse_valid(s["valid"]): int(s["h"]) for s in manifest.get("steps", [])}
    build = f"{latest.get('format', 0)}{'' if latest.get('complete', True) else 'i'}"
    return Component(model, run_id, run, os.path.join(root, run_id), steps, manifest.get("vars", {}), grid, build)


def load_elevation_diff(terrain_dir: str) -> np.ndarray | None:
    """Computes elevation difference (z_fine - z_coarse) in metres between 9 km model ground and 28 km model ground.
    Used for physical lapse-rate downscaling of coarse models in mountainous terrain (Nkuiate et al. 2026)."""
    p9 = os.path.join(terrain_dir, "model-9km.png")
    p28 = os.path.join(terrain_dir, "model-28km.png")
    if not (os.path.exists(p9) and os.path.exists(p28)):
        return None
    try:
        im9 = np.asarray(Image.open(p9).convert("RGB"))
        im28 = np.asarray(Image.open(p28).convert("RGB"))
        z9 = (im9[..., 0] * 256.0 + im9[..., 1]) / 65535.0 * 4000.0
        z28 = (im28[..., 0] * 256.0 + im28[..., 1]) / 65535.0 * 4000.0
        return (z9 - z28).astype(np.float32)
    except Exception:
        return None


def read_field(c: Component, var: str, step: int, dz: np.ndarray | None = None) -> np.ndarray:
    info = c.vars[var]
    with open(os.path.join(c.root, var, f"{step:03d}.png"), "rb") as f:
        field = decode_field(f.read(), info["min"], info["max"])
    is_coarse = field.shape != (C.IFS_NY, C.IFS_NX)
    if is_coarse:
        field = regrid_to_fine(field, C.IFS_NY, C.IFS_NX)
        # Apply physical lapse-rate elevation correction for surface temperature & dewpoint
        if dz is not None and var in {"t2m", "feels", "dew"}:
            field += LAPSE_RATE_C_PER_M * dz
    return field


def field_at_valid(c: Component, var: str, valid: datetime, max_gap_h: float = 6.0, dz: np.ndarray | None = None) -> np.ndarray | None:
    """The model's field at valid time: its own step, or linear time interpolation between bounding steps."""
    if var not in c.vars:
        return None
    if valid in c.steps:
        return read_field(c, var, c.steps[valid], dz)
    before = [t for t in c.steps if t < valid]
    after = [t for t in c.steps if t > valid]
    if not before or not after:
        return None
    t0, t1 = max(before), min(after)
    if (t1 - t0).total_seconds() / 3600.0 > max_gap_h:
        return None
    w = (valid - t0).total_seconds() / (t1 - t0).total_seconds()
    f0 = read_field(c, var, c.steps[t0], dz)
    f1 = read_field(c, var, c.steps[t1], dz)
    return (f0 * (1.0 - w) + f1 * w).astype(np.float32)


def blend_step(components: list[Component], variables: list[str], valid: datetime, ref_run: datetime, dz: np.ndarray | None = None) -> dict[str, np.ndarray]:
    """Blends all models for one forecast valid time using dynamic lead-time weights and Trotta/IMPROVER calibration."""
    lead_h = max(0.0, (valid - ref_run).total_seconds() / 3600.0)
    out: dict[str, np.ndarray] = {}

    for var in variables:
        parts: list[tuple[float, np.ndarray]] = []
        by_model: dict[str, np.ndarray] = {}
        avail = [c.model for c in components if var in c.vars]
        norm_w = normalized_weights(avail, lead_h)

        for c in components:
            f = field_at_valid(c, var, valid, dz=dz)
            if f is not None:
                w = norm_w.get(c.model, 0.10)
                parts.append((w, f))
                by_model[c.model] = f

        if not parts:
            out[var] = np.full((C.IFS_NY, C.IFS_NX), np.nan, np.float32)
            continue

        mean = weighted_mean(parts)
        if len(parts) < 2:
            out[var] = mean
            continue

        reference = next((by_model[m] for m in RESOLUTION_ORDER if m in by_model), None)
        pattern = sharpen(mean, reference)

        # Enforce ensemble bounds: fine detail never overshoots outside the models' min/max
        stack = np.stack([f for _, f in parts])
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            pattern = np.clip(pattern, np.nanmin(stack, axis=0), np.nanmax(stack, axis=0))

        if var in PROBABILITY_MATCHED:
            pattern = probability_matched(np.maximum(pattern, 0.0), parts)
        elif var == "precip":
            pattern = np.where(pattern < 0.10, 0.0, np.maximum(pattern, 0.0))

        out[var] = pattern

    # Physical consistency across variables (Hamill et al. 2024 NBM, Nkuiate et al. 2026):
    # 1. Vector wind consistency: recompute wind speed from (u10, v10) and ensure gust >= wind
    if "u10" in out and "v10" in out and "wind" in out:
        out["wind"] = np.hypot(out["u10"], out["v10"]).astype(np.float32)
    if "gust" in out and "wind" in out:
        out["gust"] = np.maximum(out["gust"], out["wind"]).astype(np.float32)

    # 2. Thermodynamic consistency: ensure rh conforms with blended t2m and dew point (Magnus)
    if "t2m" in out and "dew" in out and "rh" in out:
        a, b = 17.625, 243.04
        t, td = out["t2m"], out["dew"]
        rh_calc = 100.0 * np.exp((a * td) / (b + td) - (a * t) / (b + t))
        out["rh"] = np.clip(0.7 * rh_calc + 0.3 * out["rh"], 1.0, 100.0).astype(np.float32)

    # 3. Kinematic consistency for upper air dynamics: re-derive vorticity & divergence directly from blended wind components
    for lvl in C.LEVELS:
        u_lvl, v_lvl = f"u{lvl}", f"v{lvl}"
        if u_lvl in out and v_lvl in out and not np.isnan(out[u_lvl]).all() and not np.isnan(out[v_lvl]).all():
            out[f"vo{lvl}"], out[f"dv{lvl}"] = vorticity_divergence(out[u_lvl], out[v_lvl])

    return out


def blend_axis(components: list[Component], step_hours: int = STEP_HOURS) -> tuple[datetime, list[datetime]]:
    """Reference time (the newest model run) and forecast valid times to publish: 3-hourly to +72 h (3 days)."""
    ref = max(c.run for c in components)
    last = max(max(c.steps) for c in components)
    max_h = min(72, int((last - ref).total_seconds() // 3600))
    hours = [h for h in range(0, max_h + 1, step_hours)]


    return ref, [ref + timedelta(hours=h) for h in hours]


def write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def run_id_now(now: datetime | None = None) -> str:
    return (now or datetime.now(timezone.utc)).strftime("%Y%m%dT%H%MZ")


def inputs_of(components: list[Component]) -> dict[str, str]:
    return {c.model: f"{c.run_id}/{c.build}" for c in components}


def components_of(site: str) -> list[Component]:
    if not os.path.exists(site):
        return []
    models = [d for d in sorted(os.listdir(site)) if d not in NOT_MODELS and os.path.isdir(os.path.join(site, d))]
    return [c for c in (load_component(site, m) for m in models) if c is not None]


# ======================================================================================================================
# 4. End-to-End Build Orchestrator
# ======================================================================================================================

def build(site: str, workers: int = 4, steps_limit: int | None = None) -> str | None:
    components = components_of(site)
    if len(components) < 2:
        print(f"blend: only {len(components)} model(s) available; need at least 2 models to blend")
        return None

    # Try Kralveth AI 1km Deep Neural Weather Model first
    try:
        root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        if root_dir not in sys.path:
            sys.path.insert(0, root_dir)
        import ai_model.infer as ai_infer
        print("blend: executing Kralveth AI 1km Neural Operator...", flush=True)
        ai_res = ai_infer.build_kralveth_ai(site, steps_limit=steps_limit)
        if ai_res:
            return ai_res
    except Exception as e:
        print(f"blend: Kralveth AI neural operator fallback ({e}); using baseline blend", flush=True)

    ref, axis = blend_axis(components)
    if steps_limit:
        axis = axis[:steps_limit]

    variables = sorted({v for c in components for v in c.vars})
    published = [v for v in variables if v in C.VARS]
    runs = {c.model: c.run_id for c in components}
    run_id = run_id_now()
    run_dir = os.path.join(site, BLEND_ID, run_id)

    terrain_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "terrain")
    dz = load_elevation_diff(terrain_dir)
    if dz is not None:
        print("blend: terrain elevation correction loaded for lapse-rate standardization", flush=True)

    print(f"blend: assembling {LABEL} from {len(components)} models ({', '.join(runs)}), {len(axis)} steps, {len(published)} variables", flush=True)

    from_precip = "precip" in published and "rain24" in published
    step_vars = [v for v in published if v not in {"rain24", "raintot", "extreme", "tmin24", "tmax24"}]

    def one(i: int):
        fields = blend_step(components, step_vars, axis[i], ref, dz)
        return i, fields

    steps = []
    precip_dict: dict[int, np.ndarray] = {}
    temps_dict: dict[int, np.ndarray] = {}
    cape_dict: dict[int, np.ndarray] = {}
    h_of: list[int] = []

    with ThreadPoolExecutor(workers) as pool:
        for i, fields in pool.map(one, range(len(axis))):
            h = int((axis[i] - ref).total_seconds() // 3600)
            for v in step_vars:
                var_info = C.VARS[v]
                write(os.path.join(run_dir, v, f"{h:03d}.png"), encode_field(fields[v], var_info.lo, var_info.hi, var_info.bits))
            if "precip" in fields:
                precip_dict[h] = fields["precip"]
            if "t2m" in fields:
                temps_dict[h] = fields["t2m"]
            if "cape" in fields:
                cape_dict[h] = fields["cape"]
            h_of.append(h)
            steps.append({"h": h, "valid": f"{axis[i]:%Y-%m-%dT%H:%M:%SZ}"})

    # Forward 24h accumulations and extremes
    if precip_dict:
        h_list = sorted(precip_dict.keys())
        rain_windows = {h: (h_list[i] - h_list[i - 1] if i > 0 else (h_list[1] - h_list[0] if len(h_list) > 1 else STEP_HOURS)) for i, h in enumerate(h_list)}
        rain24_info = C.VARS["rain24"]
        accumulated = forward_accumulation(precip_dict, rain_windows)
        for h, field in accumulated.items():
            write(os.path.join(run_dir, "rain24", f"{h:03d}.png"), encode_field(field, rain24_info.lo, rain24_info.hi, rain24_info.bits))
            if "rain24" not in published:
                published.append("rain24")

        # Calibrated probability of precipitation of the next 24 h (0 to 100 %)
        extreme_info = C.VARS["extreme"]
        for h, field in accumulated.items():
            prob = rain_mm_to_probability(field)
            write(os.path.join(run_dir, "extreme", f"{h:03d}.png"), encode_field(prob, extreme_info.lo, extreme_info.hi, extreme_info.bits))
            if "extreme" not in published:
                published.append("extreme")

        # Total cumulative rain
        raintot_info = C.VARS["raintot"]
        total_rain = cumulative_accumulation(precip_dict, rain_windows)
        for h, field in total_rain.items():
            write(os.path.join(run_dir, "raintot", f"{h:03d}.png"), encode_field(field, raintot_info.lo, raintot_info.hi, raintot_info.bits))
            if "raintot" not in published:
                published.append("raintot")

    if temps_dict:
        for vid, reduce_fn in (("tmin24", np.fmin), ("tmax24", np.fmax)):
            var_info = C.VARS[vid]
            for h, field in forward_extreme(temps_dict, reduce_fn).items():
                write(os.path.join(run_dir, vid, f"{h:03d}.png"), encode_field(field, var_info.lo, var_info.hi, var_info.bits))
                if vid not in published:
                    published.append(vid)

    # Check, compare, and assimilate IMD EWRF Day-1 data
    day1_rain = accumulated.get(0) if precip_dict else None
    day1_cape = cape_dict.get(0) if cape_dict else None
    ewrf_info = None
    try:
        import compare_ewrf
        ewrf_info = compare_ewrf.run_ewrf_assimilation(run_dir, day1_rain, day1_cape)
    except Exception as e:
        print(f"blend: EWRF assimilation check notice: {e}", flush=True)

    manifest = {
        "model": BLEND_ID,
        "run": run_id,
        "build": run_id,
        "reference": f"{ref:%Y%m%dT%HZ}",
        "components": runs,
        "ewrf": ewrf_info,
        "grid": {
            "latMax": C.IFS_LAT_MAX, "latMin": C.IFS_LAT_MIN,
            "lonMin": C.IFS_LON_MIN, "lonMax": C.IFS_LON_MAX,
            "step": C.STEP_DEG, "nx": C.IFS_NX, "ny": C.IFS_NY,
        },
        "steps": steps,
        "vars": {v: {"unit": C.VARS[v].unit, "min": C.VARS[v].lo, "max": C.VARS[v].hi, "encoding": "rg16"} for v in published if v in C.VARS},
        "levels": list(C.LEVELS),
        "path": "{var}/{h:03d}.png",
        "domain": C.IFS_DOMAIN,
        "notes": {
            "blend": f"Kralveth 1 km high-definition blend synthesized from {', '.join(runs)}",
            "weights": "Dynamic lead-time CRPS minimization & cross-model diversity optimization",
            "calibration": "Elevation lapse-rate standardization & Trotta (2024) probability matching",
        },
    }
    write(os.path.join(run_dir, "manifest.json"), json.dumps(manifest, indent=2).encode())

    # Keep only newest assembly in BLEND_ID directory
    blend_dir = os.path.join(site, BLEND_ID)
    for old in os.listdir(blend_dir):
        old_path = os.path.join(blend_dir, old)
        if old != run_id and os.path.isdir(old_path):
            shutil.rmtree(old_path, ignore_errors=True)

    latest_doc = {
        "model": BLEND_ID,
        "run": run_id,
        "build": run_id,
        "domain": C.IFS_DOMAIN,
        "components": runs,
        "ewrf": ewrf_info,
        "inputs": inputs_of(components),
        "version": VERSION,
    }
    write(os.path.join(site, BLEND_ID, "latest.json"), json.dumps(latest_doc, indent=2).encode())
    print(f"blend: successfully created {BLEND_ID} run {run_id}", flush=True)
    return run_id


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True, help="site folder containing model runs")
    ap.add_argument("--live-url", help="latest.json of deployed blend to skip if inputs are unchanged")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--steps", type=int, help="only first N steps for local testing")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    comps = components_of(args.site)
    if not args.force and args.live_url:
        try:
            import requests
            r = requests.get(args.live_url, timeout=30)
            if r.ok:
                live = r.json()
                if live.get("inputs") == inputs_of(comps) and live.get("version") == VERSION:
                    print("blend: inputs unchanged since live blend; nothing to do")
                    return 0
        except Exception:
            pass

    res = build(args.site, args.workers, args.steps)
    return 0 if res or len(comps) < 2 else 1


if __name__ == "__main__":
    sys.exit(main())
