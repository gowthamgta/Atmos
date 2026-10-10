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
from derive import derive, forward_accumulation, forward_extreme
from encode import encode_field
import correction

# the bias table (bias.py) for the airports near Kallakurichi; a missing table means no correction
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


def build_manifest(fetcher, run, steps, build=None):
    grid = grid_of(fetcher)
    return {
        "model": fetcher.MODEL_ID,
        "run": f"{run:%Y%m%dT%H}Z",
        "grid": grid.manifest(),
        "steps": [{"h": h, "valid": f"{run + timedelta(hours=h):%Y-%m-%dT%H:%M:%SZ}"} for h in steps],
        "vars": {v.id: {"unit": v.unit, "min": v.lo, "max": v.hi, "encoding": "rg16"} for v in published_vars(fetcher)},
        "levels": list(C.LEVELS),
        "path": "{var}/{h:03d}.png",
        "notes": {"precip": fetcher.PRECIP_NOTE},
        # which build of the run this is: a run built again under the same id (levels that were missing, a changed method) gets a
        # new one, and the app puts it on every picture's address so no browser keeps the old pictures
        "build": build or build_id(),
        "domain": grid.domain,
    }


DERIVED_ACROSS_STEPS = {"rain24", "tmin24", "tmax24"}   # needs several steps, so it is computed after all of them (see main)


def process_step(fetcher, run, h):
    """Encode one forecast step. Also returns the step's rain rate (mm/h), which the 24 h accumulation is built from."""
    fields = derive(fetcher.read_step(run, h), fetcher.precip_window_hours(h), grid_of(fetcher).lat_max)
    if fetcher.MODEL_ID == "ecmwf_ifs" and LAND_MASK is not None:
        grid = grid_of(fetcher)
        if BIAS_TABLE:
            # the airport-based correction of temperature and humidity near them (see correction.py), at this step's valid time
            fields = correction.apply(fields, grid.lats(), grid.lons(), run + timedelta(hours=h), BIAS_TABLE, LAND_MASK)
        if RAIN_BIAS:
            # the rain factor of the Tamil Nadu gauges, on land near them (see correction.apply_rain)
            fields = correction.apply_rain(fields, grid.lats(), grid.lons(), RAIN_BIAS, LAND_MASK)
    pngs = {v.id: encode_field(fields[v.id], v.lo, v.hi, v.bits) for v in published_vars(fetcher) if v.id not in DERIVED_ACROSS_STEPS}
    return h, pngs, fields["precip"], fields["t2m"]


def build_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def live_run(url: str, fmt: int | None = None, domain: str = C.DOMAIN) -> str | None:
    """Run id currently served at `url` (a latest.json), or None if unreachable, not there yet, published incomplete
    (some data was missing, so it should be built again), or built the old way (`fmt` is the model's current LIVE_FORMAT)."""
    try:
        r = requests.get(url, timeout=30)
        if not r.ok:
            return None
        j = r.json()
        if j.get("complete") is False or (fmt is not None and j.get("format") != fmt) or j.get("domain") != domain:
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
        if args.live_url and live_run(args.live_url, getattr(fetcher, "LIVE_FORMAT", None), grid_of(fetcher).domain) == run_id:
            print(f"{args.model}: run {run_id} is already live; nothing to do")
            return 0
    all_steps = fetcher.steps_for(run) if hasattr(fetcher, "steps_for") else fetcher.STEP_HOURS  # shorter runs publish fewer steps
    steps = [int(s) for s in args.steps.split(",")] if args.steps else all_steps
    print(f"{args.model}: run {run_id}, {len(steps)} steps", flush=True)

    done = []
    rates: dict[int, object] = {}
    temps: dict[int, object] = {}
    run_dir = os.path.join(args.out, fetcher.MODEL_ID, run_id)
    try:
        with ThreadPoolExecutor(args.workers) as pool:
            for h, pngs, rate, temp in pool.map(lambda h: process_step(fetcher, run, h), steps):
                for vid, png in pngs.items():
                    write(os.path.join(run_dir, vid, f"{h:03d}.png"), png)
                rates[h] = rate
                temps[h] = temp
                done.append(h)
                print(f"  +{h:03d}h done ({len(done)}/{len(steps)})", flush=True)
        # rain over the next 24 h from each step (no data where the run ends before that)
        rain24 = C.VARS["rain24"]
        accumulated = forward_accumulation(rates, {h: fetcher.precip_window_hours(h) for h in rates})
        for h, field in accumulated.items():
            write(os.path.join(run_dir, "rain24", f"{h:03d}.png"), encode_field(field, rain24.lo, rain24.hi, rain24.bits))
        # lowest and highest temperature over the next 24 h from each step, for the models that publish them
        for vid, reduce in (("tmin24", np.fmin), ("tmax24", np.fmax)):
            if vid in {v.id for v in published_vars(fetcher)}:
                var = C.VARS[vid]
                for h, field in forward_extreme(temps, reduce).items():
                    write(os.path.join(run_dir, vid, f"{h:03d}.png"), encode_field(field, var.lo, var.hi, var.bits))
    except BaseException:
        shutil.rmtree(run_dir, ignore_errors=True)  # never deploy a half-written run
        raise

    # latest.json is written last so a half-finished folder never advertises a run
    build = build_id()
    write(os.path.join(args.out, fetcher.MODEL_ID, run_id, "manifest.json"),
          json.dumps(build_manifest(fetcher, run, sorted(done), build)).encode())
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
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
