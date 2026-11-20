import numpy as np
import fetch_worldcover as W


def test_worldcover_cog_naming():
    # Tile at 11°N, 78°E should map to the 3°x3° COG starting at 9°N, 78°E
    sw_lat, sw_lon, name = W.worldcover_cog_name(11, 78)
    assert sw_lat == 9
    assert sw_lon == 78
    assert name == "ESA_WorldCover_10m_2021_v200_N09E078_Map.tif"

    # Tile at 13°N, 80°E (Chennai) should map to 12°N, 78°E
    sw_lat2, sw_lon2, name2 = W.worldcover_cog_name(13, 80)
    assert sw_lat2 == 12
    assert sw_lon2 == 78
    assert name2 == "ESA_WorldCover_10m_2021_v200_N12E078_Map.tif"


def test_render_preview_rgb():
    # Create synthetic 2x2 class grid
    mock_classes = np.array([[10, 40], [50, 80]], dtype=np.uint8)
    rgb = W.render_preview_rgb(mock_classes)
    assert rgb.shape == (2, 2, 3)
    # 10 is Forest -> (0, 100, 0)
    assert tuple(rgb[0, 0]) == (0, 100, 0)
    # 40 is Cropland -> (240, 150, 255)
    assert tuple(rgb[0, 1]) == (240, 150, 255)
    # 50 is Urban -> (250, 0, 0)
    assert tuple(rgb[1, 0]) == (250, 0, 0)
    # 80 is Water -> (0, 100, 200)
    assert tuple(rgb[1, 1]) == (0, 100, 200)


def test_summarize_classes():
    mock_classes = np.array([10, 10, 40, 50], dtype=np.uint8)
    stats = W.summarize_classes(mock_classes)
    assert stats["Tree Cover / Forest"] == 50.0
    assert stats["Cropland / Farmland"] == 25.0
    assert stats["Built-up / Buildings"] == 25.0
