import numpy as np
import ens


def field(v):
    return np.full((2, 2), v, np.float32)


def test_next_24h_is_between_the_largest_chance_and_independent_periods():
    steps = {h: field(20.0) for h in range(0, 49, 3)}
    out = ens.next_24h(steps)
    independent = 100 * (1 - 0.8 ** 8)
    assert abs(float(out[0][0, 0]) - 0.5 * (independent + 20.0)) < 1e-3
    assert 20.0 < out[0][0, 0] < independent


def test_next_24h_has_no_answer_where_the_run_ends_inside_the_window():
    steps = {h: field(10.0) for h in range(0, 31, 3)}      # reaches +30 h: steps up to +6 h have a whole window after them
    assert sorted(ens.next_24h(steps)) == [0, 3, 6]


def test_next_24h_keeps_dry_dry_and_certain_rain():
    assert float(ens.next_24h({h: field(0.0) for h in range(0, 30, 3)})[0][0, 0]) == 0.0
    assert float(ens.next_24h({h: field(100.0) for h in range(0, 30, 3)})[0][0, 0]) == 100.0


def test_a_missing_value_in_the_window_is_no_data():
    steps = {h: field(10.0) for h in range(0, 30, 3)}
    steps[9] = np.array([[np.nan, 10.0], [10.0, 10.0]], np.float32)
    out = ens.next_24h(steps)[0]
    assert np.isnan(out[0, 0]) and np.isfinite(out[1, 1])
