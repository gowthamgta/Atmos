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
