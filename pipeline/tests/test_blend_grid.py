import json
import os
import shutil
import sys
from datetime import datetime, timezone

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import blend
import config as C
from encode import decode_field, encode_field


def test_lead_time_weights_and_normalization():
    w0 = blend.lead_time_weights(0)
    assert w0["ecmwf_ifs"] > w0["aifs"]
    assert w0["ukmo"] > w0["aifs"]

    w120 = blend.lead_time_weights(120)
    assert w120["aifs"] > w0["aifs"]  # AI model weight grows with lead time

    norm = blend.normalized_weights(["ecmwf_ifs", "ukmo", "aifs"], 24)
    assert pytest.approx(sum(norm.values()), 1e-5) == 1.0

    # Single model takes all weight
    norm_single = blend.normalized_weights(["ecmwf_ifs"], 24)
    assert norm_single == {"ecmwf_ifs": 1.0}


def test_regrid_to_fine_shape_and_linear_invariance():
    coarse = np.full((73, 117), 25.0, dtype=np.float32)
    fine = blend.regrid_to_fine(coarse, 181, 291)
    assert fine.shape == (181, 291)
    assert np.allclose(fine, 25.0, atol=1e-4)


def test_gaussian_blur_handles_nans():
    field = np.ones((50, 50), dtype=np.float32) * 10.0
    field[20:25, 20:25] = np.nan
    blurred = blend.gaussian_blur(field, sigma=2.0)
    assert np.isnan(blurred[22, 22])
    assert pytest.approx(blurred[0, 0], 1e-4) == 10.0


def test_probability_matching_preserves_peak_rain_intensity():
    # Two models with different rain locations and intensities
    m1 = np.zeros((30, 30), dtype=np.float32)
    m2 = np.zeros((30, 30), dtype=np.float32)
    m1[5:10, 5:10] = 40.0    # 25 cells of 40 mm/h
    m2[20:25, 20:25] = 40.0  # 25 cells of 40 mm/h

    consensus = (m1 + m2) / 2.0
    assert consensus.max() == 20.0  # linear averaging halves the peak down to 20 mm/h

    parts = [(0.5, m1), (0.5, m2)]
    pm = blend.probability_matched(consensus, parts)
    # Probability matching restores the intensity distribution, so peak stays at 40 mm/h
    assert pm.max() == 40.0


def test_sharpen_preserves_ensemble_bounds():
    mean = np.full((40, 40), 20.0, dtype=np.float32)
    ref = np.random.uniform(18.0, 22.0, (40, 40)).astype(np.float32)
    sharp = blend.sharpen(mean, ref, gain=0.5, sigma=2.0)
    assert sharp.shape == (40, 40)
    assert np.isfinite(sharp).all()


def test_blend_end_to_end_build(tmp_path):
    site = str(tmp_path / "site")
    run_str = "20261105T12Z"

    # Create mock IFS model
    ifs_dir = os.path.join(site, "ecmwf_ifs", run_str)
    os.makedirs(os.path.join(ifs_dir, "t2m"), exist_ok=True)
    os.makedirs(os.path.join(ifs_dir, "precip"), exist_ok=True)
    f_t2m = np.full((C.IFS_NY, C.IFS_NX), 28.0, dtype=np.float32)
    f_precip = np.full((C.IFS_NY, C.IFS_NX), 2.5, dtype=np.float32)

    with open(os.path.join(ifs_dir, "t2m", "000.png"), "wb") as f:
        f.write(encode_field(f_t2m, C.VARS["t2m"].lo, C.VARS["t2m"].hi))
    with open(os.path.join(ifs_dir, "precip", "000.png"), "wb") as f:
        f.write(encode_field(f_precip, C.VARS["precip"].lo, C.VARS["precip"].hi))

    ifs_manifest = {
        "model": "ecmwf_ifs",
        "run": run_str,
        "grid": {"latMax": 20.0, "latMin": 2.0, "lonMin": 70.0, "lonMax": 99.0, "step": 0.1, "nx": C.IFS_NX, "ny": C.IFS_NY},
        "steps": [{"h": 0, "valid": "2026-11-05T12:00:00Z"}],
        "vars": {"t2m": {"min": -40, "max": 50}, "precip": {"min": 0, "max": 100}},
    }
    with open(os.path.join(ifs_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(ifs_manifest, f)
    with open(os.path.join(site, "ecmwf_ifs", "latest.json"), "w", encoding="utf-8") as f:
        json.dump({"model": "ecmwf_ifs", "run": run_str}, f)

    # Create mock AIFS model (coarse grid 73 x 117)
    aifs_dir = os.path.join(site, "aifs", run_str)
    os.makedirs(os.path.join(aifs_dir, "t2m"), exist_ok=True)
    os.makedirs(os.path.join(aifs_dir, "precip"), exist_ok=True)
    c_t2m = np.full((73, 117), 30.0, dtype=np.float32)
    c_precip = np.full((73, 117), 1.5, dtype=np.float32)

    with open(os.path.join(aifs_dir, "t2m", "000.png"), "wb") as f:
        f.write(encode_field(c_t2m, C.VARS["t2m"].lo, C.VARS["t2m"].hi))
    with open(os.path.join(aifs_dir, "precip", "000.png"), "wb") as f:
        f.write(encode_field(c_precip, C.VARS["precip"].lo, C.VARS["precip"].hi))

    aifs_manifest = {
        "model": "aifs",
        "run": run_str,
        "grid": {"latMax": 20.0, "latMin": 2.0, "lonMin": 70.0, "lonMax": 99.0, "step": 0.25, "nx": 117, "ny": 73},
        "steps": [{"h": 0, "valid": "2026-11-05T12:00:00Z"}],
        "vars": {"t2m": {"min": -40, "max": 50}, "precip": {"min": 0, "max": 100}},
    }
    with open(os.path.join(aifs_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(aifs_manifest, f)
    with open(os.path.join(site, "aifs", "latest.json"), "w", encoding="utf-8") as f:
        json.dump({"model": "aifs", "run": run_str}, f)

    # Build the blend!
    res = blend.build(site, workers=1, steps_limit=1)
    assert res is not None

    blend_root = os.path.join(site, "blend")
    assert os.path.exists(os.path.join(blend_root, "latest.json"))
    with open(os.path.join(blend_root, "latest.json"), "r", encoding="utf-8") as f:
        latest = json.load(f)
    assert latest["model"] == "blend"
    assert latest["domain"] == "box-2-20N-70-99E"

    run_dir = os.path.join(blend_root, latest["run"])
    assert os.path.exists(os.path.join(run_dir, "manifest.json"))
    with open(os.path.join(run_dir, "manifest.json"), "r", encoding="utf-8") as f:
        manifest = json.load(f)
    assert manifest["grid"]["nx"] == C.IFS_NX
    assert manifest["grid"]["ny"] == C.IFS_NY

    # Check that blended t2m PNG is written and decodes to a valid value between 28 and 30 °C
    t2m_png_path = os.path.join(run_dir, "t2m", "000.png")
    assert os.path.exists(t2m_png_path)
    with open(t2m_png_path, "rb") as f:
        decoded_t2m = decode_field(f.read(), C.VARS["t2m"].lo, C.VARS["t2m"].hi)
    assert decoded_t2m.shape == (C.IFS_NY, C.IFS_NX)
    assert 28.0 <= decoded_t2m[90, 145] <= 30.0
