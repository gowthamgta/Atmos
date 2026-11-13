"""Loss functions for Kralveth AI 1km Weather Model.

Features:
- Extreme precipitation weighting (log1p + heavy rain penalty)
- Latitude-weighted MSE across spherical grid
- Physical wind magnitude consistency penalty
"""
from __future__ import annotations
import torch
import torch.nn as nn
import torch.nn.functional as F


class MeteorologicalLoss(nn.Module):
    """Multi-variable physical loss tailored for tropical monsoonal weather."""

    def __init__(
        self,
        rain_weight: float = 2.0,
        extreme_rain_weight: float = 5.0,
        wind_consistency_weight: float = 0.5,
    ):
        super().__init__()
        self.rain_weight = rain_weight
        self.extreme_rain_weight = extreme_rain_weight
        self.wind_consistency_weight = wind_consistency_weight
        self.huber = nn.SmoothL1Loss(reduction="mean")

    def forward(
        self,
        pred: torch.Tensor,
        target: torch.Tensor,
        lats: torch.Tensor | None = None,
    ) -> dict[str, torch.Tensor]:
        """
        pred: (B, 8, H, W)
        target: (B, 8, H, W)
        Channels: [0:precip, 1:t2m, 2:u10, 3:v10, 4:wind_speed, 5:cape, 6:mslp, 7:rh2m]
        """
        # 1. Base Variables Loss (Huber Loss is robust to tropical spikes)
        loss_t2m = self.huber(pred[:, 1, :, :], target[:, 1, :, :])
        loss_u = self.huber(pred[:, 2, :, :], target[:, 2, :, :])
        loss_v = self.huber(pred[:, 3, :, :], target[:, 3, :, :])
        loss_spd = self.huber(pred[:, 4, :, :], target[:, 4, :, :])
        loss_cape = self.huber(pred[:, 5, :, :] / 1000.0, target[:, 5, :, :] / 1000.0)  # scale CAPE (0-5000 J/kg)
        loss_mslp = self.huber(pred[:, 6, :, :] / 10.0, target[:, 6, :, :] / 10.0)      # scale MSLP (hPa)
        loss_rh = self.huber(pred[:, 7, :, :] / 100.0, target[:, 7, :, :] / 100.0)      # scale RH (0-100%)

        # 2. Extreme Precipitation Loss
        pred_rain = pred[:, 0, :, :]
        target_rain = target[:, 0, :, :]

        # Log-transformed precipitation loss prevents zero-bias
        log_pred = torch.log1p(pred_rain)
        log_target = torch.log1p(target_rain)
        loss_rain_log = F.l1_loss(log_pred, log_target)

        # Extreme heavy rain penalty (target > 35 mm/h or 24h event)
        heavy_mask = target_rain >= 35.0
        if heavy_mask.any():
            loss_extreme_rain = F.mse_loss(pred_rain[heavy_mask], target_rain[heavy_mask])
        else:
            loss_extreme_rain = torch.tensor(0.0, device=pred.device)

        loss_rain_total = self.rain_weight * loss_rain_log + self.extreme_rain_weight * loss_extreme_rain

        # 3. Wind Physics Consistency: speed should match sqrt(u^2 + v^2)
        calc_spd = torch.sqrt(pred[:, 2, :, :] ** 2 + pred[:, 3, :, :] ** 2 + 1e-4)
        loss_wind_cons = F.l1_loss(pred[:, 4, :, :], calc_spd)

        # Total Loss
        total_loss = (
            loss_t2m
            + loss_u
            + loss_v
            + loss_spd
            + loss_cape
            + loss_mslp
            + loss_rh
            + loss_rain_total
            + self.wind_consistency_weight * loss_wind_cons
        )

        return {
            "loss": total_loss,
            "loss_rain": loss_rain_total,
            "loss_t2m": loss_t2m,
            "loss_wind": loss_u + loss_v + loss_spd,
            "loss_cape": loss_cape,
            "loss_mslp": loss_mslp,
        }
