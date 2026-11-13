import os
import sys
import numpy as np
import pytest

torch = pytest.importorskip("torch", reason="torch is required for Kralveth AI neural weather model tests")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

import ai_model.config as AIC
from ai_model.models.convnext_sr import KralvethAI1km
from ai_model.models.loss import MeteorologicalLoss


def test_ai_model_config():
    assert AIC.LAT_MAX == 20.0
    assert AIC.LAT_MIN == 2.0
    assert AIC.LON_MIN == 70.0
    assert AIC.LON_MAX == 99.0
    assert AIC.NY_SYNOPTIC == 181
    assert AIC.NX_SYNOPTIC == 291
    assert AIC.REACH_HOURS == 72
    assert "precip" in AIC.TARGET_VARIABLES
    assert "elevation" in AIC.STATIC_CHANNELS


def test_kralveth_ai_neural_forward_and_physics_constraints():
    model = KralvethAI1km(hidden_dim=16, num_blocks=2)  # lightweight for unit test
    model.eval()

    # Small mock synoptic grid (1, 8, 18, 29)
    syn = torch.randn(1, 8, 18, 29)
    # Target 1km resolution (1, 6, 90, 145)
    static = torch.randn(1, 6, 90, 145)

    with torch.no_grad():
        out = model(syn, static)

    assert out.shape == (1, 8, 90, 145)

    # Physical constraints verification
    precip = out[:, 0, :, :]
    wind_spd = out[:, 4, :, :]
    cape = out[:, 5, :, :]
    rh = out[:, 7, :, :]

    assert (precip >= 0.0).all(), "Precipitation must be non-negative"
    assert (wind_spd >= 0.0).all(), "Wind speed must be non-negative"
    assert (cape >= 0.0).all(), "CAPE must be non-negative"
    assert (rh >= 0.0).all() and (rh <= 100.0).all(), "Relative humidity must be bounded in [0, 100]%"


def test_meteorological_loss_computes_finite_gradient():
    crit = MeteorologicalLoss()
    pred = torch.rand(1, 8, 30, 30, requires_grad=True)
    target = torch.rand(1, 8, 30, 30)

    loss_dict = crit(pred, target)
    total_loss = loss_dict["loss"]

    assert torch.isfinite(total_loss), "Loss must be finite"
    assert total_loss.item() > 0

    total_loss.backward()
    assert pred.grad is not None and torch.isfinite(pred.grad).all()


def test_airport_and_tn_station_assimilation():
    from ai_model.data.obs_feed import (
        AIRPORT_COORDS,
        barnes_objective_analysis_2d,
        assimilate_hourly_observations,
    )

    # 1. Airports coverage
    assert "VOMM" in AIRPORT_COORDS  # Chennai
    assert "VOCB" in AIRPORT_COORDS  # Coimbatore
    assert "VOMD" in AIRPORT_COORDS  # Madurai
    assert "VOTR" in AIRPORT_COORDS  # Trichy

    # 2. Objective analysis test: flat 30°C grid nudged by an airport observing 27°C
    flat_grid = np.full((181, 291), 30.0, dtype=np.float32)
    obs = [(12.994, 80.180, 27.0)]  # Chennai Airport reports 27°C
    nudged = barnes_objective_analysis_2d(flat_grid, obs, radius_km=40.0)

    # Near Chennai: temperature should be nudged down toward 27°C
    r_chennai = int(round((20.0 - 12.994) / 18.0 * 180))
    c_chennai = int(round((80.180 - 70.0) / 29.0 * 290))
    assert nudged[r_chennai, c_chennai] < 29.0

    # Far away (e.g. Arabian Sea or Lakshadweep): should remain undisturbed at 30°C
    assert nudged[0, 0] == 30.0

    # 3. Assimilate dictionary test
    syn_fields = {
        "t2m": np.full((181, 291), 28.0, dtype=np.float32),
        "rh": np.full((181, 291), 70.0, dtype=np.float32),
        "precip": np.full((181, 291), 0.05, dtype=np.float32),  # trace drizzle
    }
    assimilated = assimilate_hourly_observations(syn_fields, hour_utc=12)
    assert "t2m" in assimilated
    assert "rh" in assimilated
    # Trace drizzle under 0.1 mm/h is clamped to 0
    assert (assimilated["precip"] == 0.0).all()
