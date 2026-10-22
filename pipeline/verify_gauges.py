"""How right each model's rain was over Tamil Nadu: the TN-SMART rain gauges (about 1,500, hourly) against what each model forecast 1, 2 and
3 days ahead. Far more places than the airports, and real rain amounts rather than "rain reported".

  python verify_gauges.py --out ../public/data/verification/scores.json             # the rain day that ended at 08:30 IST yesterday
  python verify_gauges.py --out ../public/data/verification/scores.json --day 2026-10-20

A TN-SMART day file (obs_tnsmart.py reads the same) holds the 24 hours from 09:30 IST the day before to 08:30 IST on its date, one amount
per hour that ends at the label. The gauges are averaged over cells of CELL_DEG (a model's grid square is that size or more, so a single
gauge under a shower is not held against it), and each cell is compared with the models' forecast at its centre.

Scores per model and lead: the 24 hour total (mean absolute error and bias, mm), wet days (a cell with WET_DAY_MM or more: hits, misses,
false alarms), and 6-hour windows with WET_6H_MM or more. The Blend's amount is the rain-weighted mean of the models (blend.py).
"""
from __future__ import annotations
import argparse, gzip, json, os, sys
from datetime import date, datetime, timedelta, timezone

import blend
import obs_tnsmart
import requests

from verify import BLEND, LEADS, MODELS, FetchError, describe, fetch_previous_runs, forecast_key, merge, read_json, report_failure, write_json

CELL_DEG = 0.5         # about 55 cells over Tamil Nadu: each one is a call against the free API limit (10,000 a day)
MIN_HOURS = 20          # a gauge with fewer hourly readings in the day is left out
WET_DAY_MM = 2.5        # IMD's rainy day
WET_6H_MM = 1.0
WINDOW_H = 6


def cell_of(lat: float, lon: float) -> tuple[float, float]:
    return (round((lat // CELL_DEG) * CELL_DEG + CELL_DEG / 2, 3), round((lon // CELL_DEG) * CELL_DEG + CELL_DEG / 2, 3))


def window_start_utc(day: date) -> int:
    """The end of the first hour of the day file (09:30 IST the day before, i.e. 04:00 UTC), in unix seconds."""
    prev = day - timedelta(days=1)
    return int(datetime(prev.year, prev.month, prev.day, 4, tzinfo=timezone.utc).timestamp())


def cells(stations: list[dict]) -> dict[tuple[float, float], list[float | None]]:
    """The mean hourly rain (24 values, hour-ending order of the file) of the gauges in each cell; an hour none of them read is None."""
    sums: dict[tuple[float, float], list[list[float]]] = {}
    for st in stations:
        if st.get("lat") is None or st.get("lon") is None:
            continue
        hours = list(st["hourly_mm"].values())
        if len(hours) != 24 or sum(v is not None for v in hours) < MIN_HOURS:
            continue
        c = cell_of(float(st["lat"]), float(st["lon"]))
        acc = sums.setdefault(c, [[] for _ in range(24)])
        for i, v in enumerate(hours):
            if v is not None and v >= 0:
                acc[i].append(v)
    return {c: [sum(v) / len(v) if v else None for v in acc] for c, acc in sums.items()}


def _count(flags: list[tuple[bool, bool]]) -> dict:
    return {"hits": sum(f and o for f, o in flags), "misses": sum(o and not f for f, o in flags), "false": sum(f and not o for f, o in flags)}


def score(observed: dict[tuple[float, float], list[float | None]], forecast: dict[tuple[float, float], dict[str, dict[int, float | None]]],
          t0: int, corr: dict) -> dict:
    """Scores of each model (and the Blend) at each lead over the cells."""
    times = [t0 + 3600 * i for i in range(24)]
    out: dict = {}
    for model in [*MODELS, BLEND]:
        if model == BLEND and not corr.get("blend", {}).get("rain"):
            continue
        for lead in LEADS:
            totals, days, windows = [], [], []
            for c, obs in observed.items():
                fc = forecast.get(c, {})

                def amount(t: int) -> float | None:
                    if model == BLEND:
                        vals = {m: fc.get(forecast_key("rain", lead, MODELS[m]), {}).get(t) for m in MODELS}
                        return blend.blend_value(corr, "rain", vals)
                    return fc.get(forecast_key("rain", lead, MODELS[model]), {}).get(t)

                f = [amount(t) for t in times]
                if any(v is None for v in f) or any(v is None for v in obs):
                    continue
                ft, ot = sum(f), sum(obs)  # type: ignore[arg-type]
                totals.append((ft, ot))
                days.append((ft >= WET_DAY_MM, ot >= WET_DAY_MM))
                for s in range(0, 24, WINDOW_H):
                    windows.append((sum(f[s:s + WINDOW_H]) >= WET_6H_MM, sum(obs[s:s + WINDOW_H]) >= WET_6H_MM))  # type: ignore[arg-type]
            if not totals:
                continue
            n = len(totals)
            out.setdefault(model, {})[str(lead)] = {
                "total": {"mae": round(sum(abs(f - o) for f, o in totals) / n, 2), "bias": round(sum(f - o for f, o in totals) / n, 2), "n": n},
                "wet_day": _count(days),
                "rain6": _count(windows),
            }
    return out


def day_totals(observed: dict, forecast: dict, t0: int, lead: int = 1) -> dict:
    """What learn_bias.py learns the rain factor from: each cell's observed 24 h total and every model's, a day ahead, where all hours are known."""
    times = [t0 + 3600 * i for i in range(24)]
    cells_out, obs_out, fc_out = [], [], {m: [] for m in MODELS}
    for c, obs in observed.items():
        if any(v is None for v in obs):
            continue
        fcs = {m: [forecast.get(c, {}).get(forecast_key("rain", lead, api), {}).get(t) for t in times] for m, api in MODELS.items()}
        cells_out.append(list(c))
        obs_out.append(round(sum(obs), 2))
        for m, vals in fcs.items():
            fc_out[m].append(round(sum(vals), 2) if all(v is not None for v in vals) else None)
    return {"cells": cells_out, "obs": obs_out, "fc": fc_out}


def save_gauge_day(days_dir: str, day: date, totals: dict, stations: list[dict], keep_days: int = 45) -> None:
    """Keeps the day's totals (compressed) and the gauges' positions (the map's rain factor applies near them only)."""
    os.makedirs(days_dir, exist_ok=True)
    with gzip.open(os.path.join(days_dir, f"{day.isoformat()}.json.gz"), "wt", encoding="utf-8") as f:
        json.dump({"date": day.isoformat(), **totals}, f, separators=(",", ":"))
    positions = sorted({(round(float(s["lat"]), 3), round(float(s["lon"]), 3)) for s in stations if s.get("lat") is not None and s.get("lon") is not None})
    with open(os.path.join(days_dir, "positions.json"), "w", encoding="utf-8") as f:
        json.dump([list(p) for p in positions], f, separators=(",", ":"))
    oldest = (day - timedelta(days=keep_days)).isoformat()
    for name in os.listdir(days_dir):
        if name.endswith(".json.gz") and name[:10] < oldest:
            os.remove(os.path.join(days_dir, name))


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="the rolling scores file (read, then written)")
    ap.add_argument("--day", help="the date of the TN-SMART day file, YYYY-MM-DD (default: yesterday in India)")
    ap.add_argument("--corrections", default=os.path.join(here, "..", "public", "data", "verification", "corrections.json"))
    ap.add_argument("--days-dir", default=os.path.join(here, "data", "verification", "gauges"), help="where each day's cell totals are kept for learning")
    args = ap.parse_args()
    today_ist = (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).date()
    day = date.fromisoformat(args.day) if args.day else today_ist - timedelta(days=1)
    try:
        stations = obs_tnsmart.fetch_day(day, district=None)
    except (requests.RequestException, ValueError) as err:
        raise FetchError(describe(obs_tnsmart.day_url(day), err)) from err
    observed = cells(stations)
    if not observed:
        print(f"no gauge readings for {day}: nothing scored", file=sys.stderr)
        return 1
    points = list(observed)
    places = fetch_previous_runs(points, day - timedelta(days=1), day, ["rain"], MODELS)
    forecast = dict(zip(points, places))
    scores = score(observed, forecast, window_start_utc(day), blend.load(args.corrections))
    save_gauge_day(args.days_dir, day, day_totals(observed, forecast, window_start_utc(day)), stations)
    write_json(args.out, merge(read_json(args.out), day, {}, datetime.now(timezone.utc).date(), gauges=scores))
    wet = sum(1 for o in observed.values() if sum(v or 0 for v in o) >= WET_DAY_MM)
    print(f"{day}: {len(stations)} gauges in {len(observed)} cells, {wet} wet; 24 h rain error a day ahead (mm): " + ", ".join(
        f"{m} {s['1']['total']['mae']:.1f}" for m, s in scores.items() if "1" in s))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except FetchError as err:
        sys.exit(report_failure("verify_gauges", err))
