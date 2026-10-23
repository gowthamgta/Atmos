import gzip
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import learn_rain  # noqa: E402

NAMES = ["t108", "t62", "cool15", "ring"]
META = ["lat", "lon", "rangeKm", "dbzMax", "dbzMeanZ", "hand", "weight"]
FIXTURE = os.path.join(os.path.dirname(__file__), "..", "..", "src", "app", "core", "satellite", "rain-model.fixture.json")
DAY_MS = 86_400_000


def look(day, k, rng, rows=300, rainy_day=True):
    """One look: rain (30-48 dBZ) where the top is 225 K or colder and cooled, or stands out of its ring by 8 K; the hand-set rules rain
    only under tops of 212 K or colder (they miss half of it)."""
    t108 = rng.uniform(195, 285, rows)
    cool = rng.normal(-2, 6, rows)
    ring = rng.uniform(0, 15, rows)
    wet = rainy_day & (((t108 <= 225) & (cool < -3)) | ((t108 <= 240) & (ring > 8)))
    dbz = np.where(wet, 30 + (240 - np.minimum(t108, 240)) * 0.4 + rng.normal(0, 2, rows), rng.uniform(0, 10, rows))
    hand = np.where(t108 <= 212, 35.0, 0.0)
    cols = {"t108": t108, "t62": t108 + rng.normal(0, 1, rows), "cool15": cool, "ring": ring,
            "lat": np.full(rows, 11.0), "lon": np.full(rows, 79.0), "rangeKm": rng.uniform(30, 190, rows),
            "dbzMax": dbz + 3, "dbzMeanZ": dbz, "hand": hand, "weight": np.ones(rows)}
    return {"satTimeMs": int(day * DAY_MS + k * 900_000), "radarTimeMs": int(day * DAY_MS + k * 900_000), "features": NAMES, "meta": META,
            "rows": rows, "cols": {c: [round(float(v), 1) for v in a] for c, a in cols.items()}}


def write_pairs(folder, days, rain_every=1, looks=3, seed=1):
    rng = np.random.default_rng(seed)
    for d in range(days):
        for k in range(looks):
            lk = look(20_000 + d, k, rng, rainy_day=d % rain_every == 0)
            path = os.path.join(folder, f"{d:03d}", f"{k:02d}.json.gz")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with gzip.open(path, "wt", encoding="utf-8") as f:
                json.dump(lk, f)


def test_keeps_collecting_until_there_are_enough_storms(tmp_path):
    write_pairs(str(tmp_path), days=5)
    result = learn_rain.learn(learn_rain.load_pairs(str(tmp_path)), trees=5)
    assert not result["ready"] and not result["approved"]
    assert "collecting" in result["reason"] and result["days"] == 5


def test_learns_what_the_rules_miss_and_is_approved(tmp_path):
    write_pairs(str(tmp_path), days=16, rain_every=1, looks=6)
    result = learn_rain.learn(learn_rain.load_pairs(str(tmp_path)), trees=40)
    assert result["ready"]
    assert result["scores"]["model"]["csi"] > result["scores"]["rules"]["csi"] + 0.2
    assert result["approved"], result["reason"]
    assert set(result["importance"]) <= set(NAMES) and "t108" in result["importance"]
    m = result["model"]
    assert m["approved"] and m["features"] == NAMES and 0.05 <= m["rainProb"] <= 0.95


def test_far_and_near_pixels_and_warm_ground_are_left_out(tmp_path):
    data = {"names": NAMES, "X": np.array([[210, 211, 0, 0], [210, 211, 0, 0], [290, 280, 0, 0]], float),
            "meta": {"rangeKm": np.array([10.0, 100, 100]), "dbzMeanZ": np.zeros(3), "weight": np.ones(3), "hand": np.zeros(3)},
            "day": np.zeros(3, int)}
    assert len(learn_rain.select(data)["X"]) == 1


def test_the_trees_walk_raw_inputs_as_they_were_fitted():
    rng = np.random.default_rng(3)
    X = rng.normal(0, 1, (2000, 3))
    y = (X[:, 0] > 0.2).astype(float) * 2 + X[:, 1]
    m = learn_rain.fit_boosted(X, y, np.ones(len(y)), "squared", trees=30)
    err = np.mean(np.abs(learn_rain.trees_value(m, X) - y))
    assert err < 0.3
    # a threshold never sits on a data value, so rounding in the app cannot send a pixel the other way
    edges = learn_rain.bin_edges(np.round(X, 1))
    assert all(not np.isin(e, np.round(X, 1)).any() for e in edges)


def test_the_app_reads_the_model_as_it_is_written():
    """The fixture is the model the app's spec (rain-features.spec.ts) walks too: both must give its expected values."""
    with open(FIXTURE, encoding="utf-8") as f:
        fx = json.load(f)
    X = np.array(fx["inputs"], float)
    assert np.allclose(learn_rain.predict(fx["model"], X), fx["expected"], atol=1e-6)


def make_fixture():
    """Writes the fixture (run by hand when the model's format changes: python -c 'import tests.test_learn_rain as t; t.make_fixture()')."""
    rng = np.random.default_rng(7)
    X = np.column_stack([rng.uniform(195, 285, 3000), rng.normal(0, 6, 3000)])
    dbz = np.where((X[:, 0] < 230) & (X[:, 1] < 0), 30 + (230 - X[:, 0]) * 0.5, 0)
    model, _ = learn_rain.fit_model(X, dbz, np.ones(len(X)), ["t108", "cool15"], trees=8)
    model = learn_rain.compact(model)
    inputs = [[210.0, -5.0], [228.4, -1.2], [250.0, -9.0], [205.0, 4.0], [222.2, -0.1], [270.0, 3.3]]
    with open(FIXTURE, "w", encoding="utf-8") as f:
        json.dump({"model": model, "inputs": inputs, "expected": [round(float(v), 6) for v in learn_rain.predict(model, np.array(inputs))]}, f)
