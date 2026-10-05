"""Orchestrate one pipeline run: fetch IFS -> derive -> encode -> (write local | publish to B2).

  python run.py --out out                        # local files only
  python run.py --publish                        # upload to B2 (needs B2_* env vars)
  python run.py --steps 0,3 --out out --force    # quick test
"""
from __future__ import annotations
import argparse, json, os
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", help="write files to this folder")
    ap.add_argument("--publish", action="store_true")
    ap.add_argument("--steps", help="comma-separated forecast hours (default: all)")
    ap.add_argument("--force", action="store_true", help="run even if this run is already published")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    run = fetch_ifs.latest_run()
    run_id = f"{run:%Y%m%dT%H}Z"
    if run.hour not in C.RUN_HOURS and not args.force:
        print(f"latest run {run_id} is not a 00/12Z run; nothing to do")
        return
    steps = [int(s) for s in args.steps.split(",")] if args.steps else C.STEP_HOURS
    print(f"run {run_id}, {len(steps)} steps", flush=True)

    s3 = bucket = publish = None
    if args.publish:
        import publish
        s3, bucket = publish.client(), os.environ["B2_BUCKET"]
        if publish.current_run(s3, bucket, C.MODEL) == run_id and not args.force:
            print("already published")
            return

    done = []
    with ThreadPoolExecutor(args.workers) as pool:
        for h, pngs in pool.map(lambda h: process_step(run, h), steps):
            for vid, png in pngs.items():
                key = f"{C.MODEL}/{run_id}/{vid}/{h:03d}.png"
                if args.out:
                    p = os.path.join(args.out, key)
                    os.makedirs(os.path.dirname(p), exist_ok=True)
                    with open(p, "wb") as f:
                        f.write(png)
                if s3:
                    publish.put(s3, bucket, key, png, "image/png", publish.IMMUTABLE)
            done.append(h)
            print(f"  +{h:03d}h done ({len(done)}/{len(steps)})", flush=True)

    manifest = json.dumps(build_manifest(run, sorted(done))).encode()
    latest = json.dumps({"model": C.MODEL, "run": run_id}).encode()
    mkey = f"{C.MODEL}/{run_id}/manifest.json"
    if args.out:
        with open(os.path.join(args.out, mkey), "wb") as f:
            f.write(manifest)
        with open(os.path.join(args.out, C.MODEL, "latest.json"), "wb") as f:
            f.write(latest)
    if s3:  # latest.json last, so clients never see a half-uploaded run
        publish.put(s3, bucket, mkey, manifest, "application/json", "public, max-age=3600")
        publish.put(s3, bucket, f"{C.MODEL}/latest.json", latest, "application/json", "public, max-age=60")
        print("pruned:", publish.prune(s3, bucket, C.MODEL, keep=[run_id]))
    print("done")


if __name__ == "__main__":
    main()
