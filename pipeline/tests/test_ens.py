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


def _write_global_grib(path, lon_first, ni, nj, value_at):
    """A global 0.25 degree regular lat/lon GRIB2 file of total precipitation in ECMWF's layout (north first, the given first longitude)."""
    import eccodes as ec
    gid = ec.codes_grib_new_from_samples("regular_ll_sfc_grib2")
    for key, value in [("Ni", ni), ("Nj", nj), ("latitudeOfFirstGridPointInDegrees", 90.0), ("latitudeOfLastGridPointInDegrees", -90.0),
                       ("longitudeOfFirstGridPointInDegrees", float(lon_first)), ("longitudeOfLastGridPointInDegrees", float((lon_first + 359.75) % 360)),
                       ("iDirectionIncrementInDegrees", 0.25), ("jDirectionIncrementInDegrees", 0.25), ("jScansPositively", 0)]:
        ec.codes_set(gid, key, value)
    ec.codes_set(gid, "paramId", 228)               # tp
    lats = 90.0 - 0.25 * np.arange(nj)
    lons = (lon_first + 0.25 * np.arange(ni)) % 360
    ec.codes_set_values(gid, np.array([[value_at(la, lo) for lo in lons] for la in lats], np.float64).ravel())
    with open(path, "wb") as f:
        ec.codes_write(gid, f)
    ec.codes_release(gid)


def test_the_reader_places_longitudes_correctly_for_a_grid_that_starts_at_180_east(tmp_path):
    pytest = __import__("pytest")
    pytest.importorskip("eccodes")
    import config as C
    path = str(tmp_path / "tp.grib2")
    # total precipitation in metres that depends on both longitude and latitude: 0.01 mm per degree east + 0.0001 mm per degree north
    _write_global_grib(path, 180.0, 1440, 721, lambda la, lo: 1e-5 * lo + 1e-7 * la)
    out = ens.read_members(path)[0]

    def at(lat, lon):
        return float(out[round((C.LAT_MAX - lat) / C.STEP_DEG), round((lon - C.LON_MIN) / C.STEP_DEG)])

    for lat, lon in [(13.0, 80.0), (13.0, 70.0), (8.0, 88.0), (20.0, 75.5)]:
        assert abs(at(lat, lon) - (0.01 * lon + 0.0001 * lat)) < 0.005, (lat, lon, at(lat, lon))
    # a field that only varies by latitude (reading the wrong half of the globe, the original bug) has identical columns
    assert np.abs(np.diff(out, axis=1)).mean() > 0.0005     # the field rises 0.001 mm per 0.1 degree east


def test_a_grid_that_starts_at_0_east_is_read_the_same_way(tmp_path):
    pytest = __import__("pytest")
    pytest.importorskip("eccodes")
    import config as C
    path = str(tmp_path / "tp0.grib2")
    _write_global_grib(path, 0.0, 1440, 721, lambda la, lo: 1e-5 * lo + 1e-7 * la)
    out = ens.read_members(path)[0]
    assert abs(float(out[round((C.LAT_MAX - 13.0) / C.STEP_DEG), round((80.0 - C.LON_MIN) / C.STEP_DEG)]) - (0.01 * 80 + 0.0001 * 13)) < 0.005


def test_a_run_built_by_an_older_version_of_the_method_is_not_treated_as_live(monkeypatch):
    class Reply:
        ok = True
        def __init__(self, payload): self._payload = payload
        def json(self): return self._payload
    import requests
    monkeypatch.setattr(requests, "get", lambda url, timeout=30: Reply({"run": "20261005T18Z"}))                        # no version: the buggy v1
    assert ens.live_run("u") is None
    monkeypatch.setattr(requests, "get", lambda url, timeout=30: Reply({"run": "20261005T18Z", "version": ens.VERSION - 1}))
    assert ens.live_run("u") is None
    monkeypatch.setattr(requests, "get", lambda url, timeout=30: Reply({"run": "20261005T18Z", "version": ens.VERSION}))
    assert ens.live_run("u") == "20261005T18Z"
