"""Tamil Nadu district microclimate: the blend averaged over each district, with heat, rain timing, sea breeze and flood indicators.

Every district is the average of the blend's grid points inside its boundary (its centroid when no grid point falls inside), so
the values follow the 0.1 degree forecast and its terrain correction, with no station data. The indicators are simple rules on
those values:

  heat         NWS heat index (Rothfusz) from the air temperature and humidity, with the NWS bands
  rain timing  the first time in the next 24 h the district's mean rain reaches 0.5 mm/h, and when it stops
  sea breeze   coastal districts only: the onshore wind (blowing from the sea) reaching 2 m/s between 09 and 18 IST
  flood risk   the largest 24 h rain in the next 72 h, on the IMD classes (heavy 64.5 mm, very heavy 115.6, extremely heavy 204.5)

Sea breeze and rain timing are only as good as the model (a 10 km grid resolves the land-sea contrast only roughly), and nothing
here is checked against station observations: see the app's notes.

  python microclimate.py --site site                       # writes site/microclimate/tn.json
"""
from __future__ import annotations
import argparse, json, os, sys
from datetime import datetime, timedelta, timezone

import numpy as np

import config as C
from encode import decode_field

BLEND_ID = "blend"
OUT_ID = "microclimate"
OUT_FILE = "tn.json"
VERSION = 1
STATE = "Tamil Nadu"
IST = timedelta(hours=5, minutes=30)
VARS = ("t2m", "rh", "u10", "v10", "precip", "rain24")
DISTRICTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "data", "south-india-districts.geojson")

# Sea-side directions of the coastal districts, as unit vectors (east, north) pointing from the land to the sea. Only the
# districts whose coast is clear are listed; an inland district has no sea breeze.
SEA_SIDE: dict[str, list[tuple[float, float]]] = {
    "Chennai": [(1, 0)],
    "Thiruvallur": [(1, 0)],
    "Chengalputtu": [(1, 0)],
    "Viluppuram": [(1, 0)],
    "Cuddalore": [(1, 0)],
    "Mayiladuthurai": [(1, 0)],
    "Nagapattinam": [(1, 0)],
    "Ramanathapuram": [(1, 0), (0, -1)],
    "Thoothukkudi": [(1, 0)],
    "Kanniyakumari": [(0, -1), (1, 0), (-1, 0)],
}
SEA_BREEZE_MIN_MS = 2.0      # onshore wind that counts
SEA_BREEZE_LIKELY_MS = 2.5   # peak onshore wind in the day that makes it "likely"
RAIN_MM_H = 0.5              # the rain rate that counts as rain for the timing
HEAT_BANDS = ((27, "Comfortable"), (32, "Caution"), (41, "Extreme caution"), (54, "Danger"))
HEAT_TOP = "Extreme danger"
FLOOD_BANDS = ((64.5, "Low"), (115.6, "Heavy rain"), (204.5, "Very heavy rain"))
FLOOD_TOP = "Extremely heavy rain"


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_valid(text: str) -> datetime:
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def load_districts(path: str) -> list[dict]:
    """Tamil Nadu's districts: name and the outer rings of their boundary as (lon, lat) vertices."""
    data = json.load(open(path, encoding="utf-8"))
    out: list[dict] = []
    for f in data["features"]:
        p = f.get("properties", {})
        if p.get("kind") != "district" or p.get("state") != STATE:
            continue
        geom = f["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        rings = [np.asarray(poly[0], float) for poly in polys if poly]
        out.append({"name": p["name"], "rings": rings})
    return out


def grid_axes() -> tuple[np.ndarray, np.ndarray]:
    lats = C.LAT_MAX - C.STEP_DEG * np.arange(C.NY)
    lons = C.LON_MIN + C.STEP_DEG * np.arange(C.NX)
    return lats, lons


def inside_rings(lons: np.ndarray, lats: np.ndarray, rings: list[np.ndarray]) -> np.ndarray:
    """Even-odd point-in-polygon test of every (lon, lat) pair against the rings (vectorised ray casting)."""
    mask = np.zeros(lons.shape, bool)
    for ring in rings:
        x, y = ring[:, 0], ring[:, 1]
        j = np.roll(np.arange(len(ring)), 1)
        for i in range(len(ring)):
            cross = ((y[i] > lats) != (y[j[i]] > lats)) & (
                lons < (x[j[i]] - x[i]) * (lats - y[i]) / (y[j[i]] - y[i] + 1e-12) + x[i])
            mask ^= cross
    return mask


def district_mask(d: dict, lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
    """Grid points inside the district (a single nearest point to its centroid when the district is smaller than a cell)."""
    allpts = np.concatenate(d["rings"])
    lo_lon, hi_lon = allpts[:, 0].min(), allpts[:, 0].max()
    lo_lat, hi_lat = allpts[:, 1].min(), allpts[:, 1].max()
    box = np.zeros((len(lats), len(lons)), bool)
    rows = np.where((lats >= lo_lat - C.STEP_DEG) & (lats <= hi_lat + C.STEP_DEG))[0]
    cols = np.where((lons >= lo_lon - C.STEP_DEG) & (lons <= hi_lon + C.STEP_DEG))[0]
    if len(rows) == 0 or len(cols) == 0:
        return box
    LON, LAT = np.meshgrid(lons[cols], lats[rows])
    box[np.ix_(rows, cols)] = inside_rings(LON, LAT, d["rings"])
    if not box.any():
        clat, clon = allpts[:, 1].mean(), allpts[:, 0].mean()
        box[np.argmin(np.abs(lats - clat)), np.argmin(np.abs(lons - clon))] = True
    return box


def centroid(d: dict) -> tuple[float, float]:
    pts = np.concatenate(d["rings"])
    return float(pts[:, 1].mean()), float(pts[:, 0].mean())


def heat_index_c(t_c, rh):
    """NWS heat index in degC (Rothfusz regression, with its low- and high-humidity corrections; never below the air temperature)."""
    t = np.asarray(t_c, float)
    r = np.clip(np.asarray(rh, float), 0, 100)
    tf = t * 1.8 + 32
    simple = 0.5 * (tf + 61 + (tf - 68) * 1.2 + r * 0.094)
    full = (-42.379 + 2.04901523 * tf + 10.14333127 * r - 0.22475541 * tf * r - 6.83783e-3 * tf ** 2
            - 5.481717e-2 * r ** 2 + 1.22874e-3 * tf ** 2 * r + 8.5282e-4 * tf * r ** 2 - 1.99e-6 * tf ** 2 * r ** 2)
    adj_dry = np.where((r < 13) & (tf >= 80) & (tf <= 112), ((13 - r) / 4) * np.sqrt(np.clip((17 - np.abs(tf - 95)) / 17, 0, None)), 0)
    adj_wet = np.where((r > 85) & (tf >= 80) & (tf <= 87), ((r - 85) / 10) * ((87 - tf) / 5), 0)
    hi_f = np.where((simple + tf) / 2 >= 80, full - adj_dry + adj_wet, simple)
    hi_f = np.maximum(hi_f, tf)
    return (hi_f - 32) / 1.8


def heat_band(hi_c: float) -> str:
    if not np.isfinite(hi_c):
        return "No data"
    for limit, name in HEAT_BANDS:
        if hi_c < limit:
            return name
    return HEAT_TOP


def flood_band(mm: float) -> str:
    if not np.isfinite(mm):
        return "No data"
    for limit, name in FLOOD_BANDS:
        if mm < limit:
            return name
    return FLOOD_TOP


def window(times: list[datetime], now: datetime, hours: int) -> list[int]:
    """Indices of the steps from the one at or just before `now` up to `hours` later."""
    start = [i for i, t in enumerate(times) if t <= now]
    first = start[-1] if start else 0
    return [i for i in range(first, len(times)) if times[i] <= times[first] + timedelta(hours=hours)]


def rain_timing(times, precip, idx) -> dict:
    """When the rain starts and stops in the window (mean rate of the district, mm/h)."""
    wet = [i for i in idx if np.isfinite(precip[i]) and precip[i] >= RAIN_MM_H]
    if not wet:
        return {"start": None, "end": None, "ongoing": False, "peakMmH": 0.0, "peakTime": None}
    s = wet[0]
    ongoing = s == idx[0]
    e = next((i for i in idx if i > s and np.isfinite(precip[i]) and precip[i] < RAIN_MM_H), None)
    peak = max(wet, key=lambda i: precip[i])
    return {
        "start": iso(times[s]),
        "end": iso(times[e]) if e is not None else None,
        "ongoing": ongoing,
        "peakMmH": round(float(precip[peak]), 1),
        "peakTime": iso(times[peak]),
    }


def sea_breeze(times, u, v, sea_side, idx) -> dict:
    """Onshore wind from the sea and whether it reaches the sea-breeze threshold between 09 and 18 IST in the window."""
    onshore = np.zeros(len(times))
    for sx, sy in sea_side:
        n = float(np.hypot(sx, sy))
        onshore = np.maximum(onshore, np.maximum(0.0, -(u * sx + v * sy) / n))
    onshore = np.where(np.isfinite(onshore), onshore, 0.0)
    day = [i for i in idx if 9 <= (times[i] + IST).hour <= 18]
    peak = max((onshore[i] for i in day), default=0.0)
    first = next((i for i in day if onshore[i] >= SEA_BREEZE_MIN_MS), None)
    return {
        "likely": bool(first is not None and peak >= SEA_BREEZE_LIKELY_MS),
        "from": iso(times[first]) if first is not None else None,
        "peakOnshoreMs": round(float(peak), 1),
    }


def flood_risk(times, rain24, idx) -> dict:
    """The largest 24 h rain in the window and its IMD class."""
    vals = [(rain24[i], i) for i in idx if np.isfinite(rain24[i])]
    if not vals:
        return {"band": "No data", "peakMm": None, "peakTime": None}
    mm, i = max(vals)
    return {
        "band": flood_band(mm),
        "peakMm": round(float(mm), 1),
        "peakTime": iso(times[i]),
    }


def read_blend(site: str) -> tuple[str, list[datetime], dict[str, list[np.ndarray]]] | None:
    """(blend run id, valid times, {variable: one grid per step}) from the blend folder, or None when there is no blend."""
    root = os.path.join(site, BLEND_ID)
    try:
        run_id = json.load(open(os.path.join(root, "latest.json")))["run"]
        manifest = json.load(open(os.path.join(root, run_id, "manifest.json")))
    except (OSError, ValueError, KeyError):
        return None
    steps = sorted(manifest["steps"], key=lambda s: parse_valid(s["valid"]))
    times = [parse_valid(s["valid"]) for s in steps]
    fields: dict[str, list[np.ndarray]] = {}
    for name in VARS:
        info = manifest["vars"].get(name)
        grids = []
        for s in steps:
            if info is None:
                grids.append(np.full((C.NY, C.NX), np.nan, np.float32))
                continue
            with open(os.path.join(root, run_id, name, f"{s['h']:03d}.png"), "rb") as f:
                grids.append(decode_field(f.read(), info["min"], info["max"]))
        fields[name] = grids
    return run_id, times, fields


def _series(values, digits: int) -> list:
    return [None if not np.isfinite(v) else round(float(v), digits) for v in values]


def build(site_run: tuple[str, list[datetime], dict[str, list[np.ndarray]]], districts: list[dict], now: datetime) -> dict:
    run_id, times, fields = site_run
    lats, lons = grid_axes()
    out_districts = []
    for d in districts:
        mask = district_mask(d, lats, lons)
        lat, lon = centroid(d)

        def mean(name: str) -> np.ndarray:
            return np.array([np.nanmean(g[mask]) if np.isfinite(g[mask]).any() else np.nan for g in fields[name]], float)

        t = mean("t2m")
        rh = np.clip(mean("rh"), 0, 100)
        u, v = mean("u10"), mean("v10")
        precip, rain24 = mean("precip"), mean("rain24")
        wind = np.hypot(u, v)
        frm = (np.degrees(np.arctan2(-u, -v)) + 360.0) % 360.0
        hi = heat_index_c(t, rh)

        idx24 = window(times, now, 24)
        idx72 = window(times, now, 72)
        heat_idx = [i for i in idx24 if np.isfinite(hi[i])]
        peak_i = max(heat_idx, key=lambda i: hi[i]) if heat_idx else None
        heat = {
            "peakC": None if peak_i is None else round(float(hi[peak_i]), 1),
            "peakTime": None if peak_i is None else iso(times[peak_i]),
            "band": heat_band(hi[peak_i]) if peak_i is not None else "No data",
        }
        sea = sea_breeze(times, u, v, SEA_SIDE[d["name"]], idx24) if d["name"] in SEA_SIDE else None
        out_districts.append({
            "name": d["name"],
            "lat": round(lat, 3),
            "lon": round(lon, 3),
            "coastal": d["name"] in SEA_SIDE,
            "series": {
                "tempC": _series(t, 1), "heatIndexC": _series(hi, 1), "rhPct": _series(rh, 0),
                "windMs": _series(wind, 1), "windFromDeg": _series(frm, 0), "precipMmH": _series(precip, 2),
                "rain24Mm": _series(rain24, 1),
            },
            "indicators": {
                "heat": heat,
                "rain": rain_timing(times, precip, idx24),
                "seaBreeze": sea,
                "flood": flood_risk(times, rain24, idx72),
            },
        })
    return {
        "version": VERSION,
        "run": run_id,
        "generated": iso(now),
        "now": iso(now),
        "times": [iso(t) for t in times],
        "note": "District averages of the all-model blend (no station data). Indicators are rules on these values; see pipeline/microclimate.py.",
        "districts": out_districts,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True)
    ap.add_argument("--districts", default=DISTRICTS_FILE)
    args = ap.parse_args()
    got = read_blend(args.site)
    if got is None:
        print("no blend in the site folder; no microclimate written")
        return 0
    now = datetime.now(timezone.utc)
    data = build(got, load_districts(args.districts), now)
    os.makedirs(os.path.join(args.site, OUT_ID), exist_ok=True)
    with open(os.path.join(args.site, OUT_ID, OUT_FILE), "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    print(f"microclimate: {len(data['districts'])} districts from blend run {data['run']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
