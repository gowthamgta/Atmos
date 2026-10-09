"""All Tamil Nadu rain gauges, day by day, from the TN-SMART daily files: the history the rain correction is measured on.

  python obs_rain_history.py --out data/rain_history --start 2026-08-01

One file per date (YYYY-MM-DD.json), holding each station's district, position, hourly values (in the file's order) and total.
Dates already saved are not fetched again. The folder is regenerable, so it is not kept in git.
"""
from __future__ import annotations
import argparse, json, os, sys
from datetime import date, datetime, timedelta, timezone

import requests

import obs_tnsmart as T


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--start", default="2026-08-01")
    ap.add_argument("--end", default=None, help="last date (default: the Indian date of today)")
    args = ap.parse_args()
    start = date.fromisoformat(args.start)
    end = date.fromisoformat(args.end) if args.end else (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).date()
    os.makedirs(args.out, exist_ok=True)
    day = start
    while day <= end:
        path = os.path.join(args.out, f"{day:%Y-%m-%d}.json")
        if not os.path.exists(path) or day == end:
            try:
                stations = T.fetch_day(day, district=None)
            except (requests.RequestException, ValueError) as e:
                print(f"{day}: not fetched ({e})", file=sys.stderr)
                day += timedelta(days=1)
                continue
            with open(path + ".part", "w", encoding="utf-8") as f:
                json.dump({"date": f"{day:%Y-%m-%d}", "stations": stations}, f, ensure_ascii=False)
            os.replace(path + ".part", path)
            print(f"{day}: {len(stations)} stations", flush=True)
        day += timedelta(days=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
