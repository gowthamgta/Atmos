"""Orchestrate one pipeline run for a model: fetch -> derive -> encode -> write a static site folder.

The folder is deployed to GitHub Pages by .github/workflows/nwp.yml (free, CORS-open, no external bucket).

  python run.py --model ecmwf_ifs --out site --force         # full run into ./site/ecmwf_ifs
  python run.py --model ukmo --steps 0,3 --out out --force   # quick local test
  python run.py --model ukmo --out site --live-url https://<user>.github.io/<repo>/ukmo/latest.json
                                                             # exits quietly if that run is already live
"""
from __future__ import annotations
import argparse, json, os, shutil, sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import numpy as np
import requests
import config as C
import fetch_ifs
import models_regular
from fetch_regular import INDIA
from derive import cumulative_accumulation, derive, forward_accumulation, forward_extreme, rain_mm_to_probability
from encode import encode_field
import correction

# the bias table (data/bias/table.json) for the airports near Kallakurichi; a missing table means no correction
BIAS_TABLE = correction.load_table(os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "bias", "table.json"))
RAIN_BIAS = correction.load_rain(os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "bias", "rain.json"))
# where the grid is land (the terrain's land fraction): the corrections never change the sea
LAND_MASK = correction.land_mask(fetch_ifs.GRID.lats(), fetch_ifs.GRID.lons(), os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "terrain"))
if LAND_MASK is None and (BIAS_TABLE or RAIN_BIAS):
    print("warning: the terrain land mask is missing, so the forecast corrections are not applied (they must not touch the sea)", file=sys.stderr)

# modules and RegularModel instances share one interface (MODEL_ID, RUN_HOURS, latest_run(), read_step(), ...)
MODELS = {m.MODEL_ID: m for m in (fetch_ifs, *models_regular.ALL)}


NOT_PUBLISHED_YET = 3     # exit code: the run the caller expects is not published yet (the workflow tries again later)


def published_vars(fetcher):
    """Variables this model actually provides (the app greys out layers for the others)."""
    return [v for v in C.VARS.values() if v.id not in fetcher.UNAVAILABLE_VARS]


def grid_of(fetcher):
    """The output grid of a model: its own (the world model) or the South India box."""
    return getattr(fetcher, "GRID", None) or INDIA


def step_grid(fetcher, step_h: int):
    """The output grid for a specific step hour (supports higher-resolution Day 1 grids)."""
    if hasattr(fetcher, "step_grid"):
        return fetcher.step_grid(step_h)
    return grid_of(fetcher)


def _ext_for(fetcher) -> str:
    return "webp" if fetcher.MODEL_ID == "global" else "png"


def _encode_for(fetcher, vid: str, values: np.ndarray) -> bytes:
    v = C.VARS[vid]
    if fetcher.MODEL_ID == "global":
        if vid in ("precip", "rain24", "raintot", "extreme"):
            bits = v.bits
        elif vid in ("t2m", "rh", "feels", "dew", "u10", "v10", "msl"):
            bits = min(v.bits, 10)
        else:
            bits = min(v.bits, 9)
        return encode_field(values, v.lo, v.hi, bits, fmt="WEBP")
    return encode_field(values, v.lo, v.hi, v.bits, fmt="PNG")


def _align_shape(arr: np.ndarray, target_shape: tuple[int, int]) -> np.ndarray:
    if arr.shape == target_shape:
        return arr
    from scipy.ndimage import zoom
    return zoom(np.nan_to_num(arr, nan=0.0), (target_shape[0] / arr.shape[0], target_shape[1] / arr.shape[1]), order=1).astype(np.float32)


def build_manifest(fetcher, run, steps, build=None, omit=frozenset()):
    """The manifest of a run. `omit`: variables the source had no data for at any step, which are not published (see main)."""
    grid = grid_of(fetcher)
    ext = _ext_for(fetcher)
    step_list = []
    for h in steps:
        entry = {"h": h, "valid": f"{run + timedelta(hours=h):%Y-%m-%dT%H:%M:%SZ}"}
        sg = step_grid(fetcher, h)
        if sg != grid:
            entry["grid"] = sg.manifest()
        step_list.append(entry)
    return {
        "model": fetcher.MODEL_ID,
        "run": f"{run:%Y%m%dT%H}Z",
        "grid": grid.manifest(),
        "steps": step_list,
        "vars": {v.id: {"unit": v.unit, "min": v.lo, "max": v.hi, "encoding": "rg16"} for v in published_vars(fetcher) if v.id not in omit},
        "levels": list(C.LEVELS),
        "path": f"{{var}}/{{h:03d}}.{ext}",
        "notes": {"precip": fetcher.PRECIP_NOTE},
        # which build of the run this is: a run built again under the same id (levels that were missing, a changed method) gets a
        # new one, and the app puts it on every picture's address so no browser keeps the old pictures
        "build": build or build_id(),
        "domain": grid.domain,
    }


DERIVED_ACROSS_STEPS = {"rain24", "raintot", "extreme", "tmin24", "tmax24"}   # needs several steps, so it is computed after all of them (see main)


def process_step(fetcher, run, h, global_deltas=None):
    """Encode one forecast step. Also returns the step's rain rate (mm/h), which the 24 h accumulation is built from, its air
    temperature, and the variables that have data at this step (the rest are all "no data": see main)."""
    fields = derive(fetcher.read_step(run, h), fetcher.precip_window_hours(h), step_grid(fetcher, h).lat_max)
    if fetcher.MODEL_ID == "ecmwf_ifs" and LAND_MASK is not None:
        grid = grid_of(fetcher)
        if BIAS_TABLE:
            # the airport-based correction of temperature and humidity near them (see correction.py), at this step's valid time
            fields = correction.apply(fields, grid.lats(), grid.lons(), run + timedelta(hours=h), BIAS_TABLE, LAND_MASK)
        if RAIN_BIAS:
            # the rain factor of the Tamil Nadu gauges, on land near them (see correction.apply_rain)
            fields = correction.apply_rain(fields, grid.lats(), grid.lons(), RAIN_BIAS, LAND_MASK)
    if fetcher.MODEL_ID == "global" and global_deltas:
        import math
        from derive import dew_point, apparent_temperature
        persistence = math.exp(-h / 24.0)
        if "t2m" in global_deltas and "t2m" in fields:
            dt = _align_shape(global_deltas["t2m"], fields["t2m"].shape)
            fields["t2m"] = (fields["t2m"] + persistence * dt).astype(np.float32)
        if "rh" in global_deltas and "rh" in fields:
            dr = _align_shape(global_deltas["rh"], fields["rh"].shape)
            fields["rh"] = np.clip(fields["rh"] + persistence * dr, 5.0, 100.0).astype(np.float32)
        if "t2m" in fields and "rh" in fields:
            fields["dew"] = dew_point(fields["t2m"], fields["rh"]).astype(np.float32)
            if "u10" in fields and "v10" in fields:
                fields["feels"] = apparent_temperature(fields["t2m"], fields["rh"], np.hypot(fields["u10"], fields["v10"])).astype(np.float32)
    per_step = [v for v in published_vars(fetcher) if v.id not in DERIVED_ACROSS_STEPS]
    pngs = {
        v.id: _encode_for(fetcher, v.id, fields[v.id])
        for v in per_step
    }
    with_data = {v.id for v in per_step if np.isfinite(fields[v.id]).any()}
    return h, pngs, fields["precip"], fields["t2m"], with_data


def build_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _build_age_seconds(j: dict) -> float | None:
    b = j.get("build")
    if not isinstance(b, str):
        return None
    try:
        dt = datetime.strptime(b, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt).total_seconds()
    except ValueError:
        return None


def live_run(url: str, fmt: int | None = None, domain: str = C.DOMAIN, max_build_age_s: float | None = None) -> str | None:
    """Run id currently served at `url` (a latest.json), or None if unreachable, not there yet, published incomplete
    (some data was missing, so it should be built again), stale beyond `max_build_age_s`, or built the old way."""
    try:
        r = requests.get(url, timeout=30)
        if not r.ok:
            return None
        j = r.json()
        if j.get("complete") is False or (fmt is not None and j.get("format") != fmt) or j.get("domain") != domain:
            return None
        if max_build_age_s is not None:
            age = _build_age_seconds(j)
            if age is None or age > max_build_age_s:
                return None
        return j["run"]
    except (requests.RequestException, ValueError, KeyError):
        return None


def write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", choices=sorted(MODELS))
    ap.add_argument("--out", help="site folder to write")
    ap.add_argument("--list-models", action="store_true", help="print the model ids, one per line, and exit")
    ap.add_argument("--steps", help="comma-separated forecast hours (default: all)")
    ap.add_argument("--force", action="store_true", help="ignore the run-hour and already-live checks")
    ap.add_argument("--expect-run", help="run id (e.g. 20261010T00Z) this call is waiting for; exits with code 3 while the newest published run is older")
    ap.add_argument("--live-url", help="latest.json of the deployed model, to skip runs that are already live")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()
    if args.list_models:
        for model_id in MODELS:
            print(model_id)
        return 0
    if not args.model or not args.out:
        ap.error("--model and --out are required")

    fetcher = MODELS[args.model]
    run = fetcher.latest_run()
    run_id = f"{run:%Y%m%dT%H}Z"
    if args.expect_run and run_id < args.expect_run and not args.force:
        print(f"{args.model}: newest published run is {run_id}, still waiting for {args.expect_run}")
        return NOT_PUBLISHED_YET
    if not args.force:
        if run.hour not in fetcher.RUN_HOURS:
            print(f"{args.model}: latest run {run_id} is not one of {fetcher.RUN_HOURS}Z; nothing to do")
            return 0
        max_age = 2700.0 if fetcher.MODEL_ID == "global" else None
        if args.live_url and live_run(args.live_url, getattr(fetcher, "LIVE_FORMAT", None), grid_of(fetcher).domain, max_build_age_s=max_age) == run_id:
            print(f"{args.model}: run {run_id} is already live; nothing to do")
            return 0
    all_steps = fetcher.steps_for(run) if hasattr(fetcher, "steps_for") else fetcher.STEP_HOURS  # shorter runs publish fewer steps
    steps = [int(s) for s in args.steps.split(",")] if args.steps else all_steps
    print(f"{args.model}: run {run_id}, {len(steps)} steps", flush=True)

    done = []
    rates: dict[int, object] = {}
    temps: dict[int, object] = {}
    with_data: set[str] = set()
    empty: set[str] = set()
    global_deltas = None
    if fetcher.MODEL_ID == "global" and steps:
        try:
            import obs_global_metar
            now_wall = datetime.now(timezone.utc)
            h_now = min(steps, key=lambda s: abs((run + timedelta(hours=s) - now_wall).total_seconds()))
            g = step_grid(fetcher, h_now)
            now_fields = derive(fetcher.read_step(run, h_now), fetcher.precip_window_hours(h_now), g.lat_max)
            global_deltas = obs_global_metar.assimilate_global_metars(now_fields, g.lat_max, g.lat_min, g.lon_min, g.step)
        except Exception as e:
            print(f"global: worldwide METAR assimilation skipped ({e})", flush=True)

    run_dir = os.path.join(args.out, fetcher.MODEL_ID, run_id)
    ext = _ext_for(fetcher)
    try:
        with ThreadPoolExecutor(args.workers) as pool:
            for h, pngs, rate, temp, seen in pool.map(lambda h: process_step(fetcher, run, h, global_deltas), steps):
                for vid, png in pngs.items():
                    write(os.path.join(run_dir, vid, f"{h:03d}.{ext}"), png)
                rates[h] = rate
                temps[h] = temp
                with_data |= seen
                done.append(h)
                print(f"  +{h:03d}h done ({len(done)}/{len(steps)})", flush=True)
        # A variable the source has no data for at any step is not published (the 0.25 degree ECMWF and NOAA data have no 800 hPa level, for
        # one): the app works a level between two others out from them, and greys out any other layer, instead of drawing an empty picture.
        # One that only lacks some steps (rain at the analysis hour) stays: its empty pictures say "no data" for those.
        empty = {v.id for v in published_vars(fetcher) if v.id not in DERIVED_ACROSS_STEPS} - with_data
        for vid in sorted(empty):
            shutil.rmtree(os.path.join(run_dir, vid), ignore_errors=True)
        if empty:
            print(f"{args.model}: no data at any step for {', '.join(sorted(empty))}; not published", flush=True)
        base_g = grid_of(fetcher)
        base_shape = (base_g.ny, base_g.nx)
        rates_base = {h: _align_shape(arr, base_shape) for h, arr in rates.items()}
        temps_base = {h: _align_shape(arr, base_shape) for h, arr in temps.items()}
        # rain over the next 24 h from each step (no data where the run ends before that)
        accumulated = forward_accumulation(rates_base, {h: fetcher.precip_window_hours(h) for h in rates_base})
        for h, field in accumulated.items():
            sg = step_grid(fetcher, h)
            write(os.path.join(run_dir, "rain24", f"{h:03d}.{ext}"), _encode_for(fetcher, "rain24", _align_shape(field, (sg.ny, sg.nx))))
        # Calibrated probability of precipitation of the next 24 h (0 to 100 %)
        for h, field in accumulated.items():
            sg = step_grid(fetcher, h)
            prob = rain_mm_to_probability(_align_shape(field, (sg.ny, sg.nx)))
            write(os.path.join(run_dir, "extreme", f"{h:03d}.{ext}"), _encode_for(fetcher, "extreme", prob))
        # total rain from the start of the run to each step
        for h, field in cumulative_accumulation(rates_base, {h: fetcher.precip_window_hours(h) for h in rates_base}).items():
            sg = step_grid(fetcher, h)
            write(os.path.join(run_dir, "raintot", f"{h:03d}.{ext}"), _encode_for(fetcher, "raintot", _align_shape(field, (sg.ny, sg.nx))))
        # lowest and highest temperature over the next 24 h from each step, for the models that publish them
        for vid, reduce in (("tmin24", np.fmin), ("tmax24", np.fmax)):
            if vid in {v.id for v in published_vars(fetcher)}:
                for h, field in forward_extreme(temps_base, reduce).items():
                    sg = step_grid(fetcher, h)
                    write(os.path.join(run_dir, vid, f"{h:03d}.{ext}"), _encode_for(fetcher, vid, _align_shape(field, (sg.ny, sg.nx))))
    except BaseException:
        shutil.rmtree(run_dir, ignore_errors=True)  # never deploy a half-written run
        raise

    # latest.json is written last so a half-finished folder never advertises a run
    build = build_id()
    write(os.path.join(args.out, fetcher.MODEL_ID, run_id, "manifest.json"),
          json.dumps(build_manifest(fetcher, run, sorted(done), build, empty)).encode())
    gaps = fetcher.incomplete_steps() if hasattr(fetcher, "incomplete_steps") else []
    latest = {"model": fetcher.MODEL_ID, "run": run_id, "build": build, "domain": grid_of(fetcher).domain}
    if hasattr(fetcher, "LIVE_FORMAT"):
        latest["format"] = fetcher.LIVE_FORMAT
    if gaps:
        latest["complete"] = False          # published as it is, and built again by the next scheduled run
        latest["problem"] = fetcher.incomplete_reason()
        print(f"{args.model}: pressure levels missing at +{', +'.join(str(g) for g in gaps)} h; this run will be built again", flush=True)
    write(os.path.join(args.out, fetcher.MODEL_ID, "latest.json"), json.dumps(latest).encode())
    write(os.path.join(args.out, ".nojekyll"), b"")

    # Strict single-run retention: purge any older superseded runs in site/<model>
    model_dir = os.path.join(args.out, fetcher.MODEL_ID)
    if os.path.isdir(model_dir):
        for item in os.listdir(model_dir):
            item_path = os.path.join(model_dir, item)
            if item != run_id and item != "latest.json" and os.path.isdir(item_path):
                shutil.rmtree(item_path, ignore_errors=True)

    print("done")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        # as an annotation, which the run's public summary page shows (the step's log needs a signed-in viewer)
        import traceback
        tb = traceback.extract_tb(e.__traceback__)
        where = " < ".join(f"{os.path.basename(f.filename)}:{f.lineno} {f.name}" for f in tb[-3:][::-1])
        print(f"::error::{' '.join(sys.argv[1:3])}: {type(e).__name__}: {str(e)[:300]} (at {where})", flush=True)
        raise
