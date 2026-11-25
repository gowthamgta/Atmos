import os
import sys
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import obs_global_metar


def test_barnes_global_2d_nudges_and_wraps_longitude():
    ny, nx = 681, 1440  # -85..+85 lat, -180..+179.75 lon, 0.25 deg
    bg = np.full((ny, nx), 25.0, dtype=np.float32)
    # Station near the international date line (179.8 E) reporting 29.0 C
    obs = [(0.0, 179.8, 29.0)]
    out = obs_global_metar.barnes_global_2d(bg, obs, lat_max=85.0, lat_min=-85.0, lon_min=-180.0, step=0.25, radius_km=120.0, max_adj=4.5)

    r_eq = int(round((85.0 - 0.0) / 0.25))
    # Both 179.75 E (col 1439) and -180.0 E (col 0) should be nudged upward across the date line!
    assert out[r_eq, 1439] > 27.0
    assert out[r_eq, 0] > 27.0
    # Far away (e.g. 0 E, col 720) remains untouched
    assert out[r_eq, 720] == 25.0


def test_assimilate_global_metars_computes_t2m_and_rh_deltas():
    ny, nx = 681, 1440
    fields = {
        "t2m": np.full((ny, nx), 20.0, dtype=np.float32),
        "rh": np.full((ny, nx), 60.0, dtype=np.float32),
    }
    stations = [
        {"station": "KJFK", "lat": 40.64, "lon": -73.78, "temp_c": 23.0, "rh_pct": 75.0},
        {"station": "EGLL", "lat": 51.47, "lon": -0.45, "temp_c": 17.0, "rh_pct": 80.0},
    ]
    deltas = obs_global_metar.assimilate_global_metars(fields, 85.0, -85.0, -180.0, 0.25, stations=stations)
    assert "t2m" in deltas and "rh" in deltas
    r_jfk = int(round((85.0 - 40.64) / 0.25))
    c_jfk = int(round((-73.78 + 180.0) / 0.25))
    assert deltas["t2m"][r_jfk, c_jfk] > 1.5
    assert deltas["rh"][r_jfk, c_jfk] > 8.0
