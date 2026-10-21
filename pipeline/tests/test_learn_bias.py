import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import learn_bias  # noqa: E402
from verify import AIRPORTS, MODELS  # noqa: E402


def day(i, bias=2.0, wet_hours=(), fc_rain=lambda h: 0.0):
    """A day where every model is `bias` C too warm everywhere (with a little noise), and rain is reported in `wet_hours`."""
    obs = {a: {"temp": [25.0 + (h % 5) for h in range(24)], "rh": [70.0] * 24, "rain": [h in wet_hours for h in range(24)]} for a in AIRPORTS}
    fc = {m: {"temp": {a: [25.0 + (h % 5) + bias + (0.3 if (h + i) % 2 else -0.3) for h in range(24)] for a in AIRPORTS},
              "rh": {a: [70.0] * 24 for a in AIRPORTS},
              "rain": {a: [fc_rain(h) for h in range(24)] for a in AIRPORTS}} for m in MODELS}
    return {"date": f"2026-10-{i + 1:02d}", "obs": obs, "fc": fc}


def test_a_steady_error_is_learned_checked_and_kept():
    corr = learn_bias.learn([day(i) for i in range(14)])
    m = corr["models"]["ecmwf_ifs"]
    assert set(m["temp"]) == set(AIRPORTS)                          # kept at every airport: it clearly helps on the held-back days
    assert all(1.6 < c < 2.0 for c in m["temp"]["VOMM"])           # +2 C, pulled a little toward 0 by the shrinkage (42 hours: x 42/48)
    assert "rh" not in m                                             # humidity was right: nothing to correct
    check = m["checks"]["temp"]["VOMM"]
    assert check["accepted"] and check["mae_after"] < check["mae_before"]


def test_no_correction_when_it_does_not_help():
    # an error that flips sign every other day averages to about 0: a correction learned from the first days does not help the last
    corr = learn_bias.learn([day(i, bias=2.0 if i % 2 else -2.0) for i in range(14)])
    assert "temp" not in corr["models"]["ecmwf_ifs"]


def test_the_rain_threshold_matches_how_often_rain_is_reported():
    # reported in 4 hours of 24; the models have 1 mm in those 4 and 0.3 mm in 8 more: from 0.5 mm they say rain as often as it is reported
    wet = (1, 2, 3, 4)
    days = [day(i, wet_hours=wet, fc_rain=lambda h: 1.0 if h in wet else (0.3 if h < 13 else 0.0)) for i in range(14)]
    corr = learn_bias.learn(days)
    assert corr["models"]["gfs"]["rain_threshold_mm"] in (0.5, 0.75, 1.0)
    assert set(corr["blend"]["temp"]) == set(MODELS)                 # all equally good: all in the Blend


def test_backtest_scores_models_corrected_and_the_blend():
    bt = learn_bias.backtest([day(i) for i in range(14)])
    assert bt["temp_mae"]["ecmwf_ifs"] > 1.9
    assert bt["temp_mae"]["ecmwf_ifs+corrected"] < 0.6
    assert bt["temp_mae"]["blend"] < 0.6
