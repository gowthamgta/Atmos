"""Hourly rainfall of the Kallakurichi district's gauges, from TN-SMART (RIMES): the daily file the public page reads.

  python obs_tnsmart.py --out data/observations/rain            # today and yesterday (skips days already saved)

Source: https://beta-tnsmart.rimes.int/index.php/RTDAS/Hourly_data_TNDRRA_c/public (station-wise hourly rainfall).
Each day is one JSON file, `hourly_rainfall_YYYY-MM-DD.json`, with one row per station: district, station, latitude,
longitude, the hourly amounts (mm, labelled 09:30 AM ... 07:30 AM) and the total. The site has no stated terms on public
use; this is for a personal app, fetched at most once a day per date (a day already saved is not fetched again).
"""
from __future__ import annotations
import argparse, json, os, sys
from datetime import date, datetime, timedelta, timezone

import requests

BASE = "https://beta-tnsmart.rimes.int/Rainfall_Python_IDW/Hourly_json"
DISTRICT = "Kallakurichi"
TIMEOUT_S = 60


def day_url(day: date) -> str:
    return f"{BASE}/hourly_rainfall_{day:%Y-%m-%d}.json"


def is_hour_key(key: str) -> bool:
    """The hourly columns are labelled like '09:30 AM' or '12:30 AM'."""
    return len(key) == 8 and key[2] == ":" and key[5] == " " and key[6:] in ("AM", "PM") and key[:2].isdigit()


def parse_day(rows: list[dict], district: str | None = DISTRICT) -> list[dict]:
    """The stations of one district (or of every district when district is None), with their hourly rainfall in mm."""
    stations = []
    for r in rows:
        if district is not None and r.get("district_name") != district:
            continue
        stations.append({
            "district": r.get("district_name"),
            "station": r["station_name"],
            "lat": r.get("latitude"),
            "lon": r.get("longitude"),
            # an empty hour is missing (null), not zero rain
            "hourly_mm": {k: (float(v) if v is not None else None) for k, v in r.items() if is_hour_key(k)},
            "total_mm": float(r["total"]) if r.get("total") is not None else None,
        })
    return stations


def fetch_day(day: date, timeout: int = TIMEOUT_S, district: str | None = DISTRICT) -> list[dict]:
    res = requests.get(day_url(day), timeout=timeout)
    res.raise_for_status()
    return parse_day(res.json(), district)


def save_day(out_dir: str, day: date, stations: list[dict]) -> str:
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{day:%Y-%m-%d}.json")
    try:
        with open(path, encoding="utf-8") as f:
            if json.load(f).get("stations") == stations:
                return path      # nothing new for this day: the file stays as it is (its fetch time alone is no change)
    except (OSError, ValueError):
        pass
    doc = {
        "source": "TN-SMART (RIMES), station-wise hourly rainfall",
        "district": DISTRICT,
        "date": f"{day:%Y-%m-%d}",
        "fetched": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "stations": stations,
    }
    tmp = path + ".part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)
    return path


def summarise(stations: list[dict], day: date) -> dict:
    """The compact file the app reads for its click card: every Tamil Nadu gauge with the day's total (mm) and its wettest hour.
    A day's file is the 24 hours from 09:30 the morning before to 08:30 that morning, so this is yesterday's rain, not a live reading."""
    rows = []
    for st in stations:
        if st.get("lat") is None or st.get("lon") is None:
            continue
        hours = {k: v for k, v in st["hourly_mm"].items() if v is not None}
        peak = max(hours, key=hours.get) if hours else None
        rows.append({
            "n": st["station"], "d": st["district"], "la": round(st["lat"], 4), "lo": round(st["lon"], 4),
            "t": st["total_mm"], "pk": hours[peak] if peak else None, "pt": peak if peak and hours[peak] > 0 else None,
            "h": len(hours),                       # hours with a reading (24 = complete)
        })
    return {"source": "TN-SMART (RIMES), station-wise hourly rainfall", "date": f"{day:%Y-%m-%d}",
            "window": "09:30 IST the day before to 08:30 IST on this date", "stations": rows}


def save_summary(out_dir: str, summary: dict) -> str | None:
    """Writes rain/latest.json; None (and no write) when the stations are the same as the saved ones."""
    path = os.path.join(out_dir, "latest.json")
    try:
        with open(path, encoding="utf-8") as f:
            old = json.load(f)
        if old.get("date") == summary["date"] and old.get("stations") == summary["stations"]:
            return None
    except (OSError, ValueError):
        pass
    os.makedirs(out_dir, exist_ok=True)
    doc = {**summary, "fetched": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    tmp = path + ".part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)
    return path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="folder for the daily files")
    ap.add_argument("--days", type=int, default=2, help="how many days back, today included (default 2)")
    args = ap.parse_args()
    today = (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).date()   # the Indian date
    for back in range(args.days):
        day = today - timedelta(days=back)
        if os.path.exists(os.path.join(args.out, f"{day:%Y-%m-%d}.json")) and back > 0:
            continue                       # a past day, already saved: nothing new to fetch
        try:
            everywhere = fetch_day(day, district=None)
            stations = [st for st in everywhere if st["district"] == DISTRICT]
        except (requests.RequestException, ValueError) as e:
            print(f"{day}: not fetched ({e}); the saved days stay in place", file=sys.stderr)
            continue
        path = save_day(args.out, day, stations)
        print(f"{day}: {len(stations)} {DISTRICT} stations -> {path}")
        if back == 0:
            print("all of Tamil Nadu:", save_summary(args.out, summarise(everywhere, day)) or "unchanged")
    return 0


if __name__ == "__main__":
    sys.exit(main())
