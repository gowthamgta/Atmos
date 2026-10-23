"""Learns the synthetic radar from our own radars (the GREMLIN and IMSRA idea, at our scale): from the pairs the nowcast bot keeps every look
(the satellite's inputs at each 3 km pixel against what Chennai or Karaikal saw there at the same time; src/app/core/satellite/rain-features.ts,
bot/pairs.mjs), it fits a small model the app draws instead of its hand-set rules, once the model beats them on days it was not fitted on.

  python learn_rain.py --pairs ../rain-pairs-data             # -> ../public/data/rain-model.json, data/rain/learn.json

1. The pairs of the last LEARN_DAYS days, each pixel 20 to MAX_RANGE_KM from its radar (closer is ground clutter, farther the beam passes over
   the rain), each weighed by how many pixels of its look it stands for (the dry ones are sampled).
2. Two sets of gradient-boosted trees (depth DEPTH, learned here in numpy, no other dependency): whether a pixel rains (its radar
   reflectivity, the mean Z over the pixel, RAIN_DBZ or more), and how much where it does. Trees learn a separate curve for each kind of cloud
   patch (its size and coldest top, PERSIANN-CCS), the warm-topped showers (IMSRA) and the storm-start signals (Mecikalski and Bedka) from
   the inputs, instead of thresholds set by hand.
3. Checked on held-back days: the days are split into FOLDS groups, each scored by a model fitted on the others, against the hand-set rules'
   picture on the same pixels (the pairs keep it). The rain is drawn where its chance is over the share that gives as much rain as the radar
   saw (learned on the fitting days). The model is approved only with enough storms (MIN_RAIN_DAYS days with rain), a better threat score
   than the rules at RAIN_DBZ, no worse at HEAVY_DBZ, and a frequency bias within BIAS_RANGE.
4. Fitted again on every day and written to the app with whether it is approved; data/rain/learn.json keeps the scores and how far the
   data has come, for the owner.
"""
from __future__ import annotations

import argparse
import glob
import gzip
import json
import math
import os
from datetime import datetime, timezone

import numpy as np

LEARN_DAYS = 60
MIN_RANGE_KM = 20
MAX_RANGE_KM = 200
RAIN_DBZ = 15.0
HEAVY_DBZ = 35.0
MIN_DAYS = 14                 # fewer days of pairs and nothing is fitted
MIN_RAIN_DAYS = 8             # days with at least RAIN_DAY_PIXELS rainy pixels
RAIN_DAY_PIXELS = 300
FOLDS = 4
BIAS_RANGE = (0.6, 1.6)
MAX_ROWS = 250_000            # rows fitted at most (sampled, weights kept)
# the trees
TREES = 120
DEPTH = 4
LEARNING_RATE = 0.1
BINS = 32
L2 = 1.0
MIN_LEAF = 30                 # rows in a leaf at least
DOMAIN_MAX_K = 285.0          # as rain-features.ts DOMAIN_MAX_K
MIN_DBZ, MAX_DBZ = 15.0, 60.0
MISSING = -999.0

HERE = os.path.dirname(os.path.abspath(__file__))


# ── the pairs ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

def load_pairs(folder: str, days: int = LEARN_DAYS) -> dict | None:
    """Every look of the last `days` days with pairs: the inputs (rows x features), the meta columns, the UTC day of each row."""
    files = sorted(glob.glob(os.path.join(folder, "**", "*.json.gz"), recursive=True))
    looks = []
    for f in files:
        try:
            with gzip.open(f, "rt", encoding="utf-8") as fh:
                looks.append(json.load(fh))
        except (OSError, ValueError):
            continue
    if not looks:
        return None
    newest = max(lk["satTimeMs"] for lk in looks)
    looks = [lk for lk in looks if newest - lk["satTimeMs"] <= days * 86_400_000 and lk.get("rows", 0) > 0]
    names = looks[-1]["features"]
    looks = [lk for lk in looks if lk["features"] == names]   # a look from an older version of the inputs is left out
    X = np.concatenate([np.array([lk["cols"][k] for k in names], dtype=np.float64).T for lk in looks])
    meta = {k: np.concatenate([np.asarray(lk["cols"][k], dtype=np.float64) for lk in looks]) for k in looks[-1]["meta"]}
    day = np.concatenate([np.full(lk["rows"], lk["satTimeMs"] // 86_400_000, dtype=np.int64) for lk in looks])
    return {"names": names, "X": X, "meta": meta, "day": day, "looks": len(looks)}


def select(data: dict) -> dict:
    """The rows the radar sees well."""
    r = data["meta"]["rangeKm"]
    ok = (r >= MIN_RANGE_KM) & (r <= MAX_RANGE_KM) & (data["X"][:, data["names"].index("t108")] <= DOMAIN_MAX_K)
    return {**data, "X": data["X"][ok], "meta": {k: v[ok] for k, v in data["meta"].items()}, "day": data["day"][ok]}


# ── gradient-boosted trees ───────────────────────────────────────────────────────────────────────────────────────────────────────────

def bin_edges(X: np.ndarray, bins: int = BINS) -> list[np.ndarray]:
    """For each input, up to bins - 1 thresholds, each halfway between two neighbouring values of the data (never on one), at its quantiles:
    x <= edge k is bin k or lower."""
    out = []
    for f in range(X.shape[1]):
        vals = np.unique(X[:, f])
        if len(vals) < 2:
            out.append(np.zeros(0))
            continue
        mids = (vals[:-1] + vals[1:]) / 2
        if len(mids) >= bins:
            # the midpoint just above each quantile
            q = np.quantile(X[:, f], np.linspace(0, 1, bins + 1)[1:-1])
            mids = np.unique(mids[np.minimum(np.searchsorted(mids, q, side="left"), len(mids) - 1)])
        out.append(mids)
    return out


def binned(X: np.ndarray, edges: list[np.ndarray]) -> np.ndarray:
    return np.stack([np.searchsorted(e, X[:, f], side="left") for f, e in enumerate(edges)], axis=1).astype(np.int16)


def fit_tree(B: np.ndarray, g: np.ndarray, h: np.ndarray, edges: list[np.ndarray], depth: int = DEPTH, gains: np.ndarray | None = None) -> dict:
    """One tree on the binned inputs for gradients g and hessians h (weights already in them), as flat arrays."""
    f_, t_, l_, r_, v_ = [], [], [], [], []

    def node(idx: np.ndarray, d: int) -> int:
        k = len(f_)
        f_.append(-1), t_.append(0.0), l_.append(-1), r_.append(-1), v_.append(0.0)
        G, H = g[idx].sum(), h[idx].sum()
        v_[k] = float(-G / (H + L2))
        if d >= depth or len(idx) < 2 * MIN_LEAF:
            return k
        best = (0.0, -1, -1)
        for f in range(B.shape[1]):
            nb = len(edges[f]) + 1
            if nb < 2:
                continue
            gh = np.bincount(B[idx, f], weights=g[idx], minlength=nb)
            hh = np.bincount(B[idx, f], weights=h[idx], minlength=nb)
            nn = np.cumsum(np.bincount(B[idx, f], minlength=nb))[:-1]
            GL, HL = np.cumsum(gh)[:-1], np.cumsum(hh)[:-1]
            GR, HR = G - GL, H - HL
            ok = (nn >= MIN_LEAF) & (len(idx) - nn >= MIN_LEAF)
            if not ok.any():
                continue
            gain = np.where(ok, GL**2 / (HL + L2) + GR**2 / (HR + L2) - G**2 / (H + L2), -np.inf)
            b = int(np.argmax(gain))
            if gain[b] > best[0]:
                best = (float(gain[b]), f, b)
        if best[1] < 0:
            return k
        _, f, b = best
        if gains is not None:
            gains[f] += best[0]
        go_left = B[idx, f] <= b
        f_[k], t_[k] = f, float(edges[f][b])
        left = node(idx[go_left], d + 1)
        right = node(idx[~go_left], d + 1)
        l_[k], r_[k] = left, right
        return k

    node(np.arange(B.shape[0]), 0)
    return {"f": f_, "t": t_, "l": l_, "r": r_, "v": v_}


def tree_values(tree: dict, X: np.ndarray) -> np.ndarray:
    """A tree's leaf values for raw inputs (as the app walks it: x <= t goes left)."""
    f, t, l, r, v = (np.asarray(tree[k]) for k in ("f", "t", "l", "r", "v"))
    k = np.zeros(len(X), dtype=np.int64)
    for _ in range(64):
        inner = f[k] >= 0
        if not inner.any():
            break
        rows = np.nonzero(inner)[0]
        kk = k[rows]
        k[rows] = np.where(X[rows, f[kk]] <= t[kk], l[kk], r[kk])
    return v[k]


def trees_value(model: dict, X: np.ndarray) -> np.ndarray:
    return model["base"] + model["lr"] * sum((tree_values(tr, X) for tr in model["trees"]), np.zeros(len(X)))


def fit_boosted(X: np.ndarray, y: np.ndarray, w: np.ndarray, kind: str, trees: int = TREES, gains: np.ndarray | None = None) -> dict:
    """Gradient-boosted trees: kind 'logistic' (y 0/1, the log-odds) or 'squared' (y a value)."""
    edges = bin_edges(X)
    B = binned(X, edges)
    if kind == "logistic":
        p0 = float(np.clip(np.average(y, weights=w), 1e-4, 1 - 1e-4))
        base = math.log(p0 / (1 - p0))
    else:
        base = float(np.average(y, weights=w))
    F = np.full(len(y), base)
    out = []
    for _ in range(trees):
        if kind == "logistic":
            p = 1 / (1 + np.exp(-F))
            g, h = (p - y) * w, np.maximum(p * (1 - p), 1e-6) * w
        else:
            g, h = (F - y) * w, w.copy()
        tr = fit_tree(B, g, h, edges, gains=gains)
        F += LEARNING_RATE * tree_values(tr, X)
        out.append(tr)
    return {"base": base, "lr": LEARNING_RATE, "trees": out}


# ── the model and its scores ────────────────────────────────────────────────────────────────────────────────────────────────────────

def threshold_for_bias(prob: np.ndarray, wet: np.ndarray, w: np.ndarray) -> float:
    """The chance above which the model rains on as much (weighted) as the radar did."""
    target = float(np.sum(w[wet]))
    order = np.argsort(-prob)
    cum = np.cumsum(w[order])
    k = int(np.searchsorted(cum, target))
    return float(np.clip(prob[order[min(k, len(order) - 1)]], 0.05, 0.95))


def fit_model(X: np.ndarray, dbz: np.ndarray, w: np.ndarray, names: list[str], trees: int = TREES) -> tuple[dict, dict]:
    wet = dbz >= RAIN_DBZ
    gains = np.zeros(X.shape[1])
    rain = fit_boosted(X, wet.astype(np.float64), w, "logistic", trees, gains)
    amount = fit_boosted(X[wet], dbz[wet], w[wet], "squared", trees, gains) if wet.sum() >= 20 else {"base": RAIN_DBZ + 10, "lr": 0.0, "trees": []}
    prob = 1 / (1 + np.exp(-trees_value(rain, X)))
    # the warmest top the radars saw rain under (the app looks no warmer: a third of the work over India's warm cloud and clear sky)
    t108 = X[:, names.index("t108")]
    max_top = float(min(DOMAIN_MAX_K, math.ceil(np.quantile(t108[wet], 0.995)) + 2)) if wet.sum() >= 20 else DOMAIN_MAX_K
    model = {
        "version": 1,
        "features": list(names),
        "approved": False,
        "maxTopK": max_top,
        "rainProb": round(threshold_for_bias(prob, wet, w), 4),
        "minDbz": MIN_DBZ,
        "maxDbz": MAX_DBZ,
        "rain": rain,
        "dbz": amount,
    }
    importance = {n: round(float(g / gains.sum()), 4) for n, g in sorted(zip(names, gains), key=lambda p: -p[1]) if gains.sum() > 0 and g > 0}
    return model, importance


def predict(model: dict, X: np.ndarray) -> np.ndarray:
    """The model's reflectivity (0: no rain), as rain-features.ts predictDbz."""
    prob = 1 / (1 + np.exp(-trees_value(model["rain"], X)))
    amount = np.clip(trees_value(model["dbz"], X), model["minDbz"], model["maxDbz"])
    inside = X[:, model["features"].index("t108")] <= model["maxTopK"] if "t108" in model["features"] else True
    return np.where((prob >= model["rainProb"]) & inside, amount, 0.0)


def scores(pred: np.ndarray, truth: np.ndarray, w: np.ndarray) -> dict:
    """Threat score at RAIN_DBZ and HEAVY_DBZ (weighted), and the frequency bias at RAIN_DBZ."""
    out = {}
    for name, lim in (("csi", RAIN_DBZ), ("csiHeavy", HEAVY_DBZ)):
        p, o = pred >= lim, truth >= lim
        hits, miss, false = (float(np.sum(w[a])) for a in (p & o, ~p & o, p & ~o))
        out[name] = round(hits / (hits + miss + false), 4) if hits + miss + false > 0 else None
        if lim == RAIN_DBZ:
            out["bias"] = round((hits + false) / (hits + miss), 3) if hits + miss > 0 else None
    return out


def thin(idx: np.ndarray, w: np.ndarray, cap: int, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """At most cap rows, each kept one weighed for those it stands for."""
    if len(idx) <= cap:
        return idx, w[idx]
    keep = np.sort(rng.choice(idx, cap, replace=False))
    return keep, w[keep] * (len(idx) / cap)


def approve(model_s: dict, hand_s: dict) -> tuple[bool, str]:
    if model_s["csi"] is None or hand_s["csi"] is None:
        return False, "no rain on the held-back days"
    if model_s["csi"] <= hand_s["csi"]:
        return False, f"threat score {model_s['csi']} not above the hand-set rules' {hand_s['csi']}"
    if model_s["csiHeavy"] is not None and hand_s["csiHeavy"] is not None and model_s["csiHeavy"] < hand_s["csiHeavy"]:
        return False, f"heavy rain threat score {model_s['csiHeavy']} below the rules' {hand_s['csiHeavy']}"
    if model_s["bias"] is None or not BIAS_RANGE[0] <= model_s["bias"] <= BIAS_RANGE[1]:
        return False, f"frequency bias {model_s['bias']} outside {BIAS_RANGE}"
    return True, "beats the hand-set rules on held-back days"


def learn(data: dict, trees: int = TREES, seed: int = 0) -> dict:
    """The status, scores and (with enough data) the model."""
    data = select(data)
    X, meta, day = data["X"], data["meta"], data["day"]
    truth, w, hand = meta["dbzMeanZ"], meta["weight"], meta["hand"]
    days = np.unique(day)
    rain_days = [int(d) for d in days if np.sum((day == d) & (truth >= RAIN_DBZ)) >= RAIN_DAY_PIXELS]
    status = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "looks": data.get("looks"),
        "rows": int(len(X)),
        "rainyRows": int(np.sum(truth >= RAIN_DBZ)),
        "days": int(len(days)),
        "rainDays": len(rain_days),
        "need": {"days": MIN_DAYS, "rainDays": MIN_RAIN_DAYS},
    }
    if len(days) < MIN_DAYS or len(rain_days) < MIN_RAIN_DAYS:
        return {**status, "ready": False, "approved": False, "reason": f"collecting: {len(days)} of {MIN_DAYS} days, {len(rain_days)} of {MIN_RAIN_DAYS} rain days"}

    rng = np.random.default_rng(seed)
    # held-back days: rain days dealt round the folds in turn (each fold gets storms), the dry days likewise
    order = rain_days + [int(d) for d in days if int(d) not in rain_days]
    fold_of = {d: k % FOLDS for k, d in enumerate(order)}
    fold = np.array([fold_of[int(d)] for d in day])
    pred = np.zeros(len(X))
    for k in range(FOLDS):
        fit_idx, fit_w = thin(np.nonzero(fold != k)[0], w, MAX_ROWS, rng)
        m, _ = fit_model(X[fit_idx], truth[fit_idx], fit_w, data["names"], trees)
        test = fold == k
        pred[test] = predict(m, X[test])
    known = hand > MISSING
    model_s = scores(pred[known], truth[known], w[known])
    hand_s = scores(hand[known], truth[known], w[known])
    ok, why = approve(model_s, hand_s)

    fit_idx, fit_w = thin(np.arange(len(X)), w, MAX_ROWS, rng)
    model, importance = fit_model(X[fit_idx], truth[fit_idx], fit_w, data["names"], trees)
    model["approved"] = ok
    model["fitted"] = status["updated"]
    model["scores"] = {"model": model_s, "rules": hand_s, "heldBackDays": int(len(days))}
    return {**status, "ready": True, "approved": ok, "reason": why, "scores": {"model": model_s, "rules": hand_s}, "importance": importance, "model": model}


def compact(model: dict) -> dict:
    """Rounded for the app (about a third of the size)."""
    def tree(tr):
        return {"f": tr["f"], "t": [round(v, 3) for v in tr["t"]], "l": tr["l"], "r": tr["r"], "v": [round(v, 5) for v in tr["v"]]}
    return {**model, "rain": {**model["rain"], "trees": [tree(t) for t in model["rain"]["trees"]]}, "dbz": {**model["dbz"], "trees": [tree(t) for t in model["dbz"]["trees"]]}}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--pairs", required=True, help="the rain-pairs branch's files")
    ap.add_argument("--out", default=os.path.join(HERE, "..", "public", "data", "rain-model.json"))
    ap.add_argument("--status", default=os.path.join(HERE, "data", "rain", "learn.json"))
    a = ap.parse_args()
    data = load_pairs(a.pairs)
    result = {"ready": False, "approved": False, "reason": "no pairs yet"} if data is None else learn(data)
    model = result.pop("model", None)
    os.makedirs(os.path.dirname(a.status), exist_ok=True)
    with open(a.status, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=1)
    if model is not None:
        with open(a.out, "w", encoding="utf-8") as f:
            json.dump(compact(model), f, separators=(",", ":"))
    print(f"learn_rain: {result.get('reason')} ({result.get('days', 0)} days, {result.get('rainDays', 0)} rain days, {result.get('rows', 0)} pairs)")
    if result.get("scores"):
        print(f"  held back: model {result['scores']['model']}, hand-set rules {result['scores']['rules']}")


if __name__ == "__main__":
    main()
