import json
import os
from datetime import datetime, timedelta, timezone

import numpy as np

import attach
import config as C
from encode import decode_field, encode_field

RUN = datetime(2026, 10, 5, 18, tzinfo=timezone.utc)


def _field(v):
    return np.full((C.NY, C.NX), v, np.float32)


def _write_ens(site, starts):
    """An ensemble product whose px0 equals the start hour (so it is easy to tell which start a value came from)."""
    root = os.path.join(site, "ens", "20261005T18Z")
    for name in ("px0", "xr"):
        for h in starts:
            path = os.path.join(root, name, f"{h:03d}.png")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            open(path, "wb").write(encode_field(_field(float(h)) if name == "px0" else _field(2.0 * h), 0, 100, 12))
    vars_ = {n: {"unit": "%", "min": 0, "max": 100, "encoding": "rg16"} for n in ("px0", "xr")}
    steps = [{"h": h, "valid": f"{RUN + timedelta(hours=h):%Y-%m-%dT%H:%M:%SZ}"} for h in starts]
    json.dump({"model": "ens", "run": "20261005T18Z", "steps": steps, "vars": vars_}, open(os.path.join(root, "manifest.json"), "w"))
    json.dump({"model": "ens", "run": "20261005T18Z"}, open(os.path.join(site, "ens", "latest.json"), "w"))


def _write_model(site, model, run, step_hours):
    root = os.path.join(site, model, f"{run:%Y%m%dT%H}Z")
    os.makedirs(root, exist_ok=True)
    steps = [{"h": h, "valid": f"{run + timedelta(hours=h):%Y-%m-%dT%H:%M:%SZ}"} for h in step_hours]
    json.dump({"model": model, "run": f"{run:%Y%m%dT%H}Z", "steps": steps, "vars": {"t2m": {"unit": "C", "min": -10, "max": 50, "encoding": "rg16"}}, "notes": {}},
              open(os.path.join(root, "manifest.json"), "w"))
    json.dump({"model": model, "run": f"{run:%Y%m%dT%H}Z"}, open(os.path.join(site, model, "latest.json"), "w"))
    return root


def _px0(root, h):
    v = C.VARS["px0"]
    return decode_field(open(os.path.join(root, "px0", f"{h:03d}.png"), "rb").read(), v.lo, v.hi)


def test_field_at_uses_exact_starts_mixes_between_them_and_is_empty_outside():
    starts = {0: _field(10), 6: _field(20), 12: _field(60)}
    assert np.allclose(attach.field_at(starts, 6), 20)
    assert np.allclose(attach.field_at(starts, 3), 15)          # halfway between 10 and 20
    assert np.allclose(attach.field_at(starts, 9), 40)          # halfway between 20 and 60
    assert np.isnan(attach.field_at(starts, -3)).all() and np.isnan(attach.field_at(starts, 15)).all()


def test_attach_aligns_the_ensemble_to_each_models_valid_times(tmp_path):
    site = str(tmp_path)
    _write_ens(site, [0, 6, 12, 18])
    # IFS run 6 hours before the ensemble run: its step 6 is valid when the ensemble starts, step 12 is 6 h in
    root = _write_model(site, "ecmwf_ifs", RUN - timedelta(hours=6), [0, 3, 6, 9, 12, 15])
    run, fields = attach.load_ens(site)
    assert run == RUN
    assert attach.attach_model(site, "ecmwf_ifs", run, fields)
    tol = 100 / 4095                                              # 12-bit quantisation of a 0-100 range
    assert np.isnan(_px0(root, 0)).all() and np.isnan(_px0(root, 3)).all()     # before the ensemble began
    assert abs(float(_px0(root, 6)[5, 5]) - 0) < tol                            # valid at the ensemble start (+0 h)
    assert abs(float(_px0(root, 9)[5, 5]) - 3) < tol                            # +3 h: mix of the +0 h and +6 h starts
    assert abs(float(_px0(root, 12)[5, 5]) - 6) < tol                           # +6 h start
    assert abs(float(_px0(root, 15)[5, 5]) - 9) < tol
    manifest = json.load(open(os.path.join(root, "manifest.json")))
    assert {"px0", "xr"} <= set(manifest["vars"]) and "t2m" in manifest["vars"]


def test_steps_beyond_the_last_start_get_a_no_data_image(tmp_path):
    site = str(tmp_path)
    _write_ens(site, [0, 6])
    root = _write_model(site, "gfs", RUN, [0, 3, 6, 9, 12])
    run, fields = attach.load_ens(site)
    attach.attach_model(site, "gfs", run, fields)
    assert abs(float(_px0(root, 3)[0, 0]) - 3) < 0.1
    assert np.isnan(_px0(root, 9)).all() and np.isnan(_px0(root, 12)).all()


def test_attach_is_repeatable_and_skips_a_site_without_the_ensemble(tmp_path):
    site = str(tmp_path)
    assert attach.load_ens(site) is None and attach.main.__name__ == "main"
    _write_ens(site, [0, 6])
    root = _write_model(site, "gfs", RUN, [0, 3, 6])
    run, fields = attach.load_ens(site)
    for _ in range(2):
        assert attach.attach_model(site, "gfs", run, fields)
    assert abs(float(_px0(root, 6)[0, 0]) - 6) < 0.1
    assert attach.attach_model(site, "missing_model", run, fields) is False


def test_an_older_ensemble_product_with_a_retired_variable_does_not_break_attach(tmp_path):
    site = str(tmp_path)
    _write_ens(site, [0, 6])
    # the live site may still carry the previous thresholds until the ensemble job runs again
    old = os.path.join(site, "ens", "20261005T18Z")
    for h in (0, 6):
        os.makedirs(os.path.join(old, "px204"), exist_ok=True)
        open(os.path.join(old, "px204", f"{h:03d}.png"), "wb").write(encode_field(_field(1.0), 0, 100, 12))
    manifest = json.load(open(os.path.join(old, "manifest.json")))
    manifest["vars"]["px204"] = {"unit": "%", "min": 0, "max": 100, "encoding": "rg16"}
    json.dump(manifest, open(os.path.join(old, "manifest.json"), "w"))
    root = _write_model(site, "gfs", RUN, [0, 3, 6])
    run, fields = attach.load_ens(site)
    assert "px204" in fields and attach.attach_model(site, "gfs", run, fields)
    out = json.load(open(os.path.join(root, "manifest.json")))
    assert "px204" not in out["vars"] and "px0" in out["vars"]


def test_attach_gives_a_rebuilt_set_of_pictures_a_new_build_and_does_not_pile_suffixes_up(tmp_path):
    site = str(tmp_path)
    _write_ens(site, [0, 6, 12, 18])
    root = _write_model(site, "ecmwf_ifs", RUN, [0, 3, 6])
    manifest_path = os.path.join(root, "manifest.json")
    m = json.load(open(manifest_path))
    m["build"] = "20261005T1830Z"
    json.dump(m, open(manifest_path, "w"))
    json.dump({"model": "ecmwf_ifs", "run": f"{RUN:%Y%m%dT%H}Z", "build": "20261005T1830Z"}, open(os.path.join(site, "ecmwf_ifs", "latest.json"), "w"))
    run, fields = attach.load_ens(site)
    attach.attach_model(site, "ecmwf_ifs", run, fields)
    first = json.load(open(manifest_path))["build"]
    assert first == "20261005T1830Z.20261005T18Z"
    assert json.load(open(os.path.join(site, "ecmwf_ifs", "latest.json")))["build"] == first      # the app reads it from latest.json
    attach.attach_model(site, "ecmwf_ifs", run, fields)                                          # every deploy runs this again
    assert json.load(open(manifest_path))["build"] == first


def test_the_extreme_rain_probability_is_attached_like_the_chance_of_rain(tmp_path):
    site = str(tmp_path)
    _write_ens(site, [0, 6, 12])
    root = _write_model(site, "gfs", RUN, [0, 3, 6, 9])
    run, fields = attach.load_ens(site)
    assert attach.attach_model(site, "gfs", run, fields)
    v = C.VARS["xr"]
    xr = lambda h: decode_field(open(os.path.join(root, "xr", f"{h:03d}.png"), "rb").read(), v.lo, v.hi)   # noqa: E731
    assert abs(float(xr(6)[2, 2]) - 12.0) < 0.1                 # valid +6 h after the ensemble began: its 6 h start (2 x 6)
    assert abs(float(xr(3)[2, 2]) - 6.0) < 0.1                  # +3 h: half-way between the 0 h and 6 h starts
    manifest = json.load(open(os.path.join(root, "manifest.json")))
    assert "xr" in manifest["vars"] and "50 mm" in manifest["notes"]["xr"]
