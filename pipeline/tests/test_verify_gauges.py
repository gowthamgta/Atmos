import os
import sys
from datetime import date, datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import verify_gauges as vg  # noqa: E402
from verify import MODELS, forecast_key  # noqa: E402


def station(lat, lon, hourly):
    return {"lat": lat, "lon": lon, "hourly_mm": {f"h{i}": v for i, v in enumerate(hourly)}}


def test_the_day_file_starts_at_0930_ist_the_day_before():
    assert vg.window_start_utc(date(2026, 10, 20)) == int(datetime(2026, 10, 19, 4, tzinfo=timezone.utc).timestamp())


def test_gauges_are_averaged_by_cell_and_short_records_left_out():
    c = vg.cells([
        station(11.1, 79.1, [1.0] * 24),
        station(11.2, 79.2, [3.0] * 24),                 # the same cell: a mean of 2 mm an hour
        station(11.1, 79.1, [5.0] * 10 + [None] * 14),   # too few readings
        station(13.9, 80.4, [0.0] * 24),
    ])
    assert c[vg.cell_of(11.1, 79.1)] == [2.0] * 24
    assert c[vg.cell_of(13.9, 80.4)] == [0.0] * 24
    assert len(c) == 2


def test_scores_totals_wet_days_and_windows():
    t0 = 1_000_000 * 3600
    cell = (11.25, 79.25)
    observed = {cell: [0.5] * 24}                        # 12 mm: a wet day, and 3 mm in every 6 hours
    api = MODELS["icon"]
    forecast = {cell: {forecast_key("rain", 1, api): {t0 + 3600 * i: (1.0 if i < 6 else 0.0) for i in range(24)}}}
    s = vg.score(observed, forecast, t0, {})
    e = s["icon"]["1"]
    assert e["total"] == {"mae": 6.0, "bias": -6.0, "n": 1}
    assert e["wet_day"] == {"hits": 1, "misses": 0, "false": 0}
    assert e["rain6"] == {"hits": 1, "misses": 3, "false": 0}
    assert "blend" not in s                              # no blend weights given
