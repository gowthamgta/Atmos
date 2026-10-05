import pathlib
import sys

import numpy as np
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import fetch_regular as FR
import models_regular
from derive import derive


def test_parse_bbox_reads_south_west_north_east():
    wkt = 'GEOGCRS["WGS 84", USAGE[SCOPE["grid"], BBOX[-89.912125,-180.0,89.912125,179.88281]]]'
    assert FR.parse_bbox(wkt) == (-89.912125, -180.0, 89.912125, 179.88281)
    with pytest.raises(ValueError):
        FR.parse_bbox("no box here")


def test_grid_geometry_matches_the_known_gfs_and_aifs_grids():
    gfs = FR.grid_geometry((-89.912125, -180.0, 89.912125, 179.88281), 1536, 3072)
    assert gfs.dlat == pytest.approx(2 * 89.912125 / 1535, rel=1e-9) and gfs.dlon == pytest.approx(360 / 3072, rel=1e-5)
    aifs = FR.grid_geometry((-90.0, -180.0, 90.0, 179.75), 721, 1440)
    assert aifs.dlat == pytest.approx(0.25) and aifs.dlon == pytest.approx(0.25)


def test_speed_and_direction_become_u_and_v_with_the_meteorological_convention():
    spd = np.array([10.0, 10.0, 10.0, 10.0, 0.0], np.float32)
    deg = np.array([0.0, 90.0, 180.0, 270.0, 123.0], np.float32)   # direction the wind blows FROM
    u, v = FR.speed_dir_to_uv(spd, deg)
    assert np.allclose(u, [0, -10, 0, 10, 0], atol=1e-4)    # from the east blows west (u < 0)
    assert np.allclose(v, [-10, 0, 10, 0, 0], atol=1e-4)    # from the north blows south (v < 0)
    assert np.allclose(np.hypot(u, v), spd, atol=1e-4)


def test_units_are_normalised_to_degC_ms_pa_mm():
    t = np.array([300.0], np.float32)
    assert FR.to_si("temperature", "K", t)[0] == pytest.approx(26.85)
    assert FR.to_si("temperature", "°C", t)[0] == 300.0
    assert FR.to_si("speed", "km/h", np.array([36.0], np.float32))[0] == pytest.approx(10.0)
    assert FR.to_si("speed", "m/s", np.array([5.0], np.float32))[0] == 5.0
    assert FR.to_si("pressure", "hPa", np.array([1012.0], np.float32))[0] == pytest.approx(101200.0)
    assert FR.to_si("pressure", "Pa", np.array([101200.0], np.float32))[0] == 101200.0
    assert FR.to_si("precip", "m", np.array([0.002], np.float32))[0] == pytest.approx(2.0)


def test_rain_window_is_the_gap_to_the_previous_output_time():
    # hourly to +78 h, then 3-hourly (like ICON): the value at +81 h covers 3 h, the value at +78 h covers 1 h
    offsets = [float(h) for h in range(0, 79)] + [81.0, 84.0, 87.0]
    assert FR.accumulation_window(offsets, 6) == 1
    assert FR.accumulation_window(offsets, 78) == 1
    assert FR.accumulation_window(offsets, 81) == 3
    assert FR.accumulation_window([0.0, 6.0, 12.0], 12) == 6      # a 6-hourly model
    assert FR.accumulation_window([0.0], 0) == 1


def test_steps_for_keeps_only_steps_every_dataset_has():
    model = FR.RegularModel(model_id="x", label="X", run_hours=(0,), step_hours=[0, 3, 6, 9, 12],
                            sources=[FR.Source("a", {}), FR.Source("b", {})], unavailable=set())
    info = lambda offs: FR.DatasetInfo(None, offs, (0, 0, 1, 1))  # noqa: E731
    model._info = {"a": info([0.0, 3.0, 6.0, 9.0, 12.0]), "b": info([0.0, 3.0, 6.0, 12.0])}
    assert model.steps_for(None) == [0, 3, 6, 12]
    assert model.precip_window_hours(12) == 3


def test_every_regular_model_is_consistent():
    ids = [m.MODEL_ID for m in models_regular.ALL]
    assert len(set(ids)) == len(ids)
    for m in models_regular.ALL:
        assert m.STEP_HOURS[0] == 0 and m.STEP_HOURS == sorted(m.STEP_HOURS) and m.RUN_HOURS
        provided = {k for s in m.sources for k in s.vars} | {k for s in m.sources for w in s.winds for k in w[:2]}
        # a model that does not list a variable must declare it unavailable, and the reverse
        wants = {"rh": "relative_humidity_2m", "gust": "wind_gusts_10m", "cape": "cape", "tcwv": "total_column_integrated_water_vapour",
                 "u850": "wind_u_component_850hPa", "u500": "wind_u_component_500hPa"}
        for pub, raw in wants.items():
            assert (raw in provided) == (pub not in m.UNAVAILABLE_VARS), (m.MODEL_ID, pub)
        assert ("rh" in m.UNAVAILABLE_VARS) == ("feels" in m.UNAVAILABLE_VARS)   # feels-like needs humidity
        assert "wind_u_component_10m" in provided and "temperature_2m" in provided


def test_a_model_without_humidity_still_derives_without_crashing():
    z = np.zeros((2, 2), np.float32)
    raw = {"temperature_2m": z + 30, "wind_u_component_10m": z, "wind_v_component_10m": z, "wind_gusts_10m": z + np.nan,
           "pressure_msl": z + 101000, "precipitation": z, "cloud_cover": z, "cape": z + np.nan,
           "total_column_integrated_water_vapour": z + np.nan}
    out = derive(raw, 3)
    assert np.isnan(out["rh"]).all() and np.isnan(out["feels"]).all()
    assert np.allclose(out["t2m"], 30)
