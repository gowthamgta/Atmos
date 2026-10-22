import numpy as np

import himawari_bt as H


def test_view_angle_over_india():
    zen, bearing = H.view_geometry(np.array([13.08, 14.0, 19.07]), np.array([80.27, 87.0, 72.88]))
    assert 68 < zen[0] < 72          # Chennai: seen from about 70 degrees
    assert zen[1] < zen[0]           # the Bay of Bengal is nearer the satellite
    assert zen[2] > H.MAX_VIEW_DEG   # Mumbai: too slanted to use
    assert 0 < bearing[0] < np.pi    # toward the satellite is eastward


def test_parallax_moves_a_cold_top_toward_the_satellite_and_fills_behind():
    lat = np.repeat((15.0 - np.arange(40) * 0.03)[:, None], 60, 1)
    lon = np.repeat((84.0 + np.arange(60) * 0.03)[None, :], 40, 0)
    t = np.full(lat.shape, 300.0)
    t[18:22, 10:14] = 200.0                       # a storm top (about 14 km) seen at column 10-13
    out, (other,) = H.parallax_correct(t, [t.copy()], lat, lon)
    cold = np.argwhere(out < 250)
    assert len(cold) > 0
    assert cold[:, 1].min() > 13                  # moved east, toward the satellite (tens of km = more than 1 degree)
    assert np.all(out[18:22, 10:14] > 290)        # where it was seen, the ground is filled back in
    assert np.isfinite(out).all() and np.array_equal(np.isnan(other), np.isnan(out))


def test_far_view_is_left_empty():
    lat = np.full((3, 3), 19.0)
    lon = np.repeat(np.array([[70.0, 71.0, 72.0]]), 3, 0)
    out, _ = H.parallax_correct(np.full((3, 3), 290.0), [], lat, lon)
    assert np.isnan(out).all()


def test_cloud_height_from_temperature():
    h = H.cloud_height_km(np.array([300.0, 273.15, 180.0, np.nan]))
    assert h[0] == 0 and abs(h[1] - 28 / 6.2) < 1e-9 and h[2] == 17.5 and h[3] == 0
