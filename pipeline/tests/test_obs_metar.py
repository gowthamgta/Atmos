import obs_metar as M


def rec(**kw):
    r = {"icaoId": "VOTR", "name": "Tiruchchirapalli", "lat": 10.7, "lon": 78.7, "obsTime": 1791514800,
         "temp": 31, "dewp": 28, "wdir": "VRB", "wspd": 2, "visib": "10+", "altim": 1014, "wxString": "BR",
         "rawOb": "METAR VOTR ..."}
    r.update(kw)
    return r


def test_humidity_from_air_and_dew_point():
    assert 80 < M.relative_humidity(31, 28) < 90        # 31 C with a 28 C dew point is humid, about 84 %
    assert M.relative_humidity(25, 25) == 100.0          # saturated
    assert M.relative_humidity(20, 40) == 100.0          # never above 100 (a bad report)


def test_one_record_keeps_the_fields_in_the_units_the_app_uses():
    p = M.parse_record(rec(wspd=10, wgst=18, visib="10+"))
    assert p["station"] == "VOTR" and p["time"] == "2026-10-09T03:00:00Z"
    assert p["temp_c"] == 31 and p["dewp_c"] == 28 and p["rh_pct"] is not None
    assert p["wind_kt"] == 10 and abs(p["wind_ms"] - 5.14) < 0.01
    assert p["gust_kt"] == 18 and p["visibility_km"] == 10.0 and p["pressure_hpa"] == 1014


def test_a_report_without_time_or_temperature_is_left_out():
    assert M.parse_record(rec(obsTime=None)) is None
    assert M.parse_record(rec(temp=None)) is None


def test_records_group_by_airport_oldest_first_without_duplicates():
    rows = [rec(obsTime=1791518400), rec(obsTime=1791514800), rec(obsTime=1791514800),
            rec(icaoId="VOSM", obsTime=1791514800)]
    grouped = M.parse_all(rows)
    assert sorted(grouped) == ["VOSM", "VOTR"]
    assert [p["time"] for p in grouped["VOTR"]] == ["2026-10-09T03:00:00Z", "2026-10-09T04:00:00Z"]


def test_a_run_with_no_new_report_leaves_the_file_alone(tmp_path):
    stations = {"VOTR": [M.parse_record(rec())]}
    path = M.save(str(tmp_path), stations)
    first = open(path, encoding="utf-8").read()
    import time
    time.sleep(1.1)                                   # the fetch time would differ by a second
    M.save(str(tmp_path), stations)
    assert open(path, encoding="utf-8").read() == first            # not rewritten: nothing to commit
    stations["VOTR"].append(M.parse_record(rec(obsTime=1791518400)))
    M.save(str(tmp_path), stations)
    assert open(path, encoding="utf-8").read() != first            # a new report is saved
