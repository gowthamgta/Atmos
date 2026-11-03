import json
import os

import numpy as np
import pytest

import himawari_rgb as G
import merge_rgb as M


def grid(rows=20, cols=60):
    lat = np.full((rows, cols), 20.0)
    lon = np.tile(np.linspace(68.5, 97, cols), (rows, 1))   # west to east across India
    return lat, lon


def picture(vis, temp, shape):
    p = np.zeros(shape + (3,), np.uint8)
    p[..., 0] = p[..., 1] = vis
    p[..., 2] = temp
    return p


def test_each_place_comes_from_the_satellite_that_sees_it_more_directly():
    lat, lon = grid()
    wm, wh = M.view_weights(lat, lon)
    assert wm[0, 0] > wh[0, 0]          # the far west: Meteosat
    assert wh[0, -1] > wm[0, -1]        # the far east: Himawari
    msg, h9 = picture(100, 150, lat.shape), picture(200, 50, lat.shape)
    out, gain = M.merge_pictures(msg, h9, lat, lon)
    assert gain == 1.0                  # fewer pixels than GAIN_MIN_PIXELS to match on (see the gain test below)
    # west nearer Meteosat's values, east nearer Himawari's, and in between a gradual change (no jump)
    assert abs(int(out[0, 0, 0]) - 100) < abs(int(out[0, 0, 0]) - 200)
    assert abs(int(out[0, -1, 2]) - 50) < abs(int(out[0, -1, 2]) - 150)
    steps = np.diff(out[0, :, 2].astype(int))
    assert np.abs(steps).max() <= 10
    assert (out[..., 0] == out[..., 1]).all()


def test_a_satellite_without_a_value_leaves_the_place_to_the_other():
    lat, lon = grid()
    msg = picture(100, 150, lat.shape)
    h9 = picture(0, 0, lat.shape)       # no data (beyond its view, or its night side)
    out, _ = M.merge_pictures(msg, h9, lat, lon)
    assert (out[..., 0] == 100).all() and (out[..., 2] == 150).all()
    none, _ = M.merge_pictures(picture(0, 0, lat.shape), picture(0, 0, lat.shape), lat, lon)
    assert not none.any()


def test_himawari_brightness_is_matched_to_meteosat_where_both_see_well():
    wm = np.full((100, 100), 0.5)
    wh = np.full((100, 100), 0.5)
    msg_vis = np.full((100, 100), 120.0)
    assert M.brightness_gain(msg_vis, msg_vis / 1.25, wm, wh) == pytest.approx(1.25)
    assert M.brightness_gain(msg_vis, msg_vis * 5, wm, wh) == 1.0               # Himawari saturated: out of range, too few pixels
    assert M.brightness_gain(msg_vis, msg_vis / 1.25, wm, wh * 0.01) == 1.0     # Himawari hardly sees it: not used to match


def test_build_merges_shared_times_keeps_meteosat_elsewhere_and_its_data_pack(tmp_path):
    from PIL import Image
    site = tmp_path
    g = G.latlon_grid(G.HRV_STEP_DEG["rgb_lo"])
    shape = (g["rows"], g["cols"])
    for folder in (M.MSG_FOLDER, M.H9_FOLDER):
        os.makedirs(site / folder)

    def write(folder, name, vis, temp):
        Image.fromarray(picture(vis, temp, shape), "RGB").save(site / folder / name, "WEBP", lossless=True)

    msg_frames, h9_frames = [], []
    for t, stamp in (("2026-11-03T06:00:00Z", "20261103T0600Z"), ("2026-11-03T06:15:00Z", "20261103T0615Z")):
        write(M.MSG_FOLDER, f"rgb_lo-{stamp}.webp", 100, 150)
        (site / M.MSG_FOLDER / f"data-{stamp}.png").write_bytes(b"png")
        msg_frames.append({"time": t, "files": {"rgb_lo": f"rgb_lo-{stamp}.webp", "data": f"data-{stamp}.png"}})
    write(M.H9_FOLDER, "rgb_lo-20261103T0600Z.webp", 200, 50)   # Himawari only at 06:00
    h9_frames.append({"time": "2026-11-03T06:00:00Z", "files": {"rgb_lo": "rgb_lo-20261103T0600Z.webp"}})
    json.dump({"bounds": {"west": 68}, "frames": msg_frames}, open(site / M.MSG_FOLDER / "index.json", "w"))
    json.dump({"frames": h9_frames}, open(site / M.H9_FOLDER / "index.json", "w"))

    index = M.build(str(site))
    assert [f["time"] for f in index["frames"]] == ["2026-11-03T06:00:00Z", "2026-11-03T06:15:00Z"]
    assert index["frames"][0]["files"]["rgb_lo"] == "rgb_lo-merged-20261103T0600Z.webp"
    assert index["frames"][1]["files"]["rgb_lo"] == "rgb_lo-20261103T0615Z.webp"      # no Himawari picture then: Meteosat's own
    assert index["frames"][0]["files"]["data"] == "data-20261103T0600Z.png"
    assert index["bounds"] == {"west": 68}
    merged = np.asarray(Image.open(site / M.FOLDER / "rgb_lo-merged-20261103T0600Z.webp"))
    assert merged[0, 0, 0] < merged[0, -1, 0]           # west Meteosat's (100), east towards Himawari's (200)
    assert sorted(os.listdir(site / M.FOLDER)) == sorted(
        ["index.json", "rgb_lo-merged-20261103T0600Z.webp", "rgb_lo-20261103T0615Z.webp", "data-20261103T0600Z.png", "data-20261103T0615Z.png"])
    assert M.build(str(tmp_path / "nothing")) is None
