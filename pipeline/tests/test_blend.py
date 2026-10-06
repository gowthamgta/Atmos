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
    manifest = {"model": model, "run": run_id, "vars": {}, "steps": [{"h": h, "valid": f"{run + timedelta(hours=h):%Y-%m-%dT%H:%M:%SZ}"} for h in steps]}
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
    _write_model(str(far), "gdps", T0, [0, 12], {"t2m": lambda h: 20})
    assert blend.field_at_valid(blend.load_component(str(far), "gdps"), "t2m", valid(6)) is None    # 12 h apart: not bridged


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
    assert "px65" not in manifest["vars"] and {"t2m", "precip"} <= set(manifest["vars"])
    latest = json.load(open(os.path.join(site, "blend", "latest.json")))
    assert latest["run"] == run_id and latest["components"] == manifest["components"]


def test_build_needs_at_least_two_models_and_ignores_its_own_output(tmp_path):
    site = str(tmp_path)
    _write_model(site, "gfs", T0, [0, 3], {"t2m": lambda h: 30})
    assert blend.build(site) is None
    _write_model(site, "ecmwf_ifs", T0, [0, 3], {"t2m": lambda h: 20})
    assert blend.build(site)
    assert "blend" not in [c.model for c in blend.components_of(site)]                  # a second build never blends the old blend


def test_the_ensemble_product_is_not_a_model_to_blend(tmp_path):
    site = str(tmp_path)
    _write_model(site, "gfs", T0, [0, 3], {"t2m": lambda h: 30})
    _write_model(site, "ecmwf_ifs", T0, [0, 3], {"t2m": lambda h: 20})
    _write_model(site, "ens", T0, [0, 3], {"t2m": lambda h: 99})          # same layout as a model, but it is not one
    assert sorted(c.model for c in blend.components_of(site)) == ["ecmwf_ifs", "gfs"]
