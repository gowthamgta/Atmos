import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import blend  # noqa: E402

CORR = {
    "airports": {"A": [11.0, 79.0], "B": [16.0, 83.0]},
    "models": {"m1": {"temp": {"A": [1.0] * 24, "B": [3.0] * 24}, "rh": {"A": [-10.0] * 24}, "rain_threshold_mm": 0.5}, "m2": {}},
    "blend": {"temp": {"m1": 3.0, "m2": 1.0}, "rain": {"m1": 1.0, "m2": 1.0}, "rain_cutoff": 0.4},
}


def test_a_correction_is_full_near_an_airport_and_fades_out():
    assert blend.correction_at(CORR, "m1", "temp", 11.0, 79.0, 5) == 1.0
    # about 150 km north of A: half its weight (B is over 200 km away and does not count)
    lat = 11.0 + 150 / 111.2
    w = blend.distance_weight(blend.haversine_km(lat, 79.0, 11.0, 79.0))
    assert 0.45 < w < 0.55
    assert blend.correction_at(CORR, "m1", "temp", lat, 79.0, 5) == w * 1.0
    assert blend.correction_at(CORR, "m1", "temp", 20.0, 79.0, 5) == 0.0
    assert blend.correction_at(CORR, "m2", "temp", 11.0, 79.0, 5) == 0.0


def test_corrected_values_and_humidity_bounds():
    assert blend.corrected(CORR, "m1", "temp", 30.0, 11.0, 79.0, 0) == 29.0
    assert blend.corrected(CORR, "m1", "rh", 95.0, 11.0, 79.0, 0) == 100.0        # 95 + 10, kept at 100
    assert blend.corrected(CORR, "m1", "wind", 4.0, 11.0, 79.0, 0) == 4.0         # wind is never corrected
    assert blend.corrected(CORR, "m1", "temp", None, 11.0, 79.0, 0) is None


def test_the_blend_weights_the_models_that_have_a_value():
    assert blend.blend_value(CORR, "temp", {"m1": 30.0, "m2": 26.0}) == 29.0      # (3 x 30 + 26) / 4
    assert blend.blend_value(CORR, "temp", {"m1": None, "m2": 26.0}) == 26.0      # a missing model's weight goes to the others
    assert blend.blend_value(CORR, "temp", {"m1": None, "m2": None}) is None


def test_rain_chance_counts_each_model_from_its_own_threshold():
    assert blend.rain_chance(CORR, {"m1": 0.4, "m2": 0.3}) == 0.5                 # m1 under its 0.5 mm, m2 over the plain 0.2
    assert blend.rain_chance(CORR, {"m1": 0.6, "m2": 0.3}) == 1.0
    assert blend.rain_cutoff(CORR) == 0.4
    assert blend.rain_cutoff({}) == 0.5


def test_dew_point_from_temperature_and_humidity():
    assert abs(blend.dew_point(30.0, 100.0) - 30.0) < 0.01
    assert abs(blend.dew_point(30.0, 50.0) - 18.4) < 0.2
