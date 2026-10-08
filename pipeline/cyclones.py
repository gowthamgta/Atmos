"""Tropical-cyclone tracks near South India from ECMWF's open data (BUFR, type `tf`), written as one small JSON file.

ECMWF publishes the forecast track of every active tropical cyclone twice a day: one for the high-resolution forecast (`oper`) and
one for each of the 51 ensemble members (`enfo`). For each storm the file keeps the high-resolution track (position, central
pressure and 10 m wind at the storm centre every 6 h) and the members' positions every 12 h, so the app can draw the spread.
Only storms that come near the Bay of Bengal, the Arabian Sea or the Indian Ocean are kept (see REGION). Most of the year
there are none, and the file then says so.

  python cyclones.py --out site [--live-url <.../cyclones/tracks.json>]   # exits quietly when that run is already live
"""
from __future__ import annotations
import argparse, json, os, sys, tempfile
from datetime import datetime, timedelta, timezone

import numpy as np

import config as C

VERSION = 1
PRODUCT_ID = "cyclones"
FILE_NAME = "tracks.json"
# storms with any forecast position in this box (south, north, west, east) are kept
REGION = (C.LAT_MIN - 4.0, C.LAT_MAX + 4.0, C.LON_MIN - 6.0, C.LON_MAX + 6.0)   # south, north, west, east: the domain and a margin
MISSING = -1e50                 # BUFR missing values come out as -1e100
MEMBER_STEP_H = 12              # the members' positions are kept every 12 h
KEEP_HOURS = 240


def storm_track(arrays: dict, run: datetime) -> list[dict]:
    """The forecast track of one storm from one BUFR message's arrays: [{h, lat, lon, pMsl, wind}], analysis first.

    ECMWF's layout: at the analysis three positions (the storm centre, then two others), then for every lead time the storm
    centre followed by the position of the strongest wind. Pressure (Pa) and wind (m/s) have one value for the analysis and one
    per lead time. A lead time with no position (the storm has died) is left out.
    """
    lat, lon = np.asarray(arrays["latitude"], float), np.asarray(arrays["longitude"], float)
    periods = [int(h) for h in arrays["timePeriod"]]
    pressure = np.asarray(arrays.get("pressureReducedToMeanSeaLevel", []), float)
    wind = np.asarray(arrays.get("windSpeedAt10M", []), float)
    hours = [0, *periods]
    centre_index = [0, *[3 + 2 * k for k in range(len(periods))]]
    out: list[dict] = []
    for slot, (h, i) in enumerate(zip(hours, centre_index)):
        if i >= len(lat) or lat[i] < MISSING or lon[i] < MISSING:
            continue
        p = pressure[slot] if slot < len(pressure) and pressure[slot] > MISSING else None
        w = wind[slot] if slot < len(wind) and wind[slot] > MISSING else None
        out.append({"h": h, "lat": round(float(lat[i]), 2), "lon": round(_east(lon[i]), 2),
                    "pMsl": None if p is None else round(float(p) / 100.0, 1), "wind": None if w is None else round(float(w), 1)})
    return out


def _east(lon: float) -> float:
    """Longitude in -180..180."""
    lon = float(lon) % 360.0
    return lon - 360.0 if lon > 180 else lon


def in_region(track: list[dict], region: tuple[float, float, float, float] = REGION) -> bool:
    south, north, west, east = region
    return any(south <= p["lat"] <= north and west <= p["lon"] <= east for p in track)


def basin(storm_id: str) -> str:
    """Bay of Bengal (ids end in B), Arabian Sea (A), otherwise the wider Indian Ocean."""
    if storm_id.endswith("B"):
        return "Bay of Bengal"
    if storm_id.endswith("A"):
        return "Arabian Sea"
    return "Indian Ocean"


def _array(ec, gid, key: str) -> list:
    try:
        return list(ec.codes_get_array(gid, key))
    except Exception:  # noqa: BLE001 - a storm that has died has no such entries
        return []


def read_bufr(path: str, run: datetime) -> list[dict]:
    """[{id, name, member, track}] for every message (one storm of one forecast) in a BUFR file."""
    import eccodes as ec
    out: list[dict] = []
    with open(path, "rb") as f:
        while True:
            gid = ec.codes_bufr_new_from_file(f)
            if gid is None:
                break
            try:
                ec.codes_set(gid, "unpack", 1)
                arrays = {k: _array(ec, gid, k) for k in
                          ("latitude", "longitude", "timePeriod", "pressureReducedToMeanSeaLevel", "windSpeedAt10M")}
                storm = str(_array(ec, gid, "stormIdentifier")[0]).strip()
                try:
                    name = str(_array(ec, gid, "longStormName")[0]).strip()
                except Exception:  # noqa: BLE001
                    name = ""
                member = int(_array(ec, gid, "ensembleMemberNumber")[0])
                out.append({"id": storm, "name": name, "member": member, "track": storm_track(arrays, run)})
            finally:
                ec.codes_release(gid)
    return out


def build(oper: list[dict], enfo: list[dict], run: datetime) -> dict:
    """The file's content: the storms near the region, each with its high-resolution track and the ensemble members' positions."""
    members: dict[str, list[list[list[float]]]] = {}
    for m in enfo:
        pts = [[p["h"], p["lat"], p["lon"]] for p in m["track"] if p["h"] % MEMBER_STEP_H == 0 and p["h"] <= KEEP_HOURS]
        if len(pts) >= 2:
            members.setdefault(m["id"], []).append(pts)
    storms = []
    for m in oper:
        track = [p for p in m["track"] if p["h"] <= KEEP_HOURS]
        near = in_region(track) or any(in_region([{"lat": p[1], "lon": p[2]} for p in pts]) for pts in members.get(m["id"], []))
        if not track or not near:
            continue
        storms.append({"id": m["id"], "name": m["name"], "basin": basin(m["id"]), "track": track, "members": members.get(m["id"], [])})
    storms.sort(key=lambda s: s["id"])
    return {"version": VERSION, "run": f"{run:%Y%m%dT%H}Z", "generated": f"{datetime.now(timezone.utc):%Y-%m-%dT%H:%M:%SZ}", "storms": storms}


def latest_run() -> datetime:
    from ecmwf.opendata import Client
    return Client(source="ecmwf").latest(type="tf", stream="oper", step=360).replace(tzinfo=timezone.utc)


def fetch(run: datetime) -> tuple[list[dict], list[dict]]:
    from ecmwf.opendata import Client
    client = Client(source="ecmwf")
    with tempfile.TemporaryDirectory() as tmp:
        paths = {}
        for stream in ("oper", "enfo"):
            paths[stream] = os.path.join(tmp, f"{stream}.bufr")
            client.retrieve(date=run.strftime("%Y%m%d"), time=run.hour, stream=stream, type="tf", step=360, target=paths[stream])
        return read_bufr(paths["oper"], run), read_bufr(paths["enfo"], run)


def live_file(url: str) -> dict | None:
    import requests
    try:
        r = requests.get(url, timeout=30)
        j = r.json() if r.ok else {}
        return j if j.get("version") == VERSION and "run" in j else None
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--live-url", help="the deployed tracks.json: when it is already the newest run it is copied instead of rebuilt")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    run = latest_run()
    run_id = f"{run:%Y%m%dT%H}Z"
    live = live_file(args.live_url) if args.live_url else None
    if live is not None and live["run"] == run_id and not args.force:
        data = live                   # the same run: carry the deployed file over (the deploy replaces the whole site)
        print(f"cyclones: run {run_id} is already live; keeping it")
    else:
        try:
            oper, enfo = fetch(run)
        except Exception as e:  # noqa: BLE001 - the newest run may not be fully published yet: keep the deployed one
            print(f"cyclones: run {run_id} not available yet ({type(e).__name__}); keeping the live file")
            if live is None:
                return 0
            data = live
        else:
            data = build(oper, enfo, run)
            print(f"cyclones: run {run_id}, {len(data['storms'])} storm(s) near the region: {', '.join(s['id'] + ' ' + s['name'] for s in data['storms']) or 'none'}")
    os.makedirs(os.path.join(args.out, PRODUCT_ID), exist_ok=True)
    with open(os.path.join(args.out, PRODUCT_ID, FILE_NAME), "w") as f:
        json.dump(data, f, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
