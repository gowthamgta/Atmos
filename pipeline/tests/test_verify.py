import os
import sys
from datetime import date, datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import verify  # noqa: E402

DAY = date(2026, 10, 20)
T0 = int(datetime(2026, 10, 20, tzinfo=timezone.utc).timestamp())


def metar(icao, t, temp=28, dewp=24, wspd=10, wx=None):
    return {"icaoId": icao, "obsTime": t, "temp": temp, "dewp": dewp, "wspd": wspd, "wxString": wx}


def test_rain_in_the_present_weather():
    assert verify.reports_rain("-RA")
    assert verify.reports_rain("TSRA BR")
    assert verify.reports_rain("+SHRA")
    assert verify.reports_rain("DZ")
    assert verify.reports_rain("VCSH RA")
    assert not verify.reports_rain("TS")          # thunder alone
    assert not verify.reports_rain("HZ")
    assert not verify.reports_rain("RERA")        # recent rain, not now
    assert not verify.reports_rain(None)


def test_observations_keep_the_hours_of_the_day_at_known_airports():
    records = [
        metar("VOMM", T0),                      # on the hour: kept
        metar("VOMM", T0 + 1800),               # half past: no model value then
        metar("VOMM", T0 - 3600),               # the day before
        metar("VOMM", T0 + 86400),              # the day after
        metar("KJFK", T0),                      # not one of ours
        metar("VOMD", T0 + 3600, wspd=10, wx="-RA"),
    ]
    obs = verify.observations(records, DAY)
    assert set(obs) == {"VOMM", "VOMD"}
    assert list(obs["VOMM"]) == [T0]
    assert obs["VOMD"][T0 + 3600]["rain"] is True
    assert abs(obs["VOMD"][T0 + 3600]["wind"] - 10 * verify.KT_TO_MS) < 0.01


def test_scores_errors_bias_and_rain_by_model_and_lead():
    obs = {"VOMM": {T0: {"temp": 30.0, "dewp": 24.0, "wind": 3.0, "rain": True},
                    T0 + 3600: {"temp": 31.0, "dewp": 24.0, "wind": 4.0, "rain": False}}}
    api = verify.MODELS["ecmwf_ifs"]
    fc = {"VOMM": {
        verify.forecast_key("temp", 1, api): {T0: 29.0, T0 + 3600: 33.0},     # errors -1 and +2
        verify.forecast_key("dewp", 1, api): {T0: 24.0, T0 + 3600: None},     # one missing value: left out
        verify.forecast_key("wind", 1, api): {T0: 3.0, T0 + 3600: 4.0},
        verify.forecast_key("rain", 1, api): {T0: 0.5, T0 + 3600: 1.0},       # caught the wet hour, false alarm in the dry one
    }}
    s = verify.score_day(obs, fc)
    e = s["ecmwf_ifs"]["1"]
    assert e["temp"] == {"mae": 1.5, "bias": 0.5, "n": 2}
    assert e["dewp"] == {"mae": 0.0, "bias": 0.0, "n": 1}
    assert e["wind"]["mae"] == 0.0
    assert e["rain"] == {"hits": 1, "misses": 0, "false": 1}
    # no forecast at all for the other models and leads: nothing written for them
    assert "2" not in s["ecmwf_ifs"]
    assert "gfs" not in s


def test_merge_replaces_the_same_day_and_drops_old_days():
    first = verify.merge(None, DAY, {"gfs": {}}, date(2026, 10, 21))
    again = verify.merge(first, DAY, {"aifs": {}}, date(2026, 10, 21))
    assert [d["date"] for d in again["days"]] == ["2026-10-20"]
    assert again["days"][0]["models"] == {"aifs": {}}
    later = verify.merge(again, date(2027, 2, 1), {}, date(2027, 2, 2))
    assert [d["date"] for d in later["days"]] == ["2027-02-01"]   # 2026-10-20 is past the 90 days kept
