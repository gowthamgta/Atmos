import numpy as np
import build_global_30m_terrain as B


def test_parse_cop_name():
    assert B.parse_cop_name("Copernicus_DSM_COG_10_N27_00_E086_00_DEM") == (27, 86)
    assert B.parse_cop_name("Copernicus_DSM_COG_10_S15_00_W075_00_DEM") == (-15, -75)
    assert B.parse_cop_name("bad_name") is None


def test_encode_decode_webp_roundtrip(tmp_path):
    elev = np.array([[0.0, 1234.0], [4567.0, 8848.0]], dtype=np.float32)
    land = np.array([[0.0, 0.5], [1.0, 1.0]], dtype=np.float32)
    out = tmp_path / "t.webp"
    B.encode_webp(elev, land, str(out), quant_bits=12)
    e2, l2 = B.decode_webp(str(out))
    assert np.allclose(e2, elev, atol=3.0)
    assert np.allclose(l2, land, atol=0.01)


def test_pack_bitmask():
    b64 = B.pack_bitmask(5, {(0, 0), (31, 31)})
    assert isinstance(b64, str) and len(b64) > 0


def test_sample_cop_tiles():
    arr = np.full((10, 10), 500.0, dtype=np.float32)
    lat = np.array([[11.2], [11.8]], dtype=np.float64)
    lon = np.array([[78.2, 78.8]], dtype=np.float64)
    e, l = B.sample_cop_tiles(lat, lon, {(11, 78): arr})
    assert e.shape == (2, 2)
    assert np.allclose(e, 500.0, atol=1.0)
    assert np.allclose(l, 1.0, atol=0.01)
