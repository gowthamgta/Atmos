import json, os
from datetime import datetime, timedelta, timezone

import numpy as np
from PIL import Image

import satellite_bt as S


def test_encode_round_trip_and_no_data():
    k = np.array([[200.0, 250.25, np.nan], [300.0, 100.0, 400.0]])
    b = S.encode_bt(k)
    assert b[0, 2] == 0                      # no data
    assert b[1, 1] == 1 and b[1, 2] == 255   # clipped into the scale, never 0
    back = S.decode_bt(b)
    assert abs(back[0, 0] - 200.0) < 1e-9
    assert abs(back[0, 1] - 250.25) <= S.STEP_K / 2
    assert np.isnan(back[0, 2])


def test_grid_matches_the_apps_box():
    rows, cols = S.grid_shape()
    assert (rows, cols) == (1083, 983)
    assert (S.WEST, S.EAST, S.SOUTH, S.NORTH) == (68.0, 97.5, 5.0, 37.5)


def test_frames_written_and_old_ones_dropped(tmp_path):
    folder = str(tmp_path)
    now = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)
    rows, cols = 4, 5
    old_t = now - timedelta(minutes=120)
    new_t = now - timedelta(minutes=15)
    S.write_frame(folder, old_t, np.full((rows, cols), 220.0), np.full((rows, cols), 240.0))
    S.update_index(folder, [(old_t, S.frame_name(old_t))], now - timedelta(minutes=110))   # an earlier run
    S.write_frame(folder, new_t, np.full((rows, cols), 220.0), np.full((rows, cols), 240.0))
    index = S.update_index(folder, [(new_t, S.frame_name(new_t))], now)
    assert [f["time"] for f in index["frames"]] == ["2026-10-22T11:45:00Z"]
    assert sorted(os.listdir(folder)) == ["20261022T1145Z.png", "index.json"]
    px = np.asarray(Image.open(os.path.join(folder, "20261022T1145Z.png")))
    assert px[0, 0, 0] == S.encode_bt(np.array([220.0]))[0] and px[0, 0, 1] == S.encode_bt(np.array([240.0]))[0]
    saved = json.load(open(os.path.join(folder, "index.json")))
    assert saved["offsetK"] == 180.0 and saved["stepK"] == 0.5 and saved["channels"]["r"] == "IR_108"


def test_without_keys_it_does_nothing(tmp_path, monkeypatch):
    monkeypatch.delenv("EUMETSAT_CONSUMER_KEY", raising=False)
    monkeypatch.delenv("EUMETSAT_CONSUMER_SECRET", raising=False)
    monkeypatch.setattr("sys.argv", ["satellite_bt.py", "--out", str(tmp_path)])
    assert S.main() == 0
    assert os.listdir(tmp_path) == []
