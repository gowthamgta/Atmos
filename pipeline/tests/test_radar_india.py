import os
import json
import numpy as np
import pytest
from PIL import Image

from pipeline.radar_india import (
    GRID_BOUNDS,
    GRID_RES,
    GRID_W,
    GRID_H,
    RADAR_COLOR_STOPS,
    dbz_to_v,
    sample_radar_ramp,
    remove_background_cartography,
    keep_cores_in_rain,
    remove_map_drawings,
    fill_overlay_gaps,
    classify_station_sweep,
)

def test_grid_bounds_and_resolution():
    assert GRID_BOUNDS['south'] == 6.0
    assert GRID_BOUNDS['north'] == 37.5
    assert GRID_BOUNDS['west'] == 67.0
    assert GRID_BOUNDS['east'] == 98.0
    assert GRID_W == int(round((98.0 - 67.0) / 0.025))
    assert GRID_H == int(round((37.5 - 6.0) / 0.025))

def test_color_ramp_transparency():
    # Zero intensity must be completely transparent (alpha = 0)
    assert sample_radar_ramp(0.0) == (0, 0, 0, 0)
    # High reflectivity (40 dBZ = v ~ 2.9) has full opacity
    r, g, b, a = sample_radar_ramp(2.9)
    assert a == 250
    assert r > 200

def test_remove_background_cartography():
    arr = np.zeros((10, 10, 3), dtype=np.uint8)
    # 1. Pure canvas white [255, 255, 255] (diff = 0)
    arr[0, 0] = [255, 255, 255]
    # 2. Gray sea [191, 191, 191] (diff = 0)
    arr[1, 1] = [191, 191, 191]
    # 3. Green district lines [0, 204, 0]
    arr[2, 2] = [0, 204, 0]
    # 4. Chennai cyan sea [102, 204, 255] (b >= 140 and r >= 65)
    arr[3, 3] = [102, 204, 255]
    # 5. Topographic tan relief [180, 150, 100] (r >= 160, g >= 140, b >= 90)
    arr[4, 4] = [180, 150, 100]
    # 6. Real rain echo (Indigo 20 dBZ) [58, 0, 160] (authentic rain with high blue, zero red)
    arr[5, 5] = [58, 0, 160]

    bg_mask = remove_background_cartography(arr)
    assert bg_mask[0, 0] == True, "Canvas white should be flagged as background"
    assert bg_mask[1, 1] == True, "Gray sea should be flagged as background"
    assert bg_mask[2, 2] == True, "Green district lines should be flagged as background"
    assert bg_mask[3, 3] == True, "Cyan sea should be flagged as background"
    assert bg_mask[4, 4] == True, "Topographic tan relief should be flagged as background"
    assert bg_mask[5, 5] == False, "Genuine rain echo must NOT be flagged as background"

def test_keep_cores_in_rain():
    intensity = np.zeros((50, 50), dtype=np.float32)
    candidates = np.zeros((50, 50), dtype=bool)

    # 1. Cell with strong core surrounded by rain
    intensity[10:30, 10:30] = 2.0  # surrounding rain
    candidates[15:20, 15:20] = True
    intensity[candidates] = 4.0    # storm core

    # 2. Isolated candidate outside rain (e.g. white label or sea patch)
    candidates[40:45, 40:45] = True
    intensity[40:45, 40:45] = 4.0

    filtered = keep_cores_in_rain(intensity, candidates)
    # The core inside rain must be retained
    assert np.all(filtered[15:20, 15:20] == 4.0)
    # The isolated candidate must be eliminated
    assert np.all(filtered[40:45, 40:45] == 0.0)

def test_remove_map_drawings():
    intensity = np.zeros((50, 50), dtype=np.float32)
    # Thin 1-pixel red line across map (district border drawn in legend color)
    intensity[25, 5:45] = 3.5

    # A real rain cell of the same color surrounded by weaker rain
    intensity[5:15, 5:15] = 1.0  # weak rain rim
    intensity[8:12, 8:12] = 3.5  # core

    filtered = remove_map_drawings(intensity)
    # The thin border line with no rain surrounding it must be removed
    assert np.all(filtered[25, 5:45] == 0.0)
    # The cell core surrounded by rain must be retained
    assert np.all(filtered[8:12, 8:12] == 3.5)

def test_manifest_structure(tmp_path):
    manifest = {
        "generated_at": "2026-10-25T13:00:00Z",
        "bounds": {"south": 6.0, "north": 37.5, "west": 67.0, "east": 98.0},
        "maplibre_coordinates": [
            [67.0, 37.5],
            [98.0, 37.5],
            [98.0, 6.0],
            [67.0, 6.0],
        ],
        "stations_total": 45,
        "stations_online": 37,
        "files": {
            "composite_png": "india-composite.png",
            "composite_gif": "india-composite.gif"
        },
        "stations": {}
    }
    manifest_path = tmp_path / "latest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f)

    with open(manifest_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    assert "generated_at" in data
    assert "bounds" in data
    assert "maplibre_coordinates" in data
    assert len(data["maplibre_coordinates"]) == 4
    assert "stations" in data
    assert data["stations_total"] == 45
    assert data["stations_online"] > 0
    assert "composite_png" in data["files"]
