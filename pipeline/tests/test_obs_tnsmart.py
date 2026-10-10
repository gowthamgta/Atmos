from datetime import date

import obs_tnsmart as O


def row(district, station, **hours):
    r = {"district_name": district, "station_name": station, "latitude": 11.7, "longitude": 78.9, "total": 3.0}
    r.update({k: v for k, v in hours.items()})
    return r


def test_only_the_district_stations_are_kept_with_their_hourly_rain():
    rows = [
        row("Kallakurichi", "Virugavur", **{"09:30 AM": 0, "10:30 AM": 1.2, "07:30 AM": 0.4}),
        row("Villupuram", "Nolambai", **{"09:30 AM": 2}),
        row("Kallakurichi", "Kaattu Edaiyar", **{"09:30 AM": 0.6}),
    ]
    stations = O.parse_day(rows)
    assert [s["station"] for s in stations] == ["Virugavur", "Kaattu Edaiyar"]
    assert stations[0]["hourly_mm"] == {"09:30 AM": 0.0, "10:30 AM": 1.2, "07:30 AM": 0.4}
    assert stations[0]["total_mm"] == 3.0 and stations[0]["lat"] == 11.7


def test_hour_columns_are_recognised_and_other_fields_are_not_mistaken_for_hours():
    assert O.is_hour_key("09:30 AM") and O.is_hour_key("12:30 PM")
    assert not any(O.is_hour_key(k) for k in ("district_name", "total", "latitude", "09:30"))


def test_a_day_is_saved_as_one_small_file(tmp_path):
    stations = O.parse_day([row("Kallakurichi", "Virugavur", **{"09:30 AM": 0})])
    path = O.save_day(str(tmp_path), date(2026, 10, 8), stations)
    import json
    doc = json.load(open(path, encoding="utf-8"))
    assert doc["date"] == "2026-10-08" and doc["district"] == "Kallakurichi"
    assert doc["stations"][0]["station"] == "Virugavur"


def test_the_daily_file_address_follows_the_date():
    assert O.day_url(date(2026, 10, 8)).endswith("/hourly_rainfall_2026-10-08.json")


def test_an_empty_hour_is_missing_not_zero_rain():
    stations = O.parse_day([row("Kallakurichi", "Virugavur", **{"09:30 AM": None, "10:30 AM": 0})])
    assert stations[0]["hourly_mm"] == {"09:30 AM": None, "10:30 AM": 0.0}


def test_a_day_that_has_not_changed_is_not_rewritten(tmp_path):
    import time
    stations = O.parse_day([row("Kallakurichi", "Virugavur", **{"09:30 AM": 0, "10:30 AM": 1.2})])
    path = O.save_day(str(tmp_path), date(2026, 10, 8), stations)
    first = open(path, encoding="utf-8").read()
    time.sleep(1.1)
    O.save_day(str(tmp_path), date(2026, 10, 8), stations)
    assert open(path, encoding="utf-8").read() == first
    stations[0]["hourly_mm"]["11:30 AM"] = 2.0
    O.save_day(str(tmp_path), date(2026, 10, 8), stations)
    assert open(path, encoding="utf-8").read() != first


def test_the_card_summary_keeps_total_and_wettest_hour_per_gauge(tmp_path):
    from datetime import date
    st = [{"district": "Salem", "station": "A", "lat": 11.123456, "lon": 78.5, "hourly_mm": {"09:30 AM": 0.0, "10:30 AM": 4.5, "11:30 AM": None}, "total_mm": 4.5},
          {"district": "Salem", "station": "B", "lat": None, "lon": 78.5, "hourly_mm": {}, "total_mm": 0.0},
          {"district": "Erode", "station": "C", "lat": 11.0, "lon": 77.7, "hourly_mm": {"09:30 AM": 0.0}, "total_mm": 0.0}]
    s = O.summarise(st, date(2026, 10, 10))
    assert [r["n"] for r in s["stations"]] == ["A", "C"]                         # a gauge without a position is left out
    a = s["stations"][0]
    assert a["t"] == 4.5 and a["pk"] == 4.5 and a["pt"] == "10:30 AM" and a["h"] == 2 and a["la"] == 11.1235
    assert s["stations"][1]["pt"] is None                                       # a dry gauge has no wettest hour
    assert O.save_summary(str(tmp_path), s) is not None
    assert O.save_summary(str(tmp_path), s) is None                             # same stations: not rewritten
