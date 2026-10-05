"""Orchestrate one pipeline run: fetch IFS -> derive -> encode -> write a static site folder.

The folder is deployed to GitHub Pages by .github/workflows/nwp.yml (free, CORS-open, no external bucket).

  python run.py --out site --force                 # full run into ./site
  python run.py --steps 0,3 --out out --force      # quick local test
  python run.py --out site --live-url https://<user>.github.io/<repo>/ecmwf_ifs/latest.json
                                                   # exit code 0 and no output if that run is already live
"""
from __future__ import annotations
import argparse, json, os, sys
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import requests
import config as C
from derive import derive
from encode import encode_field
import fetch_ifs


def build_manifest(run, steps):
    return {
        "model": C.MODEL,
        "run": f"{run:%Y%m%dT%H}Z",
        "grid": {"latMax": C.LAT_MAX, "latMin": C.LAT_MIN, "lonMin": C.LON_MIN, "lonMax": C.LON_MAX,
                 "step": C.STEP_DEG, "nx": C.NX, "ny": C.NY},
        "steps": [{"h": h, "valid": f"{run + timedelta(hours=h):%Y-%m-%dT%H:%M:%SZ}"} for h in steps],
        "vars": {v.id: {"unit": v.unit, "min": v.lo, "max": v.hi, "encoding": "rg16"} for v in C.VARS.values()},
        "path": "{var}/{h:03d}.png",
        "notes": {"precip": "IFS precipitation at the valid hour (mm); semantics beyond +90 h to be verified"},
    }


def process_step(run, h):
    fields = derive(fetch_ifs.read_step(run, h))
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
    ap.add_argument("--out", required=True, help="site folder to write")
    ap.add_argument("--steps", help="comma-separated forecast hours (default: all)")
    ap.add_argument("--force", action="store_true", help="ignore the 00/12Z and already-live checks")
    ap.add_argument("--live-url", help="latest.json of the deployed site, to skip runs that are already live")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    run = fetch_ifs.latest_run()
    run_id = f"{run:%Y%m%dT%H}Z"
    if not args.force:
        if run.hour not in C.RUN_HOURS:
            print(f"latest run {run_id} is not a 00/12Z run; nothing to do")
            return 0
        if args.live_url and live_run(args.live_url) == run_id:
            print(f"run {run_id} is already live; nothing to do")
            return 0
    steps = [int(s) for s in args.steps.split(",")] if args.steps else C.STEP_HOURS
    print(f"run {run_id}, {len(steps)} steps", flush=True)

    done = []
    with ThreadPoolExecutor(args.workers) as pool:
        for h, pngs in pool.map(lambda h: process_step(run, h), steps):
            for vid, png in pngs.items():
                write(os.path.join(args.out, C.MODEL, run_id, vid, f"{h:03d}.png"), png)
            done.append(h)
            print(f"  +{h:03d}h done ({len(done)}/{len(steps)})", flush=True)

    # latest.json is written last so a half-finished folder never advertises a run
    write(os.path.join(args.out, C.MODEL, run_id, "manifest.json"), json.dumps(build_manifest(run, sorted(done))).encode())
    write(os.path.join(args.out, C.MODEL, "latest.json"), json.dumps({"model": C.MODEL, "run": run_id}).encode())
    write(os.path.join(args.out, ".nojekyll"), b"")
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
