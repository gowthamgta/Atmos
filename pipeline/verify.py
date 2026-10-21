"""How right each forecast model was: yesterday's weather at the South Indian airports against what each model forecast for it 1, 2 and
3 days ahead. One day is added to a rolling file each run; the app reads the last weeks of it to rank the models.

  python verify.py --out ../public/data/verification/scores.json              # scores yesterday (UTC)
  python verify.py --out ../public/data/verification/scores.json --day 2026-10-20

What happened: the airports' hourly reports (METAR, aviationweather.gov, read by obs_metar.parse_record); only the reports on the hour,
which the models' hourly values are valid at. What was forecast: Open-Meteo's previous-runs API, which keeps, for every hour, the value of
the run made 1, 2, ... days before (`<variable>_previous_dayN`), for the same five models as the app's point forecast. Both are free and
need no key.

Scores per model, lead and variable (over all airports and hours of the day that have both):
  temperature, dew point (C) and wind (m/s): mean absolute error and bias (forecast minus observed);
  rain: of the hours an airport reported rain or drizzle, the share the model had at least 0.2 mm in (caught), and of the hours the model
  had rain, the share the airport reported none (false alarms).
The reports give whole degrees and knots, so an error under about 0.3 C or 0.3 m/s means nothing.
"""
from __future__ import annotations
import argparse, json, os, re, sys
from datetime import date, datetime, timedelta, timezone

import requests

from obs_metar import KT_TO_MS, parse_record

METAR_API = "https://aviationweather.gov/api/data/metar"
FORECAST_API = "https://previous-runs-api.open-meteo.com/v1/forecast"
TIMEOUT_S = 90

# Airports of South India with hourly reports: id, latitude, longitude (as aviationweather.gov gives them)
AIRPORTS: dict[str, tuple[float, float]] = {
    "VOMM": (12.994, 80.180),   # Chennai
    "VOMD": (9.835, 78.093),    # Madurai
    "VOTR": (10.765, 78.710),   # Tiruchirappalli
    "VOCB": (11.030, 77.043),   # Coimbatore
    "VOTK": (8.724, 78.026),    # Thoothukudi
    "VOSM": (11.783, 78.065),   # Salem
    "VOPC": (11.968, 79.812),   # Puducherry
    "VOBL": (13.198, 77.706),   # Bengaluru
    "VOTV": (8.482, 76.920),    # Thiruvananthapuram
    "VOCI": (10.152, 76.402),   # Kochi
    "VOCL": (11.137, 75.955),   # Kozhikode
    "VOML": (12.961, 74.890),   # Mangaluru
    "VOTP": (13.633, 79.543),   # Tirupati
}

# The app's model ids and Open-Meteo's (the same five as the point forecast, see src/app/core/meteogram)
MODELS: dict[str, str] = {
    "ecmwf_ifs": "ecmwf_ifs",
    "ukmo": "ukmo_global_deterministic_10km",
    "gfs": "gfs_global",
    "aigfs": "ncep_aigfs025",
    "aifs": "ecmwf_aifs025_single",
}
LEADS = (1, 2, 3)                       # days ahead
VARIABLES = {"temp": "temperature_2m", "dewp": "dew_point_2m", "wind": "wind_speed_10m", "rain": "precipitation"}
RAIN_MM = 0.2                           # an hour with at least this much forecast counts as rain
KEEP_DAYS = 90                          # days kept in the file
_RAIN_WX = re.compile(r"(?<![A-Z])(?:[-+]|VC)?(?:TS|SH)?(?:RA|DZ)")


def reports_rain(weather: str | None) -> bool:
    """True when a METAR's present weather has rain or drizzle (RA, DZ, SHRA, TSRA, -RA, +RA...), not thunder alone or recent rain."""
    if not weather:
        return False
    return any(_RAIN_WX.match(tok) for tok in weather.split() if not tok.startswith("RE"))


def observations(records: list[dict], day: date) -> dict[str, dict[int, dict]]:
    """The reports on the hour during `day` (UTC), by airport and hour (unix seconds): temperature, dew point, wind (m/s) and rain (bool)."""
    start = int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp())
    out: dict[str, dict[int, dict]] = {}
    for r in records:
        p = parse_record(r)
        if p is None or p["station"] not in AIRPORTS:
            continue
        t = int(datetime.strptime(p["time"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())
        if t % 3600 != 0 or not start <= t < start + 86400:
            continue
        out.setdefault(p["station"], {})[t] = {
            "temp": p["temp_c"],
            "dewp": p["dewp_c"],
            "wind": p["wind_ms"],
            "rain": reports_rain(p["weather"]),
        }
    return out


def forecast_key(var: str, lead: int, model_api: str) -> str:
    return f"{VARIABLES[var]}_previous_day{lead}_{model_api}"


def score_day(obs: dict[str, dict[int, dict]], forecasts: dict[str, dict[str, dict[int, float | None]]]) -> dict:
    """Scores of each model at each lead: `forecasts[airport][key][hour]` holds the forecast values by the keys of forecast_key."""
    out: dict = {}
    for model, api in MODELS.items():
        for lead in LEADS:
            acc = {v: {"abs": 0.0, "sum": 0.0, "n": 0} for v in ("temp", "dewp", "wind")}
            rain = {"hits": 0, "misses": 0, "false": 0}
            for airport, hours in obs.items():
                fc = forecasts.get(airport, {})
                for t, o in hours.items():
                    for v in ("temp", "dewp", "wind"):
                        f = fc.get(forecast_key(v, lead, api), {}).get(t)
                        if f is None or o[v] is None:
                            continue
                        acc[v]["abs"] += abs(f - o[v])
                        acc[v]["sum"] += f - o[v]
                        acc[v]["n"] += 1
                    fr = fc.get(forecast_key("rain", lead, api), {}).get(t)
                    if fr is None:
                        continue
                    wet = fr >= RAIN_MM
                    if o["rain"] and wet:
                        rain["hits"] += 1
                    elif o["rain"]:
                        rain["misses"] += 1
                    elif wet:
                        rain["false"] += 1
            entry = {
                v: {"mae": round(a["abs"] / a["n"], 2), "bias": round(a["sum"] / a["n"], 2), "n": a["n"]}
                for v, a in acc.items() if a["n"] > 0
            }
            entry["rain"] = rain
            if any(a["n"] for a in acc.values()):
                out.setdefault(model, {})[str(lead)] = entry
    return out


def fetch_metars(day: date) -> list[dict]:
    """Every report of `day` (UTC) at every airport. The API answers at most 400 reports a request, so each airport is asked on its own
    (48 reports a day: on the hour and at half past), for the 24 hours that end with the day."""
    end = datetime(day.year, day.month, day.day, 23, 59, 59, tzinfo=timezone.utc)
    if datetime.now(timezone.utc) - end > timedelta(days=14):
        raise SystemExit(f"{day} is too long ago: the METAR API keeps about two weeks")
    out: list[dict] = []
    for airport in AIRPORTS:
        params = {"ids": airport, "format": "json", "hours": 24, "date": end.strftime("%Y-%m-%dT%H:%M:%SZ")}
        res = requests.get(METAR_API, params=params, timeout=TIMEOUT_S)
        res.raise_for_status()
        out.extend(res.json() if res.content.strip() else [])
    return out


def fetch_forecasts(day: date) -> dict[str, dict[str, dict[int, float | None]]]:
    """What each model forecast 1 to 3 days ahead for every hour of `day`, at every airport (one request for all of them)."""
    hourly = [f"{VARIABLES[v]}_previous_day{lead}" for v in VARIABLES for lead in LEADS]
    params = {
        "latitude": ",".join(str(AIRPORTS[a][0]) for a in AIRPORTS),
        "longitude": ",".join(str(AIRPORTS[a][1]) for a in AIRPORTS),
        "hourly": ",".join(hourly),
        "models": ",".join(MODELS.values()),
        "start_date": day.isoformat(),
        "end_date": day.isoformat(),
        "timeformat": "unixtime",
        "wind_speed_unit": "ms",
    }
    res = requests.get(FORECAST_API, params=params, timeout=TIMEOUT_S)
    res.raise_for_status()
    body = res.json()
    places = body if isinstance(body, list) else [body]
    if len(places) != len(AIRPORTS):
        raise SystemExit(f"expected {len(AIRPORTS)} places from the forecast API, got {len(places)}")
    out: dict[str, dict[str, dict[int, float | None]]] = {}
    for airport, place in zip(AIRPORTS, places):
        h = place["hourly"]
        times = h["time"]
        out[airport] = {k: dict(zip(times, vals)) for k, vals in h.items() if k != "time"}
    return out


def merge(existing: dict | None, day: date, scores: dict, today: date) -> dict:
    """The file with `day`'s scores in (replacing an earlier run of the same day), days older than KEEP_DAYS dropped, newest last."""
    days = {d["date"]: d for d in (existing or {}).get("days", [])}
    days[day.isoformat()] = {"date": day.isoformat(), "models": scores}
    oldest = (today - timedelta(days=KEEP_DAYS)).isoformat()
    kept = [days[k] for k in sorted(days) if k >= oldest]
    return {
        "about": "Forecast errors at South Indian airports by model and days ahead (pipeline/verify.py)",
        "airports": list(AIRPORTS),
        "leads": list(LEADS),
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "days": kept,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="the rolling scores file (read, then written)")
    ap.add_argument("--day", help="the UTC day to score, YYYY-MM-DD (default: yesterday)")
    args = ap.parse_args()
    today = datetime.now(timezone.utc).date()
    day = date.fromisoformat(args.day) if args.day else today - timedelta(days=1)
    obs = observations(fetch_metars(day), day)
    if not obs:
        print(f"no airport reports for {day}: nothing scored", file=sys.stderr)
        return 1
    scores = score_day(obs, fetch_forecasts(day))
    existing = None
    if os.path.exists(args.out):
        with open(args.out, encoding="utf-8") as f:
            existing = json.load(f)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(merge(existing, day, scores, today), f, separators=(",", ":"))
    n = sum(len(h) for h in obs.values())
    print(f"{day}: {n} reports at {len(obs)} airports; temperature error a day ahead: " + ", ".join(
        f"{m} {s['1']['temp']['mae']:.2f}" for m, s in scores.items() if "1" in s and "temp" in s["1"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
