import json
import os
import sys
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import compare_ewrf  # noqa: E402


def test_ewrf_assimilation_generates_json_and_summary(tmp_path):
    run_dir = str(tmp_path / "blend_run")
    
    # Synthetic rain & CAPE grids (10x10)
    rain = np.zeros((10, 10), dtype=np.float32)
    rain[2, 3] = 45.0  # heavy rain
    rain[4, 5] = 15.0

    cape = np.full((10, 10), 1200.0, dtype=np.float32)
    cape[5, 5] = 3200.0  # severe risk

    summary = compare_ewrf.run_ewrf_assimilation(run_dir, day1_rain24=rain, day1_cape=cape)

    assert os.path.exists(os.path.join(run_dir, "ewrf_comparison.json"))
    with open(os.path.join(run_dir, "ewrf_comparison.json"), "r") as f:
        data = json.load(f)

    assert data["blend_day1_max_rain24_mm"] == 45.0
    assert data["blend_day1_heavy_rain_pct"] == 1.0  # 1 out of 100 cells >= 35mm
    assert data["blend_day1_max_cape_j_kg"] == 3200.0
    assert data["convective_lightning_risk"] == "severe"


def test_ewrf_assimilation_handles_empty_or_nan(tmp_path):
    run_dir = str(tmp_path / "blend_run_empty")
    summary = compare_ewrf.run_ewrf_assimilation(run_dir, day1_rain24=None, day1_cape=None)

    assert os.path.exists(os.path.join(run_dir, "ewrf_comparison.json"))
    assert "blend_day1_max_rain24_mm" not in summary
    assert "convective_lightning_risk" not in summary
