"""Bias of the ECMWF IFS forecast against the airport observations near Kallakurichi (METAR), and whether a correction by hour
of day helps on days it was not learned from.

  python bias.py --days 9 --out data/bias/table.json

For each airport and variable (2 m temperature, relative humidity, 10 m wind speed): the model's value at each observation
time (the nearest hour), the error (model minus observation), its mean by hour of day, and the error on the last third of
the period when the first two-thirds set the correction. The result is a table to apply to the forecast, and a check on
whether it improves things (mean absolute error before and after).

Honest limits: the airports are 80 km and more from Kallakurichi, so the table describes the airports; it is not measured
at Kallakurichi itself. Only temperature, humidity and wind are corrected here (rain is checked separately against the
TN-SMART gauges).
"""
from __future__ import annotations
import argparse, json, os, sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import requests

import obs_metar

HIST = "https://historical-forecast-api.open-meteo.com/v1/forecast"
MODEL = "ecmwf_ifs"
VARS = ("temperature_2m", "relative_humidity_2m", "wind_speed_10m")
TIMEOUT_S = 120


def model_series(lat: float, lon: float, start: datetime, end: datetime) -> dict[datetime, dict[str, float]]:
    """The model's hourly values at a point (UTC), keyed by time."""
    params = {
        "latitude": lat, "longitude": lon, "hourly": ",".join(VARS), "models": MODEL, "timezone": "UTC",
        "wind_speed_unit": "ms", "start_date": f"{start:%Y-%m-%d}", "end_date": f"{end:%Y-%m-%d}",
    }
    res = requests.get(HIST, params=params, timeout=TIMEOUT_S)
    res.raise_for_status()
    h = res.json()["hourly"]
    out = {}
    for i, t in enumerate(h["time"]):
        when = datetime.strptime(t, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)
        out[when] = {"temp_c": h["temperature_2m"][i], "rh_pct": h["relative_humidity_2m"][i], "wind_ms": h["wind_speed_10m"][i]}
    return out


def nearest_hour(t: datetime) -> datetime:
    return (t + timedelta(minutes=30)).replace(minute=0, second=0, microsecond=0)


def pairs(obs: list[dict], model: dict[datetime, dict[str, float]]) -> list[dict]:
    """Observation and model value at the same hour, for every observation the model has."""
    out = []
    for o in obs:
        t = nearest_hour(datetime.strptime(o["time"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc))
        m = model.get(t)
        if m is None or o.get("temp_c") is None:
            continue
        rec = {"time": t, "hour": t.hour}
        for key, okey in (("temp_c", "temp_c"), ("rh_pct", "rh_pct"), ("wind_ms", "wind_ms")):
            if o.get(okey) is not None and m.get(key) is not None:
                rec[key] = (m[key], o[okey])     # (model, observed)
        out.append(rec)
    return out


def hourly_correction(train: list[dict], var: str) -> dict[int, float]:
    """Mean error (model minus observed) by hour of day, smoothed over three hours. Hours with no data get 0."""
    err = defaultdict(list)
    for r in train:
        if var in r:
            m, o = r[var]
            err[r["hour"]].append(m - o)
    raw = {h: sum(v) / len(v) for h, v in err.items() if v}
    out = {}
    for h in range(24):
        vals = [raw[(h + d) % 24] for d in (-1, 0, 1) if (h + d) % 24 in raw]
        out[h] = round(sum(vals) / len(vals), 3) if vals else 0.0
    return out


def mae(rows: list[dict], var: str, corr: dict[int, float] | None) -> float | None:
    errs = []
    for r in rows:
        if var not in r:
            continue
        m, o = r[var]
        if corr is not None:
            m = m - corr.get(r["hour"], 0.0)
        errs.append(abs(m - o))
    return round(sum(errs) / len(errs), 3) if errs else None


def evaluate(all_pairs: list[dict]) -> dict:
    """Learn the correction on the first two-thirds of the period and test it on the last third, per variable."""
    times = sorted(r["time"] for r in all_pairs)
    if not times:
        return {}
    cut = times[0] + (times[-1] - times[0]) * (2 / 3)
    train = [r for r in all_pairs if r["time"] < cut]
    test = [r for r in all_pairs if r["time"] >= cut]
    result = {}
    for var in ("temp_c", "rh_pct", "wind_ms"):
        corr = hourly_correction(train, var)
        result[var] = {
            "n_test": sum(1 for r in test if var in r),
            "mae_before": mae(test, var, None),
            "mae_after": mae(test, var, corr),
            "correction_by_hour_utc": corr,
        }
    return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=9)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    metar = requests.get(obs_metar.API, params={"ids": ",".join(obs_metar.AIRPORTS), "format": "json", "hours": args.days * 24}, timeout=120)
    metar.raise_for_status()
    raw = metar.json()
    by_station = obs_metar.parse_all(raw)
    coords = {r["icaoId"]: (r["lat"], r["lon"]) for r in raw if r.get("lat") is not None}
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=args.days)
    report = {"model": MODEL, "period_utc": [start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")], "airports": {}}
    for station, obs in by_station.items():
        if station not in coords:
            continue
        lat, lon = coords[station]
        model = model_series(lat, lon, start, end)
        rows = pairs(obs, model)
        report["airports"][station] = {"lat": lat, "lon": lon, "n_pairs": len(rows), "variables": evaluate(rows)}
        print(station, len(rows), "pairs", flush=True)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1)
    print("wrote", args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
