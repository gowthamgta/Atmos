import numpy as np

from extreme import AMOUNT_POINTS, CAP, amount_score, extreme_rain_percent

F = lambda v: np.array([[v]], np.float32)   # noqa: E731


def pct(own, blend, chance):
    return float(extreme_rain_percent(F(own), None if blend is None else F(blend), F(chance))[0, 0])


def test_the_amount_sets_the_probability_along_the_curve():
    got = {mm: float(amount_score(np.array([mm]))[0]) for mm in (0, 10, 25, 50, 75, 100, 150, 400)}
    assert got == {0: 0.0, 10: 0.0, 25: 0.25, 50: 0.70, 75: 0.82, 100: 0.90, 150: 0.95, 400: 0.95}
    assert abs(float(amount_score(np.array([37.5]))[0]) - 0.475) < 1e-9          # a straight line between the corners
    assert np.isnan(amount_score(np.array([np.nan]))[0])
    mm = np.linspace(0, 300, 61)
    assert (np.diff(amount_score(mm)) >= 0).all() and amount_score(mm).max() <= CAP + 1e-12
    assert AMOUNT_POINTS[0][0] == 0


def test_50_mm_in_the_model_and_in_the_blend_with_rain_expected_is_about_70_percent():
    assert abs(pct(50, 50, 90) - 70) < 0.01
    assert abs(pct(100, 100, 95) - 90) < 0.01
    assert pct(300, 300, 100) == 95.0                      # never certain


def test_it_grows_with_the_amount():
    values = [pct(mm, mm, 90) for mm in (5, 15, 25, 40, 50, 75, 100, 150)]
    assert values == sorted(values) and values[0] == 0 and values[-1] > 90


def test_it_is_lower_when_the_model_and_the_blend_disagree():
    agree = pct(50, 50, 90)
    split = pct(50, 25, 90)                               # consensus 37.5 mm, and the models are half-way apart
    assert split < agree - 25
    assert abs(split - 100 * 0.475 * (0.65 + 0.35 * 0.5)) < 0.01
    assert pct(50, 5, 90) < split                          # further apart: lower still


def test_it_goes_to_nothing_when_the_ensemble_does_not_expect_rain():
    assert pct(80, 80, 10) == 0
    assert pct(80, 80, 20) == 0
    assert 0 < pct(80, 80, 45) < pct(80, 80, 70)
    assert pct(80, 80, 70) == pct(80, 80, 100)             # from 70 % the chance of rain no longer matters


def test_without_a_blend_the_model_stands_alone_and_unknowns_stay_unknown():
    assert abs(pct(50, None, 90) - 70) < 0.01
    assert abs(pct(50, float("nan"), 90) - 70) < 0.01
    own = np.array([[50.0, np.nan, 50.0]], np.float32)
    out = extreme_rain_percent(own, own, np.array([[90.0, 90.0, np.nan]], np.float32))
    assert abs(out[0, 0] - 70) < 0.01 and np.isnan(out[0, 1]) and np.isnan(out[0, 2])
