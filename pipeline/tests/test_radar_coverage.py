import math
import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import radar_coverage as R


def flat(height_m: float):
    return lambda lat, lon: np.full(np.shape(lat), height_m)


def test_beam_height_is_the_climb_plus_the_curve_of_the_earth():
    # at 100 km: 100 * tan(0.5 deg) + 100^2 / (2 * 4/3 * 6371) = 0.8727 + 0.5886 km above the antenna
    assert R.beam_height_km(100.0) == pytest_approx(1.4613, 1e-3)
    assert R.beam_height_km(0.0) == 0.0
    h = R.beam_height_km(np.array([50.0, 150.0, 250.0]))
    assert h[0] < h[1] < h[2] and h[2] == pytest_approx(250 * math.tan(math.radians(0.5)) + 250 ** 2 / (2 * R.R_EFFECTIVE_KM), 1e-9)


def pytest_approx(value: float, rel: float):
    import pytest
    return pytest.approx(value, rel=rel)


def test_blocked_share_is_half_when_the_beam_centre_meets_the_ground_and_grows_with_the_obstacle():
    assert R.blocked_fraction(R.SWEEP_DEG) == pytest_approx(0.5, 1e-6)
    assert R.blocked_fraction(R.SWEEP_DEG - 3.0) < 0.001
    assert R.blocked_fraction(R.SWEEP_DEG + 3.0) > 0.999
    lo, mid, hi = R.blocked_fraction(np.array([-0.5, 0.0, 0.5]))
    assert lo < mid < hi


def test_erf_matches_known_values():
    x = np.array([0.0, 0.5, 1.0, -1.0, 2.0])
    expect = np.array([0.0, 0.5204999, 0.8427008, -0.8427008, 0.9953223])
    assert np.allclose(R._erf(x), expect, atol=2e-7)


def test_destination_goes_the_distance_along_the_bearing():
    lat, lon = R.destination(10.0, 78.0, np.array([0.0, 90.0]), np.array([111.19, 111.19]))
    assert lat[0] == pytest_approx(11.0, 1e-3) and abs(lon[0] - 78.0) < 1e-6        # a degree of latitude is 111.19 km
    assert abs(lat[1] - 10.0) < 0.01 and lon[1] > 78.9                               # east: longitude grows, latitude barely changes


def test_over_flat_ground_the_beam_climbs_with_distance_and_nothing_blocks_it():
    rays = R.trace_rays(flat(0.0), 10.0, 78.0, 1.0, azimuths=8, gates=250)
    agl = rays["agl_km"]
    assert agl.shape == (8, 250)
    assert np.all(np.diff(agl, axis=1) > 0)
    assert np.all(rays["blocked"] < 1e-9)            # the beam's lower tail grazes flat ground, but that is not blockage
    assert agl[0, 99] == pytest_approx(R.ANTENNA_M / 1000.0 + R.beam_height_km(100.0), 1e-6)


def test_a_ridge_blocks_what_is_behind_it_and_only_there():
    def terrain(lat, lon):
        lat = np.asarray(lat)
        lon = np.asarray(lon)
        h = np.zeros(lat.shape)
        h[(lon > 78.4) & (lon < 78.5)] = 1500.0     # a north-south ridge about 40 km east of the radar
        return h
    rays = R.trace_rays(terrain, 10.0, 78.0, 1.0, azimuths=360, gates=150)
    east, west = 90, 270                               # azimuth index = degrees
    assert rays["blocked"][east, 20] < 0.01            # in front of the ridge
    assert rays["blocked"][east, 80] > 0.9             # behind it: the ridge stands well above the beam
    assert rays["blocked"][west, 80] < 0.01            # the other side has no ridge


def test_classes_follow_the_beam_height_and_the_blocked_share():
    agl = np.array([0.5, 1.9, 2.5, 3.9, 4.5, 1.0, 1.0, 1.0])
    blk = np.array([0.0, 0.05, 0.0, 0.4, 0.0, 0.2, 0.55, 0.0])
    got = R.classify(agl, blk)
    assert list(got) == [R.GOOD, R.GOOD, R.LIMITED, R.LIMITED, R.POOR, R.LIMITED, R.POOR, R.GOOD]
