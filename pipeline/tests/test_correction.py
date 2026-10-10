from datetime import datetime, timezone

import numpy as np

import correction as C


def table(lat=11.0, lon=78.0, temp=None, rh=None):
    variables = {}
    if temp is not None:
        variables["temp_c"] = {h: temp for h in range(24)}
    if rh is not None:
        variables["rh_pct"] = {h: rh for h in range(24)}
    return {"VOTR": {"lat": lat, "lon": lon, "variables": variables}}


def grid():
    lats = np.arange(12.0, 10.0 - 1e-9, -0.5)        # north to south
    lons = np.arange(77.0, 80.0 + 1e-9, 0.5)
    return lats, lons


def test_the_weight_is_full_near_an_airport_and_gone_far_away():
    assert C.weight(50) == 1.0
    assert C.weight(C.FULL_KM) == 1.0
    assert C.weight(C.FADE_KM) == 0.0 and C.weight(500) == 0.0
    assert 0.0 < C.weight(150) < 1.0


def test_a_correction_moves_nearby_values_and_leaves_far_ones_alone():
    lats, lons = grid()
    fields = {"t2m": np.full((len(lats), len(lons)), 30.0, np.float32), "u10": np.full((len(lats), len(lons)), 2.0, np.float32)}
    out = C.apply(fields, lats, lons, datetime(2026, 10, 9, 6, tzinfo=timezone.utc), table(temp=2.0))
    assert np.allclose(out["t2m"][lats == 11.0][0, lons == 78.0], 28.0, atol=0.01)   # the airport's cell: full correction
    assert np.allclose(out["u10"], 2.0)                                              # wind is never corrected


def test_far_from_every_airport_nothing_changes():
    lats = np.array([30.0, 29.5])
    lons = np.array([80.0, 80.5])
    fields = {"t2m": np.full((2, 2), 25.0, np.float32)}
    out = C.apply(fields, lats, lons, datetime(2026, 10, 9, 6, tzinfo=timezone.utc), table(temp=2.0))
    assert np.allclose(out["t2m"], 25.0)


def test_humidity_stays_between_0_and_100():
    lats, lons = grid()
    fields = {"rh": np.full((len(lats), len(lons)), 99.0, np.float32)}
    out = C.apply(fields, lats, lons, datetime(2026, 10, 9, 6, tzinfo=timezone.utc), table(rh=-20.0))
    assert out["rh"].max() <= 100.0 and out["rh"].min() >= 0.0


def test_overlapping_airports_are_averaged_not_added():
    lats, lons = grid()
    fields = {"t2m": np.full((len(lats), len(lons)), 30.0, np.float32)}
    two = {**table(lat=11.0, lon=78.0, temp=2.0), "VOSM": {"lat": 11.0, "lon": 78.0, "variables": {"temp_c": {h: 4.0 for h in range(24)}}}}
    out = C.apply(fields, lats, lons, datetime(2026, 10, 9, 6, tzinfo=timezone.utc), two)
    assert np.allclose(out["t2m"][lats == 11.0][0, lons == 78.0], 27.0, atol=0.01)   # the average of 2 and 4, not 6


def test_load_table_keeps_only_the_variables_that_improved(tmp_path):
    import json
    doc = {"airports": {"VOTR": {"lat": 10.7, "lon": 78.7, "variables": {
        "temp_c": {"mae_before": 1.0, "mae_after": 0.5, "n_test": 80, "correction_by_hour_utc": {"6": 1.5}},
        "rh_pct": {"mae_before": 6.0, "mae_after": 5.9, "n_test": 80, "correction_by_hour_utc": {"6": 1.0}},
        "wind_ms": {"mae_before": 0.8, "mae_after": 0.9, "n_test": 80, "correction_by_hour_utc": {"6": 0.3}},
    }}}}
    path = tmp_path / "t.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    t = C.load_table(str(path))
    assert list(t["VOTR"]["variables"]) == ["temp_c"]          # humidity improved by under 5 %, wind never corrected
    assert t["VOTR"]["variables"]["temp_c"][6] == 1.5
    assert C.load_table(str(tmp_path / "missing.json")) == {}


def test_a_correction_from_too_few_test_points_is_not_used(tmp_path):
    import json
    doc = {"airports": {"VOSM": {"lat": 11.7, "lon": 78.1, "variables": {
        "temp_c": {"mae_before": 1.4, "mae_after": 0.8, "n_test": 20, "correction_by_hour_utc": {"6": 1.0}}}}}}
    path = tmp_path / "t.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    assert C.load_table(str(path)) == {}


def test_dew_point_and_feels_like_follow_the_corrected_temperature_and_humidity():
    lats, lons = grid()
    shape = (len(lats), len(lons))
    fields = {"t2m": np.full(shape, 30.0, np.float32), "rh": np.full(shape, 70.0, np.float32),
              "u10": np.full(shape, 3.0, np.float32), "v10": np.full(shape, 4.0, np.float32),
              "dew": np.full(shape, 99.0, np.float32), "feels": np.full(shape, 99.0, np.float32)}
    out = C.apply(fields, lats, lons, datetime(2026, 10, 9, 6, tzinfo=timezone.utc), table(temp=2.0, rh=-5.0))
    from derive import apparent_temperature, dew_point
    near = (lats == 11.0)[:, None] & (lons == 78.0)[None, :]
    t, rh = out["t2m"][near][0], out["rh"][near][0]
    assert abs(out["dew"][near][0] - dew_point(np.array(t), np.array(rh))) < 0.01
    assert abs(out["feels"][near][0] - apparent_temperature(np.array(t), np.array(rh), np.array(5.0))) < 0.01
    assert out["dew"][near][0] != 99.0       # recalculated, not left at the model's value


def test_rain_is_scaled_on_land_near_a_gauge_only():
    lats = np.array([11.0, 10.0, 8.0])
    lons = np.array([78.0, 79.0])
    rate = np.full((3, 2), 2.0, np.float32)
    land = np.array([[True, True], [True, False], [True, True]])     # (10.0, 79.0) is sea
    rain = {"factor": 0.5, "gauges": np.array([[11.0, 78.0]])}
    out = C.apply_rain({"precip": rate}, lats, lons, rain, land)["precip"]
    assert np.isclose(out[0, 0], 1.0)            # land at the gauge: halved
    assert np.isclose(out[1, 1], 2.0)            # sea: unchanged
    assert np.isclose(out[2, 0], 2.0)            # about 111 km away: beyond the fade, unchanged


def test_no_rain_correction_without_an_accepted_factor(tmp_path):
    import json
    path = tmp_path / "r.json"
    path.write_text(json.dumps({"rain": {"factor": 0.8, "accepted": False, "n_test": 500}, "gauges": [[11.0, 78.0]]}), encoding="utf-8")
    assert C.load_rain(str(path)) is None
    lats = np.array([11.0])
    lons = np.array([78.0])
    rate = np.array([[3.0]], np.float32)
    out = C.apply_rain({"precip": rate}, lats, lons, None, np.array([[True]]))["precip"]
    assert np.isclose(out[0, 0], 3.0)


def test_one_airport_fades_with_distance_instead_of_staying_at_full_strength():
    lats = np.array([11.0])
    lons = np.array([78.0, 79.4, 79.75])            # 0, about 153 and about 191 km east of the airport
    fields = {"t2m": np.full((1, 3), 30.0, np.float32)}
    out = C.apply(fields, lats, lons, datetime(2026, 10, 9, 6, tzinfo=timezone.utc), table(temp=2.0))["t2m"][0]
    assert np.isclose(out[0], 28.0, atol=0.01)                      # at the airport: the full 2 degrees
    assert 28.0 < out[1] < 29.5                                     # part way: less than the full correction
    assert out[1] < out[2] <= 30.0                                   # nearly gone near the 200 km edge
    assert abs((30.0 - out[1]) - 2.0 * C.weight(153)) < 0.05       # the correction follows the weight


def test_the_sea_is_left_out_of_the_airport_correction():
    lats, lons = grid()
    shape = (len(lats), len(lons))
    land = np.ones(shape, bool)
    land[:, 0] = False                                              # the first column is sea
    fields = {"t2m": np.full(shape, 30.0, np.float32)}
    out = C.apply(fields, lats, lons, datetime(2026, 10, 9, 6, tzinfo=timezone.utc), table(temp=2.0), land)["t2m"]
    assert np.allclose(out[:, 0], 30.0)                             # sea: unchanged
    assert out[:, 1:].min() < 30.0                                  # land: corrected
