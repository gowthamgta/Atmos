"""Hourly airport weather (METAR) for the airports near Kallakurichi: temperature, humidity, wind, visibility, pressure.

  python obs_metar.py --out ../public/data/observations/metar        # the last 24 hours, rewritten each run

Source: aviationweather.gov METAR API (public, no key). Airports: Tiruchirappalli (VOTR, about 80 km from Kallakurichi),
Salem (VOSM) and Puducherry (VOPC). Each record is one observation as the airport reported it.
Humidity is worked out from the temperature and the dew point (Magnus formula); the wind is also given in m/s.
"""
from __future__ import annotations
import argparse, csv, json, math, os, sys
from datetime import datetime, timezone

import requests

API = "https://aviationweather.gov/api/data/metar"
AIRPORTS = ("VOMM", "VOCB", "VOMD", "VOTK", "VOTR", "VOSM", "VOPC")   # the airports of Tamil Nadu with hourly reports
HOURS = 24
TIMEOUT_S = 60
KT_TO_MS = 0.514444


def relative_humidity(temp_c: float, dewp_c: float) -> float:
    """Relative humidity (%) from air and dew-point temperature (Magnus formula, 0-100)."""
    a, b = 17.625, 243.04
    rh = 100 * math.exp(a * dewp_c / (b + dewp_c) - a * temp_c / (b + temp_c))
    return round(min(100.0, max(0.0, rh)), 1)


def _number(v) -> float | None:
    """A reported value as a number; text such as '10+' (visibility) is read as its number, anything else as missing."""
    if v is None:
        return None
    try:
        return float(str(v).rstrip("+"))
    except ValueError:
        return None


def parse_record(r: dict) -> dict | None:
    """One METAR record as the app keeps it, or None when it has no time or no air temperature."""
    if r.get("obsTime") is None or r.get("temp") is None:
        return None
    temp = _number(r["temp"])
    dewp = _number(r.get("dewp"))
    wind = _number(r.get("wspd"))
    return {
        "station": r.get("icaoId"),
        "name": r.get("name"),
        "lat": r.get("lat"),
        "lon": r.get("lon"),
        "time": datetime.fromtimestamp(r["obsTime"], timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "temp_c": temp,
        "dewp_c": dewp,
        "rh_pct": relative_humidity(temp, dewp) if dewp is not None else None,
        "wind_dir": r.get("wdir"),
        "wind_kt": wind,
        "wind_ms": round(wind * KT_TO_MS, 2) if wind is not None else None,
        "gust_kt": _number(r.get("wgst")),
        "visibility_km": _number(r.get("visib")),
        "pressure_hpa": _number(r.get("altim")),
        "weather": r.get("wxString"),
        "raw": r.get("rawOb"),
    }


def parse_all(records: list[dict]) -> dict[str, list[dict]]:
    """Records grouped by airport, oldest first, without duplicates."""
    by = {}
    for r in records:
        p = parse_record(r)
        if p is None:
            continue
        by.setdefault(p["station"], {})[p["time"]] = p
    return {k: [v[t] for t in sorted(v)] for k, v in by.items()}


def fetch(hours: int = HOURS, timeout: int = TIMEOUT_S) -> list[dict]:
    res = requests.get(API, params={"ids": ",".join(AIRPORTS), "format": "json", "hours": hours}, timeout=timeout)
    res.raise_for_status()
    return res.json()


def save(out_dir: str, stations: dict[str, list[dict]]) -> str:
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "latest.json")
    try:
        with open(path, encoding="utf-8") as f:
            saved = json.load(f)
        if saved.get("stations") == stations and saved.get("hours") == HOURS:
            return path          # no new report since the last run: the file stays as it is (its fetch time alone is no change)
    except (OSError, ValueError):
        pass
    doc = {
        "source": "aviationweather.gov METAR (airport observations)",
        "hours": HOURS,
        "fetched": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "stations": stations,
    }
    tmp = path + ".part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)
    return path


ARCHIVE_FIELDS = ("station", "time", "temp_c", "dewp_c", "rh_pct", "wind_dir", "wind_kt", "gust_kt", "visibility_km", "pressure_hpa", "weather", "raw")


def archive(archive_dir: str, stations: dict[str, list[dict]]) -> list[str]:
    """Adds the reports to the long-term archive: one CSV per month (data/metar-archive/YYYY-MM.csv), one row per airport and
    time, kept sorted and without duplicates. The app's latest.json only holds a day; this is the history that lets a
    temperature correction be tested later. A month's file is rewritten only when it gains rows."""
    os.makedirs(archive_dir, exist_ok=True)
    by_month: dict[str, dict[tuple, dict]] = {}
    for rows in stations.values():
        for r in rows:
            by_month.setdefault(r["time"][:7], {})[(r["station"], r["time"])] = r
    changed = []
    for month, new in sorted(by_month.items()):
        path = os.path.join(archive_dir, f"{month}.csv")
        have: dict[tuple, dict] = {}
        try:
            with open(path, newline="", encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    have[(row["station"], row["time"])] = row
        except OSError:
            pass
        merged = dict(have)
        for key, r in new.items():
            if key not in merged:
                merged[key] = {k: ("" if r.get(k) is None else r[k]) for k in ARCHIVE_FIELDS}
        if len(merged) == len(have):
            continue
        tmp = path + ".part"
        with open(tmp, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=ARCHIVE_FIELDS, lineterminator="\n")
            w.writeheader()
            for key in sorted(merged, key=lambda k: (k[1], k[0])):
                w.writerow(merged[key])
        os.replace(tmp, path)
        changed.append(path)
    return changed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="folder for latest.json")
    ap.add_argument("--archive", help="folder of the monthly archive CSVs (data/metar-archive)")
    ap.add_argument("--hours", type=int, default=HOURS, help="how far back to fetch for the archive (the latest.json always holds the last day)")
    args = ap.parse_args()
    try:
        fetched = parse_all(fetch(max(args.hours, HOURS) if args.archive else HOURS))
        if args.archive:
            archive(args.archive, fetched)
        cutoff = datetime.now(timezone.utc).timestamp() - HOURS * 3600
        stations = {k: [r for r in v if datetime.strptime(r["time"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp() >= cutoff] for k, v in fetched.items()}
    except (requests.RequestException, ValueError) as e:
        print(f"METAR not fetched ({e}); the saved file stays in place", file=sys.stderr)
        return 1
    path = save(args.out, stations)
    print({k: len(v) for k, v in stations.items()}, "->", path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
