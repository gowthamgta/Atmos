import obs_synop as S

SALEM = "AAXX 09004 43325 31596 60000 10264 20241 39805 40116 70522 83531 333 59018="                       # 09 Oct 00 UTC, real report
ARIYALUR = "AAXX 09034 43324 22597 22301 10282 20232 30004 40090 82500 333 10320 20250 58003 6001/ 555 00012 10010="
LISTING = "\n".join([
    f"43325,2026,10,09,00,00,{SALEM}",
    f"43324,2026,10,09,03,00,{ARIYALUR}",
    "43326,2026,10,09,03,00,AAXX 09034 43326 NIL=",                       # a station that sent nothing
    "43001,2026,10,09,03,00,AAXX 09034 43001 31995 00000 10266 20218 40126=",    # not in Tamil Nadu
    f"43325,2026,10,09,00,00,{SALEM}",                                    # the same report twice
])


def test_decodes_temperature_dew_point_pressure_and_calm_wind():
    r = S.decode(SALEM)
    assert r["temp_c"] == 26.4 and r["dewp_c"] == 24.1
    assert r["stn_hpa"] == 980.5 and r["msl_hpa"] == 1011.6          # the thousands are dropped in the code
    assert r["wind_kt"] == 0.0 and r["wind_dir"] is None            # a calm has no direction
    assert 85 < r["rh_pct"] < 92                                    # worked out from the temperature and dew point
    assert r["rain_mm"] is None                                     # this report carries no rain


def test_decodes_wind_extremes_and_rain_of_the_third_section():
    r = S.decode(ARIYALUR)
    assert r["wind_dir"] == 230 and r["wind_kt"] == 1.0 and abs(r["wind_ms"] - 0.51) < 0.01
    assert r["temp_c"] == 28.2 and r["dewp_c"] == 23.2 and r["msl_hpa"] == 1009.0 and r["stn_hpa"] == 1000.4
    assert r["tmax_c"] == 32.0 and r["tmin_c"] == 25.0
    assert r["rain_mm"] == 1.0 and r["rain_hours"] is None          # "6001/": 1 mm, period not given


def test_rain_codes_trace_tenths_and_period():
    base = "AAXX 09034 43325 11596 60000 10264 20241 39805 40116 "
    assert S.decode(base + "69901=")["rain_mm"] == 0.0               # 990 is a trace
    r = S.decode(base + "69953=")
    assert r["rain_mm"] == 0.5 and r["rain_hours"] == 18             # 995 = 0.5 mm over 18 h (period code 3)
    assert S.decode(base + "60252=")["rain_mm"] == 25.0 and S.decode(base + "60252=")["rain_hours"] == 12


def test_negative_temperatures_and_relative_humidity_in_place_of_dew_point():
    r = S.decode("AAXX 09034 43317 31596 60000 11015 29072 40116=")
    assert r["temp_c"] == -1.5 and r["rh_pct"] == 72.0 and r["dewp_c"] is None


def test_wind_in_metres_per_second_is_converted_to_knots():
    r = S.decode("AAXX 09031 43325 31596 60510 10264 20241 40116=")  # the date group's last digit 1: m/s
    assert r["wind_dir"] == 50 and abs(r["wind_kt"] - 19.4) < 0.1 and abs(r["wind_ms"] - 10.0) < 0.05


def test_nil_and_empty_reports_have_no_values():
    assert S.decode("AAXX 09034 43326 NIL=") is None
    assert S.decode("") is None


def test_the_listing_keeps_tamil_nadu_stations_once_each_oldest_first():
    got = S.parse_listing(LISTING)
    assert sorted(got) == ["43324", "43325"]
    assert [r["time"] for r in got["43325"]] == ["2026-10-09T00:00:00Z"] and got["43325"][0]["name"] == "Salem"
    assert got["43324"][0]["raw"].startswith("AAXX 09034 43324")


def test_archive_and_latest_do_not_rewrite_unchanged_files(tmp_path):
    from datetime import datetime, timezone
    got = S.parse_listing(LISTING)
    assert len(S.archive(str(tmp_path / "a"), got)) == 1
    lines = (tmp_path / "a" / "2026-10.csv").read_text(encoding="utf-8").splitlines()
    assert lines[0].startswith("station,time,temp_c") and len(lines) == 3
    assert S.archive(str(tmp_path / "a"), got) == []                  # nothing new
    now = datetime(2026, 10, 9, 6, tzinfo=timezone.utc)
    assert S.save(str(tmp_path / "o"), got, now=now) is not None
    assert S.save(str(tmp_path / "o"), got, now=now) is None


def test_every_station_has_a_position_in_tamil_nadu_or_puducherry():
    for code, (name, lat, lon, elev) in S.STATIONS.items():
        assert code.startswith("43") and 8 <= lat <= 13.6 and 76.2 <= lon <= 80.4, name
