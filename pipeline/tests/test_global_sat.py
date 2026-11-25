import json
import os
import sys
from datetime import datetime, timezone

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import global_sat
import satellite_bt as S


def test_reproject_goes_to_global_maps_subsatellite_point():
    x_rad = np.linspace(-0.15, 0.15, 31)
    y_rad = np.linspace(0.15, -0.15, 31)
    cmi = np.full((31, 31), 240.0, dtype=np.float32)
    out = global_sat.reproject_goes_to_global(
        cmi, x_rad, y_rad, lon_0_deg=-75.2, h_m=35786023.0, r_eq=6378137.0, r_pol=6356752.31414,
    )
    assert out.shape == (global_sat.NY, global_sat.NX)
    # Subsatellite point at equator, -75.25 lon should be valid and 240 K
    r_eq = round((global_sat.LAT_MAX - 0.0) / global_sat.STEP_DEG)
    c_sat = round((-75.25 - global_sat.LON_MIN) / global_sat.STEP_DEG)
    assert np.isclose(out[r_eq, c_sat], 240.0)
    # Opposite side of Earth (+105 E) should be NaN (not visible from GOES-East)
    c_opp = round((105.0 - global_sat.LON_MIN) / global_sat.STEP_DEG)
    assert np.isnan(out[r_eq, c_opp])


def test_build_global_ir_stitches_regional_bt(tmp_path, monkeypatch):
    monkeypatch.setattr(global_sat, "_latest_goes_key", lambda *a, **k: None)
    h9_dir = tmp_path / "bt-h9"
    h9_dir.mkdir()
    reg_k = np.full((20, 30), 215.0, dtype=np.float32)
    Image.fromarray(S.encode_bt(reg_k), "L").save(h9_dir / "f1.png", "PNG")
    (h9_dir / "index.json").write_text(json.dumps({
        "bounds": {"west": 70.0, "south": 2.0, "east": 99.0, "north": 20.0},
        "frames": [{"time": "2026-11-25T06:00:00Z", "file": "f1.png"}],
    }))

    idx = global_sat.build_global_ir(str(tmp_path), now_utc=datetime(2026, 11, 25, 6, 10, tzinfo=timezone.utc))
    assert idx is not None
    doc = json.loads(open(idx, encoding="utf-8").read())
    assert len(doc["frames"]) == 1
    out_png = Image.open(tmp_path / "bt-global" / doc["frames"][0]["file"]).convert("L")
    decoded = S.decode_bt(np.array(out_png))
    r_ind = round((global_sat.LAT_MAX - 11.0) / global_sat.STEP_DEG)
    c_ind = round((79.0 - global_sat.LON_MIN) / global_sat.STEP_DEG)
    assert 213.0 <= decoded[r_ind, c_ind] <= 217.0
