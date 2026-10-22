import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import correction  # noqa: E402
import learn_bias  # noqa: E402


def gauge_day(i, scale=2.0, wet=True):
    """A day of 40 cells where it rained 10 mm in half of them and the model had `1 / scale` of it everywhere."""
    obs = [10.0 if (c + i) % 2 == 0 and wet else 0.0 for c in range(40)]
    return {"date": f"2026-10-{i + 1:02d}", "cells": [[11.0, 79.0]] * 40, "obs": obs, "fc": {"ecmwf_ifs": [o / scale for o in obs]}}


def test_a_model_that_halves_the_rain_gets_its_factor(tmp_path):
    days = [gauge_day(i) for i in range(14)]
    r = learn_bias.learn_rain_factor(days)
    assert r["accepted"]
    assert r["factor"] == 1.5                                   # 2 would be right, but it is kept within 0.5 to 1.5
    assert r["mae_after"] < r["mae_before"]
    positions = tmp_path / "positions.json"
    positions.write_text(json.dumps([[11.0, 79.0], [12.0, 80.0]]))
    table = tmp_path / "rain.json"
    learn_bias.write_rain_table(str(table), r, str(positions), days)
    loaded = correction.load_rain(str(table))                   # the map pipeline reads it as before
    assert loaded is not None and loaded["factor"] == 1.5 and loaded["gauges"].shape == (2, 2)


def test_no_factor_when_it_does_not_help_or_there_is_too_little_rain(tmp_path):
    right = learn_bias.learn_rain_factor([gauge_day(i, scale=1.0) for i in range(14)])
    assert not right["accepted"]                                # the model was right: scaling cannot lower the error
    dry = learn_bias.learn_rain_factor([gauge_day(i, wet=False) for i in range(14)])
    assert not dry["accepted"]
    few = learn_bias.learn_rain_factor([gauge_day(i) for i in range(5)])
    assert not few["accepted"] and "only 5" in few["reason"]
    table = tmp_path / "rain.json"
    learn_bias.write_rain_table(str(table), right, str(tmp_path / "missing.json"), [])
    assert correction.load_rain(str(table)) is None             # not accepted: the map is not scaled
