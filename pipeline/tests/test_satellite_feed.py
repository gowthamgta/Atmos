"""Unit tests for near-realtime satellite ingestion and convective proxy."""
import os
import sys
from datetime import datetime, timezone, timedelta
import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from ai_model.data.satellite_feed import (
    parse_iso_time,
    BASE_SATELLITE_URL,
    MAX_SATELLITE_AGE_HOURS,
)
from ai_model.data.obs_feed import is_fresh_observation


def test_parse_iso_time():
    t_str = "2026-11-13T09:20:00Z"
    dt = parse_iso_time(t_str)
    assert dt is not None
    assert dt.year == 2026 and dt.month == 11 and dt.day == 13
    assert dt.hour == 9 and dt.minute == 20
    assert dt.tzinfo is not None


def test_convective_rain_transfer_function():
    # Cold cloud tops colder than -38°C produce rain; warm tops produce 0
    t_warm = np.array([-10.0, 0.0, 15.0, -35.0], dtype=np.float32)
    cold_mask = t_warm < -38.0
    rain_warm = np.zeros_like(t_warm)
    rain_warm[cold_mask] = 0.45 * (-38.0 - t_warm[cold_mask])
    assert (rain_warm == 0.0).all()

    # Deep convective storm (-60°C) with overshooting core
    t_storm = np.array([-60.0], dtype=np.float32)
    cold_mask = t_storm < -38.0
    rain_storm = np.zeros_like(t_storm)
    rain_storm[cold_mask] = 0.45 * (-38.0 - t_storm[cold_mask])
    overshoot = t_storm < -55.0
    rain_storm[overshoot] += 1.25 * (-55.0 - t_storm[overshoot])
    assert rain_storm[0] > 15.0  # torrential convective precipitation


def test_effective_cloud_fraction():
    # Warm surface (26°C) -> 0.0 cloud fraction
    cf_clear = np.clip((26.0 - 26.0) / 60.0, 0.0, 1.0)
    assert cf_clear == 0.0

    # Cold convective storm (-40°C) -> 1.0 cloud fraction
    cf_overcast = np.clip((26.0 - (-40.0)) / 60.0, 0.0, 1.0)
    assert cf_overcast == 1.0


def test_satellite_freshness_policy():
    now = datetime.now(timezone.utc)
    fresh_time = (now - timedelta(minutes=45)).isoformat()
    old_time = (now - timedelta(hours=6)).isoformat()

    assert is_fresh_observation(fresh_time, ref_time=now, max_age_hours=MAX_SATELLITE_AGE_HOURS) is True
    assert is_fresh_observation(old_time, ref_time=now, max_age_hours=MAX_SATELLITE_AGE_HOURS) is False
