"""How right each forecast model was: yesterday's weather at the South Indian airports against what each model forecast for it 1, 2 and
3 days ahead. One day is added to a rolling file each run; the app reads the last weeks of it to rank the models.

  python verify.py --out ../public/data/verification/scores.json              # scores yesterday (UTC)
  python verify.py --out ../public/data/verification/scores.json --day 2026-10-20

What happened: the airports' hourly reports (METAR, aviationweather.gov, read by obs_metar.parse_record); only the reports on the hour,
which the models' hourly values are valid at. What was forecast: Open-Meteo's previous-runs API, which keeps, for every hour, the value of
the run made 1, 2, ... days before (`<variable>_previous_dayN`). Both are free and need no key.

Models: the five on the map, and five more that Open-Meteo keeps the previous runs of (scored so the Blend can use the good ones).
The Blend (see blend.py) is scored too, with the corrections and weights learned from the days before (corrections file, --corrections).

Scores per model, lead and variable (over all airports and hours of the day that have both):
  temperature, dew point (C), humidity (%) and wind (m/s): mean absolute error and bias (forecast minus observed); temp_c, dewp_c, rh_c:
  the same after the model's correction;
  rain (hours with at least RAIN_MM forecast) and rain_cal (from the model's own threshold): of the hours an airport reported rain or
  drizzle, those the model had rain in (hits) or not (misses), and the dry hours it had rain in (false); rain6: the same over 6-hour windows.
The reports give whole degrees and knots, so an error under about 0.3 C or 0.3 m/s means nothing.

Each day's reports and the forecasts made a day ahead are also kept, compressed (--days-dir), for learn_bias.py.
"""
from __future__ import annotations
import argparse, gzip, json, os, re, sys, time
from datetime import date, datetime, timedelta, timezone

import requests

import blend
from obs_metar import KT_TO_MS, parse_record

METAR_API = "https://aviationweather.gov/api/data/metar"
FORECAST_API = "https://previous-runs-api.open-meteo.com/v1/forecast"
TIMEOUT_S = 120

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

# Our model ids and Open-Meteo's: the five of the map and the point forecast (src/app/core/forecast/forecast-models.ts), then the others
MAP_MODELS: dict[str, str] = {
    "ecmwf_ifs": "ecmwf_ifs",
    "ukmo": "ukmo_global_deterministic_10km",
    "gfs": "gfs_global",
    "aigfs": "ncep_aigfs025",
    "aifs": "ecmwf_aifs025_single",
    "icon": "icon_global",
}
EXTRA_MODELS: dict[str, str] = {
    "gem": "gem_global",
    "arpege": "meteofrance_arpege_world",
    "jma": "jma_gsm",
    "cma": "cma_grapes_global",
}
MODELS: dict[str, str] = {**MAP_MODELS, **EXTRA_MODELS}
BLEND = "blend"
LEADS = (1, 2, 3)                       # days ahead
VARIABLES = {"temp": "temperature_2m", "dewp": "dew_point_2m", "rh": "relative_humidity_2m", "wind": "wind_speed_10m", "rain": "precipitation"}
ERROR_VARS = ("temp", "dewp", "rh", "wind")
RAIN_MM = 0.2                           # an hour with at least this much forecast counts as rain (before each model's own threshold)
WINDOW_H = 6                            # rain over windows of this many hours
MODELS_PER_REQUEST = 4                  # the forecast API answers for this many models at once (the answer stays a few MB)
KEEP_DAYS = 90                          # days kept in the scores file
_RAIN_WX = re.compile(r"(?<![A-Z])(?:[-+]|VC)?(?:TS|SH)?(?:RA|DZ)")


def get_json(url: str, params: dict, tries: int = 3):
    """The JSON answer of a GET, tried again after a pause when the service fails or the answer arrives cut short."""
    for attempt in range(1, tries + 1):
        try:
            res = requests.get(url, params=params, timeout=TIMEOUT_S)
            res.raise_for_status()
            return res.json() if res.content.strip() else []
        except (requests.RequestException, ValueError) as err:
            if attempt == tries:
                raise FetchError(describe(url, err)) from err
            # "too many requests": the free limit counts calls a minute, so wait the minute out
            busy = isinstance(err, requests.HTTPError) and err.response is not None and err.response.status_code == 429
            time.sleep(65 if busy else 10 * attempt)


class FetchError(RuntimeError):
    """A service could not be read after the retries; the message says which and what it answered."""


def describe(url: str, err: Exception) -> str:
    """Which service failed and how: the status and the start of what it answered (Open-Meteo says why it refuses), or the network error."""
    host = url.split("/")[2]
    res = getattr(err, "response", None)
    if res is not None:
        return f"{host} answered {res.status_code}: {res.text[:200].strip()}"
    return f"{host}: {type(err).__name__}: {str(err)[:200]}"


def report_failure(script: str, err: Exception) -> int:
    """Prints the failure as a GitHub Actions error annotation (shown on the run's page and in the API, unlike the log) and returns 1."""
    print(f"::error title={script}::{err}")
    print(f"{script}: {err}", file=sys.stderr)
    return 1


def reports_rain(weather: str | None) -> bool:
    """True when a METAR's present weather has rain or drizzle (RA, DZ, SHRA, TSRA, -RA, +RA...), not thunder alone or recent rain."""
    if not weather:
        return False
    return any(_RAIN_WX.match(tok) for tok in weather.split() if not tok.startswith("RE"))


def observations(records: list[dict], day: date) -> dict[str, dict[int, dict]]:
    """The reports on the hour during `day` (UTC), by airport and hour (unix seconds): temperature, dew point, humidity, wind (m/s), rain."""
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
            "rh": p["rh_pct"],
            "wind": p["wind_ms"],
            "rain": reports_rain(p["weather"]),
        }
    return out


def forecast_key(var: str, lead: int, model_api: str) -> str:
    return f"{VARIABLES[var]}_previous_day{lead}_{model_api}"


class Forecasts:
    """The forecasts at the airports (`raw[airport][key][hour]`, keys from forecast_key), each model's corrected values, and the Blend."""

    def __init__(self, raw: dict[str, dict[str, dict[int, float | None]]], corr: dict):
        self.raw = raw
        self.corr = corr

    def value(self, model: str, var: str, lead: int, airport: str, t: int, corrected: bool = False) -> float | None:
        if model == BLEND:
            return self.blend(var, lead, airport, t)
        v = self.raw.get(airport, {}).get(forecast_key(var, lead, MODELS[model]), {}).get(t)
        if not corrected or v is None:
            return v
        lat, lon = AIRPORTS[airport]
        hour = datetime.fromtimestamp(t, timezone.utc).hour
        if var == "dewp":
            temp = self.value(model, "temp", lead, airport, t, True)
            rh = self.value(model, "rh", lead, airport, t, True)
            return blend.dew_point(temp, rh) if temp is not None and rh is not None else v
        return blend.corrected(self.corr, model, var, v, lat, lon, hour)

    def blend(self, var: str, lead: int, airport: str, t: int) -> float | None:
        """The Blend's value: rain as its chance of rain (0-1), the rest as the weighted mean of the corrected models."""
        if var == "rain":
            return blend.rain_chance(self.corr, {m: self.value(m, "rain", lead, airport, t) for m in MODELS})
        return blend.blend_value(self.corr, "temp", {m: self.value(m, var, lead, airport, t, True) for m in MODELS})

    def is_rain(self, model: str, lead: int, airport: str, t: int, calibrated: bool) -> bool | None:
        v = self.value(model, "rain", lead, airport, t)
        if v is None:
            return None
        if model == BLEND:
            return v >= blend.rain_cutoff(self.corr)
        return v >= (blend.rain_threshold(self.corr, model, RAIN_MM) if calibrated else RAIN_MM)

    def window_rain(self, model: str, lead: int, airport: str, hours: list[int]) -> bool | None:
        """Rain in a window of hours: the model's total from its threshold, or the Blend's chance in any hour of it."""
        if model == BLEND:
            flags = [self.is_rain(BLEND, lead, airport, t, True) for t in hours]
            return None if any(f is None for f in flags) else any(flags)
        vals = [self.value(model, "rain", lead, airport, t) for t in hours]
        if any(v is None for v in vals):
            return None
        return sum(vals) >= blend.rain_threshold(self.corr, model, RAIN_MM)  # type: ignore[arg-type]


def _errors(pairs: list[tuple[float, float]]) -> dict | None:
    if not pairs:
        return None
    n = len(pairs)
    return {"mae": round(sum(abs(f - o) for f, o in pairs) / n, 2), "bias": round(sum(f - o for f, o in pairs) / n, 2), "n": n}


def _count(flags: list[tuple[bool, bool]]) -> dict:
    """Rain hits, misses and false alarms from (forecast, observed) pairs."""
    return {"hits": sum(f and o for f, o in flags), "misses": sum(o and not f for f, o in flags), "false": sum(f and not o for f, o in flags)}


def score_day(obs: dict[str, dict[int, dict]], fc: Forecasts, models: list[str] | None = None) -> dict:
    """Scores of each model (and the Blend, when the corrections file has weights) at each lead."""
    models = models if models is not None else [*MODELS, BLEND]
    out: dict = {}
    for model in models:
        if model == BLEND and not fc.corr.get("blend"):
            continue
        for lead in LEADS:
            entry: dict = {}
            for var in ERROR_VARS:
                pairs, pairs_c = [], []
                for airport, hours in obs.items():
                    for t, o in hours.items():
                        if o[var] is None:
                            continue
                        f = fc.value(model, var, lead, airport, t)
                        if f is not None:
                            pairs.append((f, o[var]))
                        if var != "wind" and model != BLEND:
                            fcc = fc.value(model, var, lead, airport, t, True)
                            if fcc is not None:
                                pairs_c.append((fcc, o[var]))
                if (e := _errors(pairs)) is not None:
                    entry[var] = e
                if fc.corr.get("models", {}).get(model) and (e := _errors(pairs_c)) is not None:
                    entry[f"{var}_c"] = e
            raw, cal, win = [], [], []
            for airport, hours in obs.items():
                for t, o in hours.items():
                    if model != BLEND and (r := fc.is_rain(model, lead, airport, t, False)) is not None:
                        raw.append((r, o["rain"]))
                    if (r := fc.is_rain(model, lead, airport, t, True)) is not None:
                        cal.append((r, o["rain"]))
                times = sorted(hours)
                for start in range(0, 24, WINDOW_H):
                    ts = [t for t in times if (t // 3600) % 24 // WINDOW_H == start // WINDOW_H]
                    if len(ts) < WINDOW_H:
                        continue                       # a window with a report missing is left out
                    f = fc.window_rain(model, lead, airport, ts)
                    if f is not None:
                        win.append((f, any(hours[t]["rain"] for t in ts)))
            if raw:
                entry["rain"] = _count(raw)
            if cal:
                entry["rain_cal"] = _count(cal)
            if win:
                entry["rain6"] = _count(win)
            if any(k in entry for k in ERROR_VARS):
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
        out.extend(get_json(METAR_API, params))
    return out


def fetch_previous_runs(points: list[tuple[float, float]], start: date, end: date, variables: list[str], models: dict[str, str]) -> list[dict[str, dict[int, float | None]]]:
    """For each point, `{key: {hour: value}}` of what the models forecast 1 to 3 days ahead for the hours from `start` to `end` (UTC days)."""
    hourly = [f"{VARIABLES[v]}_previous_day{lead}" for v in variables for lead in LEADS]
    out: list[dict[str, dict[int, float | None]]] = [{} for _ in points]
    apis = list(models.values())
    for i in range(0, len(apis), MODELS_PER_REQUEST):
        params = {
            "latitude": ",".join(f"{p[0]:.3f}" for p in points),
            "longitude": ",".join(f"{p[1]:.3f}" for p in points),
            "hourly": ",".join(hourly),
            "models": ",".join(apis[i:i + MODELS_PER_REQUEST]),
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "timeformat": "unixtime",
            "wind_speed_unit": "ms",
        }
        body = get_json(FORECAST_API, params)
        places = body if isinstance(body, list) else [body]
        if len(places) != len(points):
            raise SystemExit(f"expected {len(points)} places from the forecast API, got {len(places)}")
        for k, place in enumerate(places):
            h = place["hourly"]
            if len(apis[i:i + MODELS_PER_REQUEST]) == 1:
                # with a single model the API may leave its name off the keys
                h = {(key if key == "time" or key.endswith(apis[i]) else f"{key}_{apis[i]}"): v for key, v in h.items()}
            out[k].update({key: dict(zip(h["time"], vals)) for key, vals in h.items() if key != "time"})
    return out


def fetch_forecasts(day: date) -> dict[str, dict[str, dict[int, float | None]]]:
    """What each model forecast 1 to 3 days ahead for every hour of `day`, at every airport."""
    places = fetch_previous_runs(list(AIRPORTS.values()), day, day, list(VARIABLES), MODELS)
    return dict(zip(AIRPORTS, places))


def day_record(obs: dict[str, dict[int, dict]], raw: dict[str, dict[str, dict[int, float | None]]], day: date) -> dict:
    """What learn_bias.py learns from: the reports, and each model's forecasts of temperature, humidity and rain made a day ahead."""
    start = int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp())
    hours = [start + 3600 * h for h in range(24)]
    fc = {}
    for model, api in MODELS.items():
        for var in ("temp", "rh", "rain"):
            key = forecast_key(var, 1, api)
            fc.setdefault(model, {})[var] = {a: [raw.get(a, {}).get(key, {}).get(t) for t in hours] for a in AIRPORTS}
    o = {a: {var: [obs.get(a, {}).get(t, {}).get(var) for t in hours] for var in ("temp", "rh", "rain")} for a in AIRPORTS}
    return {"date": day.isoformat(), "obs": o, "fc": fc}


def save_day_record(days_dir: str, record: dict, keep_days: int, today: date) -> None:
    os.makedirs(days_dir, exist_ok=True)
    with gzip.open(os.path.join(days_dir, f"{record['date']}.json.gz"), "wt", encoding="utf-8") as f:
        json.dump(record, f, separators=(",", ":"))
    oldest = (today - timedelta(days=keep_days)).isoformat()
    for name in os.listdir(days_dir):
        if name.endswith(".json.gz") and name[:10] < oldest:
            os.remove(os.path.join(days_dir, name))


def merge(existing: dict | None, day: date, scores: dict, today: date, gauges: dict | None = None) -> dict:
    """The file with `day`'s scores in (replacing an earlier run of the same day, keeping its gauge scores unless new ones are given),
    days older than KEEP_DAYS dropped, newest last."""
    days = {d["date"]: d for d in (existing or {}).get("days", [])}
    entry = dict(days.get(day.isoformat(), {"date": day.isoformat()}))
    if scores:
        entry["models"] = scores
    if gauges is not None:
        entry["gauges"] = gauges
    entry.setdefault("models", {})
    days[day.isoformat()] = entry
    oldest = (today - timedelta(days=KEEP_DAYS)).isoformat()
    kept = [days[k] for k in sorted(days) if k >= oldest]
    return {
        "about": "Forecast errors at South Indian airports and Tamil Nadu rain gauges by model and days ahead (pipeline/verify.py, verify_gauges.py)",
        "airports": list(AIRPORTS),
        "leads": list(LEADS),
        "map_models": list(MAP_MODELS),
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "days": kept,
    }


def read_json(path: str) -> dict | None:
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path: str, doc: dict) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="the rolling scores file (read, then written)")
    ap.add_argument("--day", help="the UTC day to score, YYYY-MM-DD (default: yesterday)")
    ap.add_argument("--corrections", default=os.path.join(here, "..", "public", "data", "verification", "corrections.json"),
                    help="the corrections and blend weights learned from the days before (learn_bias.py)")
    ap.add_argument("--days-dir", default=os.path.join(here, "data", "verification", "days"), help="where each day's data is kept for learning")
    args = ap.parse_args()
    today = datetime.now(timezone.utc).date()
    day = date.fromisoformat(args.day) if args.day else today - timedelta(days=1)
    obs = observations(fetch_metars(day), day)
    if not obs:
        print(f"no airport reports for {day}: nothing scored", file=sys.stderr)
        return 1
    raw = fetch_forecasts(day)
    corr = blend.load(args.corrections)
    scores = score_day(obs, Forecasts(raw, corr))
    save_day_record(args.days_dir, day_record(obs, raw, day), 45, today)
    write_json(args.out, merge(read_json(args.out), day, scores, today))
    n = sum(len(h) for h in obs.values())
    print(f"{day}: {n} reports at {len(obs)} airports; temperature error a day ahead: " + ", ".join(
        f"{m} {s['1']['temp']['mae']:.2f}" for m, s in scores.items() if "1" in s and "temp" in s["1"]))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except FetchError as err:
        sys.exit(report_failure("verify", err))
