from datetime import date, datetime, timedelta, timezone

import numpy as np
from PIL import Image

import rain_bias as R


def test_hour_labels_map_to_the_position_in_the_09_30_to_07_30_window():
    assert R._hour_index("09:30 AM") == 0
    assert R._hour_index("12:30 PM") == 3
    assert R._hour_index("09:30 PM") == 12
    assert R._hour_index("12:30 AM") == 15
    assert R._hour_index("07:30 AM") == 22          # the 23rd and last value


def test_a_window_with_a_missing_model_hour_has_no_total_not_zero_rain():
    day = date(2026, 10, 8)
    start = datetime(2026, 10, 8, 4, tzinfo=timezone.utc)
    full = {start + timedelta(hours=k): 1.0 for k in range(R.WINDOW_HOURS)}
    assert R.window_total(full, day) == R.WINDOW_HOURS
    gap = dict(full)
    del gap[start + timedelta(hours=5)]
    assert R.window_total(gap, day) is None


def rows(n_days, model, obs, per_day=20):
    return [{"date": date(2026, 9, 1) + timedelta(days=d), "station": f"g{i}", "district": "x", "model": model(d), "obs": obs(d)}
            for d in range(n_days) for i in range(per_day)]


def test_a_factor_that_helps_on_most_held_out_days_is_accepted():
    # the model is 25 percent too wet every day: scaling by the learned factor helps on every test day
    out = R.evaluate(rows(36, lambda d: 8.0 + d % 3, lambda d: 0.75 * (8.0 + d % 3)))
    assert out["accepted"] is True and out["test_days"] >= R.MIN_TEST_DAYS
    assert abs(out["factor"] - 0.75) < 0.02


def test_too_few_held_out_days_are_not_enough_however_many_gauges_there_are():
    out = R.evaluate(rows(12, lambda d: 8.0, lambda d: 6.0, per_day=2000))       # 4 test days, 8,000 gauge-days
    assert out["n_test"] > 50 and out["test_days"] < R.MIN_TEST_DAYS
    assert out["accepted"] is False


def test_a_factor_that_helps_on_the_average_but_not_on_most_days_is_not_accepted():
    # learn on days that are 25 percent too wet; on the held-out days it is right on most days but one huge day is wetter
    def obs(d):
        return 20.0 if d == 35 else 8.0
    out = R.evaluate(rows(36, lambda d: 8.0, obs))
    assert out["accepted"] is False


def test_the_land_fraction_at_a_whole_degree_latitude_reads_the_south_edge_of_the_tile(tmp_path, monkeypatch):
    # a 4 x 4 tile of 1 x 1 degree N11E078: land (blue 255) only on the bottom (south) row
    px = np.zeros((4, 4, 3), np.uint8)
    px[3, :, 2] = 255
    folder = tmp_path / "L1"
    folder.mkdir()
    Image.fromarray(px).save(folder / "N11E078.webp", format="WEBP", lossless=True)
    monkeypatch.setattr(R, "TERRAIN", str(tmp_path))
    cache = {}
    assert R.land_fraction(11.0, 78.5, cache) == 1.0       # exactly 11.0 N is the south edge of the tile
    assert R.land_fraction(11.99, 78.5, cache) == 0.0      # near 12 N is the north edge: sea
    assert R.land_fraction(30.0, 78.5, cache) is None      # no tile


def test_model_cache_is_reused_only_for_points_that_cover_the_dates(tmp_path, monkeypatch):
    import json
    cache_path = tmp_path / "c.json"
    short = {f"2026-09-0{d}T{h:02d}:00": 0.0 for d in range(1, 4) for h in range(24)}
    cache_path.write_text(json.dumps({"11.0000,78.0000": short}), encoding="utf-8")
    calls = []

    def fake_get(params):
        calls.append(params)
        t = [f"2026-09-{d:02d}T{h:02d}:00" for d in range(1, 8) for h in range(24)]
        return {"hourly": {"time": t, "precipitation": [1.0] * len(t)}}

    monkeypatch.setattr(R, "_get", fake_get)
    monkeypatch.setattr(R.time if hasattr(R, "time") else __import__("time"), "sleep", lambda s: None)
    out = R.model_precip([(11.0, 78.0)], date(2026, 9, 1), date(2026, 9, 7), str(cache_path))
    assert len(calls) == 1                                  # the cached series ends on 3 September: fetched again
    assert max(out[(11.0, 78.0)]) >= datetime(2026, 9, 7, 23, tzinfo=timezone.utc)
