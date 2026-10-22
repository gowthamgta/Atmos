"""Learns, from the last weeks of airport data that verify.py keeps, each model's usual error and the AtmosIQ Blend, and checks them on days
held back from the learning. Writes the corrections file the app and verify.py read, and the map's correction table for ECMWF IFS.

  python learn_bias.py                        # data/verification/days -> ../public/data/verification/corrections.json, data/bias/table.json

1. Corrections: for each model, airport and variable (temperature, humidity), the mean error a day ahead at each hour of the day (UTC),
   pooled with the hour before and after, and pulled toward no correction when there are few hours (SHRINK). Learned on all days but the
   last TEST_DAYS and checked on those: a correction is kept only when it lowers the mean absolute error there by MIN_GAIN or more, on at
   least MIN_TEST hours. A kept one is then learned again on every day.
2. Rain thresholds: for each model, the hourly amount at which it forecasts rain at the airports as often as they report it.
3. Blend weights: each model by 1 / (its corrected temperature error)^2, and for rain by its threat score (hits / (hits + misses + false
   alarms)); models much worse than the best are left out (CUTOFF).
5. The map's rain factor for ECMWF IFS (data/bias/rain.json, read by correction.apply_rain): the observed rain over the forecast rain,
   summed over the Tamil Nadu gauge cells of the last weeks (verify_gauges.py), checked on held-back days like the corrections, kept between
   0.5 and 1.5, and applied only when it lowered the error there.
4. A backtest: the same steps learned without the last days (TEST_DAYS, or half while there are few), and the Blend and every model
   scored on them.
"""
from __future__ import annotations
import argparse, gzip, json, os, sys
from datetime import datetime, timezone

import blend
from verify import AIRPORTS, MAP_MODELS, MODELS

LEARN_DAYS = 28
TEST_DAYS = 7
MIN_DAYS = 12                 # fewer days than this and nothing is learned (the file is left as it was)
SHRINK = 6.0                  # hours of "no error" added to every hour's mean
MIN_TEST = 40
MIN_GAIN = 0.05
THRESHOLDS = (0.1, 0.2, 0.3, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0)
MIN_WET_HOURS = 15            # fewer rainy hours than this and a model keeps the plain threshold
CUTOFF = 1.5                  # a model whose temperature error is over this times the best one's is left out of the Blend (rain: under 1/this)


def load_days(days_dir: str) -> list[dict]:
    names = sorted(n for n in os.listdir(days_dir) if n.endswith(".json.gz")) if os.path.isdir(days_dir) else []
    out = []
    for n in names[-LEARN_DAYS:]:
        with gzip.open(os.path.join(days_dir, n), "rt", encoding="utf-8") as f:
            out.append(json.load(f))
    return out


def errors(days: list[dict], model: str, var: str, airport: str) -> list[tuple[int, float]]:
    """(hour of day, forecast minus observed) of every hour that has both."""
    out = []
    for d in days:
        fc = d["fc"].get(model, {}).get(var, {}).get(airport) or []
        ob = d["obs"].get(airport, {}).get(var) or []
        for h, (f, o) in enumerate(zip(fc, ob)):
            if f is not None and o is not None:
                out.append((h, f - o))
    return out


def hourly_correction(errs: list[tuple[int, float]]) -> list[float]:
    """The mean error at each hour of the day, pooled with the hours either side and shrunk toward 0 when there are few."""
    out = []
    for h in range(24):
        near = [e for hh, e in errs if min((hh - h) % 24, (h - hh) % 24) <= 1]
        out.append(round(sum(near) / (len(near) + SHRINK), 2) if near else 0.0)
    return out


def check(learn: list[tuple[int, float]], test: list[tuple[int, float]]) -> dict:
    c = hourly_correction(learn)
    n = len(test)
    before = sum(abs(e) for _, e in test) / n if n else None
    after = sum(abs(e - c[h]) for h, e in test) / n if n else None
    ok = n >= MIN_TEST and before is not None and after is not None and after < before * (1 - MIN_GAIN)
    return {"n_test": n, "mae_before": round(before, 3) if before is not None else None, "mae_after": round(after, 3) if after is not None else None, "accepted": ok}


def rain_pairs(days: list[dict], model: str) -> list[tuple[float, bool]]:
    out = []
    for d in days:
        for a in AIRPORTS:
            fc = d["fc"].get(model, {}).get("rain", {}).get(a) or []
            ob = d["obs"].get(a, {}).get("rain") or []
            out.extend((f, bool(o)) for f, o in zip(fc, ob) if f is not None and o is not None)
    return out


def rain_threshold(pairs: list[tuple[float, bool]]) -> float:
    wet = sum(o for _, o in pairs)
    if wet < MIN_WET_HOURS or not pairs:
        return 0.2
    target = wet / len(pairs)
    return min(THRESHOLDS, key=lambda t: abs(sum(f >= t for f, _ in pairs) / len(pairs) - target))


def test_split(n_days: int) -> int:
    """How many of the last days check the corrections: TEST_DAYS, or a third of the days while there are few."""
    return min(TEST_DAYS, max(2, n_days // 3))


def learn(days: list[dict]) -> dict:
    """The corrections file learned from `days` (the last few of them only check the corrections, see test_split)."""
    k = test_split(len(days))
    learn_part, test_part = days[:-k], days[-k:]
    corr: dict = {"airports": {a: list(p) for a, p in AIRPORTS.items()}, "models": {}}
    for model, api in MODELS.items():
        m: dict = {"api": api, "map": model in MAP_MODELS, "checks": {}}
        for var in blend.CORRECTED:
            kept = {}
            for a in AIRPORTS:
                c = check(errors(learn_part, model, var, a), errors(test_part, model, var, a))
                m["checks"].setdefault(var, {})[a] = c
                if c["accepted"]:
                    kept[a] = hourly_correction(errors(days, model, var, a))
            if kept:
                m[var] = kept
        m["rain_threshold_mm"] = rain_threshold(rain_pairs(days, model))
        corr["models"][model] = m
    corr["blend"] = blend_weights(days, corr)
    corr["blend"]["rain_cutoff"] = blend_rain_cutoff(learn_part or days, corr)
    return corr


CUTOFFS = (0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7)


def blend_rain_cutoff(days: list[dict], corr: dict) -> float:
    """The Blend's chance of rain from which it says it rains: the one at which it says so as often as the airports report rain."""
    chances: list[tuple[float, bool]] = []
    for d in days:
        for a in AIRPORTS:
            ob = d["obs"].get(a, {}).get("rain") or [None] * 24
            for h in range(24):
                ch = blend.rain_chance(corr, {m: (d["fc"].get(m, {}).get("rain", {}).get(a) or [None] * 24)[h] for m in MODELS})
                if ch is not None and ob[h] is not None:
                    chances.append((ch, bool(ob[h])))
    wet = sum(o for _, o in chances)
    if wet < MIN_WET_HOURS:
        return 0.5
    target = wet / len(chances)
    return min(CUTOFFS, key=lambda c: abs(sum(ch >= c for ch, _ in chances) / len(chances) - target))


def corrected_temp_mae(days: list[dict], model: str, corr: dict) -> tuple[float, int] | None:
    total = n = 0
    for d in days:
        for a, (lat, lon) in AIRPORTS.items():
            fc = d["fc"].get(model, {}).get("temp", {}).get(a) or []
            ob = d["obs"].get(a, {}).get("temp") or []
            for h, (f, o) in enumerate(zip(fc, ob)):
                if f is None or o is None:
                    continue
                total += abs(blend.corrected(corr, model, "temp", f, lat, lon, h) - o)
                n += 1
    return (total / n, n) if n else None


def threat(days: list[dict], model: str, corr: dict) -> float | None:
    thr = blend.rain_threshold(corr, model)
    pairs = rain_pairs(days, model)
    if sum(o for _, o in pairs) < MIN_WET_HOURS:
        return None
    hits = sum(f >= thr and o for f, o in pairs)
    miss = sum(f < thr and o for f, o in pairs)
    false = sum(f >= thr and not o for f, o in pairs)
    return hits / (hits + miss + false) if hits + miss + false else None


def blend_weights(days: list[dict], corr: dict) -> dict:
    temp = {m: r[0] for m in MODELS if (r := corrected_temp_mae(days, m, corr)) and r[1] >= 100}
    rain = {m: t for m in MODELS if (t := threat(days, m, corr)) is not None and t > 0}
    out: dict = {}
    if temp:
        best = min(temp.values())
        out["temp"] = {m: round(1 / mae ** 2, 4) for m, mae in temp.items() if mae <= best * CUTOFF}
    if rain:
        best = max(rain.values())
        # by the square of the threat score: rain skill differs far more between models than temperature skill does
        out["rain"] = {m: round(t * t, 4) for m, t in rain.items() if t >= best / CUTOFF}
    return out


def backtest(days: list[dict]) -> dict | None:
    """Everything learned without the last days, then every model (as it is and corrected) and the Blend scored on them."""
    if len(days) < MIN_DAYS:
        return None
    k = min(TEST_DAYS, len(days) // 2)
    train, test = days[:-k], days[-k:]
    corr = learn(train)
    out = {"test_days": [test[0]["date"], test[-1]["date"]], "temp_mae": {}, "rain_threat": {}}
    for m in MODELS:
        raw = corrected_temp_mae(test, m, {})
        cor = corrected_temp_mae(test, m, corr)
        if raw:
            out["temp_mae"][m] = round(raw[0], 2)
        if cor:
            out["temp_mae"][f"{m}+corrected"] = round(cor[0], 2)
        if (t := threat(test, m, corr)) is not None:
            out["rain_threat"][m] = round(t, 3)
    total = n = hits = miss = false = 0
    for d in test:
        for a, (lat, lon) in AIRPORTS.items():
            ob_t = d["obs"].get(a, {}).get("temp") or [None] * 24
            ob_r = d["obs"].get(a, {}).get("rain") or [None] * 24
            for h in range(24):
                vals = {m: blend.corrected(corr, m, "temp", (d["fc"].get(m, {}).get("temp", {}).get(a) or [None] * 24)[h], lat, lon, h) for m in MODELS}
                b = blend.blend_value(corr, "temp", vals)
                if b is not None and ob_t[h] is not None:
                    total += abs(b - ob_t[h])
                    n += 1
                amounts = {m: (d["fc"].get(m, {}).get("rain", {}).get(a) or [None] * 24)[h] for m in MODELS}
                ch = blend.rain_chance(corr, amounts)
                if ch is not None and ob_r[h] is not None:
                    f, o = ch >= blend.rain_cutoff(corr), bool(ob_r[h])
                    hits += f and o
                    miss += o and not f
                    false += f and not o
    if n:
        out["temp_mae"]["blend"] = round(total / n, 2)
    if hits + miss + false:
        out["rain_threat"]["blend"] = round(hits / (hits + miss + false), 3)
    return out


def map_table(corr: dict, days: list[dict]) -> dict:
    """The map's correction table for ECMWF IFS (correction.py's format: temp_c and rh_pct by airport and hour, with the check)."""
    m = corr["models"].get("ecmwf_ifs", {})
    airports = {}
    for a, (lat, lon) in AIRPORTS.items():
        variables = {}
        for var, key in (("temp", "temp_c"), ("rh", "rh_pct")):
            if a in m.get(var, {}):
                c = m["checks"][var][a]
                variables[key] = {"n_test": c["n_test"], "mae_before": c["mae_before"], "mae_after": c["mae_after"],
                                  "correction_by_hour_utc": {str(h): v for h, v in enumerate(m[var][a])}}
        if variables:
            airports[a] = {"lat": lat, "lon": lon, "variables": variables}
    return {"model": "ecmwf_ifs", "period_utc": [days[0]["date"], days[-1]["date"]], "source": "learn_bias.py (airport reports, a day ahead)", "airports": airports}


RAIN_FACTOR_MODEL = "ecmwf_ifs"
RAIN_FACTOR_RANGE = (0.5, 1.5)
MIN_WET_CELLS = 30            # cell-days with rain in the held-back part, or the factor is not trusted


def load_gauge_days(days_dir: str) -> list[dict]:
    names = sorted(n for n in os.listdir(days_dir) if n.endswith(".json.gz")) if os.path.isdir(days_dir) else []
    out = []
    for n in names[-LEARN_DAYS:]:
        with gzip.open(os.path.join(days_dir, n), "rt", encoding="utf-8") as f:
            out.append(json.load(f))
    return out


def rain_pairs_gauges(days: list[dict], model: str) -> list[tuple[float, float]]:
    """(forecast, observed) 24 h totals of every cell-day the model has."""
    out = []
    for d in days:
        for f, o in zip(d["fc"].get(model) or [], d["obs"]):
            if f is not None and o is not None:
                out.append((f, o))
    return out


def rain_factor(pairs: list[tuple[float, float]]) -> float | None:
    fc = sum(f for f, _ in pairs)
    if fc <= 0:
        return None
    lo, hi = RAIN_FACTOR_RANGE
    return min(hi, max(lo, sum(o for _, o in pairs) / fc))


def learn_rain_factor(days: list[dict], model: str = RAIN_FACTOR_MODEL) -> dict:
    """The model's rain factor from the gauges, checked on the last days held back (see the module notes)."""
    out: dict = {"model": model, "days": len(days), "accepted": False}
    if len(days) < MIN_DAYS:
        out["reason"] = f"only {len(days)} gauge days (needs {MIN_DAYS})"
        return out
    k = test_split(len(days))
    learn_part, test_part = rain_pairs_gauges(days[:-k], model), rain_pairs_gauges(days[-k:], model)
    f = rain_factor(learn_part)
    if f is None or not test_part:
        out["reason"] = "no forecast rain to scale"
        return out
    wet = sum(o >= 2.5 for _, o in test_part)
    before = sum(abs(fc - o) for fc, o in test_part) / len(test_part)
    after = sum(abs(fc * f - o) for fc, o in test_part) / len(test_part)
    final = rain_factor(rain_pairs_gauges(days, model))
    out.update({"factor": round(final, 3) if final else None, "factor_learned_before_test": round(f, 3), "test_days": k, "n_test": len(test_part),
                "wet_cells_test": wet, "mae_before": round(before, 3), "mae_after": round(after, 3)})
    out["accepted"] = final is not None and wet >= MIN_WET_CELLS and after < before * (1 - MIN_GAIN)
    if not out["accepted"]:
        out["reason"] = "too few wet cells held back" if wet < MIN_WET_CELLS else "it did not lower the error on the held-back days"
    return out


def write_rain_table(path: str, result: dict, positions_path: str, days: list[dict]) -> None:
    """data/bias/rain.json as correction.load_rain reads it (the factor applies only when accepted, and only near the gauges)."""
    try:
        with open(positions_path, encoding="utf-8") as f:
            gauges = json.load(f)
    except (OSError, ValueError):
        gauges = []
    doc = {"model": result["model"], "period": [days[0]["date"], days[-1]["date"]] if days else None,
           "source": "learn_bias.py (Tamil Nadu gauges, TN-SMART, a day ahead)", "rain": result, "gauges": gauges}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days-dir", default=os.path.join(here, "data", "verification", "days"))
    ap.add_argument("--out", default=os.path.join(here, "..", "public", "data", "verification", "corrections.json"))
    ap.add_argument("--map-table", default=os.path.join(here, "data", "bias", "table.json"))
    ap.add_argument("--gauge-days-dir", default=os.path.join(here, "data", "verification", "gauges"))
    ap.add_argument("--rain-table", default=os.path.join(here, "data", "bias", "rain.json"))
    args = ap.parse_args()
    gauge_days = load_gauge_days(args.gauge_days_dir)
    rain = learn_rain_factor(gauge_days)
    write_rain_table(args.rain_table, rain, os.path.join(args.gauge_days_dir, "positions.json"), gauge_days)
    print(f"rain factor ({rain['model']}): {json.dumps(rain)}")
    days = load_days(args.days_dir)
    if len(days) < MIN_DAYS:
        print(f"only {len(days)} days kept: nothing learned (needs {MIN_DAYS})", file=sys.stderr)
        return 0
    corr = learn(days)
    corr["about"] = "Model corrections at the airports, rain thresholds and Blend weights (pipeline/learn_bias.py)"
    corr["updated"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    corr["learned_from"] = [days[0]["date"], days[-1]["date"]]
    corr["backtest"] = backtest(days)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(corr, f, separators=(",", ":"))
    with open(args.map_table, "w", encoding="utf-8") as f:
        json.dump(map_table(corr, days), f, indent=1)
    kept = {m: sum(len(v.get(var, {})) for var in blend.CORRECTED) for m, v in corr["models"].items()}
    print(f"learned from {len(days)} days; corrections kept (airport x variable): {kept}")
    print(f"blend weights: {corr['blend']}")
    print(f"backtest: {json.dumps(corr['backtest'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
