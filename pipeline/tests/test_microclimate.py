import json
import os
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

import config as C
import microclimate as M
from encode import encode_field

UTC = timezone.utc


def test_heat_index_matches_the_nws_table():
    # NWS table: 90 F at 70 % humidity feels like 106 F; 100 F at 50 % feels like 118 F
    assert abs(float(M.heat_index_c(32.2, 70)) * 1.8 + 32 - 106) < 1.0
    assert abs(float(M.heat_index_c(37.8, 50)) * 1.8 + 32 - 118) < 1.0


def test_heat_index_is_never_below_the_air_temperature_and_bands_by_degree():
    assert float(M.heat_index_c(25, 40)) == pytest.approx(25, abs=0.01)
    assert M.heat_band(26) == "Comfortable" and M.heat_band(28) == "Caution"
    assert M.heat_band(33) == "Extreme caution" and M.heat_band(42) == "Danger" and M.heat_band(60) == "Extreme danger"


def test_flood_bands_follow_the_imd_classes():
    assert M.flood_band(30) == "Low" and M.flood_band(64.4) == "Low"
    assert M.flood_band(64.5) == "Heavy rain" and M.flood_band(120) == "Very heavy rain" and M.flood_band(250) == "Extremely heavy rain"


def test_a_point_inside_a_square_only():
    sq = np.array([[80.0, 10.0], [81.0, 10.0], [81.0, 11.0], [80.0, 11.0], [80.0, 10.0]])
    lons = np.array([80.5, 82.0, 80.9])
    lats = np.array([10.5, 10.5, 11.5])
    assert M.inside_rings(lons, lats, [sq]).tolist() == [True, False, False]


def test_rain_timing_finds_the_start_end_and_peak():
    times = [datetime(2026, 10, 8, 0, tzinfo=UTC) + timedelta(hours=3 * k) for k in range(8)]
    precip = np.array([0.0, 0.1, 0.8, 2.0, 0.3, 0.0, 0.0, 0.0])
    r = M.rain_timing(times, precip, list(range(8)))
    assert r["start"] == "2026-10-08T06:00:00Z" and r["end"] == "2026-10-08T12:00:00Z"
    assert r["peakMmH"] == 2.0 and r["peakTime"] == "2026-10-08T09:00:00Z"
    assert r["ongoing"] is False


def test_rain_already_falling_is_ongoing_and_dry_means_no_start():
    times = [datetime(2026, 10, 8, 0, tzinfo=UTC) + timedelta(hours=3 * k) for k in range(3)]
    ongoing = M.rain_timing(times, np.array([1.0, 0.0, 0.0]), [0, 1, 2])
    assert ongoing["ongoing"] is True and ongoing["start"] == "2026-10-08T00:00:00Z"
    dry = M.rain_timing(times, np.zeros(3), [0, 1, 2])
    assert dry["start"] is None and dry["end"] is None


def test_sea_breeze_needs_onshore_wind_in_the_afternoon_on_a_coast():
    times = [datetime(2026, 10, 8, 0, tzinfo=UTC) + timedelta(hours=3 * k) for k in range(8)]    # IST 05:30 .. 23:30
    u = np.array([0, 0, 0, -1.0, -3.0, -3.5, 0, 0])                                              # u < 0 blows westward, i.e. from the east (the sea)
    v = np.zeros(8)
    sb = M.sea_breeze(times, u, v, [(1, 0)], list(range(8)))                                       # east coast: sea to the east
    assert sb["likely"] is True and sb["from"] == "2026-10-08T12:00:00Z" and sb["peakOnshoreMs"] == 3.0   # the 3.5 m/s at 20:30 IST is outside the 09 to 18 window
    weak = M.sea_breeze(times, u * 0.5, v, [(1, 0)], list(range(8)))
    assert weak["likely"] is False
    offshore = M.sea_breeze(times, -u, v, [(1, 0)], list(range(8)))                                # blowing out to sea
    assert offshore["from"] is None and offshore["likely"] is False


def test_wind_direction_is_where_the_wind_comes_from():
    u = np.array([0.0, -5.0]); v = np.array([-5.0, 0.0])                                         # southward, westward
    frm = (np.degrees(np.arctan2(-u, -v)) + 360.0) % 360.0
    assert frm.round().tolist() == [0.0, 90.0]


def test_the_tamil_nadu_districts_load_with_their_boundaries():
    ds = M.load_districts(M.DISTRICTS_FILE)
    names = {d["name"] for d in ds}
    assert len(ds) == 38 and {"Chennai", "Coimbatore", "Kanniyakumari", "Madurai"} <= names
    lat, lon = M.centroid(next(d for d in ds if d["name"] == "Chennai"))
    assert 12.8 < lat < 13.3 and 79.9 < lon < 80.4


def _write_blend(site: str, run: str, valid: list[datetime], values: dict[str, float]) -> None:
    root = os.path.join(site, "blend")
    os.makedirs(os.path.join(root, run), exist_ok=True)
    vars_ = {}
    steps = []
    for k, t in enumerate(valid):
        steps.append({"h": k * 3, "valid": t.strftime("%Y-%m-%dT%H:%M:%SZ")})
    for name, (lo, hi) in {"t2m": (-10, 50), "rh": (0, 100), "u10": (-60, 60), "v10": (-60, 60), "precip": (0, 100),
                           "rain24": (0, 600)}.items():
        vars_[name] = {"unit": "x", "min": lo, "max": hi, "encoding": "rg16"}
        for k in range(len(valid)):
            path = os.path.join(root, run, name, f"{k * 3:03d}.png")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            value = values[name](k) if callable(values.get(name)) else values[name]
            open(path, "wb").write(encode_field(np.full((C.NY, C.NX), value, np.float32), lo, hi, 16))
    json.dump({"run": run}, open(os.path.join(root, "latest.json"), "w"))
    json.dump({"run": run, "steps": steps, "vars": vars_}, open(os.path.join(root, run, "manifest.json"), "w"))


def test_a_whole_run_gives_every_district_its_values_and_indicators(tmp_path):
    site = str(tmp_path)
    valid = [datetime(2026, 10, 8, 0, tzinfo=UTC) + timedelta(hours=3 * k) for k in range(12)]     # 00 to 33 UTC
    _write_blend(site, "20261008T00Z", valid, {
        "t2m": lambda k: 30 + k * 0.5,
        "rh": 70, "u10": -4.0, "v10": 0.0,
        "precip": lambda k: 3.0 if k in (5, 6) else 0.0,
        "rain24": lambda k: 80.0 if k == 6 else 10.0,
    })
    got = M.read_blend(site)
    assert got is not None
    run, times, fields = got
    data = M.build((run, times, fields), M.load_districts(M.DISTRICTS_FILE), now=valid[0])
    assert data["run"] == "20261008T00Z" and len(data["times"]) == 12
    chennai = next(d for d in data["districts"] if d["name"] == "Chennai")
    assert chennai["coastal"] is True and len(chennai["series"]["tempC"]) == 12
    assert chennai["series"]["windFromDeg"][0] == 90.0                                # blowing west: from the east, from the sea
    assert chennai["indicators"]["heat"]["band"] in ("Danger", "Extreme caution", "Caution", "Extreme danger")
    assert chennai["indicators"]["rain"]["start"] == "2026-10-08T15:00:00Z"
    assert chennai["indicators"]["seaBreeze"]["likely"] is True
    assert chennai["indicators"]["flood"]["band"] == "Heavy rain" and chennai["indicators"]["flood"]["peakMm"] == 80.0
    madurai = next(d for d in data["districts"] if d["name"] == "Madurai")
    assert madurai["coastal"] is False and madurai["indicators"]["seaBreeze"] is None


def test_no_blend_writes_nothing(tmp_path):
    assert M.read_blend(str(tmp_path)) is None
