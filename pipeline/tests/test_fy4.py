from datetime import datetime, timezone

import numpy as np
from PIL import Image

import fy4


XML = (
    '<imagelist name="x">'
    '<image time="2026-10-06 12:15 (UTC)" url="//img.nsmc.org.cn/a/FY4B-_AGRI--_N_REGI_1050E_L2-_GRA-_C002_GLL_20261006121500_20261006122959_0500M_V0001.JPG-thumb.JPG"/>'
    '<image time="2026-10-06 12:15 (UTC)" url="//img.nsmc.org.cn/a/FY4B-_AGRI--_N_REGI_1050E_L2-_GRA-_C002_GLL_20261006121500_20261006122959_0500M_V0001.JPG"/>'
    '<image time="2026-10-06 12:00 (UTC)" url="//img.nsmc.org.cn/a/FY4B-_AGRI--_N_REGI_1050E_L2-_GRA-_C002_GLL_20261006120000_20261006121459_0500M_V0001.JPG"/>'
    "</imagelist>"
)


def test_parse_slots_keeps_full_pictures_and_drops_thumbnails():
    slots = fy4.parse_slots(XML)
    assert sorted(slots) == ["20261006120000", "20261006121500"]
    assert slots["20261006121500"].startswith("http://img.nsmc.org.cn/")
    assert not slots["20261006121500"].lower().endswith("thumb.jpg")


def test_the_domain_window_is_in_each_channels_own_pixels():
    # the 1 km channel has pixels twice as big as the 0.5 km one, the 4 km channel eight times
    x0, y0, x1, y1 = fy4.window("C02")
    a0, b0, a1, b1 = fy4.window("C01")
    c0, d0, c1, d1 = fy4.window("C13")
    # the 4 km channel has a whole number of pixels only when the domain is a multiple of 0.04 degrees: allow one pixel
    assert abs((x1 - x0) - 2 * (a1 - a0)) <= 1 and abs((x1 - x0) - 8 * (c1 - c0)) <= 8
    assert abs((y1 - y0) - 2 * (b1 - b0)) <= 1 and abs((y1 - y0) - 8 * (d1 - d0)) <= 8
    # the forecast domain (16.5 degrees of longitude, 9 of latitude) at 0.005 degrees a pixel
    assert x1 - x0 == 3300 and y1 - y0 == 1800


def test_crop_domain_pads_rows_south_of_the_pictures_coverage():
    x0, y0, x1, y1 = fy4.window("C13")
    img = Image.new("L", (1964, 1224), 200)
    grey = fy4.crop_domain(img, "C13")
    assert grey.shape == (y1 - y0, x1 - x0)
    assert grey[0, 0] == 200
    covered = 1224 - y0
    assert grey[covered - 1, 0] == 200 and grey[covered, 0] == 0 if covered < grey.shape[0] else True


def test_choose_slots_wants_all_visible_channels_by_day_and_the_infrared_at_night():
    day, night = "20261006051500", "20261006171500"        # 10:45 and 22:45 IST
    lists = {
        "C01": {day: "u1", "20261006050000": "u0"},
        "C02": {day: "u2"},
        "C03": {day: "u3", "20261006050000": "u"},
        "C13": {night: "ir", "20261006050000": "ir0"},
    }
    assert fy4.choose_slots(lists) == [(night, "night"), (day, "day")]    # 05:00 lacks C02 and is left out
    assert fy4.choose_slots(lists, count=1) == [(night, "night")]


def test_the_picture_is_day_over_south_india_in_the_morning_and_not_at_night():
    assert fy4.is_day(datetime(2026, 10, 6, 5, 0, tzinfo=timezone.utc))
    assert not fy4.is_day(datetime(2026, 10, 6, 18, 0, tzinfo=timezone.utc))


def test_remove_lines_paints_a_burned_in_coastline_out_but_leaves_other_bright_things():
    h, w = 120, 160
    base = np.full((h, w), 20, np.float32)
    mask = np.zeros((h, w), bool)
    mask[:, 78:83] = True                        # a coastline 5 px wide (the mask is the band it can be in)
    img = base.copy()
    img[:, 80] = 250                             # the burned-in line
    img[40:44, 20:24] = 250                      # a small cloud away from the coast
    out = fy4.remove_lines(img, "C02", mask)
    assert out[60, 80] < 40                      # the line is gone
    assert out[41, 21] == 250                    # the cloud is not touched


def test_remove_lines_keeps_a_cloud_that_covers_the_coast():
    h, w = 80, 120
    img = np.full((h, w), 230, np.float32)       # cloud everywhere, line invisible in it
    mask = np.zeros((h, w), bool)
    mask[:, 58:63] = True
    out = fy4.remove_lines(img, "C02", mask)
    assert np.allclose(out, 230, atol=1)


def test_true_colour_is_a_clean_rgb_picture_with_the_red_channels_detail():
    h, w = 40, 60
    red = np.full((h, w), 60, np.float32)
    red[:, ::2] = 120                            # fine detail only the 0.5 km channel has
    blue = np.full((h // 2, w // 2), 90, np.float32)
    nir = np.full((h // 2, w // 2), 80, np.float32)
    rgb = fy4.true_colour(red, blue, nir, datetime(2026, 10, 6, 5, 0, tzinfo=timezone.utc))
    assert rgb.shape == (h, w, 3) and rgb.dtype == np.uint8
    assert abs(int(rgb[20, 10, 0]) - int(rgb[20, 11, 0])) > 10        # the stripes survive in the red band
    # no band is saturated for a mid-grey scene at noon
    assert rgb.max() < 255


def test_sun_elevation_is_high_at_noon_and_negative_at_night():
    noon = datetime(2026, 10, 6, 6, 30, tzinfo=timezone.utc)           # about 12:00 local solar time at 79 E
    assert fy4.sun_elevation_deg(noon, 13.0, 79.0) > 60
    assert fy4.sun_elevation_deg(datetime(2026, 10, 6, 18, 0, tzinfo=timezone.utc), 13.0, 79.0) < 0


def test_the_bundled_coastline_covers_the_domain():
    lines = fy4.coast_lines()
    pts = [p for l in lines for p in l]
    assert any(fy4.WEST < lo < fy4.EAST and fy4.SOUTH < la < fy4.NORTH for lo, la in pts)
    mask = fy4.coast_mask("C13", (fy4.window("C13")[3] - fy4.window("C13")[1], fy4.window("C13")[2] - fy4.window("C13")[0]), lines)
    assert 0.002 < mask.mean() < 0.2
