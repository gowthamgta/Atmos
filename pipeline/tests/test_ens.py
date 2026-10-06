import numpy as np

import ens


def _members(values):
    """[member, 1, 1] fields from a list of per-member rain amounts."""
    return np.array(values, np.float32).reshape(-1, 1, 1)


def test_exceedance_is_the_share_of_members_at_or_above_each_threshold():
    acc = _members([0, 2.4, 2.5, 15.5, 15.6, 64.4, 64.5, 120, 210, 5])    # 10 members
    out = ens.exceedance_percent(acc)
    assert out["px2"][0, 0] == 80.0     # 2.5, 15.5, 15.6, 64.4, 64.5, 120, 210, 5  (the threshold itself counts; 2.4 does not)
    assert out["px16"][0, 0] == 50.0    # 15.6, 64.4, 64.5, 120, 210
    assert out["px65"][0, 0] == 30.0    # 64.5, 120, 210
    assert out["px115"][0, 0] == 20.0   # 120, 210


def test_exceedance_is_zero_with_no_heavy_rain_and_100_when_all_members_agree():
    assert all(v[0, 0] == 0 for v in ens.exceedance_percent(_members([0.1, 0.5, 1, 2.4])).values())     # all dry or trace
    assert all(v[0, 0] == 100 for v in ens.exceedance_percent(_members([300] * 5)).values())


def test_exceedance_ignores_missing_members_and_keeps_empty_cells_empty():
    out = ens.exceedance_percent(_members([100, np.nan, 100, np.nan, 10]))     # 3 valid, 2 of them >= 65
    assert abs(out["px65"][0, 0] - 100 * 2 / 3) < 1e-4
    assert out["px2"][0, 0] == 100.0 and out["px115"][0, 0] == 0.0
    assert np.isnan(ens.exceedance_percent(_members([np.nan, np.nan]))["px65"][0, 0])


def test_window_accumulation_is_the_rain_between_two_steps_and_never_negative():
    tp = {0: _members([0, 0]), 24: _members([50, 120]), 30: _members([60, 100])}
    assert ens.window_accumulation(tp, 0).ravel().tolist() == [50, 120]
    assert ens.window_accumulation(tp, 6) is None                     # +30 h is there but +6 h is not
    assert ens.window_accumulation({0: _members([5]), 24: _members([4.9999])}, 0).ravel().tolist() == [0.0]


def test_the_steps_to_read_cover_every_window():
    for s in ens.START_HOURS:
        assert s in ens.STEP_HOURS and s + ens.WINDOW_HOURS in ens.STEP_HOURS
    assert ens.START_HOURS[0] == 0 and ens.STEP_HOURS[-1] == ens.START_HOURS[-1] + 24


def test_manifest_lists_the_three_thresholds_and_the_start_times():
    from datetime import datetime, timezone
    m = ens.build_manifest(datetime(2026, 10, 5, 18, tzinfo=timezone.utc), [0, 6])
    assert m["run"] == "20261005T18Z" and [s["h"] for s in m["steps"]] == [0, 6]
    assert set(m["vars"]) == {"px2", "px16", "px65", "px115"} and all(v["max"] == 100 for v in m["vars"].values())
    assert m["steps"][1]["valid"] == "2026-10-06T00:00:00Z"
    assert m["thresholdsMm"] == {"px2": 2.5, "px16": 15.6, "px65": 64.5, "px115": 115.6}   # IMD: rain, moderate, heavy, very heavy
