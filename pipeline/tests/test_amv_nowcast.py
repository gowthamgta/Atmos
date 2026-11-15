import os, json, tempfile
import datetime as dt
import numpy as np
import pytest

import amv_nowcast as A


def test_meteorological_direction():
    # U > 0 (west wind blowing eastward) -> direction = 270 deg
    assert A.meteorological_direction(10.0, 0.0) == 270.0
    # U < 0 (east wind blowing westward) -> direction = 90 deg
    assert A.meteorological_direction(-10.0, 0.0) == 90.0
    # V > 0 (south wind blowing northward) -> direction = 180 deg
    assert A.meteorological_direction(0.0, 10.0) == 180.0
    # V < 0 (north wind blowing southward) -> direction = 0 deg
    assert A.meteorological_direction(0.0, -10.0) == 0.0
    # Calm wind
    assert A.meteorological_direction(0.0, 0.0) == 0.0


def test_circular_mean_deg():
    # 350 deg and 10 deg -> circular mean must be 0 deg, never arithmetic 180 deg
    mean_dir = A.circular_mean_deg([350.0, 10.0])
    assert abs(mean_dir - 0.0) < 1e-4 or abs(mean_dir - 360.0) < 1e-4

    # All identical
    assert abs(A.circular_mean_deg([90.0, 90.0, 90.0]) - 90.0) < 1e-4


def test_viewing_zenith_angle():
    # Sub-satellite point (0N, 45.5E) seen from Meteosat-9 at 45.5E must have zenith = 0 deg
    zen_ssp = A.viewing_zenith_angle(np.array([45.5]), np.array([0.0]), sub_lon=45.5)[0]
    assert abs(zen_ssp - 0.0) < 0.1

    # Chennai (13.08N, 80.27E)
    zen_chennai_met = A.viewing_zenith_angle(np.array([80.27]), np.array([13.08]), sub_lon=45.5)[0]
    assert 38.0 < zen_chennai_met < 45.0

    # Chennai seen from Himawari (140.7E) has higher zenith angle (> 60 deg)
    zen_chennai_him = A.viewing_zenith_angle(np.array([80.27]), np.array([13.08]), sub_lon=140.7)[0]
    assert zen_chennai_him > 60.0
    assert zen_chennai_met < zen_chennai_him


def test_merge_unique_tracers():
    vecs = [
        # Two co-located vectors at (78.0, 12.0)
        {"original_lon": 78.0, "original_lat": 12.0, "channel": "IR_108", "confidence": "HIGH", "pressure_hpa": 250.0, "speed_mps": 12.0},
        {"original_lon": 78.01, "original_lat": 12.01, "channel": "WV_062", "confidence": "LOW", "pressure_hpa": 260.0, "speed_mps": 11.5},
        # One isolated vector at (85.0, 15.0)
        {"original_lon": 85.0, "original_lat": 15.0, "channel": "IR_108", "confidence": "HIGH", "pressure_hpa": 300.0, "speed_mps": 15.0},
    ]
    merged = A.merge_unique_tracers(vecs, cluster_dist_deg=0.15)
    # The two co-located vectors should collapse into 1, leaving 2 unique vectors total
    assert len(merged) == 2
    assert merged[0]["channel"] == "IR_108"


def test_export_geojson_and_index(tmp_path):
    vecs = [
        {
            "lon": 78.5, "lat": 12.5, "original_lon": 78.5, "original_lat": 12.5,
            "u_mps": 10.0, "v_mps": 5.0, "speed_mps": 11.18, "direction_deg": 243.4,
            "pressure_hpa": 250.0, "height_m": 10800, "layer": "high",
            "satellite": "Meteosat-9", "channel": "IR_108", "quality_indicator": 88.5, "zenith_deg": 41.2
        }
    ]
    geojson = A.export_geojson(vecs, "2026-11-14T12:00:00Z")
    assert geojson["type"] == "FeatureCollection"
    assert geojson["count"] == 1
    feat = geojson["features"][0]
    assert feat["geometry"]["coordinates"] == [78.5, 12.5]
    assert feat["properties"]["speed"] == 11.18
    assert feat["properties"]["layer"] == "high"
    # Wind barb properties: 11.18 m/s = 21.7 kt -> barb-20, green color (>=20 kt)
    assert feat["properties"]["speed_kt"] == 21.7
    assert feat["properties"]["barb_id"] == "barb-20"
    assert feat["properties"]["barb_color"] == "#00e676"

    # Test index update
    out_dir = str(tmp_path)
    frame = {
        "time": "2026-11-14T12:00:00Z",
        "file": "amv_test.json",
        "count": 1,
        "meteosat_count": 1,
        "himawari_count": 0,
        "ecmwf_count": 1
    }
    test_now = dt.datetime.fromisoformat("2026-11-14T12:05:00+00:00")
    A.update_amv_index(out_dir, frame, keep_minutes=250, now=test_now)
    idx_file = os.path.join(out_dir, "amv", "index.json")
    assert os.path.exists(idx_file)
    with open(idx_file, "r") as f:
        data = json.load(f)
    assert len(data["frames"]) == 1
    assert data["frames"][0]["file"] == "amv_test.json"
    assert data["frames"][0]["ecmwf_count"] == 1


def test_barb_color_thresholds():
    light_vec = [{"speed_mps": 5.0, "lon": 80.0, "lat": 13.0, "u_mps": 5.0, "v_mps": 0.0, "direction_deg": 270.0,
                  "pressure_hpa": 850.0, "height_m": 1500, "layer": "low", "satellite": "ECMWF IFS", "channel": "850hPa",
                  "quality_indicator": 95.0, "zenith_deg": 0.0}]
    gale_vec = [{"speed_mps": 11.0, "lon": 80.0, "lat": 13.0, "u_mps": 11.0, "v_mps": 0.0, "direction_deg": 270.0,
                 "pressure_hpa": 850.0, "height_m": 1500, "layer": "low", "satellite": "ECMWF IFS", "channel": "850hPa",
                 "quality_indicator": 95.0, "zenith_deg": 0.0}]
    
    geo_light = A.export_geojson(light_vec, "2026-11-14T12:00:00Z")
    geo_gale = A.export_geojson(gale_vec, "2026-11-14T12:00:00Z")
    
    # 5 m/s = 9.7 kt (< 20 kt) -> dark slate
    assert geo_light["features"][0]["properties"]["barb_color"] == "#334155"
    assert geo_light["features"][0]["properties"]["barb_id"] == "barb-10"
    
    # 11 m/s = 21.4 kt (>= 20 kt) -> vibrant green
    assert geo_gale["features"][0]["properties"]["barb_color"] == "#00e676"
    assert geo_gale["features"][0]["properties"]["barb_id"] == "barb-20"
