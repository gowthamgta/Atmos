"""ECMWF ensemble (50 members): the chance that the next 24 hours bring extreme rain.

Open-Meteo's bucket only has "any rain" probabilities for the ensembles, so this reads ECMWF's own open data
(CC BY 4.0, https://data.ecmwf.int): total precipitation of the 50 perturbed members at 0.25 degrees
(the control member is not in the open index).
`tp` is the rain accumulated since the start of the run, so the rain of the 24 hours after step s is tp(s+24) - tp(s).
The share of members at or above each threshold is the chance, in percent. The thresholds are IMD's daily rain classes:
heavy 64.5 mm, very heavy 115.6 mm, extremely heavy 204.5 mm.

The result is stored as the product `ens` (one image per variable and start time, every 6 h to +72 h). attach.py then
copies it, aligned in time, onto every model's own timeline, so the layer works whichever model is selected.

  python ens.py --out site --force                  # newest run into ./site/ens
  python ens.py --out site --live-url <.../ens/latest.json>   # exits quietly if that run is already live
"""
from __future__ import annotations
import argparse, json, os, shutil, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import numpy as np

import config as C
from encode import encode_field
from regular import regrid_regular, window_indices

PRODUCT_ID = "ens"
LABEL = "ECMWF ensemble (50 members)"
RUN_HOURS = (0, 6, 12, 18)
START_HOURS = list(range(0, 73, 6))                 # forecast hours the 24 h windows start at
WINDOW_HOURS = 24
STEP_HOURS = sorted({s for s in START_HOURS} | {s + WINDOW_HOURS for s in START_HOURS})   # accumulation is read at these steps
# IMD's daily rain classes (mm in 24 h) and the variables they publish
THRESHOLDS_MM: dict[str, float] = {"px65": 64.5, "px115": 115.6, "px204": 204.5}
MIN_MEMBERS = 40                                    # a read with fewer members than this is treated as a failed download

LATS = C.LAT_MAX - C.STEP_DEG * np.arange(C.NY)
LONS = C.LON_MIN + C.STEP_DEG * np.arange(C.NX)


def exceedance_percent(accumulated_mm: np.ndarray, thresholds: dict[str, float] = THRESHOLDS_MM) -> dict[str, np.ndarray]:
    """Percent of members (axis 0) at or above each threshold. A cell where every member is NaN stays NaN."""
    valid = np.isfinite(accumulated_mm)
    count = valid.sum(axis=0)
    out: dict[str, np.ndarray] = {}
    for name, limit in thresholds.items():
        hits = (np.where(valid, accumulated_mm, -np.inf) >= limit).sum(axis=0)
        pct = np.where(count > 0, 100.0 * hits / np.maximum(count, 1), np.nan)
        out[name] = pct.astype(np.float32)
    return out


def window_accumulation(tp_mm: dict[int, np.ndarray], start: int, hours: int = WINDOW_HOURS) -> np.ndarray | None:
    """Rain of the `hours` after `start` for every member: tp(start + hours) - tp(start), clipped at 0. None if a step is missing."""
    if start not in tp_mm or start + hours not in tp_mm:
        return None
    return np.maximum(tp_mm[start + hours] - tp_mm[start], 0.0)


def read_members(path: str) -> np.ndarray:
    """All members' total precipitation (mm) from one ECMWF open-data GRIB file, as float32 [member, NY, NX] on the 0.1 degree grid."""
    import eccodes as ec   # imported here so the rest of the module (and its tests) work without the ecCodes library
    members: dict[int, np.ndarray] = {}
    with open(path, "rb") as f:
        while True:
            gid = ec.codes_grib_new_from_file(f)
            if gid is None:
                break
            try:
                if ec.codes_get(gid, "shortName") != "tp":
                    continue
                ni, nj = ec.codes_get(gid, "Ni"), ec.codes_get(gid, "Nj")
                lat0 = ec.codes_get(gid, "latitudeOfFirstGridPointInDegrees")
                lon0 = ec.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
                dlat, dlon = ec.codes_get(gid, "jDirectionIncrementInDegrees"), ec.codes_get(gid, "iDirectionIncrementInDegrees")
                north_first = not ec.codes_get(gid, "jScansPositively")
                grid = np.asarray(ec.codes_get_values(gid), np.float32).reshape(nj, ni)
                if north_first:                    # regrid_regular wants rows going south to north
                    grid = grid[::-1]
                    lat0 = lat0 - dlat * (nj - 1)
                if lon0 > 180:
                    lon0 -= 360.0
                r0, r1 = window_indices(lat0, dlat, nj, C.LAT_MIN, C.LAT_MAX)
                c0, c1 = window_indices(lon0, dlon, ni, C.LON_MIN, C.LON_MAX)
                block = grid[r0:r1, c0:c1] * 1000.0     # metres of water to mm
                number = ec.codes_get(gid, "number") if ec.codes_get(gid, "dataType") == "pf" else 0
                members[number] = regrid_regular(block, lat0 + r0 * dlat, dlat, lon0 + c0 * dlon, dlon, LATS, LONS)
            finally:
                ec.codes_release(gid)
    if not members:
        raise RuntimeError(f"no total-precipitation messages in {path}")
    return np.stack([members[k] for k in sorted(members)])


def latest_run() -> datetime:
    from ecmwf.opendata import Client
    run = Client(source="ecmwf").latest(type="pf", stream="enfo", param="tp", step=WINDOW_HOURS + START_HOURS[-1])
    return run.replace(tzinfo=timezone.utc)


def fetch_step(run: datetime, step: int, workdir: str | None = None) -> np.ndarray:
    """One forecast step of all members, [member, NY, NX] mm since the start of the run."""
    from ecmwf.opendata import Client
    with tempfile.TemporaryDirectory(dir=workdir) as tmp:
        target = os.path.join(tmp, f"tp{step:03d}.grib2")
        Client(source="ecmwf").retrieve(
            date=run.strftime("%Y%m%d"), time=run.hour, stream="enfo", type="pf", param="tp", step=step, target=target)
        out = read_members(target)
    if out.shape[0] < MIN_MEMBERS:
        raise RuntimeError(f"step +{step} h: only {out.shape[0]} ensemble members came back")
    return out


def build_manifest(run: datetime, starts: list[int]) -> dict:
    vars_ = {name: {"unit": "%", "min": 0, "max": 100, "encoding": "rg16"} for name in THRESHOLDS_MM}
    return {
        "model": PRODUCT_ID,
        "run": f"{run:%Y%m%dT%H}Z",
        "grid": {"latMax": C.LAT_MAX, "latMin": C.LAT_MIN, "lonMin": C.LON_MIN, "lonMax": C.LON_MAX,
                 "step": C.STEP_DEG, "nx": C.NX, "ny": C.NY},
        "steps": [{"h": h, "valid": f"{run + timedelta(hours=h):%Y-%m-%dT%H:%M:%SZ}"} for h in starts],
        "vars": vars_,
        "thresholdsMm": THRESHOLDS_MM,
        "path": "{var}/{h:03d}.png",
        "notes": {"px": f"% of the {MIN_MEMBERS}+ ensemble members whose rain over the {WINDOW_HOURS} h after this time reaches the threshold"},
    }


def write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def live_run(url: str) -> str | None:
    import requests
    try:
        r = requests.get(url, timeout=30)
        return r.json()["run"] if r.ok else None
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="site folder to write")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--live-url", help="latest.json of the deployed product, to skip a run that is already live")
    ap.add_argument("--starts", help="comma-separated start hours (default: every 6 h to +72 h); for quick local tests")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()

    run = latest_run()
    run_id = f"{run:%Y%m%dT%H}Z"
    if not args.force and args.live_url and live_run(args.live_url) == run_id:
        print(f"ens: run {run_id} is already live; nothing to do")
        return 0
    starts = [int(s) for s in args.starts.split(",")] if args.starts else START_HOURS
    steps = sorted({s for s in starts} | {s + WINDOW_HOURS for s in starts})
    print(f"ens: run {run_id}, {len(starts)} start times from {len(steps)} steps", flush=True)

    run_dir = os.path.join(args.out, PRODUCT_ID, run_id)
    tp: dict[int, np.ndarray] = {}
    try:
        with ThreadPoolExecutor(args.workers) as pool:
            for step, field in zip(steps, pool.map(lambda h: fetch_step(run, h), steps)):
                tp[step] = field
                print(f"  +{step:03d}h read ({len(tp)}/{len(steps)})", flush=True)
        done: list[int] = []
        for s in starts:
            acc = window_accumulation(tp, s)
            if acc is None:
                continue
            for name, pct in exceedance_percent(acc).items():
                write(os.path.join(run_dir, name, f"{s:03d}.png"), encode_field(pct, 0, 100, 12))
            done.append(s)
    except BaseException:
        shutil.rmtree(run_dir, ignore_errors=True)
        raise
    write(os.path.join(run_dir, "manifest.json"), json.dumps(build_manifest(run, done)).encode())
    write(os.path.join(args.out, PRODUCT_ID, "latest.json"), json.dumps({"model": PRODUCT_ID, "run": run_id}).encode())
    write(os.path.join(args.out, ".nojekyll"), b"")
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
