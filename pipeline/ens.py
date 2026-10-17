"""Probability of rain from the ECMWF ensemble (51 members), published in the same folder format as a model.

Open-Meteo republishes the ensemble's own `precipitation_probability` (0 to 100 %, the share of members with rain in the 3 hours
that end at the valid time, 0.25 degree, every 3 hours to +144 h). Each step file is about 0.4 MB, so the whole run is about 20 MB.

The app's "Probability of rain, next 24 h" layer wants the chance of rain at any time in the next 24 hours from a step, so the eight
3-hourly values that follow a step are combined (see `next_24h`) and published as `pop24`, one picture per step.

  python ens.py --out site --live-url https://<user>.github.io/<repo>/ens/latest.json
"""
from __future__ import annotations
import argparse, json, os, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import numpy as np
import requests
from config import BUCKET_URL
from encode import encode_field
from fetch_regular import dataset_info, read_dataset_vars
from models_regular import COARSE_GRID
from net import download

MODEL_ID = "ens"
LABEL = "ECMWF ensemble"
DATASET = "ecmwf_ifs025_ensemble"
VARIABLE = "precipitation_probability"
VAR_ID = "pop24"
WINDOW_STEPS = 8                  # 8 x 3 h = the next 24 hours
STEP_H = 3
RUN_HOURS = (0, 6, 12, 18)
FORMAT = 1                        # bump when the way a run is built changes, so a live run built the old way is built again


def next_24h(steps: dict[int, np.ndarray]) -> dict[int, np.ndarray]:
    """From the chance of rain in each 3 hours (`steps`, % by forecast hour), the chance of rain at some time in the 24 hours after each hour.

    The 8 values that follow a step are joined as if rain in one period said nothing about the next (1 - product of the chances of
    dry) and as if it said everything (the largest value). The truth lies between the two (rain in a monsoon spell lasts), so the
    answer is half way between them. No data (NaN) where the run ends before the 24 hours do, or a value is missing."""
    out: dict[int, np.ndarray] = {}
    for h in sorted(steps):
        window = [steps.get(h + STEP_H * k) for k in range(1, WINDOW_STEPS + 1)]
        if any(w is None for w in window):
            continue
        p = np.clip(np.stack(window).astype(np.float64) / 100.0, 0.0, 1.0)
        independent = 1.0 - np.prod(1.0 - p, axis=0)
        correlated = p.max(axis=0)
        out[h] = (50.0 * (independent + correlated)).astype(np.float32)
        out[h][~np.isfinite(p).all(axis=0)] = np.nan
    return out


def file_url(run: datetime, step_h: int) -> str:
    valid = run + timedelta(hours=step_h)
    return f"{BUCKET_URL}/data_spatial/{DATASET}/{run:%Y/%m/%d/%H}00Z/{valid:%Y-%m-%dT%H}00.om"


def live_run(url: str) -> str | None:
    """The run id served at `url` (a latest.json), or None when there is none or it was built the old way."""
    try:
        r = requests.get(url, timeout=30)
        if not r.ok:
            return None
        j = r.json()
        if j.get("format") != FORMAT or j.get("domain") != COARSE_GRID.domain:
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
    ap.add_argument("--out", required=True)
    ap.add_argument("--live-url", help="the deployed latest.json: when it already has the newest run the run is not built again")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--max-step", type=int, default=144, help="the last forecast hour to read")
    args = ap.parse_args()

    try:
        info = dataset_info(DATASET)
    except Exception as e:  # noqa: BLE001 - the newest run is still being written: keep the live one
        print(f"ens: no finished run yet ({type(e).__name__}: {e}); keeping the live one")
        return 0
    run = info.reference
    run_id = f"{run:%Y%m%dT%H}Z"
    if args.live_url and not args.force and live_run(args.live_url) == run_id:
        print(f"ens: run {run_id} is already live; keeping it")
        return 0

    hours = [int(h) for h in info.offsets if h <= args.max_step and float(h).is_integer() and int(h) % STEP_H == 0]
    print(f"ens: run {run_id}, {len(hours)} steps", flush=True)

    def read(h: int) -> tuple[int, np.ndarray | None]:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "p.om")
            try:
                download(file_url(run, h), path)
            except requests.HTTPError as e:
                if h == 0 and e.response is not None and e.response.status_code == 404:
                    return h, None      # the analysis hour has no "rain in the last 3 hours": the first window starts at +3 h
                raise
            return h, read_dataset_vars(path, [VARIABLE], info.bbox, COARSE_GRID)[VARIABLE]

    with ThreadPoolExecutor(4) as pool:
        steps = {h: a for h, a in pool.map(read, hours) if a is not None}

    fields = next_24h(steps)
    if not fields:
        print("ens: the run is too short for a 24 hour window; nothing published")
        return 0
    run_dir = os.path.join(args.out, MODEL_ID, run_id)
    for h, field in fields.items():
        write(os.path.join(run_dir, VAR_ID, f"{h:03d}.png"), encode_field(field, 0.0, 100.0))
    build = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    manifest = {
        "model": MODEL_ID,
        "run": run_id,
        "grid": COARSE_GRID.manifest(),
        "steps": [{"h": h, "valid": f"{run + timedelta(hours=h):%Y-%m-%dT%H:%M:%SZ}"} for h in sorted(fields)],
        "vars": {VAR_ID: {"unit": "%", "min": 0, "max": 100, "encoding": "rg16"}},
        "levels": [],
        "path": "{var}/{h:03d}.png",
        "notes": {VAR_ID: "chance of rain at some time in the 24 hours after the step: the ECMWF ensemble's 3-hourly chance of rain, combined"},
        "build": build,
        "domain": COARSE_GRID.domain,
    }
    write(os.path.join(run_dir, "manifest.json"), json.dumps(manifest).encode())
    latest = {"model": MODEL_ID, "run": run_id, "build": build, "domain": COARSE_GRID.domain, "format": FORMAT}
    write(os.path.join(args.out, MODEL_ID, "latest.json"), json.dumps(latest).encode())   # last: a half-written run is never advertised
    write(os.path.join(args.out, ".nojekyll"), b"")
    print(f"ens: published {len(fields)} steps")
    return 0


if __name__ == "__main__":
    sys.exit(main())
