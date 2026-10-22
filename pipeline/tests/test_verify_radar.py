import os
import sys
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import verify_radar as vr  # noqa: E402
from verify_gauges import window_start_utc  # noqa: E402

DAY = date(2026, 10, 20)
T0 = window_start_utc(DAY) - 3600          # the rain day's first second
NEAR_KKL = [10.75, 79.75]                   # a cell near Karaikal
NEAR_CNI = [12.75, 80.25]                   # a cell near Chennai
FAR = [8.25, 76.25]                         # beyond both radars


def store(zp_kkl, zp_cni, every_min=10, hours=24, start=T0):
    """Looks every `every_min` minutes, the Karaikal cell at `zp_kkl` and the Chennai cell at `zp_cni` all day."""
    recs = []
    for k in range(hours * 60 // every_min):
        t = (start + k * every_min * 60) * 1000
        live = [[zp_kkl, 40, 1.0], [zp_cni, 40, 1.0], None]
        recs.append({"t": t, "live": live, "n30": live, "n60": live})
    return {"points": [NEAR_KKL, NEAR_CNI, FAR], "halfDeg": 0.25, "records": recs}


def test_cells_belong_to_the_nearest_radar_in_range():
    assert vr.nearest_radar(*NEAR_KKL) == "karaikal"
    assert vr.nearest_radar(*NEAR_CNI) == "chennai"
    assert vr.nearest_radar(*FAR) is None


def test_a_rain_day_adds_up_the_looks_and_keeps_the_cells_with_gauges():
    gauge_day = {"cells": [NEAR_KKL, NEAR_CNI, FAR], "obs": [10.0, 5.0, 3.0]}
    rec = vr.rain_day_record(store(2.0, 1.0), gauge_day, DAY)
    assert rec["covered_h"] == 24.0
    assert rec["cells"] == [NEAR_KKL, NEAR_CNI]           # the far cell has no radar
    assert rec["radar_a1"] == [48.0, 24.0]                 # zp x 24 h
    assert vr.rain_day_record(store(2.0, 1.0, hours=10), gauge_day, DAY) is None   # too few hours of radar


def test_the_fitted_a_makes_the_radar_match_the_gauges_and_is_kept_when_it_helps():
    true_a = 400.0
    radar_a1 = 48.0
    gauge = vr.total_for(radar_a1, true_a)                 # what the gauges had, if a = 400 were right
    days = [{"date": f"2026-10-{i + 1:02d}", "cells": [NEAR_KKL, NEAR_CNI], "radar_a1": [radar_a1, radar_a1], "obs": [gauge * 10, gauge * 10]}
            for i in range(10)]
    cal = vr.learn(days)
    k = cal["karaikal"]
    assert k["accepted"]
    assert abs(k["a"] - vr.A_RANGE[0]) < 1e-6 or k["a"] < vr.MP_A    # ten times the rain: a much smaller a (clipped at the bottom)
    assert k["mae_fitted"] < k["mae_marshall_palmer"]


def test_no_fit_without_enough_days_or_rain():
    few = vr.learn([{"date": "2026-10-01", "cells": [NEAR_KKL], "radar_a1": [10.0], "obs": [5.0]}])
    assert not few["karaikal"]["accepted"] and few["karaikal"]["a"] == vr.MP_A
    dry = vr.learn([{"date": f"2026-10-{i + 1:02d}", "cells": [NEAR_KKL], "radar_a1": [0.0], "obs": [0.0]} for i in range(10)])
    assert not dry["karaikal"]["accepted"]


def test_the_nowcast_is_scored_against_what_followed_and_beside_a_still_picture():
    # rain moves into the Karaikal cell after an hour: the nowcast saw it coming, a still picture did not
    recs = []
    for k in range(12):
        t = (T0 + k * 600) * 1000
        wet_now = 1.0 if k >= 6 else 0.0
        wet_30 = 1.0 if k + 3 >= 6 else 0.0
        recs.append({"t": t, "live": [[1, 40, wet_now]], "n30": [[1, 40, wet_30]], "n60": [[1, 40, wet_now]]})
    s = vr.score_nowcast({"points": [NEAR_KKL], "records": recs}, T0, T0 + 86400)
    assert s["30"]["nowcast"] == {"hits": 6, "misses": 0, "false": 0}
    assert s["30"]["still"]["misses"] == 3                 # the three looks before the rain arrived
