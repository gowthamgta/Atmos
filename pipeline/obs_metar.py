"""Hourly airport weather (METAR) for the airports near Kallakurichi: temperature, humidity, wind, visibility, pressure.

  python obs_metar.py --out ../public/data/observations/metar        # the last 24 hours, rewritten each run

Source: aviationweather.gov METAR API (public, no key). Airports: Tiruchirappalli (VOTR, about 80 km from Kallakurichi),
Salem (VOSM) and Puducherry (VOPC). Each record is one observation as the airport reported it.
Humidity is worked out from the temperature and the dew point (Magnus formula); the wind is also given in m/s.
"""
from __future__ import annotations
import argparse, json, math, os, sys
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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="folder for latest.json")
    args = ap.parse_args()
    try:
        stations = parse_all(fetch())
    except (requests.RequestException, ValueError) as e:
        print(f"METAR not fetched ({e}); the saved file stays in place", file=sys.stderr)
        return 1
    path = save(args.out, stations)
    print({k: len(v) for k, v in stations.items()}, "->", path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
