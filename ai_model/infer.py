"""Kralveth AI 1km: Real-Time Neural Inference Engine.

Replaces the legacy arithmetic blend with deep learning 1km downscaling:
- Ingests multi-model consensus (ECMWF IFS, GFS, ICON, UKMO, AIFS) on 0.1° synoptic grid.
- Ingests 90m Copernicus DEM topography, slope gradients, and land-sea boundaries.
- Executes KralvethAI1km ConvNeXt Neural Operator to predict 1km high-definition fields.
- Publishes quantized PNGs, manifest.json, and latest.json directly into site/blend/.
"""
from __future__ import annotations
import argparse, json, os, sys, time
from datetime import datetime, timezone
import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ai_model.config as AIC
import pipeline.config as C
from pipeline.encode import encode_field
import pipeline.blend as legacy_blend
import pipeline.compare_ewrf as compare_ewrf
from ai_model.models.convnext_sr import build_model, KralvethAI1km

# Variable quantisation ranges matching pipeline/config.py & blend.py
VARS_ENCODING = {
    "precip":     {"lo": 0.0,    "hi": 100.0, "bits": 12, "units": "mm/h"},
    "rain24":     {"lo": 0.0,    "hi": 600.0, "bits": 14, "units": "mm"},
    "t2m":        {"lo": -40.0,  "hi": 50.0,  "bits": 14, "units": "C"},
    "dew":        {"lo": -50.0,  "hi": 40.0,  "bits": 14, "units": "C"},
    "rh2m":       {"lo": 0.0,    "hi": 100.0, "bits": 12, "units": "%"},
    "wind_speed": {"lo": 0.0,    "hi": 75.0,  "bits": 13, "units": "m/s"},
    "gust":       {"lo": 0.0,    "hi": 100.0, "bits": 13, "units": "m/s"},
    "mslp":       {"lo": 900.0,  "hi": 1050.0,"bits": 14, "units": "hPa"},
    "cape":       {"lo": 0.0,    "hi": 6000.0,"bits": 12, "units": "J/kg"},
    "pop24":      {"lo": 0.0,    "hi": 100.0, "bits": 10, "units": "%"},
}


class KralvethAIInferenceEngine:
    def __init__(self, device: str = "cpu"):
        self.device = torch.device(device)
        print(f"Kralveth AI 1km: Initializing Neural Inference Engine on {self.device}...", flush=True)

        # 1. Load static physical tensors
        if not os.path.exists(AIC.STATIC_1KM_FILE):
            print("Static 1km tensors not found, building now...", flush=True)
            from ai_model.data.build_static_1km import main as build_static
            build_static()

        data = np.load(AIC.STATIC_1KM_FILE)
        elev = data["elevation"]
        mask = data["land_mask"]
        sx = data["slope_x"]
        sy = data["slope_y"]
        sin_lat = data["sin_lat"]
        cos_lon = data["cos_lon"]

        # Stack into (1, 6, H, W)
        static_stack = np.stack([elev / 4000.0, mask, sx, sy, sin_lat, cos_lon], axis=0)
        self.static_1km = torch.from_numpy(static_stack).unsqueeze(0).to(self.device).float()
        print(f"Loaded 1km static physical tensors: shape {self.static_1km.shape}", flush=True)

        # 2. Build and load neural network
        self.model = build_model().to(self.device)
        self.model.eval()

    @torch.no_grad()
    def predict_step_1km(self, synoptic_fields: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
        """Runs the 1km Neural Operator on a single time-step synoptic field dictionary."""
        # Channels: [0:precip, 1:t2m, 2:u10, 3:v10, 4:wind_speed, 5:cape, 6:mslp, 7:rh2m]
        p = synoptic_fields.get("precip", np.zeros((C.NY, C.NX), dtype=np.float32))
        t = synoptic_fields.get("t2m", np.full((C.NY, C.NX), 28.0, dtype=np.float32))
        u = synoptic_fields.get("u10", np.zeros((C.NY, C.NX), dtype=np.float32))
        v = synoptic_fields.get("v10", np.zeros((C.NY, C.NX), dtype=np.float32))
        w = synoptic_fields.get("wind_speed", np.sqrt(u**2 + v**2))
        c = synoptic_fields.get("cape", np.zeros((C.NY, C.NX), dtype=np.float32))
        m = synoptic_fields.get("mslp", np.full((C.NY, C.NX), 1010.0, dtype=np.float32))
        rh = synoptic_fields.get("rh2m", np.full((C.NY, C.NX), 75.0, dtype=np.float32))

        # Fill NaNs with defaults
        p = np.nan_to_num(p, nan=0.0)
        t = np.nan_to_num(t, nan=28.0)
        u = np.nan_to_num(u, nan=0.0)
        v = np.nan_to_num(v, nan=0.0)
        w = np.nan_to_num(w, nan=0.0)
        c = np.nan_to_num(c, nan=0.0)
        m = np.nan_to_num(m, nan=1010.0)
        rh = np.nan_to_num(rh, nan=75.0)

        syn_stack = np.stack([p, t, u, v, w, c, m, rh], axis=0)
        syn_tensor = torch.from_numpy(syn_stack).unsqueeze(0).to(self.device).float()

        # Neural forward pass
        out_tensor = self.model(syn_tensor, self.static_1km)
        out = out_tensor.squeeze(0).cpu().numpy()

        # Compute dew point from 1km T2M and RH2M
        t_1km = out[1]
        rh_1km = np.clip(out[7], 1.0, 100.0)
        dew_1km = t_1km - ((100.0 - rh_1km) / 5.0)  # Standard meteorological approximation

        # Gusts estimation: wind_speed + convective downdraft factor from CAPE
        gust_1km = out[4] * 1.35 + np.sqrt(np.maximum(out[5], 0.0)) * 0.12

        return {
            "precip": out[0],
            "t2m": out[1],
            "u10": out[2],
            "v10": out[3],
            "wind": out[4],
            "cape": out[5],
            "mslp": out[6],
            "rh": out[7],
            "dew": dew_1km,
            "gust": gust_1km,
        }


def build_kralveth_ai(site: str, steps_limit: int | None = None) -> str | None:
    """Entrypoint to run Kralveth AI 1km inference for all forecast steps and publish to site/blend/."""
    components = legacy_blend.find_components(site)
    if not components:
        print("ai_model: no component model runs found in site directory", flush=True)
        return None

    ref, axis = legacy_blend.blend_axis(components)
    run_id = f"{ref:%Y%m%dT%HZ}"
    run_dir = os.path.join(site, "blend", run_id)
    os.makedirs(run_dir, exist_ok=True)

    engine = KralvethAIInferenceEngine()
    print(f"Kralveth AI 1km: Building run {run_id} to +{AIC.REACH_HOURS}h...", flush=True)

    corr = legacy_blend.load_corrections(site)
    precip_dict: dict[int, np.ndarray] = {}
    cape_dict: dict[int, np.ndarray] = {}
    steps = []
    published = []

    axis_steps = axis[:steps_limit] if steps_limit else axis

    for i, valid in enumerate(axis_steps):
        h = int((valid - ref).total_seconds() // 3600)
        t0 = time.time()

        # 1. Gather synoptic multi-model consensus
        synoptic_fields = legacy_blend.blend_step(components, ["precip", "t2m", "u10", "v10", "wind", "cape", "mslp", "rh"], valid, corr)

        # 1b. Assimilate hourly airport METARs and Tamil Nadu station ground observations
        try:
            from ai_model.data.obs_feed import assimilate_hourly_observations
            synoptic_fields = assimilate_hourly_observations(synoptic_fields, hour_utc=valid.hour)
        except Exception as e:
            print(f"ai_model: observation assimilation notice: {e}", flush=True)

        # 2. Run 1km AI Neural Operator
        fields_1km = engine.predict_step_1km(synoptic_fields)

        # Store for 24h accumulation
        precip_dict[h] = fields_1km["precip"]
        cape_dict[h] = fields_1km["cape"]

        # 3. Save quantized PNGs
        step_str = f"{h:03d}"
        for var_name, arr in fields_1km.items():
            enc_name = "wind_speed" if var_name == "wind" else "rh2m" if var_name == "rh" else var_name
            if enc_name not in VARS_ENCODING:
                continue
            vinfo = VARS_ENCODING[enc_name]
            png_bytes = encode_field(arr, vinfo["lo"], vinfo["hi"], bits=vinfo["bits"])

            var_dir = os.path.join(run_dir, var_name)
            os.makedirs(var_dir, exist_ok=True)
            with open(os.path.join(var_dir, f"{step_str}.png"), "wb") as f:
                f.write(png_bytes)
            if var_name not in published:
                published.append(var_name)

        steps.append({"h": h, "valid": f"{valid:%Y-%m-%dT%H:%M:%SZ}"})
        print(f"  step +{h:02d}h resolved to 1km in {time.time() - t0:.2f}s", flush=True)

    # 4. Compute 24h accumulation and PoP24
    hours = sorted(precip_dict.keys())
    accumulated = legacy_blend.cumulative_accumulation(precip_dict, hours, 24)
    for h, arr in accumulated.items():
        vinfo = VARS_ENCODING["rain24"]
        png_bytes = encode_field(arr, vinfo["lo"], vinfo["hi"], bits=vinfo["bits"])
        r24_dir = os.path.join(run_dir, "rain24")
        os.makedirs(r24_dir, exist_ok=True)
        with open(os.path.join(r24_dir, f"{h:03d}.png"), "wb") as f:
            f.write(png_bytes)

    if "rain24" not in published and accumulated:
        published.append("rain24")

    # 5. Run EWRF Assimilation & Verification
    day1_rain = accumulated.get(0) if accumulated else None
    day1_cape = cape_dict.get(0) if cape_dict else None
    ewrf_info = compare_ewrf.run_ewrf_assimilation(run_dir, day1_rain, day1_cape)

    # 6. Write manifest and latest pointer
    manifest = {
        "model": "blend",
        "name": AIC.MODEL_LABEL,
        "run": run_id,
        "build": run_id,
        "reference": f"{ref:%Y%m%dT%HZ}",
        "architecture": "Kralveth-ConvNeXt-1km-Neural-Operator",
        "resolution": AIC.MODEL_RESOLUTION,
        "components": {c.name: c.run_id for c in components},
        "ewrf": ewrf_info,
        "grid": {
            "latMax": C.IFS_LAT_MAX, "latMin": C.IFS_LAT_MIN,
            "lonMin": C.IFS_LON_MIN, "lonMax": C.IFS_LON_MAX,
            "step": AIC.STEP_1KM,
            "nx": AIC.NX_1KM - 1, "ny": AIC.NY_1KM - 1,
        },
        "steps": steps,
        "vars": {v: VARS_ENCODING.get(v, {"min": 0, "max": 100}) for v in published},
    }
    with open(os.path.join(run_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    latest = {
        "model": "blend",
        "name": AIC.MODEL_LABEL,
        "run": run_id,
        "build": run_id,
        "domain": C.IFS_DOMAIN,
        "architecture": "Kralveth-ConvNeXt-1km-Neural-Operator",
        "components": {c.name: c.run_id for c in components},
        "ewrf": ewrf_info,
        "version": 2,
    }
    with open(os.path.join(site, "blend", "latest.json"), "w", encoding="utf-8") as f:
        json.dump(latest, f, indent=2)

    print(f"Kralveth AI 1km: Run {run_id} published successfully ({len(steps)} steps, {len(published)} vars resolved).", flush=True)
    return run_id


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Kralveth AI 1km Inference Engine")
    parser.add_argument("--site", default="pipeline/site", help="Site output directory")
    parser.add_argument("--steps", type=int, default=None, help="Limit steps for testing")
    args = parser.parse_args()

    build_kralveth_ai(args.site, steps_limit=args.steps)
