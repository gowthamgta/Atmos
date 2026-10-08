import json
import os
from datetime import datetime, timedelta, timezone

import numpy as np

import blend
import config as C
from encode import decode_field, encode_field

T0 = datetime(2026, 10, 5, 12, tzinfo=timezone.utc)


def _field(v):
    return np.full((C.NY, C.NX), v, np.float32)


def _write_model(site, model, run, steps, values):
    """A model run: `values[var]` is a function of the step hour. Steps are forecast hours after `run`."""
    run_id = f"{run:%Y%m%dT%H}Z"
    root = os.path.join(site, model, run_id)
    manifest = {"model": model, "run": run_id, "vars": {}, "grid": {"nx": C.NX, "ny": C.NY},
                "steps": [{"h": h, "valid": f"{run + timedelta(hours=h):%Y-%m-%dT%H:%M:%SZ}"} for h in steps]}
    for var, fn in values.items():
        v = C.VARS[var]
        manifest["vars"][var] = {"unit": v.unit, "min": v.lo, "max": v.hi, "encoding": "rg16"}
        for h in steps:
            path = os.path.join(root, var, f"{h:03d}.png")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            open(path, "wb").write(encode_field(_field(fn(h)), v.lo, v.hi, v.bits))
    json.dump(manifest, open(os.path.join(root, "manifest.json"), "w"))
    json.dump({"model": model, "run": run_id}, open(os.path.join(site, model, "latest.json"), "w"))


def _read(site, var, h):
    run_id = json.load(open(os.path.join(site, "blend", "latest.json")))["run"]
    v = C.VARS[var]
    return decode_field(open(os.path.join(site, "blend", run_id, var, f"{h:03d}.png"), "rb").read(), v.lo, v.hi)


def test_weighted_mean_uses_the_weights_and_skips_missing_cells():
    a, b = _field(30), _field(20)
    assert np.allclose(blend.weighted_mean([(3.0, a), (1.0, b)]), 27.5)
    b[0, 0] = np.nan
    out = blend.weighted_mean([(3.0, a), (1.0, b)])
    assert out[0, 0] == 30 and abs(out[1, 1] - 27.5) < 1e-4            # the cell nobody else has is just model a
    nobody = blend.weighted_mean([(1.0, _field(np.nan)), (2.0, _field(np.nan))])
    assert np.isnan(nobody).all()


def test_models_are_lined_up_by_valid_time_and_interpolated_only_between_real_steps(tmp_path):
    site = str(tmp_path)
    _write_model(site, "gfs", T0, [0, 6, 12], {"t2m": lambda h: 20 + h})          # a 6-hourly model started at T0
    c = blend.load_component(site, "gfs")
    valid = lambda h: T0 + timedelta(hours=h)
    assert abs(float(blend.field_at_valid(c, "t2m", valid(6))[0, 0]) - 26) < 0.01
    assert abs(float(blend.field_at_valid(c, "t2m", valid(3))[0, 0]) - 23) < 0.01  # halfway between 20 and 26
    assert blend.field_at_valid(c, "t2m", valid(-3)) is None and blend.field_at_valid(c, "t2m", valid(15)) is None
    assert blend.field_at_valid(c, "u10", valid(3)) is None                          # a variable the model does not have
    far = tmp_path / "sparse"
    _write_model(str(far), "gfs", T0, [0, 12], {"t2m": lambda h: 20})
    assert blend.field_at_valid(blend.load_component(str(far), "gfs"), "t2m", valid(6)) is None    # 12 h apart: not bridged


def test_the_blend_axis_starts_at_the_newest_run_and_runs_to_the_longest_horizon(tmp_path):
    site = str(tmp_path)
    _write_model(site, "ecmwf_ifs", T0, [0, 3, 6, 9, 12], {"t2m": lambda h: 30})
    _write_model(site, "gfs", T0 + timedelta(hours=6), [0, 3, 6, 9], {"t2m": lambda h: 30})
    comps = blend.components_of(site)
    ref, axis = blend.blend_axis(comps)
    assert ref == T0 + timedelta(hours=6)
    assert axis[0] == ref and axis[-1] == T0 + timedelta(hours=15) and len(axis) == 4        # +6, +9, +12, +15 h


def test_build_blends_models_from_different_runs_and_publishes_a_manifest(tmp_path):
    site = str(tmp_path)
    # IFS (weight 3) ran 6 h earlier than GFS (weight 2); its temperature rises 1 degC per hour from 20
    _write_model(site, "ecmwf_ifs", T0, [0, 3, 6, 9, 12, 15, 18], {"t2m": lambda h: 20 + h, "precip": lambda h: 1.0})
    _write_model(site, "gfs", T0 + timedelta(hours=6), [0, 3, 6, 9], {"t2m": lambda h: 40, "precip": lambda h: 3.0})
    _write_model(site, "ukmo", T0, [0, 3], {"t2m": lambda h: 0})                           # ends early: must drop out
    run_id = blend.build(site)
    assert run_id and len(run_id) == len("20261005T1830Z") and run_id.endswith("Z")
    manifest = json.load(open(os.path.join(site, "blend", run_id, "manifest.json")))
    assert manifest["model"] == "blend" and manifest["reference"] == f"{T0 + timedelta(hours=6):%Y%m%dT%HZ}"
    assert manifest["components"] == {"ecmwf_ifs": f"{T0:%Y%m%dT%H}Z", "gfs": f"{T0 + timedelta(hours=6):%Y%m%dT%H}Z", "ukmo": f"{T0:%Y%m%dT%H}Z"}
    assert [s["h"] for s in manifest["steps"]] == [0, 3, 6, 9, 12]                       # relative to the newest run (T0 + 6 h)
    # first blend step is T0+6h: IFS 26 (w3), GFS 40 (w2); UKMO has already ended (its last step is T0+3h)
    assert abs(float(_read(site, "t2m", 0)[0, 0]) - (3 * 26 + 2 * 40) / 5) < 0.02
    assert abs(float(_read(site, "precip", 0)[0, 0]) - (3 * 1 + 2 * 3) / 5) < 0.05
    # past GFS's last step (T0+15h) only IFS is left
    assert abs(float(_read(site, "t2m", 12)[0, 0]) - 38) < 0.02                          # T0+18h: 20 + 18
    assert {"t2m", "precip"} <= set(manifest["vars"])
    latest = json.load(open(os.path.join(site, "blend", "latest.json")))
    assert latest["run"] == run_id and latest["components"] == manifest["components"]


def test_build_needs_at_least_two_models_and_ignores_its_own_output(tmp_path):
    site = str(tmp_path)
    _write_model(site, "gfs", T0, [0, 3], {"t2m": lambda h: 30})
    assert blend.build(site) is None
    _write_model(site, "ecmwf_ifs", T0, [0, 3], {"t2m": lambda h: 20})
    assert blend.build(site)
    assert "blend" not in [c.model for c in blend.components_of(site)]                  # a second build never blends the old blend


def _spike(value, row, col):
    f = np.zeros((C.NY, C.NX), np.float32)
    f[row, col] = value
    return f


def test_gaussian_blur_keeps_constants_ignores_missing_cells_and_spreads_a_spike():
    flat = _field(7.0)
    assert np.allclose(blend.gaussian_blur(flat, 2.5), 7.0, atol=1e-4)               # no darkening at the edges of the domain
    holey = _field(7.0)
    holey[10:14, 10:14] = np.nan
    out = blend.gaussian_blur(holey, 2.5)
    assert np.isnan(out[11, 11]) and np.allclose(out[np.isfinite(out)], 7.0, atol=1e-3)   # NaN stays NaN and does not leak into neighbours
    blurred = blend.gaussian_blur(_spike(100, 50, 50), 2.5)
    assert blurred[50, 50] < 100 and blurred[50, 53] > 0 and abs(float(blurred.sum()) - 100) < 0.5   # spread out, nothing lost


def _block(value, row, col, size=20):
    f = np.zeros((C.NY, C.NX), np.float32)
    f[row:row + size, col:col + size] = value
    return f


def test_probability_matching_keeps_realistic_intensity_when_models_place_the_rain_differently():
    # two models each have a 10 mm area, in different places: a plain mean shows two weak 5 mm areas covering twice the ground
    a, b = _block(10, 40, 40), _block(10, 50, 110)
    mean = blend.weighted_mean([(1.0, a), (1.0, b)])
    assert float(mean.max()) == 5.0 and int((mean > 0).sum()) == 800
    matched = blend.probability_matched(mean, [(1.0, a), (1.0, b)])
    assert float(matched.max()) == 10.0                                              # the models' own intensity
    assert int((matched > 0.01).sum()) == 400                                        # and the wet area of one model, not two
    assert int((matched[matched > 0] == 10.0).sum()) == 400


def test_probability_matching_weights_the_models_and_leaves_missing_cells_missing():
    wet, dry = _field(4.0), _field(0.0)
    pattern = blend.weighted_mean([(3.0, wet), (1.0, dry)])
    assert np.allclose(blend.probability_matched(pattern, [(3.0, wet), (1.0, dry)]), 3.0)    # weighted mean of the two intensities
    partial = pattern.copy()
    partial[:5] = np.nan
    assert np.isnan(blend.probability_matched(partial, [(1.0, wet)])[:5]).all()


def test_sharpen_adds_the_fine_structure_of_the_reference_but_not_to_a_smooth_field():
    smooth = _field(20.0)
    assert np.allclose(blend.sharpen(smooth, smooth), 20.0, atol=1e-4)               # nothing to add
    fine = _field(20.0)
    fine[60:63, 60:63] = 26.0                                                        # a small feature only the fine model has
    consensus = _field(20.0)
    out = blend.sharpen(consensus, fine)
    assert out[61, 61] > 22.0 and out[10, 10] == 20.0 or abs(out[10, 10] - 20.0) < 0.05
    assert blend.sharpen(consensus, None) is consensus                               # no fine model: unchanged


def _write_precip_model(site, model, field):
    run_id = f"{T0:%Y%m%dT%H}Z"
    root = os.path.join(site, model, run_id)
    v = C.VARS["precip"]
    os.makedirs(os.path.join(root, "precip"), exist_ok=True)
    open(os.path.join(root, "precip", "003.png"), "wb").write(encode_field(field, v.lo, v.hi, v.bits))
    json.dump({"model": model, "run": run_id, "vars": {"precip": {"unit": "mm", "min": v.lo, "max": v.hi, "encoding": "rg16"}},
               "grid": {"nx": C.NX, "ny": C.NY}, "steps": [{"h": 3, "valid": f"{T0 + timedelta(hours=3):%Y-%m-%dT%H:%M:%SZ}"}]}, open(os.path.join(root, "manifest.json"), "w"))
    json.dump({"model": model, "run": run_id}, open(os.path.join(site, model, "latest.json"), "w"))


def test_blend_step_keeps_rain_intense_when_models_disagree_on_where_it_falls(tmp_path):
    site = str(tmp_path)
    _write_precip_model(site, "ecmwf_ifs", _block(12, 40, 40))
    _write_precip_model(site, "ukmo", _block(12, 50, 110))
    comps = blend.components_of(site)
    valid = T0 + timedelta(hours=3)
    plain = blend.weighted_mean([(c.weight, blend.field_at_valid(c, "precip", valid)) for c in comps])
    out = blend.blend_step(comps, ["precip"], valid)["precip"]
    assert float(plain.max()) < 8.0                                                   # plain mean: about 12 x 3/5.5 = 6.5 mm/h, over twice the area
    assert float(out.max()) > 10.0                                                    # blend: close to the models' own intensity
    assert int((out > 1.0).sum()) < int((plain > 1.0).sum())                          # and not spread over the sum of the two areas
    assert np.isfinite(out).all() and float(out.min()) >= 0.0                         # never negative


def test_blend_step_with_one_model_is_that_model_unchanged(tmp_path):
    site = str(tmp_path)
    _write_precip_model(site, "ecmwf_ifs", _block(5, 60, 60))
    out = blend.blend_step(blend.components_of(site), ["precip"], T0 + timedelta(hours=3))["precip"]
    assert abs(float(out.max()) - 5.0) < 0.01 and int((out > 0.5).sum()) == 400


def test_the_blend_never_leaves_the_range_of_the_models(tmp_path):
    site = str(tmp_path)
    v = C.VARS["t2m"]
    fine = _field(25.0)
    fine[60:63, 60:63] = 40.0                       # a hot pixel group only the fine model has: the detail step must not push past it
    for model, field in (("ecmwf_ifs", fine), ("gfs", _field(25.0)), ("ecmwf_aifs", _field(24.0))):
        run_id = f"{T0:%Y%m%dT%H}Z"
        root = os.path.join(site, model, run_id)
        os.makedirs(os.path.join(root, "t2m"), exist_ok=True)
        open(os.path.join(root, "t2m", "003.png"), "wb").write(encode_field(field, v.lo, v.hi, v.bits))
        json.dump({"model": model, "run": run_id, "vars": {"t2m": {"unit": "C", "min": v.lo, "max": v.hi, "encoding": "rg16"}},
                   "grid": {"nx": C.NX, "ny": C.NY}, "steps": [{"h": 3, "valid": f"{T0 + timedelta(hours=3):%Y-%m-%dT%H:%M:%SZ}"}]}, open(os.path.join(root, "manifest.json"), "w"))
        json.dump({"model": model, "run": run_id}, open(os.path.join(site, model, "latest.json"), "w"))
    out = blend.blend_step(blend.components_of(site), ["t2m"], T0 + timedelta(hours=3))["t2m"]
    assert float(out.max()) <= 40.01 and float(out.min()) >= 23.99                       # inside [lowest model, highest model]
    assert float(out[61, 61]) > float(out[10, 10]) + 3                                   # but the fine feature is kept


def test_every_model_the_pipeline_builds_is_in_the_blend_and_in_its_resolution_order():
    import run
    # the blend combines the South India models; a model on another grid (the world one) is published alone
    models = {k for k, m in run.MODELS.items() if run.grid_of(m).domain == run.C.DOMAIN}
    assert models == set(blend.WEIGHTS), "a model without a weight would be blended at the default weight, one without a model never"
    assert set(blend.RESOLUTION_ORDER) == models                       # every model can lend its detail, none is missing from the order


def test_the_blend_is_rebuilt_when_a_model_is_rebuilt_under_the_same_run(tmp_path):
    site = str(tmp_path)
    _write_model(site, "ecmwf_ifs", T0, [0, 3], {"t2m": lambda h: 20.0})
    _write_model(site, "gfs", T0, [0, 3], {"t2m": lambda h: 24.0})
    before = blend.inputs_of(blend.components_of(site))
    # IFS is built again for the same run (its pressure levels were empty the first time)
    json.dump({"model": "ecmwf_ifs", "run": f"{T0:%Y%m%dT%H}Z", "format": 2}, open(os.path.join(site, "ecmwf_ifs", "latest.json"), "w"))
    after = blend.inputs_of(blend.components_of(site))
    assert before != after and before["gfs"] == after["gfs"]
    # a run published as incomplete counts as another build again, so the blend follows when it is completed
    json.dump({"model": "ecmwf_ifs", "run": f"{T0:%Y%m%dT%H}Z", "format": 2, "complete": False}, open(os.path.join(site, "ecmwf_ifs", "latest.json"), "w"))
    assert blend.inputs_of(blend.components_of(site)) not in (before, after)


def test_missing_models_are_named(tmp_path):
    site = str(tmp_path)
    _write_model(site, "ecmwf_ifs", T0, [0], {"t2m": lambda h: 20.0})
    _write_model(site, "gfs", T0, [0], {"t2m": lambda h: 24.0})
    missing = blend.missing_models(blend.components_of(site))
    assert "ukmo" in missing and "ecmwf_ifs" not in missing and "gfs" not in missing


def test_rain_over_24_hours_is_the_sum_of_the_blended_rain_rate():
    # a 3 h rate of 1 mm/h for 8 steps is 24 mm over the next 24 h; a missing rate makes its cells NaN
    rates = [np.full((C.NY, C.NX), 1.0, np.float32) for _ in range(12)]
    rates[5][0, 0] = np.nan
    out = blend.rain24_from_precip(rates)
    assert np.allclose(out[0][1, 1], 24.0) and np.allclose(out[3][1, 1], 24.0)
    assert np.isnan(out[0][0, 0]) and np.isnan(out[3][0, 0])      # the windows of steps 0 and 3 hold the missing rate
    assert np.isnan(out[4:]).all()                                  # the last 24 h of the axis have no full day after them


def test_the_blend_writes_a_24_hour_rain_that_matches_its_own_rain_rate(tmp_path):
    site = str(tmp_path)
    hours = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30]
    _write_model(site, "ecmwf_ifs", T0, hours, {"t2m": lambda h: 20, "precip": lambda h: 1.0, "rain24": lambda h: 0.0})
    _write_model(site, "gfs", T0, hours, {"t2m": lambda h: 22, "precip": lambda h: 1.0, "rain24": lambda h: 0.0})
    blend.build(site)
    assert abs(float(_read(site, "rain24", 0)[10, 10]) - 24.0) < 0.1          # 1 mm/h for 24 h, whatever the models' own totals say
    assert abs(float(_read(site, "precip", 0)[10, 10]) - 1.0) < 0.01
