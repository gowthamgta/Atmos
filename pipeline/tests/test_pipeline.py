import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import o1280
from derive import apparent_temperature, relative_humidity
from encode import decode_field, encode_field


def test_encode_roundtrip_error_below_quantisation_step():
    rng = np.random.default_rng(0)
    v = rng.uniform(-10, 50, (181, 221)).astype(np.float32)
    back = decode_field(encode_field(v, -10, 50), -10, 50)
    assert np.abs(back - v).max() <= (60 / 65535) / 2 + 1e-4


def test_encode_nan_and_clipping():
    v = np.array([[np.nan, -99, 999, 25]], np.float32)
    back = decode_field(encode_field(v, -10, 50), -10, 50)
    assert np.isnan(back[0, 0]) and back[0, 1] == -10
    assert abs(back[0, 2] - 50) < 1e-3 and abs(back[0, 3] - 25) < 1e-3


def test_o1280_geometry():
    assert o1280.OFFSETS[-1] == 6_599_680
    assert o1280.LATS[0] > 89.9 and o1280.LATS[-1] < -89.9 and np.all(np.diff(o1280.LATS) < 0)
    r0, r1 = o1280.band_rows(4, 22)
    assert o1280.LATS[r0] >= 22 and o1280.LATS[r1 - 1] <= 4


def test_regrid_constant_and_latitude_field():
    r0, r1 = o1280.band_rows(4, 22)
    a, b = int(o1280.OFFSETS[r0]), int(o1280.OFFSETS[r1])
    lats, lons = np.arange(22, 4 - 1e-9, -0.1), np.arange(68, 90 + 1e-9, 0.1)
    flat = np.full(b - a, 7.0, np.float32)
    assert np.allclose(o1280.regrid_band(flat, r0, r1, lats, lons), 7.0, atol=1e-4)
    lat_field = np.concatenate(
        [np.full(int(o1280.LENGTHS[r]), o1280.LATS[r], np.float32) for r in range(r0, r1)]
    )
    out = o1280.regrid_band(lat_field, r0, r1, lats, lons)
    assert np.abs(out - lats[:, None]).max() < 0.05


def test_relative_humidity_and_apparent_temperature():
    t = np.array([30.0, 20.0])
    td = np.array([30.0, 10.0])
    rh = relative_humidity(t, td)
    assert abs(rh[0] - 100) < 1e-6 and 45 < rh[1] < 55
    calm = apparent_temperature(np.array([32.0]), np.array([80.0]), np.array([0.0]))
    windy = apparent_temperature(np.array([32.0]), np.array([80.0]), np.array([8.0]))
    assert calm[0] > 32 and windy[0] < calm[0]


def test_precip_is_normalised_to_mm_per_hour():
    from derive import derive
    z = np.zeros((2, 2), np.float32)
    raw = {k: z + 1 for k in ["temperature_2m", "dew_point_2m", "wind_u_component_10m", "wind_v_component_10m",
                              "wind_gusts_10m", "pressure_msl", "cloud_cover", "cape",
                              "total_column_integrated_water_vapour"]}
    raw["precipitation"] = z + 6.0
    assert np.allclose(derive(raw, 90)["precip"], 6.0)    # still hourly totals
    assert np.allclose(derive(raw, 93)["precip"], 2.0)    # 3-hour totals become mm/h
