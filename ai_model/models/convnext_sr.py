"""Kralveth AI 1km: Physics-Informed ConvNeXt Neural Weather Model.

Downscales and synthesizes multi-model synoptic atmospheric fields (0.1°) into true 1km
high-definition weather forecasts (0.01°) conditioned on 90m Copernicus DEM topography,
orographic slope vectors, land-sea boundary, and spatial coordinates.
"""
from __future__ import annotations
import torch
import torch.nn as nn
import torch.nn.functional as F


class ConvNeXtBlock(nn.Module):
    """ConvNeXt Block with 7x7 depthwise convolution, LayerNorm, and 4x inverted bottleneck."""

    def __init__(self, dim: int, drop_path: float = 0.0):
        super().__init__()
        self.dwconv = nn.Conv2d(dim, dim, kernel_size=7, padding=3, groups=dim)  # depthwise conv
        self.norm = nn.GroupNorm(1, dim)  # Equivalent to LayerNorm across channels
        self.pwconv1 = nn.Conv2d(dim, 4 * dim, kernel_size=1)
        self.act = nn.GELU()
        self.pwconv2 = nn.Conv2d(4 * dim, dim, kernel_size=1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = x
        x = self.dwconv(x)
        x = self.norm(x)
        x = self.pwconv1(x)
        x = self.act(x)
        x = self.pwconv2(x)
        return residual + x


class OrographicInteractionLayer(nn.Module):
    """Computes meteorological orographic wind lift: W_orog = V_h • ∇h = u * (∂z/∂x) + v * (∂z/∂y).
    This explicitly provides the network with the physical driver of mountain cloudbursts."""

    def __init__(self, u_idx: int = 2, v_idx: int = 3, slope_x_idx: int = 2, slope_y_idx: int = 3):
        super().__init__()
        self.u_idx = u_idx
        self.v_idx = v_idx
        self.slope_x_idx = slope_x_idx
        self.slope_y_idx = slope_y_idx

    def forward(self, synoptic_up: torch.Tensor, static_1km: torch.Tensor) -> torch.Tensor:
        u = synoptic_up[:, self.u_idx : self.u_idx + 1, :, :]
        v = synoptic_up[:, self.v_idx : self.v_idx + 1, :, :]
        slope_x = static_1km[:, self.slope_x_idx : self.slope_x_idx + 1, :, :]
        slope_y = static_1km[:, self.slope_y_idx : self.slope_y_idx + 1, :, :]

        w_orog = u * slope_x + v * slope_y  # Orographic vertical velocity proxy (m/s)
        return w_orog


class KralvethAI1km(nn.Module):
    """Kralveth AI 1km Deep Neural Weather Operator.

    Inputs:
      - synoptic: (B, 8, H_syn, W_syn) - Multi-model fields on 0.1° grid
      - static_1km: (B, 6, H_1km, W_1km) - Topography, slopes, mask, coordinates
    Output:
      - forecast_1km: (B, 8, H_1km, W_1km) - Physical 1km resolved weather fields
    """

    def __init__(
        self,
        synoptic_channels: int = 8,
        static_channels: int = 6,
        hidden_dim: int = 64,
        num_blocks: int = 6,
    ):
        super().__init__()
        self.orog_layer = OrographicInteractionLayer()

        # Input channels: Synoptic (8) + Static (6) + Orographic Lift (1) = 15 channels
        in_channels = synoptic_channels + static_channels + 1

        self.stem = nn.Sequential(
            nn.Conv2d(in_channels, hidden_dim, kernel_size=3, padding=1),
            nn.GroupNorm(1, hidden_dim),
            nn.GELU(),
        )

        self.blocks = nn.ModuleList([ConvNeXtBlock(hidden_dim) for _ in range(num_blocks)])

        self.head = nn.Sequential(
            nn.GroupNorm(1, hidden_dim),
            nn.GELU(),
            nn.Conv2d(hidden_dim, synoptic_channels, kernel_size=3, padding=1),
        )

    def forward(
        self,
        synoptic: torch.Tensor,
        static_1km: torch.Tensor,
    ) -> torch.Tensor:
        """Forward pass.
        synoptic: (B, 8, H_syn, W_syn)
        static_1km: (B, 6, H_1km, W_1km)
        """
        target_size = (static_1km.shape[2], static_1km.shape[3])

        # 1. Bilinear upsample synoptic consensus to 1km target grid
        synoptic_up = F.interpolate(synoptic, size=target_size, mode="bilinear", align_corners=True)

        # 2. Compute physical orographic vertical motion
        w_orog = self.orog_layer(synoptic_up, static_1km)

        # 3. Concatenate all multi-source tensors
        fused = torch.cat([synoptic_up, static_1km, w_orog], dim=1)

        # 4. Deep feature extraction via ConvNeXt blocks
        feats = self.stem(fused)
        for block in self.blocks:
            feats = block(feats)

        # 5. Residual prediction (base synoptic + neural microclimate adjustments)
        delta = self.head(feats)
        out = synoptic_up + delta

        # 6. Apply physical meteorological constraints
        precip = F.relu(out[:, 0:1, :, :])                # Non-negative precipitation
        t2m = out[:, 1:2, :, :]                          # Temperature (unbounded °C)
        u10 = out[:, 2:3, :, :]                          # U-wind
        v10 = out[:, 3:4, :, :]                          # V-wind
        wind_speed = F.relu(out[:, 4:5, :, :])            # Scalar wind speed
        cape = F.relu(out[:, 5:6, :, :])                  # CAPE >= 0 J/kg
        mslp = out[:, 6:7, :, :]                         # MSLP (hPa)
        rh2m = torch.clamp(out[:, 7:8, :, :], 0.0, 100.0) # Relative humidity 0-100%

        return torch.cat([precip, t2m, u10, v10, wind_speed, cape, mslp, rh2m], dim=1)


def build_model(pretrained_path: str | None = None) -> KralvethAI1km:
    model = KralvethAI1km()
    if pretrained_path:
        import os
        if os.path.exists(pretrained_path):
            state = torch.load(pretrained_path, map_location="cpu", weights_only=True)
            model.load_state_dict(state)
            print(f"Loaded Kralveth AI 1km weights from {pretrained_path}")
    return model
