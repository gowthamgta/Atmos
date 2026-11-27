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
    lat, lon = global_sat.mercator_lat_lon()
    x_rad = np.linspace(-0.15, 0.15, 31)
    y_rad = np.linspace(0.15, -0.15, 31)
    cmi = np.full((31, 31), 240.0, dtype=np.float32)
    out = global_sat.reproject_goes_to_global(
        cmi, x_rad, y_rad, lon_0_deg=-75.2, h_m=35786023.0, r_eq=6378137.0, r_pol=6356752.31414,
        lat=lat, lon=lon,
    )
    assert out.shape == (global_sat.GRID_H, global_sat.GRID_W)
    r_eq = int(np.argmin(np.abs(lat[:, 0] - 0.0)))
    c_sat = int(np.argmin(np.abs(lon[0, :] - (-75.2))))
    assert np.isclose(out[r_eq, c_sat], 240.0)
    c_opp = int(np.argmin(np.abs(lon[0, :] - 105.0)))
    assert np.isnan(out[r_eq, c_opp])


def test_mosaic_best_view_picks_lowest_zenith_angle():
    lat = np.array([[0.0]])
    lon = np.array([[45.0]])  # right over Meteosat-9 (45.5 E), far from Himawari (140.7 E)
    z_m9 = global_sat.sat_zenith(lat, lon, 45.5)
    z_h9 = global_sat.sat_zenith(lat, lon, 140.7)
    assert z_m9[0, 0] < z_h9[0, 0]

    a_m9 = np.array([[220.0]], dtype=np.float32)
    a_h9 = np.array([[260.0]], dtype=np.float32)
    blended, ok = global_sat.mosaic_best_view([a_m9, a_h9], [z_m9, z_h9])
    assert ok[0, 0]
    assert np.isclose(blended[0, 0], 220.0, atol=0.1)


def test_build_global_ir_stitches_regional_bt(tmp_path, monkeypatch):
    monkeypatch.setattr(global_sat, "_latest_goes_key", lambda *a, **k: None)
    monkeypatch.setattr(global_sat, "_fetch_gmgsi_ir", lambda *a, **k: None)
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
    assert doc["projection"] == "EPSG:3857"
    assert len(doc["frames"]) == 1
    out_png = Image.open(tmp_path / "bt-global" / doc["frames"][0]["file"]).convert("L")
    decoded = S.decode_bt(np.array(out_png))
    lat, lon = global_sat.mercator_lat_lon()
    r_ind = int(np.argmin(np.abs(lat[:, 0] - 11.0)))
    c_ind = int(np.argmin(np.abs(lon[0, :] - 79.0)))
    assert 213.0 <= decoded[r_ind, c_ind] <= 217.0


def test_build_global_rgb_writes_mercator_webp(tmp_path, monkeypatch):
    disk = np.full((128, 128, 3), 200.0, dtype=np.float32)
    monkeypatch.setattr(global_sat, "_eumet_latest_times", lambda s, layers: {la: None for la in layers})
    monkeypatch.setattr(global_sat, "_fetch_eumet_cropped", lambda *a, **k: None)
    monkeypatch.setattr(global_sat, "_fetch_slider_disk", lambda sat, s=None: disk if sat == "goes-19" else None)

    idx = global_sat.build_global_rgb(str(tmp_path), now_utc=datetime(2026, 11, 25, 12, 0, tzinfo=timezone.utc))
    assert idx is not None
    doc = json.loads(open(idx, encoding="utf-8").read())
    assert doc["projection"] == "EPSG:3857"
    assert len(doc["frames"]) == 1
    webp = Image.open(tmp_path / "rgb-global" / doc["frames"][0]["file"])
    assert webp.size == (global_sat.GRID_W, global_sat.GRID_H)
    assert webp.mode == "RGBA"


def test_hrv_patch_day_and_night():
    lat = np.array([[0.0], [0.0]])
    lon = np.array([[60.0], [-120.0]])
    sza = np.array([[20.0], [140.0]])  # day vs night
    twi = np.array([[1.0], [0.0]])
    vis = np.array([[0.6], [0.0]])
    bt = np.array([[230.0], [215.0]])
    rgb = global_sat._hrv_patch(vis, bt, sza, twi)
    assert rgb[0, 0, 0] > 150 and rgb[0, 0, 0] == rgb[0, 0, 1]
    assert rgb[1, 0, 0] == 0 and rgb[1, 0, 1] == 0 and rgb[1, 0, 2] > 200


def test_tile_specs_cover_globe():
    specs = global_sat._tile_specs(256)
    assert len(specs) == 72
    west = min(b["west"] for _, b, _, _ in specs)
    east = max(b["east"] for _, b, _, _ in specs)
    south = min(b["south"] for _, b, _, _ in specs)
    north = max(b["north"] for _, b, _, _ in specs)
    assert (west, east, south, north) == (-180.0, 180.0, -72.5, 72.5)
