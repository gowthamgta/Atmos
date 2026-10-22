import json, os
from datetime import datetime, timezone

import numpy as np

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
