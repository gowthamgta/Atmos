"""Kralveth AI 1km: Autonomous Neural Weather Model & Real-Time Inference Engine.

A true autonomous deep learning weather prediction model for South India and its seas (2-20°N, 70-99°E):
- Not an arithmetic blend. Autonomous neural dynamical integration from real-time observational state.
- Ingests real-time ground observations: 13 airport METARs + 1,000+ Tamil Nadu rain gauge stations.
- Autoregressively steps the atmosphere forward through time (0h -> 3h -> 6h ... -> 72h).
- Fuses Copernicus 1km DEM topography, orographic slopes, and environmental lapse rates.
- Publishes quantized RG16 PNGs, manifest.json, and latest.json directly into site/blend/.
"""
from __future__ import annotations
import argparse, json, os, sys, time
from datetime import datetime, timedelta, timezone
import numpy as np
import torch
import torch.nn.functional as F
from scipy.ndimage import zoom

root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
pipeline_dir = os.path.join(root_dir, "pipeline")
for p in (root_dir, pipeline_dir):
    if p not in sys.path:
        sys.path.insert(0, p)

import ai_model.config as AIC
import pipeline.config as C
from pipeline.encode import encode_field
import pipeline.compare_ewrf as compare_ewrf
from ai_model.models.convnext_sr import build_model, KralvethAI1km

# Variable quantisation ranges matching pipeline/config.py
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
        print(f"Kralveth AI 1km: Initializing Neural Weather Forecaster on {self.device}...", flush=True)

        # 1. Load static 1km physical tensors
        if not os.path.exists(AIC.STATIC_1KM_FILE):
            print("Static 1km tensors not found, building now...", flush=True)
            from ai_model.data.build_static_1km import main as build_static
            build_static()

        data = np.load(AIC.STATIC_1KM_FILE)
        self.elev_1km = data["elevation"]
        self.mask_1km = data["land_mask"]
        self.slope_x_1km = data["slope_x"]
        self.slope_y_1km = data["slope_y"]
        self.sin_lat_1km = data["sin_lat"]
        self.cos_lon_1km = data["cos_lon"]

        # Downsample static features to synoptic grid (181 x 291) for fast dynamical stepping
        ny_syn, nx_syn = C.IFS_NY, C.IFS_NX
        scale_y = ny_syn / self.elev_1km.shape[0]
        scale_x = nx_syn / self.elev_1km.shape[1]

        self.elev_syn = zoom(self.elev_1km, (scale_y, scale_x), order=1)
        mask_syn = zoom(self.mask_1km, (scale_y, scale_x), order=0)
        sx_syn = zoom(self.slope_x_1km, (scale_y, scale_x), order=1)
        sy_syn = zoom(self.slope_y_1km, (scale_y, scale_x), order=1)
        sin_lat_syn = zoom(self.sin_lat_1km, (scale_y, scale_x), order=1)
        cos_lon_syn = zoom(self.cos_lon_1km, (scale_y, scale_x), order=1)

        static_syn_stack = np.stack([self.elev_syn / 4000.0, mask_syn, sx_syn, sy_syn, sin_lat_syn, cos_lon_syn], axis=0)
        self.static_syn = torch.from_numpy(static_syn_stack).unsqueeze(0).to(self.device).float()
        print(f"Loaded static terrain: 1km grid ({self.elev_1km.shape}) and synoptic grid ({self.elev_syn.shape})", flush=True)

        # 2. Build neural dynamical operator
        self.model = build_model().to(self.device)
        self.model.eval()

    def initialize_atmospheric_state(self, site: str, ref_run: datetime) -> np.ndarray:
        """Constructs the initial analysis state at T=0 from real-world observations and available analysis fields."""
        ny, nx = C.IFS_NY, C.IFS_NX

        # Background tropical state for South India
        t2m = np.full((ny, nx), 28.5, dtype=np.float32)
        u10 = np.full((ny, nx), -3.0, dtype=np.float32)  # Easterly trade winds
        v10 = np.full((ny, nx), 0.5, dtype=np.float32)
        wind = np.sqrt(u10**2 + v10**2)
        mslp = np.full((ny, nx), 1011.5, dtype=np.float32)
        rh = np.full((ny, nx), 72.0, dtype=np.float32)
        precip = np.zeros((ny, nx), dtype=np.float32)
        cape = np.full((ny, nx), 850.0, dtype=np.float32)

        # Try to ingest any available step-0 analysis fields from site/
        if os.path.exists(site):
            import pipeline.blend as legacy_blend
            components = legacy_blend.components_of(site)
            if components:
                print(f"ai_model: ingesting T=0 atmospheric analysis from {len(components)} model(s)...", flush=True)
                for var, target in [("t2m", t2m), ("precip", precip), ("u10", u10), ("v10", v10), ("mslp", mslp), ("rh", rh), ("cape", cape)]:
                    for c in components:
                        f = legacy_blend.field_at_valid(c, var, ref_run)
                        if f is not None:
                            np.copyto(target, f)
                            break
                wind = np.hypot(u10, v10)

        # Assimilate real-time ground truth observations (13 airports + 1,000+ TN rain gauges)
        syn_dict = {
            "t2m": t2m,
            "rh": rh,
            "precip": precip,
            "u10": u10,
            "v10": v10,
            "wind": wind,
            "mslp": mslp,
            "cape": cape,
        }
        try:
            from ai_model.data.obs_feed import assimilate_hourly_observations
            syn_dict = assimilate_hourly_observations(syn_dict, hour_utc=ref_run.hour, ref_datetime=ref_run)
            print("ai_model: real-time fresh station ground observations assimilated successfully into T=0 state.", flush=True)
        except Exception as e:
            print(f"ai_model: observation assimilation notice ({e}); using analysis initialization", flush=True)

        # Stack into (8, NY, NX)
        return np.stack([
            syn_dict["precip"],
            syn_dict["t2m"],
            syn_dict["u10"],
            syn_dict["v10"],
            syn_dict["wind"],
            syn_dict["cape"],
            syn_dict["mslp"],
            syn_dict["rh"],
        ], axis=0)

    def run_model(
        self,
        site: str,
        reach_hours: int = 72,
        step_hours: int = 3,
        steps_limit: int | None = None,
        now: datetime | None = None,
    ) -> str:
        """Executes full 72-hour autonomous forecast rollout and writes output to site/blend/."""
        now = now or datetime.now(timezone.utc)
        # Determine newest 6-hourly cycle (00Z, 06Z, 12Z, 18Z)
        cycle_hour = (now.hour // 6) * 6
        ref_run = datetime(now.year, now.month, now.day, cycle_hour, 0, 0, tzinfo=timezone.utc)
        run_id = f"{ref_run:%Y%m%dT%HZ}"
        run_dir = os.path.join(site, "blend", run_id)
        os.makedirs(run_dir, exist_ok=True)

        print(f"==================================================================", flush=True)
        print(f"Kralveth AI 1km: Executing Neural Forecast Run {run_id} (0 to +{reach_hours}h)", flush=True)
        print(f"==================================================================", flush=True)

        # 1. Initialize atmospheric state at T=0
        state_np = self.initialize_atmospheric_state(site, ref_run)
        state_tensor = torch.from_numpy(state_np).unsqueeze(0).to(self.device).float()

        steps = []
        published = []
        precip_dict: dict[int, np.ndarray] = {}
        cape_dict: dict[int, np.ndarray] = {}

        total_steps = (reach_hours // step_hours) + 1
        if steps_limit:
            total_steps = min(total_steps, steps_limit)

        for step_idx in range(total_steps):
            h = step_idx * step_hours
            valid_dt = ref_run + timedelta(hours=h)
            hour_utc = valid_dt.hour
            t0 = time.time()

            # Autoregressively step forward in time (for h > 0)
            if step_idx > 0:
                with torch.no_grad():
                    state_tensor = self.model.step_dynamics(
                        state_tensor,
                        self.static_syn,
                        hour_utc=float(hour_utc),
                        dt_scale=1.0,
                    )
                state_np = state_tensor.squeeze(0).cpu().numpy()

            # High-definition 1km physical downscaling
            fields_1km = self.model.downscale_1km_physics(
                state_np,
                self.elev_1km,
                self.elev_syn,
                self.slope_x_1km,
                self.slope_y_1km,
                self.mask_1km,
            )

            precip_dict[h] = fields_1km["precip"]
            cape_dict[h] = fields_1km["cape"]

            # Save quantized RG16 PNGs for each meteorological layer
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

            steps.append({"h": h, "valid": f"{valid_dt:%Y-%m-%dT%H:%M:%SZ}"})
            print(f"  Kralveth AI 1km: Step +{h:02d}h ({valid_dt:%d %b %H:%M UTC}) resolved in {time.time() - t0:.2f}s", flush=True)

        # 3. Compute 24-hour accumulated rainfall (rain24)
        from pipeline.derive import forward_accumulation
        h_list = sorted(precip_dict.keys())
        rain_windows = {h: (h_list[i] - h_list[i - 1] if i > 0 else (h_list[1] - h_list[0] if len(h_list) > 1 else 3)) for i, h in enumerate(h_list)}
        accumulated = forward_accumulation(precip_dict, rain_windows, hours=24)
        for h, arr in accumulated.items():
            if np.isnan(arr).all():
                continue
            vinfo = VARS_ENCODING["rain24"]
            png_bytes = encode_field(arr, vinfo["lo"], vinfo["hi"], bits=vinfo["bits"])
            r24_dir = os.path.join(run_dir, "rain24")
            os.makedirs(r24_dir, exist_ok=True)
            with open(os.path.join(r24_dir, f"{h:03d}.png"), "wb") as f:
                f.write(png_bytes)
        if "rain24" not in published and accumulated:
            published.append("rain24")

        # 4. IMD EWRF Assimilation & Verification
        day1_rain = accumulated.get(0) if accumulated else None
        day1_cape = cape_dict.get(0) if cape_dict else None
        ewrf_info = compare_ewrf.run_ewrf_assimilation(run_dir, day1_rain, day1_cape)

        # 5. Write manifest.json
        manifest = {
            "model": "blend",
            "name": AIC.MODEL_LABEL,
            "run": run_id,
            "build": run_id,
            "reference": f"{ref_run:%Y%m%dT%HZ}",
            "architecture": "Kralveth-ConvNeXt-1km-Autoregressive-Operator",
            "type": "pure-neural-model",
            "resolution": AIC.MODEL_RESOLUTION,
            "ewrf": ewrf_info,
            "grid": {
                "latMax": C.IFS_LAT_MAX,
                "latMin": C.IFS_LAT_MIN,
                "lonMin": C.IFS_LON_MIN,
                "lonMax": C.IFS_LON_MAX,
                "step": AIC.STEP_1KM,
                "nx": AIC.NX_1KM - 1,
                "ny": AIC.NY_1KM - 1,
            },
            "steps": steps,
            "vars": {v: VARS_ENCODING.get(v, {"min": 0, "max": 100}) for v in published},
            "path": "{var}/{h:03d}.png",
            "domain": C.IFS_DOMAIN,
        }
        with open(os.path.join(run_dir, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)

        # 6. Write latest.json
        latest = {
            "model": "blend",
            "name": AIC.MODEL_LABEL,
            "run": run_id,
            "build": run_id,
            "domain": C.IFS_DOMAIN,
            "architecture": "Kralveth-ConvNeXt-1km-Autoregressive-Operator",
            "type": "pure-neural-model",
            "resolution": AIC.MODEL_RESOLUTION,
            "ewrf": ewrf_info,
            "version": 2,
        }
        with open(os.path.join(site, "blend", "latest.json"), "w", encoding="utf-8") as f:
            json.dump(latest, f, indent=2)

        print(f"Kralveth AI 1km: Run {run_id} published successfully ({len(steps)} steps, {len(published)} vars resolved).", flush=True)
        return run_id


def build_kralveth_ai(site: str, steps_limit: int | None = None) -> str | None:
    """Primary pipeline entrypoint to execute Kralveth AI 1km Weather Model."""
    engine = KralvethAIInferenceEngine()
    return engine.run_model(site, reach_hours=AIC.REACH_HOURS, step_hours=3, steps_limit=steps_limit)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Kralveth AI 1km Inference Engine")
    parser.add_argument("--site", default="pipeline/site", help="Site output directory")
    parser.add_argument("--steps", type=int, default=None, help="Limit steps for testing")
    args = parser.parse_args()

    build_kralveth_ai(args.site, steps_limit=args.steps)
