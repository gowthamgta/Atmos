import json, os
from datetime import datetime, timezone

import numpy as np

import himawari_bt as H
import himawari_rgb as G


def test_grid_is_web_mercator_over_the_box():
    g = G.grid(1000)
    assert (g["cols"], g["rows"]) == (2505, 2946)
    assert abs(g["lat"][0, 0] - 30) < 0.02 and abs(g["lat"][-1, 0] - 5) < 0.02     # rows north to south
    r, c = g["to_rc"](np.array([g["lat"][100, 7]]), np.array([g["lon"][100, 7]]))
    assert abs(r[0] - 100) < 1e-6 and abs(c[0] - 7) < 1e-6                          # a place maps back to its own cell


def test_sun_zenith_noon_and_night():
    lat, lon = np.array([13.0]), np.array([80.0])
    assert G.sun_zenith(datetime(2026, 10, 22, 6, 40, tzinfo=timezone.utc), lat, lon)[0] < 30     # about noon in Chennai
    assert G.sun_zenith(datetime(2026, 10, 22, 18, 40, tzinfo=timezone.utc), lat, lon)[0] > 150   # about midnight


def test_sandwich_colours_only_cold_tops():
    vis = np.array([[0.8, 0.8]])
    bt = np.array([[280.0, 200.0]])
    rgb = G.sandwich(vis, bt)
    assert np.allclose(rgb[0, 0], rgb[0, 0, 0])            # warm: the visible picture in grey
    assert rgb[0, 1, 0] > rgb[0, 1, 2]                     # cold: coloured (red over blue at 200 K)


def test_specks_filled_but_not_the_edge():
    rgb = np.full((5, 5, 3), 0.5)
    rgb[2, 2] = np.nan                    # a speck inside
    rgb[:, 4] = np.nan                    # the edge of the data
    out = G.fill_specks(rgb)
    assert np.allclose(out[2, 2], 0.5)
    assert np.isnan(out[0, 4]).all()


def test_data_encoding():
    v = G.encode_data(np.array([180.0, 320.0, 250.0, np.nan]))
    assert list(v[:2]) == [1, 255] and v[3] == 0
    assert abs(G.DATA_MIN_K + v[2] / 255 * G.DATA_SPAN_K - 250) < 0.3


def test_index_keeps_whole_recent_frames(tmp_path):
    folder = str(tmp_path)
    now = datetime(2026, 10, 22, 6, 30, tzinfo=timezone.utc)
    for n in ("a.webp", "b.png", "old.webp"):
        open(os.path.join(folder, n), "wb").write(b"x")
    index = G.update_index(folder, [(datetime(2026, 10, 22, 6, 20, tzinfo=timezone.utc), {"truecolor": "a.webp", "data": "b.png"}),
                                    (datetime(2026, 10, 22, 4, 0, tzinfo=timezone.utc), {"truecolor": "old.webp"})], now)
    assert [f["time"] for f in index["frames"]] == ["2026-10-22T06:20:00Z"]
    assert sorted(os.listdir(folder)) == ["a.webp", "b.png", "index.json"]
    assert index["bounds"] == {"west": 75.0, "east": 97.5, "south": 5.0, "north": 30.0}


def test_meteosat_pictures_helpers():
    import meteosat_rgb as M
    a = np.array([[1.0, 1.0, 1.0], [1.0, np.nan, 1.0], [1.0, 1.0, 4.0]])
    b = M.box_blur(a, 1)
    assert np.isfinite(b).all() and abs(b[1, 1] - 11 / 8) < 1e-9          # the NaN left out of the mean
    rgb = np.full((3, 3, 3), 0.5)
    hrv = np.array([[0.2, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, np.nan]])
    s = M.sharpen(rgb, hrv, r=1)
    assert s[1, 1, 0] > 0.5 and s[0, 0, 0] < 0.5                          # the HRV's detail comes through
    assert np.allclose(s[2, 2], 0.5)                                       # no HRV: unchanged
    g = G.grid(M.RES_M, M.BOX)
    assert (g["cols"], g["rows"]) == (2627, 3161)
    z, _ = H.view_geometry(np.array([13.0]), np.array([80.3]), M.SUB_LON)
    assert 35 < z[0] < 45                                                  # Chennai, seen from 45.5 E


def test_parallax_toward_meteosat_moves_tops_west():
    lat = np.repeat((15.0 - np.arange(40) * 0.03)[:, None], 60, 1)
    lon = np.repeat((80.0 + np.arange(60) * 0.03)[None, :], 40, 0)
    t = np.full(lat.shape, 300.0)
    t[18:22, 40:44] = 200.0
    out, _ = H.parallax_correct(t, [], lat, lon, sub_lon=45.5, max_view=80)
    assert np.argwhere(out < 250)[:, 1].max() < 40                          # moved west, toward the satellite


def test_hrv_clouds_takes_eumetviews_brightness_curve():
    vis = np.array([[0.0, 87 / 255, 1.0, np.nan]])
    bt = np.array([[300.0, 250.0, 203.0, 260.0]])
    px = G.hrv_clouds_rgb(vis, bt)
    assert px[0, 0, 0] == 40 and px[0, 1, 0] == 135 and px[0, 2, 0] == 226   # EUMETView's curve, highlights rolled off
    assert px[0, 3, 0] == 0 and px[0, 3, 2] > 0                              # no visible: red and green 0, the infrared stays
    assert px[0, 2, 2] == 255                                                 # 203 K: blue full


def test_index_keeps_four_hours_and_thins_old_frames(tmp_path):
    folder = str(tmp_path)
    now = datetime(2026, 10, 23, 8, 0, tzinfo=timezone.utc)
    names = ["rgb-a.webp", "rgb_lo-a.webp", "data-a.png", "natural-a.webp", "rgb-b.webp", "data-b.png", "natural-b.webp", "rgb-c.webp"]
    for n in names:
        open(os.path.join(folder, n), "wb").write(b"x")
    index = G.update_index(folder, [
        (datetime(2026, 10, 23, 5, 0, tzinfo=timezone.utc), {"rgb": "rgb-a.webp", "rgb_lo": "rgb_lo-a.webp", "data": "data-a.png", "natural": "natural-a.webp"}),
        (datetime(2026, 10, 23, 7, 45, tzinfo=timezone.utc), {"rgb": "rgb-b.webp", "data": "data-b.png", "natural": "natural-b.webp"}),
        (datetime(2026, 10, 23, 3, 30, tzinfo=timezone.utc), {"rgb": "rgb-c.webp"}),
    ], now)
    times = [f["time"] for f in index["frames"]]
    assert times == ["2026-10-23T05:00:00Z", "2026-10-23T07:45:00Z"]          # 3 h old kept, 4.5 h old gone
    assert set(index["frames"][0]["files"]) == {"rgb", "rgb_lo", "data"}         # old: only what the loop shows
    assert "natural" in index["frames"][1]["files"]                               # newest hour: everything
    assert not os.path.exists(os.path.join(folder, "natural-a.webp")) and not os.path.exists(os.path.join(folder, "rgb-c.webp"))
