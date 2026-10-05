"""Orchestrate one pipeline run for a model: fetch -> derive -> encode -> write a static site folder.

The folder is deployed to GitHub Pages by .github/workflows/nwp.yml (free, CORS-open, no external bucket).

  python run.py --model ecmwf_ifs --out site --force         # full run into ./site/ecmwf_ifs
  python run.py --model gfs --steps 0,3 --out out --force    # quick local test
  python run.py --model gfs --out site --live-url https://<user>.github.io/<repo>/gfs/latest.json
                                                             # exits quietly if that run is already live
"""
from __future__ import annotations
import argparse, json, os, shutil, sys
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import requests
import config as C
import fetch_gfs
import fetch_ifs
from derive import derive
from encode import encode_field

MODELS = {m.MODEL_ID: m for m in (fetch_ifs, fetch_gfs)}


def build_manifest(fetcher, run, steps):
    return {
        "model": fetcher.MODEL_ID,
        "run": f"{run:%Y%m%dT%H}Z",
        "grid": {"latMax": C.LAT_MAX, "latMin": C.LAT_MIN, "lonMin": C.LON_MIN, "lonMax": C.LON_MAX,
                 "step": C.STEP_DEG, "nx": C.NX, "ny": C.NY},
        "steps": [{"h": h, "valid": f"{run + timedelta(hours=h):%Y-%m-%dT%H:%M:%SZ}"} for h in steps],
        "vars": {v.id: {"unit": v.unit, "min": v.lo, "max": v.hi, "encoding": "rg16"} for v in C.VARS.values()},
        "path": "{var}/{h:03d}.png",
        "notes": {"precip": fetcher.PRECIP_NOTE},
    }


def process_step(fetcher, run, h):
    fields = derive(fetcher.read_step(run, h), h, fetcher.PRECIP_3H_AFTER_H)
    return h, {vid: encode_field(fields[vid], C.VARS[vid].lo, C.VARS[vid].hi) for vid in C.VARS}


def live_run(url: str) -> str | None:
    """Run id currently served at `url` (a latest.json), or None if unreachable or not there yet."""
    try:
        r = requests.get(url, timeout=30)
        return r.json()["run"] if r.ok else None
    except (requests.RequestException, ValueError, KeyError):
        return None


def write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, choices=sorted(MODELS))
    ap.add_argument("--out", required=True, help="site folder to write")
    ap.add_argument("--steps", help="comma-separated forecast hours (default: all)")
    ap.add_argument("--force", action="store_true", help="ignore the run-hour and already-live checks")
    ap.add_argument("--live-url", help="latest.json of the deployed model, to skip runs that are already live")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    fetcher = MODELS[args.model]
    run = fetcher.latest_run()
    run_id = f"{run:%Y%m%dT%H}Z"
    if not args.force:
        if run.hour not in fetcher.RUN_HOURS:
            print(f"{args.model}: latest run {run_id} is not one of {fetcher.RUN_HOURS}Z; nothing to do")
            return 0
        if args.live_url and live_run(args.live_url) == run_id:
            print(f"{args.model}: run {run_id} is already live; nothing to do")
            return 0
    steps = [int(s) for s in args.steps.split(",")] if args.steps else fetcher.STEP_HOURS
    print(f"{args.model}: run {run_id}, {len(steps)} steps", flush=True)

    done = []
    run_dir = os.path.join(args.out, fetcher.MODEL_ID, run_id)
    try:
        with ThreadPoolExecutor(args.workers) as pool:
            for h, pngs in pool.map(lambda h: process_step(fetcher, run, h), steps):
                for vid, png in pngs.items():
                    write(os.path.join(run_dir, vid, f"{h:03d}.png"), png)
                done.append(h)
                print(f"  +{h:03d}h done ({len(done)}/{len(steps)})", flush=True)
    except BaseException:
        shutil.rmtree(run_dir, ignore_errors=True)  # never deploy a half-written run
        raise

    # latest.json is written last so a half-finished folder never advertises a run
    write(os.path.join(args.out, fetcher.MODEL_ID, run_id, "manifest.json"),
          json.dumps(build_manifest(fetcher, run, sorted(done))).encode())
    write(os.path.join(args.out, fetcher.MODEL_ID, "latest.json"),
          json.dumps({"model": fetcher.MODEL_ID, "run": run_id}).encode())
    write(os.path.join(args.out, ".nojekyll"), b"")
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
