"""ECMWF ensemble (50 members): the chance of rain, and of heavy rain, in the next 24 hours.

Open-Meteo's bucket only has "any rain" probabilities for the ensembles, so this reads ECMWF's own open data
(CC BY 4.0, https://data.ecmwf.int): total precipitation of the 50 perturbed members at 0.25 degrees
(the control member is not in the open index).
`tp` is the rain accumulated since the start of the run, so the rain of the 24 hours after step s is tp(s+24) - tp(s).
The share of members at or above the threshold is the chance of rain, in percent: PoP = members with 24 h rain >= 0.1 mm (measurable
rain) divided by all members, as meteorologists define it.

The extreme-rain probability is ECMWF's own: the open data has ready-made ensemble probability products (type `ep`), among them the
chance of 50 mm or more in 24 hours (`tpg50`, windows starting every 12 h), which is read as it is.

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
# The chance of rain: measurable rain is 0.1 mm or more in the 24 hours. (The extreme-rain probability is not computed here: it is ECMWF's own
# tpg50 product, see PROBABILITY_PRODUCTS.)
THRESHOLDS_MM: dict[str, float] = {"px0": 0.1}
# ECMWF's own probability products (type "ep" in the open data): variable -> (GRIB parameter, millimetres in 24 h). Every 12 h a window.
PROBABILITY_PRODUCTS: dict[str, tuple[str, float]] = {"xr": ("tpg50", 50.0)}
PROBABILITY_WINDOW_STEP = 12
# Bump when the method changes, so a run that is already live under the old method is rebuilt (v2: fixed the longitude
# of ECMWF's 180-east-first grids, which had produced fields that only varied by latitude; v3: only the chance of any rain, 0.1 mm; v4: the extreme-rain probability is ECMWF's own tpg50)
VERSION = 4
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


def _message_to_domain(gid, scale: float = 1.0) -> np.ndarray:
    """One global GRIB message on the 0.1 degree domain grid, float32 [NY, NX] (the values times `scale`)."""
    import eccodes as ec
    ni, nj = ec.codes_get(gid, "Ni"), ec.codes_get(gid, "Nj")
    lat0 = ec.codes_get(gid, "latitudeOfFirstGridPointInDegrees")
    lon0 = ec.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
    dlat, dlon = ec.codes_get(gid, "jDirectionIncrementInDegrees"), ec.codes_get(gid, "iDirectionIncrementInDegrees")
    north_first = not ec.codes_get(gid, "jScansPositively")
    grid = np.asarray(ec.codes_get_values(gid), np.float32).reshape(nj, ni)
    if north_first:                    # regrid_regular wants rows going south to north
        grid = grid[::-1]
        lat0 = lat0 - dlat * (nj - 1)
    if lon0 >= 180:      # ECMWF's global grids start at 180 E and run east through 0: that is -180 on a -180..180 axis
        lon0 -= 360.0
    r0, r1 = window_indices(lat0, dlat, nj, C.LAT_MIN, C.LAT_MAX)
    c0, c1 = window_indices(lon0, dlon, ni, C.LON_MIN, C.LON_MAX)
    block = grid[r0:r1, c0:c1] * scale
    return regrid_regular(block, lat0 + r0 * dlat, dlat, lon0 + c0 * dlon, dlon, LATS, LONS)


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
                number = ec.codes_get(gid, "number") if ec.codes_get(gid, "dataType") == "pf" else 0
                members[number] = _message_to_domain(gid, 1000.0)     # metres of water to mm
            finally:
                ec.codes_release(gid)
    if not members:
        raise RuntimeError(f"no total-precipitation messages in {path}")
    return np.stack([members[k] for k in sorted(members)])


def read_probabilities(path: str, short_name: str) -> dict[int, np.ndarray]:
    """{first hour of the 24 h window: probability in percent on the domain grid} for one ECMWF probability parameter."""
    import eccodes as ec
    out: dict[int, np.ndarray] = {}
    with open(path, "rb") as f:
        while True:
            gid = ec.codes_grib_new_from_file(f)
            if gid is None:
                break
            try:
                if ec.codes_get(gid, "shortName") != short_name:
                    continue
                start = int(str(ec.codes_get(gid, "stepRange")).split("-")[0])
                out[start] = _message_to_domain(gid)
            finally:
                ec.codes_release(gid)
    if not out:
        raise RuntimeError(f"no {short_name} messages in {path}")
    return out


def probability_starts(starts: list[int]) -> list[int]:
    """The windows to download: ECMWF publishes one every 12 h, so a start in between uses the two around it."""
    step = PROBABILITY_WINDOW_STEP
    need: set[int] = set()
    for s in starts:
        need.add(s // step * step)
        if s % step:
            need.add(s // step * step + step)
    return sorted(need)


def blend_probability(windows: dict[int, np.ndarray], start: int) -> np.ndarray:
    """The probability for a window starting at `start`: ECMWF's own, or the mix of the two published windows around it."""
    if start in windows:
        return windows[start]
    below = max(h for h in windows if h < start)
    above = min(h for h in windows if h > start)
    w = (start - below) / (above - below)
    return (windows[below] * (1 - w) + windows[above] * w).astype(np.float32)


def fetch_probabilities(run: datetime, starts: list[int], param: str) -> dict[int, np.ndarray]:
    """ECMWF's ready-made ensemble probability (percent) of a 24 h window starting at each of `starts` hours, for run `run`."""
    from ecmwf.opendata import Client
    windows = probability_starts(starts)
    steps = [f"{h}-{h + WINDOW_HOURS}" for h in windows]
    with tempfile.TemporaryDirectory() as tmp:
        target = os.path.join(tmp, "ep.grib2")
        Client(source="ecmwf").retrieve(date=run.strftime("%Y%m%d"), time=run.hour, stream="enfo", type="ep", param=param, step=steps, target=target)
        fields = read_probabilities(target, param)
    missing = [h for h in windows if h not in fields]
    if missing:
        raise RuntimeError(f"ECMWF's {param} probability is missing for the windows starting at {missing} h")
    return {s: blend_probability(fields, s) for s in starts}


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
    vars_ = {name: {"unit": "%", "min": 0, "max": 100, "encoding": "rg16"} for name in [*THRESHOLDS_MM, *PROBABILITY_PRODUCTS]}
    return {
        "model": PRODUCT_ID,
        "run": f"{run:%Y%m%dT%H}Z",
        "grid": {"latMax": C.LAT_MAX, "latMin": C.LAT_MIN, "lonMin": C.LON_MIN, "lonMax": C.LON_MAX,
                 "step": C.STEP_DEG, "nx": C.NX, "ny": C.NY},
        "steps": [{"h": h, "valid": f"{run + timedelta(hours=h):%Y-%m-%dT%H:%M:%SZ}"} for h in starts],
        "vars": vars_,
        "thresholdsMm": THRESHOLDS_MM,
        "probabilityProducts": {name: {"param": param, "mm": mm} for name, (param, mm) in PROBABILITY_PRODUCTS.items()},
        "path": "{var}/{h:03d}.png",
        "notes": {"px": f"% of the {MIN_MEMBERS}+ ensemble members whose rain over the {WINDOW_HOURS} h after this time reaches the threshold"},
    }


def write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def live_run(url: str) -> str | None:
    """Run id live at `url` (a latest.json), or None if it is unreachable or was built by an older version of the method."""
    import requests
    try:
        r = requests.get(url, timeout=30)
        j = r.json() if r.ok else {}
        return j["run"] if j.get("version") == VERSION else None
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
        # ECMWF's own probability products, read as they are (a handful of small messages)
        for name, (param, mm) in PROBABILITY_PRODUCTS.items():
            fields = fetch_probabilities(run, done, param)
            for s, pct in fields.items():
                write(os.path.join(run_dir, name, f"{s:03d}.png"), encode_field(pct, 0, 100, 12))
            print(f"  {name}: ECMWF's {param} (chance of {mm:g} mm or more in 24 h) for {len(fields)} start times", flush=True)
    except BaseException as e:
        shutil.rmtree(run_dir, ignore_errors=True)
        import requests
        if isinstance(e, requests.HTTPError) and e.response is not None and e.response.status_code == 404:
            print(f"ens: ECMWF has not published the probability products of run {run_id} yet; the next cycle tries again")
            return 0
        raise
    write(os.path.join(run_dir, "manifest.json"), json.dumps(build_manifest(run, done)).encode())
    write(os.path.join(args.out, PRODUCT_ID, "latest.json"), json.dumps({"model": PRODUCT_ID, "run": run_id, "version": VERSION}).encode())
    write(os.path.join(args.out, ".nojekyll"), b"")
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
