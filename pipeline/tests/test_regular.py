import pathlib
import sys

import numpy as np
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import fetch_regular as FR
import models_regular
from derive import derive

ENSEMBLE = frozenset({"px0", "xr"})   # supplied by attach.py, never by a single model


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
                            sources=[FR.Source("a", {}), FR.Source("b", {})])
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


# --- pressure levels, extra parameters and availability ---------------------------------------------------------

import config as C
import derive as D
import encode as E
import fetch_aifs, fetch_gfs, fetch_ifs


def test_every_level_has_five_fields_with_sensible_ranges():
    assert C.LEVELS == (925, 850, 700, 500, 300, 250, 200)
    for lvl in C.LEVELS:
        for kind in ("u", "v", "t", "rh", "gh"):
            var = C.VARS[f"{kind}{lvl}"]
            assert var.hi > var.lo and var.bits == 12
    # a typical value of each level must sit inside its encoding range (no clipping)
    assert C.VARS["t850"].lo < 20 < C.VARS["t850"].hi and C.VARS["t500"].lo < -8 < C.VARS["t500"].hi
    assert C.VARS["gh500"].lo < 5880 < C.VARS["gh500"].hi and C.VARS["gh200"].lo < 12400 < C.VARS["gh200"].hi
    assert C.VARS["t300"].lo < -42 < C.VARS["t300"].hi and C.VARS["t200"].lo < -55 < C.VARS["t200"].hi


def test_dew_point_is_the_inverse_of_relative_humidity():
    t = np.array([30.0, 20.0, 5.0], np.float32)
    td = np.array([25.0, 10.0, -3.0], np.float32)
    rh = D.relative_humidity(t, td)
    assert np.allclose(D.dew_point(t, rh), td, atol=0.05)
    assert np.allclose(D.dew_point(t, np.array([100, 100, 100], np.float32)), t, atol=0.05)   # saturated: dew point = air temperature


def _raw(**extra):
    z = np.zeros((2, 2), np.float32)
    raw = {"temperature_2m": z + 30, "relative_humidity_2m": z + 70, "wind_u_component_10m": z, "wind_v_component_10m": z,
           "wind_gusts_10m": z, "pressure_msl": z + 101000, "precipitation": z, "cloud_cover": z, "cape": z,
           "total_column_integrated_water_vapour": z}
    raw.update({k: z + v for k, v in extra.items()})
    return raw


def test_derive_handles_levels_and_the_extra_surface_parameters():
    out = D.derive(_raw(temperature_850hPa=20, relative_humidity_850hPa=60, geopotential_height_850hPa=1500,
                        wind_u_component_850hPa=8, wind_v_component_850hPa=-2, cloud_cover_low=40, cloud_cover_mid=20,
                        cloud_cover_high=10, visibility=12000, shortwave_radiation=650))
    assert np.allclose(out["t850"], 20) and np.allclose(out["rh850"], 60) and np.allclose(out["gh850"], 1500)
    assert np.allclose(out["u850"], 8) and np.allclose(out["v850"], -2)
    assert np.allclose(out["cloud_low"], 40) and np.allclose(out["cloud_high"], 10)
    assert np.allclose(out["vis"], 12.0)          # metres in the file, kilometres published
    assert np.allclose(out["solar"], 650)
    assert np.allclose(out["dew"], D.dew_point(np.float32(30), np.float32(70)), atol=0.01)   # derived from temperature and humidity
    assert np.isnan(out["t500"]).all()            # a level the model lacks stays empty


def test_dew_point_prefers_the_models_own_value():
    out = D.derive(_raw(dew_point_2m=22.5))
    assert np.allclose(out["dew"], 22.5)


def test_unavailable_for_follows_the_raw_fields_a_model_has():
    everything = set(D.LEVEL_RAW_KEYS) | {"temperature_2m", "relative_humidity_2m", "wind_u_component_10m", "wind_v_component_10m",
        "wind_gusts_10m", "pressure_msl", "precipitation", "cloud_cover", "cape", "total_column_integrated_water_vapour",
        "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high", "visibility", "shortwave_radiation",
            "convective_inhibition", "lifted_index"}
    assert D.unavailable_for(everything) == {"px0", "xr"}   # only attach.py supplies those
    no_humidity = everything - {"relative_humidity_2m"}
    assert D.unavailable_for(no_humidity) - ENSEMBLE == {"rh", "feels", "dew"}                        # none of the three can be made
    assert D.unavailable_for(no_humidity | {"dew_point_2m"}) == ENSEMBLE                 # a dew point restores all three
    assert D.unavailable_for(everything - {"wind_v_component_10m"}) - ENSEMBLE == {"v10", "feels"}     # feels-like needs both wind components
    assert D.unavailable_for(everything - {"geopotential_height_500hPa"}) - ENSEMBLE == {"gh500"}
    assert D.unavailable_for(everything - {"relative_humidity_200hPa"}) - ENSEMBLE == {"rh200"}


def test_the_three_hand_written_models_provide_all_levels():
    for mod in (fetch_ifs, fetch_gfs, fetch_aifs):
        for key in D.LEVEL_RAW_KEYS:
            assert key in mod.PROVIDES, (mod.MODEL_ID, key)
        assert not any(v[0] in "utv" and v[1:].isdigit() for v in mod.UNAVAILABLE_VARS if v[1:].isdigit())


def test_regular_models_publish_what_their_datasets_have():
    by_id = {m.MODEL_ID: m for m in models_regular.ALL}
    assert {"cloud_low", "cloud_mid", "cloud_high"} <= by_id["gdps"].UNAVAILABLE_VARS     # the Canadian surface set has none
    assert by_id["ukmo"].UNAVAILABLE_VARS - {"px0", "xr"} == {"solar", "tcwv", "li"}                            # UKMO: everything else, winds via speed + direction
    assert "vis" not in by_id["cma_grapes"].UNAVAILABLE_VARS and "solar" not in by_id["cma_grapes"].UNAVAILABLE_VARS
    for m in models_regular.ALL:
        # every model has all seven levels (vertical velocity is published by only some)
        assert not {k for k in D.LEVEL_RAW_KEYS if not k.startswith("vertical_velocity")} - m.PROVIDES - {"relative_humidity_200hPa"}, m.MODEL_ID


def test_reduced_precision_encoding_stays_within_its_error_bound_and_compresses_better():
    rng = np.random.default_rng(3)
    base = np.linspace(-20, 20, 181 * 221, dtype=np.float32).reshape(181, 221)
    field = base + rng.normal(0, 0.05, base.shape).astype(np.float32)
    full = E.encode_field(field, -30, 30)
    coarse = E.encode_field(field, -30, 30, bits=12)
    back = E.decode_field(coarse, -30, 30)
    assert np.abs(back - field).max() <= (60 / 65535) * 8 + 1e-3          # half a 12-bit step, 16 codes wide
    assert len(coarse) < len(full)
    assert np.isnan(E.decode_field(E.encode_field(np.array([[np.nan, 1.0]], np.float32), -30, 30, bits=12), -30, 30)[0, 0])


def test_stability_variables_come_from_the_models_that_have_them():
    by_id = {m.MODEL_ID: m for m in models_regular.ALL}
    assert "cin" not in by_id["ukmo"].UNAVAILABLE_VARS and "li" in by_id["ukmo"].UNAVAILABLE_VARS      # UKMO: CIN only
    assert not ({"cin", "li"} & by_id["cma_grapes"].UNAVAILABLE_VARS)                                    # GRAPES: both
    assert {"cin", "li"} <= by_id["dwd_icon"].UNAVAILABLE_VARS and {"cin", "li"} <= by_id["gdps"].UNAVAILABLE_VARS
    assert not ({"cin", "li"} & fetch_gfs.UNAVAILABLE_VARS)                                              # GFS: both
    assert "cin" not in fetch_ifs.UNAVAILABLE_VARS and "li" in fetch_ifs.UNAVAILABLE_VARS                # IFS: CIN only


def test_cin_is_published_as_a_magnitude_whatever_the_sign_of_the_source():
    z = np.zeros((2, 3), np.float32)
    base = {"temperature_2m": z + 30, "relative_humidity_2m": z + 70, "wind_u_component_10m": z, "wind_v_component_10m": z,
            "wind_gusts_10m": z, "pressure_msl": z + 101000, "precipitation": z, "cloud_cover": z, "cape": z,
            "total_column_integrated_water_vapour": z + 50}
    assert np.allclose(D.derive({**base, "convective_inhibition": z - 248})["cin"], 248)   # UK Met Office: negative
    assert np.allclose(D.derive({**base, "convective_inhibition": z + 216})["cin"], 216)   # GFS, IFS, GRAPES: positive
    assert np.isnan(D.derive(base)["cin"]).all() and np.isnan(D.derive(base)["li"]).all()
    assert np.allclose(D.derive({**base, "lifted_index": z - 5})["li"], -5)


def _field(v):
    return np.full((2, 2), v, np.float32)


def test_forward_accumulation_sums_exact_windows():
    # IFS late in the run: 3-hourly steps, each rate is the mean over the 3 h before it
    rates = {h: _field(2.0) for h in range(0, 49, 3)}
    rates[0] = _field(np.nan)
    acc = D.forward_accumulation(rates, {h: 3 for h in rates})
    assert np.allclose(acc[0], 2.0 * 24)
    assert np.allclose(acc[24], 2.0 * 24)
    assert np.isnan(acc[27]).all() and np.isnan(acc[48]).all()      # the run ends before 24 h more


def test_forward_accumulation_follows_the_rate_in_each_gap():
    rates = {h: _field(0.0) for h in range(0, 43, 6)}
    rates[12] = _field(5.0)         # the 6 h before +12 h rained 5 mm/h
    acc = D.forward_accumulation(rates, {h: 6 for h in rates})
    assert np.allclose(acc[0], 30.0)                  # 5 mm/h x 6 h
    assert np.allclose(acc[6], 30.0)
    assert np.allclose(acc[12], 0.0)                  # that rain is in the past by then


def test_forward_accumulation_estimates_sampled_models_from_neighbouring_rates():
    # hourly rate sampled every 3 h (window 1 < spacing 3): the gap uses the mean of the rates at both ends
    rates = {0: _field(np.nan), 3: _field(4.0), 6: _field(0.0), 9: _field(0.0), 12: _field(0.0), 15: _field(0.0),
             18: _field(0.0), 21: _field(0.0), 24: _field(0.0), 27: _field(0.0)}
    acc = D.forward_accumulation(rates, {h: 1 for h in rates})
    # gaps: (0,3] has no earlier rate so uses 4.0 -> 12 mm; (3,6] uses (4+0)/2 -> 6 mm; the rest dry
    assert np.allclose(acc[0], 12.0 + 6.0)
    assert np.allclose(acc[3], 6.0)


def test_forward_accumulation_needs_the_whole_24_hours():
    rates = {h: _field(1.0) for h in (0, 3, 6, 9, 12, 15, 18, 21, 24)}
    assert np.allclose(D.forward_accumulation(rates, {h: 3 for h in rates})[0], 24.0)
    # a step that is missing just makes a longer gap, which is estimated like any sampled gap: still a value
    gappy = {h: _field(1.0) for h in (0, 3, 6, 12, 15, 18, 21, 24)}
    assert np.allclose(D.forward_accumulation(gappy, {h: 3 for h in gappy})[0], 24.0)
    # no step lands exactly 24 h on, or the run is a short local test: no accumulation
    odd = {h: _field(1.0) for h in (0, 5, 10, 15, 20, 25)}
    assert np.isnan(D.forward_accumulation(odd, {h: 5 for h in odd})[0]).all()
    partial = {h: _field(1.0) for h in (0, 3)}
    assert all(np.isnan(f).all() for f in D.forward_accumulation(partial, {0: 1, 3: 1}).values())


def test_forward_extreme_takes_the_lowest_and_highest_of_the_next_24_hours():
    temps = {h: np.full((2, 2), float(t), np.float32) for h, t in zip(range(0, 49, 6), [20, 18, 30, 25, 22, 31, 24, 19, 21])}
    low = D.forward_extreme(temps, np.fmin)
    high = D.forward_extreme(temps, np.fmax)
    assert low[0][0, 0] == 18 and high[0][0, 0] == 30          # steps 0..24
    assert low[12][0, 0] == 22 and high[12][0, 0] == 31        # steps 12..36
    assert low[24][0, 0] == 19 and high[24][0, 0] == 31        # steps 24..48
    assert np.isnan(low[30]).all() and np.isnan(high[48]).all()  # the run ends before the window does


def test_vorticity_and_divergence_of_simple_winds():
    import config
    R = 6.371e6
    lat = np.radians(config.LAT_MAX - config.STEP_DEG * np.arange(config.NY))[:, None] * np.ones((1, config.NX))
    lon = np.radians(config.LON_MIN + config.STEP_DEG * np.arange(config.NX))[None, :] * np.ones((config.NY, 1))
    # solid-body rotation about the pole: u = w R cos(lat), v = 0 has vorticity 2 w sin(lat)
    omega = 1e-5
    u = (omega * R * np.cos(lat)).astype(np.float32)
    vo, dv = D.vorticity_divergence(u, np.zeros_like(u))
    row = round((config.LAT_MAX - 13.0) / config.STEP_DEG)
    assert abs(float(vo[row, 100]) - 2 * 1.0 * np.sin(np.radians(13.0))) < 0.02       # in 1e-5 per second
    assert abs(float(dv[row, 100])) < 0.02
    # a uniform eastward-growing u (in metres) spreads the air out: divergence du/dx
    u2 = (3e-6 * R * np.cos(lat) * lon).astype(np.float32)                             # du/dx = 3e-6 per second
    _, dv2 = D.vorticity_divergence(u2, np.zeros_like(u2))
    assert abs(float(dv2[row, 100]) - 0.3) < 0.02


def test_the_new_level_fields_exist_and_are_derived_from_the_level_winds():
    assert "w250" in C.VARS and "vo925" in C.VARS and "dv200" in C.VARS
    assert D.NEEDS["vo250"] == [{"wind_u_component_250hPa", "wind_v_component_250hPa"}]
    assert D.NEEDS["w500"] == [{"vertical_velocity_500hPa"}]
