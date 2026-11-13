import os
import sys
import numpy as np
import torch

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
