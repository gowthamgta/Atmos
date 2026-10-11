"""SYNOP reports of the Tamil Nadu weather stations (IMD observatories): temperature, dew point, humidity, wind, pressure, rain.

  python obs_synop.py --out ../public/data/observations/synop --archive ../data/synop-archive --hours 48

Source: Ogimet's public SYNOP listing (https://www.ogimet.com/cgi-bin/getsynop), which republishes the reports the stations send
to the WMO network. One request returns the whole of WMO block 43 (India, Sri Lanka...) for the hours asked; the Tamil Nadu
stations below are kept. Most report every 3 hours (some only twice a day), and a station that sends nothing comes back "NIL".
A personal app: one request per run. The reports are in the standard FM-12 SYNOP code; `decode` reads the groups the app needs.
"""
from __future__ import annotations
import argparse, csv, json, os, sys
from datetime import datetime, timedelta, timezone

import requests

from obs_metar import relative_humidity

URL = "https://www.ogimet.com/cgi-bin/getsynop"
BLOCK = "43"
HOURS = 48
TIMEOUT_S = 120
KT_TO_MS = 0.514444

# WMO station number: (name, latitude, longitude, elevation m). The stations of Tamil Nadu and Puducherry (from the CWOP site list).
STATIONS: dict[str, tuple[str, float, float, int]] = {
    "43374": ("Kovalam", 8.08333, 77.25, 35),
    "43377": ("Kanniyakumari", 8.08333, 77.5, 35),
    "43376": ("Palayankottai", 8.73333, 77.75, 51),
    "43379": ("Tuticorin New Port", 8.8, 78.15, 2),
    "43363": ("Pamban", 9.28333, 79.21667, 11),
    "43358": ("Kovilangulam", 9.55, 78.08333, 103),
    "43361": ("Tondi", 9.73333, 79.03333, 5),
    "43360": ("Madurai", 9.83451, 78.09338, 131),
    "43359": ("Madurai (town)", 9.91667, 78.11667, 133),
    "43327": ("Karaikudi", 10.0667, 78.8, 92),
    "43339": ("Kodaikanal", 10.23333, 77.46667, 2343),
    "43341": ("Valparai", 10.28333, 77.0, 1041),
    "43348": ("Atiramapattinam", 10.33333, 79.38333, 6),
    "43349": ("Vedaranniyam", 10.36667, 79.85, 4),
    "43345": ("Kudimiamalai", 10.4, 78.66667, 123),
    "43344": ("Tiruchirappalli", 10.76536, 78.70972, 88),
    "43343": ("Tiruchirappalli (town)", 10.76667, 78.71667, 88),
    "43347": ("Nagapattinam", 10.76667, 79.85, 9),
    "43330": ("Thanjavur", 10.78333, 79.13333, 68),
    "43346": ("Karaikal", 10.91667, 79.83333, 7),
    "43342": ("K. Paramathy", 10.95, 78.08333, 182),
    "43319": ("Coimbatore", 11.0, 76.96667, 409),
    "43324": ("Ariyalur", 11.1813, 79.0, 76),
    "43338": ("Erode", 11.48333, 77.76667, 173),
    "43325": ("Salem", 11.65, 78.16667, 278),
    "43326": ("Kallakurichi", 11.73333, 78.96667, 127),
    "43329": ("Cuddalore", 11.76667, 79.76667, 5),
    "43328": ("Puducherry", 11.91667, 79.83333, 6),
    "43331": ("Puducherry (observatory)", 11.96667, 79.81667, 38),
    "43301": ("Dharmapuri", 12.13333, 78.03333, 473),
    "43302": ("Tiruppattur", 12.48333, 78.56667, 390),
    "43308": ("Mahabalipuram", 12.617, 80.2, 9),
    "43303": ("Vellore", 12.91667, 79.15, 214),
    "43279": ("Chennai (Meenambakkam)", 12.99441, 80.18052, 16),
    "43278": ("Chennai (Nungambakkam)", 13.06667, 80.2, 6),
    "43277": ("Tiruttani", 13.15, 79.53333, 86),
    "43207": ("Parangipettai", 11.5, 79.76667, 3),
    "43318": ("Coonoor", 11.35, 76.8, 1747),
    "43317": ("Udhagamandalam", 11.4, 76.73333, 2244),
    "43340": ("Yercaud", 11.75, 78.16667, 1463),
}

RAIN_HOURS = {"1": 6, "2": 12, "3": 18, "4": 24, "5": 1, "6": 2, "7": 3, "8": 9, "9": 15}   # the code of the period a rain amount covers


def _tenths(sign: str, digits: str) -> float | None:
    """A temperature group's sign digit (0 positive, 1 negative) and three digits as degrees C; None when not reported."""
    if not digits.isdigit() or sign not in ("0", "1"):
        return None
    v = int(digits) / 10
    return -v if sign == "1" else v


def _rain(rrr: str) -> float | None:
    """A rain amount in mm from its three digits: 990 is a trace, 991 to 999 are 0.1 to 0.9 mm."""
    if not rrr.isdigit():
        return None
    n = int(rrr)
    return 0.0 if n == 990 else (n - 990) / 10 if n > 990 else float(n)


def _pressure(p: str) -> float | None:
    """Pressure in hPa from four digits in tenths, the thousands dropped (0116 is 1011.6, 9805 is 980.5)."""
    if not p.isdigit():
        return None
    v = int(p) / 10
    return round(v + 1000 if v < 500 else v, 1)


def decode(report: str) -> dict | None:
    """The values of one SYNOP report, or None when it carries none ('NIL'). Wind speed is in knots (converted when the report is in m/s)."""
    tokens = report.strip().rstrip("=").split()
    if len(tokens) < 6 or tokens[0] != "AAXX":
        return None
    in_knots = tokens[1][4:5] in ("3", "4")                       # the last digit of the day/hour group: wind units
    body: list[str] = []
    section3: list[str] = []
    current = body
    for tok in tokens[3:]:
        if tok in ("222", "444", "555"):
            current = []                                          # sections this reader does not use
        elif tok == "333":
            current = section3
        else:
            current.append(tok)
    if len(body) < 2:
        return None
    out: dict = {"temp_c": None, "dewp_c": None, "rh_pct": None, "wind_dir": None, "wind_kt": None, "msl_hpa": None, "stn_hpa": None,
                 "rain_mm": None, "rain_hours": None, "rain24_mm": None, "tmax_c": None, "tmin_c": None}
    rain_in_section1 = body[0][:1] in ("0", "1")                  # iR: 0 or 1 = a rain group follows in the first section
    wind, rest = body[1], body[2:]
    if len(wind) == 5 and wind[1:5].isdigit():
        dd, ff = int(wind[1:3]), int(wind[3:5])
        if ff == 99 and rest and rest[0].startswith("00") and rest[0][2:].isdigit():   # a speed of 99 or more has its own group
            ff, rest = int(rest[0][2:]), rest[1:]
        out["wind_dir"] = None if dd == 99 or ff == 0 else dd * 10  # 99 = variable; no direction in a calm
        out["wind_kt"] = round(float(ff) if in_knots else ff / KT_TO_MS, 1)
    for g in rest:
        if len(g) != 5:
            continue
        k = g[0]
        if k == "1":
            out["temp_c"] = _tenths(g[1], g[2:5])
        elif k == "2":
            if g[1] == "9":                                       # a relative humidity instead of a dew point
                out["rh_pct"] = float(g[2:5]) if g[2:5].isdigit() else None
            else:
                out["dewp_c"] = _tenths(g[1], g[2:5])
        elif k == "3":
            out["stn_hpa"] = _pressure(g[1:5])
        elif k == "4" and g[1] in ("0", "9"):                     # 4a3hhh (a standard level's height) is not a sea-level pressure
            out["msl_hpa"] = _pressure(g[1:5])
        elif k == "6" and rain_in_section1:
            out["rain_mm"], out["rain_hours"] = _rain(g[1:4]), RAIN_HOURS.get(g[4])
    for g in section3:
        if len(g) != 5:
            continue
        k = g[0]
        if k == "1":
            out["tmax_c"] = _tenths(g[1], g[2:5])
        elif k == "2":
            out["tmin_c"] = _tenths(g[1], g[2:5])
        elif k == "6" and out["rain_mm"] is None:
            out["rain_mm"], out["rain_hours"] = _rain(g[1:4]), RAIN_HOURS.get(g[4])
        elif k == "7" and g[1:5].isdigit():
            out["rain24_mm"] = round(int(g[1:5]) / 10, 1)
    if out["rh_pct"] is None and out["temp_c"] is not None and out["dewp_c"] is not None:
        out["rh_pct"] = relative_humidity(out["temp_c"], out["dewp_c"])
    if all(out[k] is None for k in ("temp_c", "dewp_c", "wind_kt", "msl_hpa", "rain_mm")):
        return None
    out["wind_ms"] = round(out["wind_kt"] * KT_TO_MS, 2) if out["wind_kt"] is not None else None
    return out


def parse_listing(text: str) -> dict[str, list[dict]]:
    """Ogimet's CSV lines (station, year, month, day, hour, minute, report) as reports per Tamil Nadu station, oldest first."""
    by: dict[str, dict[str, dict]] = {}
    for line in text.splitlines():
        parts = line.split(",", 6)
        if len(parts) < 7 or parts[0] not in STATIONS:
            continue
        try:
            t = datetime(int(parts[1]), int(parts[2]), int(parts[3]), int(parts[4]), int(parts[5]), tzinfo=timezone.utc)
        except ValueError:
            continue
        values = decode(parts[6])
        if values is None:
            continue
        name, lat, lon, _elev = STATIONS[parts[0]]
        stamp = t.strftime("%Y-%m-%dT%H:%M:%SZ")
        by.setdefault(parts[0], {})[stamp] = {"station": parts[0], "name": name, "lat": lat, "lon": lon, "time": stamp, **values,
                                              "raw": parts[6].strip().rstrip("=")}
    return {k: [v[t] for t in sorted(v)] for k, v in by.items()}


def fetch(hours: int = HOURS, timeout: int = TIMEOUT_S, now: datetime | None = None) -> str:
    end = now or datetime.now(timezone.utc)
    res = requests.get(URL, params={"block": BLOCK, "begin": f"{end - timedelta(hours=hours):%Y%m%d%H%M}", "end": f"{end:%Y%m%d%H%M}"}, timeout=timeout)
    res.raise_for_status()
    return res.text


ARCHIVE_FIELDS = ("station", "time", "temp_c", "dewp_c", "rh_pct", "wind_dir", "wind_kt", "msl_hpa", "stn_hpa", "rain_mm", "rain_hours",
                  "rain24_mm", "tmax_c", "tmin_c", "raw")


def archive(archive_dir: str, stations: dict[str, list[dict]]) -> list[str]:
    """Adds the reports to the long-term archive: one CSV per month (data/synop-archive/YYYY-MM.csv), one row per station and time,
    sorted and without duplicates. A month's file is rewritten only when it gains rows."""
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


def save(out_dir: str, stations: dict[str, list[dict]], hours: int = 24, now: datetime | None = None) -> str | None:
    """Writes latest.json with the last `hours` hours of every station (None, and no write, when nothing changed)."""
    cutoff = ((now or datetime.now(timezone.utc)) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
    recent = {k: [{f: r[f] for f in r if f != "raw"} for r in v if r["time"] >= cutoff] for k, v in stations.items()}
    recent = {k: v for k, v in recent.items() if v}
    path = os.path.join(out_dir, "latest.json")
    try:
        with open(path, encoding="utf-8") as f:
            if json.load(f).get("stations") == recent:
                return None
    except (OSError, ValueError):
        pass
    os.makedirs(out_dir, exist_ok=True)
    doc = {"source": "SYNOP reports of the Tamil Nadu weather stations, via Ogimet", "hours": hours,
           "fetched": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "stations": recent}
    tmp = path + ".part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)
    return path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="folder for latest.json (the last day, read by the app)")
    ap.add_argument("--archive", help="folder of the monthly archive CSVs (data/synop-archive)")
    ap.add_argument("--hours", type=int, default=HOURS, help="how far back to fetch (default 48)")
    args = ap.parse_args()
    try:
        stations = parse_listing(fetch(args.hours))
    except (requests.RequestException, ValueError) as e:
        print(f"SYNOP not fetched ({e}); the saved files stay in place", file=sys.stderr)
        return 1
    if not stations:
        print("SYNOP: no Tamil Nadu reports in the listing; the saved files stay in place", file=sys.stderr)
        return 1
    if args.archive:
        archive(args.archive, stations)
    path = save(args.out, stations)
    print({k: len(v) for k, v in stations.items()}, "->", path or "unchanged")
    return 0


if __name__ == "__main__":
    sys.exit(main())
