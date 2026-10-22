"""The IMD radar against the Tamil Nadu rain gauges, and the radar nowcast against the pictures that followed it.

  python verify_radar.py --samples ../bot/samples/radar-samples.json            # yesterday's rain day and yesterday's nowcasts

The nowcast bot keeps, every ten minutes, the radar over each 0.5 degree gauge cell (bot/samples.mjs): `zp`, the mean of Z^(1/1.6) over the
cell, from which the mean rain rate for any a of Z = a R^1.6 is zp / a^(1/1.6); the strongest dBZ; the share of the cell at 25 dBZ or more;
and the same for the nowcast's pictures 30 and 60 minutes ahead.

1. Radar rain: for the rain day of the gauges (09:30 IST to 08:30 IST, verify_gauges.py), each cell's radar total for a = 1 (the sum of
   zp x the minutes until the next look, at most 30), kept per day with the gauges' totals (data/verification/radar/<date>.json.gz).
2. Calibration (--learn): for each radar, the a that makes the radar's rain over its cells (within its 250 km) add up to the gauges', over
   the last weeks; checked on held-back days against Marshall-Palmer's a = 200 and kept only when it lowers the error there. Written to
   public/data/verification/radar.json, which the app's rain rate reads.
3. The nowcast: of the cells wet 30 (60) minutes after a look (a quarter of it at 25 dBZ or more), those the nowcast had wet (hits), not
   (misses), and the cells it had wet that stayed dry (false alarms); and the same for a picture that does not move (the look itself), the
   baseline any nowcast has to beat. Added to the day's entry of the scores file.
"""
from __future__ import annotations
import argparse, gzip, json, math, os, sys
from datetime import date, datetime, timedelta, timezone

from verify import merge, read_json, write_json
from verify_gauges import window_start_utc

RADARS = {"chennai": (13.0839, 80.2901), "karaikal": (10.9129, 79.8418)}
RADAR_RANGE_KM = 250.0
ZR_B = 1.6
MP_A = 200.0                       # Marshall-Palmer
MAX_GAP_MIN = 30                   # a look counts for the minutes until the next one, at most this
MIN_COVERAGE_H = 18                # a rain day with fewer hours of radar is not used
WET_SHARE = 0.25                   # a cell "has rain" with this share of it at 25 dBZ or more
LEARN_DAYS = 28
MIN_DAYS = 7
MIN_GAUGE_MM = 50.0                # a radar's cells must have had this much gauge rain in all, or nothing is fitted
MIN_GAIN = 0.05
A_RANGE = (50.0, 1000.0)


def haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371.0 * math.asin(min(1.0, math.sqrt(a)))


def nearest_radar(lat: float, lon: float) -> str | None:
    """The radar a cell belongs to: the nearest one within its range (None beyond both)."""
    d = {name: haversine_km(lat, lon, *pos) for name, pos in RADARS.items()}
    name = min(d, key=d.get)
    return name if d[name] <= RADAR_RANGE_KM else None


def radar_totals(store: dict, start_s: int, end_s: int) -> tuple[list[float | None], float]:
    """Each cell's radar rain for a = 1 between two times (unix seconds), and the hours the looks cover."""
    recs = [r for r in store.get("records", []) if start_s * 1000 <= r["t"] < end_s * 1000]
    n = len(store.get("points", []))
    totals: list[float | None] = [0.0] * n
    covered_h = 0.0
    for k, r in enumerate(recs):
        nxt = recs[k + 1]["t"] if k + 1 < len(recs) else end_s * 1000
        dt_h = min((nxt - r["t"]) / 60000, MAX_GAP_MIN) / 60
        covered_h += dt_h
        for i, cell in enumerate(r["live"]):
            if totals[i] is None:
                continue
            if cell is None:
                totals[i] = None             # beyond the radar in this look: the cell's day is not complete
            else:
                totals[i] += cell[0] * dt_h  # zp x hours
    return totals, covered_h


def rain_day_record(store: dict, gauge_day: dict, day: date) -> dict | None:
    """One rain day's radar totals (a = 1) beside the gauges' totals, cell by cell, or None with too little radar."""
    t0 = window_start_utc(day) - 3600                 # the rain day's first hour starts an hour before its first hour-ending time
    totals, covered = radar_totals(store, t0, t0 + 24 * 3600)
    if covered < MIN_COVERAGE_H:
        return None
    index = {tuple(p): i for i, p in enumerate(store["points"])}
    cells, radar, obs = [], [], []
    for c, o in zip(gauge_day["cells"], gauge_day["obs"]):
        i = index.get((round(c[0], 3), round(c[1], 3)))
        if i is None or totals[i] is None or o is None:
            continue
        cells.append(c)
        radar.append(round(totals[i], 3))
        obs.append(o)
    return {"date": day.isoformat(), "covered_h": round(covered, 2), "cells": cells, "radar_a1": radar, "obs": obs}


def total_for(radar_a1: float, a: float) -> float:
    return radar_a1 / a ** (1 / ZR_B)


def fit_a(pairs: list[tuple[float, float]]) -> float | None:
    """The a that makes the radar's total equal the gauges' over `pairs` of (radar total for a = 1, gauge total)."""
    s_radar = sum(r for r, _ in pairs)
    s_obs = sum(o for _, o in pairs)
    if s_obs < MIN_GAUGE_MM or s_radar <= 0:
        return None
    lo, hi = A_RANGE
    return min(hi, max(lo, (s_radar / s_obs) ** ZR_B))


def pairs_for(days: list[dict], radar: str) -> list[tuple[float, float]]:
    out = []
    for d in days:
        for c, r, o in zip(d["cells"], d["radar_a1"], d["obs"]):
            if nearest_radar(c[0], c[1]) == radar:
                out.append((r, o))
    return out


def mae(pairs, a):
    return sum(abs(total_for(r, a) - o) for r, o in pairs) / len(pairs) if pairs else None


def learn(days: list[dict]) -> dict:
    """Each radar's a, checked on the last days held back (a third of them, at most 7)."""
    out = {}
    k = min(7, max(2, len(days) // 3))
    for radar in RADARS:
        entry: dict = {"a": MP_A, "b": ZR_B, "accepted": False, "days": len(days)}
        if len(days) < MIN_DAYS:
            entry["reason"] = f"only {len(days)} rain days with the radar (needs {MIN_DAYS})"
            out[radar] = entry
            continue
        learn_pairs, test_pairs = pairs_for(days[:-k], radar), pairs_for(days[-k:], radar)
        a_learned = fit_a(learn_pairs)
        if a_learned is None or not test_pairs:
            entry["reason"] = "too little rain at the gauges to fit"
            out[radar] = entry
            continue
        before, after = mae(test_pairs, MP_A), mae(test_pairs, a_learned)
        final = fit_a(pairs_for(days, radar)) or a_learned
        ok = after < before * (1 - MIN_GAIN)
        entry.update({"a_fitted": round(final, 1), "mae_marshall_palmer": round(before, 2), "mae_fitted": round(after, 2),
                      "n_test": len(test_pairs), "accepted": ok})
        if ok:
            entry["a"] = round(final, 1)
        else:
            entry["reason"] = "the fitted a did not lower the error on the held-back days"
        out[radar] = entry
    return out


def _count(flags):
    return {"hits": sum(f and o for f, o in flags), "misses": sum(o and not f for f, o in flags), "false": sum(f and not o for f, o in flags)}


def score_nowcast(store: dict, start_s: int, end_s: int) -> dict:
    """The nowcast 30 and 60 minutes ahead, and a picture that does not move, against the looks that followed, over a period."""
    recs = store.get("records", [])
    by_time = sorted(recs, key=lambda r: r["t"])
    out = {}
    for lead, key in ((30, "n30"), (60, "n60")):
        nowcast, still = [], []
        for r in by_time:
            if not start_s * 1000 <= r["t"] < end_s * 1000:
                continue
            target = r["t"] + lead * 60000
            later = min(by_time, key=lambda x: abs(x["t"] - target))
            if abs(later["t"] - target) > 7 * 60000:
                continue
            for guess, now, then in zip(r[key], r["live"], later["live"]):
                if then is None or now is None:
                    continue
                observed = then[2] >= WET_SHARE
                still.append((now[2] >= WET_SHARE, observed))
                if guess is not None:
                    nowcast.append((guess[2] >= WET_SHARE, observed))
        if nowcast:
            out[str(lead)] = {"nowcast": _count(nowcast), "still": _count(still)}
    return out


def save_day(days_dir: str, record: dict, keep_days: int = 45) -> None:
    os.makedirs(days_dir, exist_ok=True)
    with gzip.open(os.path.join(days_dir, f"{record['date']}.json.gz"), "wt", encoding="utf-8") as f:
        json.dump(record, f, separators=(",", ":"))
    oldest = (date.fromisoformat(record["date"]) - timedelta(days=keep_days)).isoformat()
    for name in os.listdir(days_dir):
        if name.endswith(".json.gz") and name[:10] < oldest:
            os.remove(os.path.join(days_dir, name))


def load_days(days_dir: str) -> list[dict]:
    names = sorted(n for n in os.listdir(days_dir) if n.endswith(".json.gz")) if os.path.isdir(days_dir) else []
    out = []
    for n in names[-LEARN_DAYS:]:
        with gzip.open(os.path.join(days_dir, n), "rt", encoding="utf-8") as f:
            out.append(json.load(f))
    return out


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--samples", required=True, help="the nowcast bot's store of radar samples")
    ap.add_argument("--scores", default=os.path.join(here, "..", "public", "data", "verification", "scores.json"))
    ap.add_argument("--gauge-days-dir", default=os.path.join(here, "data", "verification", "gauges"))
    ap.add_argument("--days-dir", default=os.path.join(here, "data", "verification", "radar"))
    ap.add_argument("--out", default=os.path.join(here, "..", "public", "data", "verification", "radar.json"))
    args = ap.parse_args()
    store = read_json(args.samples)
    if not store or not store.get("records"):
        print("no radar samples kept yet (the nowcast bot keeps them): nothing to do", file=sys.stderr)
        return 0
    now = datetime.now(timezone.utc)
    today_ist = (now + timedelta(hours=5, minutes=30)).date()
    rain_day = today_ist - timedelta(days=1)

    gauge_path = os.path.join(args.gauge_days_dir, f"{rain_day.isoformat()}.json.gz")
    if os.path.exists(gauge_path):
        with gzip.open(gauge_path, "rt", encoding="utf-8") as f:
            record = rain_day_record(store, json.load(f), rain_day)
        if record:
            save_day(args.days_dir, record)
            print(f"radar rain day {rain_day}: {len(record['cells'])} cells, {record['covered_h']} h of radar")
        else:
            print(f"radar rain day {rain_day}: too few hours of radar kept", file=sys.stderr)
    calibration = learn(load_days(args.days_dir))

    yesterday = now.date() - timedelta(days=1)
    start = int(datetime(yesterday.year, yesterday.month, yesterday.day, tzinfo=timezone.utc).timestamp())
    nowcast = score_nowcast(store, start, start + 86400)
    if nowcast:
        doc = merge(read_json(args.scores), yesterday, {}, now.date())
        for d in doc["days"]:
            if d["date"] == yesterday.isoformat():
                d["nowcast"] = nowcast
        write_json(args.scores, doc)
    write_json(args.out, {"about": "Z = a R^b of each IMD radar, fitted to the Tamil Nadu gauges (pipeline/verify_radar.py)",
                          "updated": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "zr": calibration})
    print(f"Z-R: {json.dumps(calibration)}")
    print(f"nowcast {yesterday}: {json.dumps(nowcast)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
