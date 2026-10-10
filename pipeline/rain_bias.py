"""Rain: the ECMWF IFS rainfall against the Tamil Nadu gauges (TN-SMART), on land only, and a scale factor that helps on days
it was not learned from.

  python rain_bias.py --history data/rain_history --out data/bias/rain.json

Each gauge day is the window 09:30 AM to 07:30 AM Indian time (04:00 to 02:00 UTC the next day), as the daily files
label their hours. Gauges on the sea (by the terrain's land fraction) are left out. The model's rainfall at each gauge
comes from Open-Meteo's historical forecast (ecmwf_ifs, the same model the app shows).

The factor is observed total divided by model total over the learning days, applied to the model's rain. It is used only
if it clearly lowers the daily error on the last third of the days (see correction.py, MIN_GAIN, MIN_TEST_POINTS).
"""
from __future__ import annotations
import argparse, io, json, math, os, sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

import numpy as np
import requests
from PIL import Image

HIST = "https://historical-forecast-api.open-meteo.com/v1/forecast"
TERRAIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "terrain")
BATCH = 120
TIMEOUT_S = 180
WINDOW_START_UTC_H = 4          # 09:30 IST
WINDOW_DAY_OFFSET = -1         # the file labelled D holds 09:30 AM on D-1 to 07:30 AM on D (the model agrees best with this)
# a factor is accepted only when the held-out days are enough and it helps on most of them (gauges on one day share the
# weather, so the number of days matters more than the number of gauge-days)
MIN_TEST_DAYS = 10
MIN_DAYS_IMPROVED = 0.6
MIN_GAIN = 0.05
WINDOW_HOURS = 23               # 09:30 AM to 07:30 AM the next day: 23 hourly values (04:00 to 02:00 UTC)


def _hour_index(label: str) -> int:
    """Position of an hourly column label ('09:30 AM' ... '07:30 AM') in the window: 0 for 09:30 AM."""
    t = datetime.strptime(label, "%I:%M %p")
    h = t.hour % 24
    return (h - 9) % 24            # 09:30 -> 0, 10:30 -> 1 ... 07:30 -> 22 (the 23rd value)


def land_fraction(lat: float, lon: float, cache: dict) -> float | None:
    """The terrain's land fraction at a point (from the 270 m tile); None where there is no tile (sea)."""
    name = f"N{math.floor(lat):02d}E{math.floor(lon):03d}"
    if name not in cache:
        path = os.path.join(TERRAIN, "L1", name + ".webp")
        cache[name] = np.asarray(Image.open(path).convert("RGB")) if os.path.exists(path) else None
    px = cache[name]
    if px is None:
        return None
    n = px.shape[0]
    col = min(n - 1, int((lon - math.floor(lon)) * n))
    row = min(n - 1, int((math.floor(lat) + 1 - lat) * n))
    return px[row, col, 2] / 255.0


def load_history(folder: str) -> list[dict]:
    """Each day: {date, stations: [{station, district, lat, lon, window_mm (by hour index, 23 values)}]}."""
    days = []
    for f in sorted(os.listdir(folder)):
        if not (f.endswith(".json") and len(f) == len("2026-10-09.json") and f[:4].isdigit()):
            continue                          # the daily files only (the model cache is kept beside them)
        with open(os.path.join(folder, f), encoding="utf-8") as fh:
            doc = json.load(fh)
        rows = []
        for s in doc["stations"]:
            if s.get("lat") is None or s.get("lon") is None:
                continue
            w = [None] * WINDOW_HOURS
            for label, v in s["hourly_mm"].items():
                i = _hour_index(label)
                if 0 <= i < WINDOW_HOURS:
                    w[i] = v
            rows.append({"station": s["station"], "district": s.get("district"), "lat": s["lat"], "lon": s["lon"],
                         "window_mm": w})
        days.append({"date": doc["date"], "stations": rows})
    return days


def fixed_positions(days: list[dict]) -> None:
    """Each station gets one position for the whole record (the latest file's), so its model series is fetched once."""
    latest = {(s["district"], s["station"]): (s["lat"], s["lon"]) for s in days[-1]["stations"] if s.get("lat") is not None}
    for d in days:
        for s in d["stations"]:
            key = (s["district"], s["station"])
            if key in latest:
                s["lat"], s["lon"] = latest[key]


def _get(params: dict) -> object:
    """A request to the forecast API, waiting and trying again when it asks to slow down (HTTP 429)."""
    import time
    for attempt in range(8):
        res = requests.get(HIST, params=params, timeout=TIMEOUT_S)
        if res.status_code != 429:
            res.raise_for_status()
            return res.json()
        time.sleep(30 * (attempt + 1))
    res.raise_for_status()


def model_precip(points: list[tuple[float, float]], start: date, end: date, cache_path: str) -> dict[tuple[float, float], dict[datetime, float]]:
    """Hourly model rainfall (mm) at each point, UTC, keyed by point then time. Results are kept in cache_path as they arrive,
    so a run that is stopped (the API limits how much it serves) carries on from where it stopped."""
    import time
    cache = {}
    if os.path.exists(cache_path):
        with open(cache_path, encoding="utf-8") as f:
            cache = json.load(f)
    key = lambda p: f"{p[0]:.4f},{p[1]:.4f}"
    first = f"{start:%Y-%m-%d}T00:00"
    last = f"{end:%Y-%m-%d}T23:00"

    def covers(series: dict | None) -> bool:
        # a cached series is reused only if it spans the dates asked for (a longer history needs the newer days fetched)
        return bool(series) and min(series) <= first and max(series) >= last

    todo = [p for p in points if not covers(cache.get(key(p)))]
    for i in range(0, len(todo), BATCH):
        chunk = todo[i:i + BATCH]
        params = {"latitude": ",".join(str(p[0]) for p in chunk), "longitude": ",".join(str(p[1]) for p in chunk),
                  "hourly": "precipitation", "models": "ecmwf_ifs", "timezone": "UTC",
                  "start_date": f"{start:%Y-%m-%d}", "end_date": f"{end:%Y-%m-%d}"}
        data = _get(params)
        blocks = data if isinstance(data, list) else [data]
        for p, blk in zip(chunk, blocks):
            cache[key(p)] = dict(zip(blk["hourly"]["time"], blk["hourly"]["precipitation"]))   # a null hour stays null
        with open(cache_path + ".part", "w", encoding="utf-8") as f:
            json.dump(cache, f)
        os.replace(cache_path + ".part", cache_path)
        time.sleep(2)
    out = {}
    for p in points:
        series = cache.get(key(p))
        if covers(series):
            out[p] = {datetime.strptime(t, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc): v for t, v in series.items() if v is not None}
    return out


def window_total(series: dict[datetime, float], day: date) -> float | None:
    """Model rainfall (mm) in the window of a day: 04:00 UTC on the day to 02:00 UTC the next day (23 hours).
    None when any hour of the window is missing: a missing hour is not 0 mm of rain."""
    start = datetime(day.year, day.month, day.day, WINDOW_START_UTC_H, tzinfo=timezone.utc)
    hours = [series.get(start + timedelta(hours=k)) for k in range(WINDOW_HOURS)]
    return None if any(v is None for v in hours) else sum(hours)


def build_pairs(days: list[dict], model: dict, cache: dict) -> list[dict]:
    """One row per land gauge and day: observed and model window totals (mm)."""
    rows = []
    for d in days:
        label = date.fromisoformat(d["date"])
        day = label + timedelta(days=WINDOW_DAY_OFFSET)
        for s in d["stations"]:
            if None in s["window_mm"]:
                continue
            lf = land_fraction(s["lat"], s["lon"], cache)
            if lf is None or lf < 0.5:
                continue                      # the sea: left out
            series = model.get((s["lat"], s["lon"]))
            if series is None:
                continue
            total = window_total(series, day)
            if total is None:
                continue                      # the model has no value for part of this window
            rows.append({"date": label, "station": s["station"], "district": s["district"],
                         "obs": sum(s["window_mm"]), "model": total})
    return rows


def best_window_offset(days: list[dict], model: dict, cache: dict) -> dict:
    """Checks the day label against the model: the gauge window that the model agrees with best (0 = the label's own day,
    -1 = the day before). Reported, so the alignment can be checked."""
    scores = {}
    for off in (0, -1):
        obs, mod = [], []
        for d in days:
            day = date.fromisoformat(d["date"]) + timedelta(days=off)
            for s in d["stations"]:
                if None in s["window_mm"]:
                    continue
                lf = land_fraction(s["lat"], s["lon"], cache)
                if lf is None or lf < 0.5:
                    continue
                series = model.get((s["lat"], s["lon"]))
                if series is None:
                    continue
                total = window_total(series, day)
                if total is None:
                    continue
                obs.append(sum(s["window_mm"]))
                mod.append(total)
        if len(obs) > 2 and np.std(obs) > 0 and np.std(mod) > 0:
            scores[off] = round(float(np.corrcoef(obs, mod)[0, 1]), 3)
    return scores


def evaluate(rows: list[dict]) -> dict:
    """Learn the factor on the first two-thirds of the days, test on the last third (daily totals per gauge)."""
    dates = sorted({r["date"] for r in rows})
    if len(dates) < 3:
        return {}
    cut = dates[int(len(dates) * 2 / 3)]
    train = [r for r in rows if r["date"] < cut]
    test = [r for r in rows if r["date"] >= cut]
    sm = sum(r["model"] for r in train)
    k = (sum(r["obs"] for r in train) / sm) if sm > 0 else 1.0
    err_before = [abs(r["model"] - r["obs"]) for r in test]
    err_after = [abs(r["model"] * k - r["obs"]) for r in test]
    # the error of each held-out day on its own: does the factor help on most days, not only on average?
    per_day = defaultdict(lambda: [[], []])
    for r, b, a in zip(test, err_before, err_after):
        per_day[r["date"]][0].append(b)
        per_day[r["date"]][1].append(a)
    days_improved = sum(1 for b, a in per_day.values() if np.mean(a) < np.mean(b))
    mae_before = round(float(np.mean(err_before)), 3) if test else None
    mae_after = round(float(np.mean(err_after)), 3) if test else None
    accepted = bool(
        test and len(per_day) >= MIN_TEST_DAYS and days_improved / len(per_day) >= MIN_DAYS_IMPROVED
        and mae_after <= mae_before * (1 - MIN_GAIN)
    )
    return {
        "factor": round(k, 3),
        "learn_days": len({r["date"] for r in train}),
        "n_test": len(test),
        "test_days": len(per_day),
        "days_improved": days_improved,
        "mae_before": mae_before,
        "mae_after": mae_after,
        "gauges": len({r["station"] for r in rows}),
        "accepted": accepted,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--history", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    days = load_history(args.history)
    if not days:
        print("no history", file=sys.stderr)
        return 1
    dates = [date.fromisoformat(d["date"]) for d in days]
    start, end = min(dates) - timedelta(days=1), max(dates) + timedelta(days=1)
    fixed_positions(days)
    cache = {}
    # the sea is left out before anything is fetched: only gauges on land are needed
    points = sorted({(s["lat"], s["lon"]) for d in days for s in d["stations"]
                     if s.get("lat") is not None and (land_fraction(s["lat"], s["lon"], cache) or 0) >= 0.5})
    print(f"{len(points)} land gauge points, {start}..{end}", flush=True)
    model = model_precip(points, start, end, os.path.join(args.history, "model_cache.json"))
    offsets = best_window_offset(days, model, cache)
    rows = build_pairs(days, model, cache)
    rain = evaluate(rows) or {"accepted": False}
    gauges = points
    result = {
        "model": "ecmwf_ifs",
        "period": [str(min(dates)), str(max(dates))],
        "window_check_correlation_by_day_offset": offsets,
        "land_gauges_used": len({r["station"] for r in rows}),
        "rain": rain,
        "gauges": [[round(la, 4), round(lo, 4)] for la, lo in gauges],
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=1)
    print(json.dumps(result, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
