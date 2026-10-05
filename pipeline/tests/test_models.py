import json
import pathlib
import sys
from datetime import datetime, timezone

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import fetch_gfs
import fetch_ifs
import mirror
from derive import derive
from regular import regrid_regular, window_indices

RUN = datetime(2026, 10, 5, 6, tzinfo=timezone.utc)


def test_window_indices_cover_the_requested_range_with_padding():
    i0, i1 = window_indices(-90.0, 0.25, 721, 4.0, 22.0)
    assert -90 + i0 * 0.25 <= 4.0 - 0.25 and -90 + (i1 - 1) * 0.25 >= 22.0 + 0.25
    assert window_indices(-90.0, 0.25, 721, -100, 100) == (0, 721)  # clamped to the array


def test_regrid_regular_reproduces_a_linear_field_exactly():
    lat_first, dlat, lon_first, dlon = 0.0, 0.25, 60.0, 0.25
    lat_axis = lat_first + dlat * np.arange(100)
    lon_axis = lon_first + dlon * np.arange(160)
    window = (2.0 * lat_axis[:, None] + 0.5 * lon_axis[None, :]).astype(np.float32)   # f = 2*lat + 0.5*lon
    lats = np.arange(22, 4 - 1e-9, -0.1)
    lons = np.arange(68, 90 + 1e-9, 0.1)
    out = regrid_regular(window, lat_first, dlat, lon_first, dlon, lats, lons)
    expected = 2.0 * lats[:, None] + 0.5 * lons[None, :]
    assert out.shape == (len(lats), len(lons)) and out.dtype == np.float32
    assert np.abs(out - expected).max() < 5e-4


def test_regrid_regular_propagates_gaps_and_clamps_outside_the_window():
    window = np.ones((10, 10), np.float32)
    window[4, 4] = np.nan
    out = regrid_regular(window, 0.0, 1.0, 0.0, 1.0, np.array([4.0, 50.0]), np.array([4.0, -30.0]))
    assert np.isnan(out[0, 0])
    assert out[1, 1] == 1.0   # far outside: clamped to the edge value instead of failing


def test_gfs_file_urls_point_at_the_right_dataset_and_hour():
    assert fetch_gfs.file_url(fetch_gfs.FINE, RUN, 3).endswith("/ncep_gfs013/2026/10/05/0600Z/2026-10-05T0900.om")
    assert fetch_gfs.file_url(fetch_gfs.COARSE, RUN, 24).endswith("/ncep_gfs025/2026/10/05/0600Z/2026-10-06T0600.om")


def test_ifs_file_urls_unchanged():
    assert fetch_ifs.file_url(RUN, 3).endswith("/ecmwf_ifs/2026/10/05/0600Z/2026-10-05T0900.om")


def test_model_modules_declare_what_run_py_needs():
    for m in (fetch_ifs, fetch_gfs):
        assert m.MODEL_ID and m.LABEL and m.RUN_HOURS and m.STEP_HOURS and m.PRECIP_NOTE
        assert m.STEP_HOURS[0] == 0 and m.STEP_HOURS == sorted(m.STEP_HOURS)
    assert fetch_ifs.MODEL_ID != fetch_gfs.MODEL_ID


def test_derive_uses_the_models_own_relative_humidity_when_there_is_no_dew_point():
    z = np.zeros((2, 2), np.float32)
    raw = {"temperature_2m": z + 30, "relative_humidity_2m": z + 70,
           "wind_u_component_10m": z + 3, "wind_v_component_10m": z + 4, "wind_gusts_10m": z + 9,
           "pressure_msl": z + 101000, "precipitation": z + 1, "cloud_cover": z + 40, "cape": z + 500,
           "total_column_integrated_water_vapour": z + 50}
    out = derive(raw, 6, None)
    assert np.allclose(out["rh"], 70) and np.allclose(out["msl"], 1010) and np.allclose(out["t2m"], 30)
    assert set(out) == {"t2m", "rh", "feels", "u10", "v10", "gust", "msl", "precip", "cloud", "cape", "tcwv"}
    raw["relative_humidity_2m"] = z + 140            # nonsense is clipped to the physical range
    assert np.allclose(derive(raw, 6, None)["rh"], 100)


class _Resp:
    def __init__(self, status, content=b""):
        self.status_code, self.content = status, content


def _fake_site(files):
    def get(url, timeout=0):
        return _Resp(200, files[url]) if url in files else _Resp(404)
    return get


def test_mirror_copies_a_live_model_and_writes_latest_last(tmp_path):
    base = "https://x.github.io/Atmos"
    manifest = {"vars": {"t2m": {}, "rh": {}}, "steps": [{"h": 0}, {"h": 3}]}
    files = {f"{base}/gfs/latest.json": json.dumps({"run": "R1"}).encode(),
             f"{base}/gfs/R1/manifest.json": json.dumps(manifest).encode()}
    for var in manifest["vars"]:
        for h in (0, 3):
            files[f"{base}/gfs/R1/{var}/{h:03d}.png"] = b"png-" + var.encode()
    assert mirror.mirror_model(str(tmp_path), base, "gfs", get=_fake_site(files))
    assert json.loads((tmp_path / "gfs" / "latest.json").read_text())["run"] == "R1"
    assert (tmp_path / "gfs" / "R1" / "t2m" / "003.png").read_bytes() == b"png-t2m"
    assert len(list((tmp_path / "gfs" / "R1").rglob("*.png"))) == 4


def test_mirror_skips_a_model_that_is_not_live_yet_and_leaves_nothing(tmp_path):
    assert mirror.mirror_model(str(tmp_path), "https://x.github.io/Atmos", "gfs", get=_fake_site({})) is False
    assert not (tmp_path / "gfs").exists()


def test_mirror_cleans_up_when_a_file_is_missing(tmp_path):
    base = "https://x.github.io/Atmos"
    manifest = {"vars": {"t2m": {}}, "steps": [{"h": 0}, {"h": 3}]}
    files = {f"{base}/gfs/latest.json": json.dumps({"run": "R1"}).encode(),
             f"{base}/gfs/R1/manifest.json": json.dumps(manifest).encode(),
             f"{base}/gfs/R1/t2m/000.png": b"ok"}            # 003.png is missing
    assert mirror.mirror_model(str(tmp_path), base, "gfs", get=_fake_site(files)) is False
    assert not (tmp_path / "gfs").exists()


def test_each_model_declares_when_rain_switches_to_three_hour_totals():
    assert fetch_ifs.PRECIP_3H_AFTER_H == 90
    assert fetch_gfs.PRECIP_3H_AFTER_H == 120
    z = np.zeros((2, 2), np.float32)
    raw = {"temperature_2m": z + 30, "relative_humidity_2m": z + 70, "wind_u_component_10m": z, "wind_v_component_10m": z,
           "wind_gusts_10m": z, "pressure_msl": z + 101000, "precipitation": z + 6, "cloud_cover": z, "cape": z,
           "total_column_integrated_water_vapour": z}
    assert np.allclose(derive(raw, 120, fetch_gfs.PRECIP_3H_AFTER_H)["precip"], 6)
    assert np.allclose(derive(raw, 126, fetch_gfs.PRECIP_3H_AFTER_H)["precip"], 2)
