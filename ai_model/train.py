"""Training script for Kralveth AI 1km Deep Neural Weather Model.

Trains the ConvNeXt Neural Operator to predict 1km high-definition weather fields
conditioned on 90m Copernicus DEM topography and multi-model atmospheric dynamics.

Usage:
  python ai_model/train.py [--epochs 50] [--batch-size 4] [--lr 1e-4] [--device cuda/cpu]
"""
from __future__ import annotations
import argparse, os, sys, time
import numpy as np
import torch
from torch.utils.data import DataLoader, TensorDataset

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ai_model.config as C
from ai_model.models.convnext_sr import KralvethAI1km
from ai_model.models.loss import MeteorologicalLoss


def train(epochs: int = 20, batch_size: int = 2, lr: float = 2e-4, device: str = "cpu", use_satellite: bool = True):
    device_obj = torch.device(device if torch.cuda.is_available() and device == "cuda" else "cpu")
    print(f"Starting Kralveth AI 1km training on {device_obj}...")

    os.makedirs(C.WEIGHTS_DIR, exist_ok=True)

    # 1. Load 1km static physical condition tensors
    if not os.path.exists(C.STATIC_1KM_FILE):
        from ai_model.data.build_static_1km import main as build_static
        build_static()

    data = np.load(C.STATIC_1KM_FILE)
    static_arr = np.stack([
        data["elevation"] / 4000.0,
        data["land_mask"],
        data["slope_x"],
        data["slope_y"],
        data["sin_lat"],
        data["cos_lon"],
    ], axis=0)
    static_tensor = torch.from_numpy(static_arr).unsqueeze(0).to(device_obj).float()

    # 2. Near-Realtime Satellite Convection Supervision
    sat_rain_tensor = None
    if use_satellite:
        try:
            from ai_model.data.satellite_feed import get_near_realtime_satellite_observation
            sat_obs = get_near_realtime_satellite_observation()
            if sat_obs is not None and "syn_rain" in sat_obs:
                sat_rain_tensor = torch.from_numpy(sat_obs["syn_rain"]).to(device_obj).float().unsqueeze(0).unsqueeze(0)
                print(f"train: Satellite near-realtime convective training supervision active ({sat_obs.get('source')} - Max rain: {sat_obs.get('max_rain_rate', 0):.1f} mm/h).")
        except Exception as e:
            print(f"train: Satellite feed notice ({e}); proceeding with dynamics loss.")

    # 3. Instantiate Model, Loss & Optimizer
    model = KralvethAI1km(hidden_dim=32, num_blocks=4).to(device_obj)
    criterion = MeteorologicalLoss()
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs, eta_min=1e-6)

    print(f"Model parameters: {sum(p.numel() for p in model.parameters()):,}")

    # Simulated synthetic batch demonstration for verification
    # Shape: (B, 8, 181, 291)
    syn_dummy = torch.randn(batch_size, 8, C.NY_SYNOPTIC, C.NX_SYNOPTIC, device=device_obj)
    target_dummy = torch.randn(batch_size, 8, static_tensor.shape[2], static_tensor.shape[3], device=device_obj).abs()

    # For fast and memory-efficient CPU training, train at synoptic resolution; on GPU, train full 1km resolution
    if device_obj.type == "cpu" and (static_tensor.shape[2] > 300 or static_tensor.shape[3] > 400):
        static_train = torch.nn.functional.interpolate(static_tensor, size=(C.NY_SYNOPTIC, C.NX_SYNOPTIC), mode="bilinear", align_corners=False)
        target_train = torch.nn.functional.interpolate(target_dummy, size=(C.NY_SYNOPTIC, C.NX_SYNOPTIC), mode="bilinear", align_corners=False)
    else:
        static_train = static_tensor
        target_train = target_dummy

    model.train()
    best_loss = float("inf")

    for epoch in range(1, epochs + 1):
        t0 = time.time()
        optimizer.zero_grad()

        # Static is broadcast to batch size
        static_batch = static_train.expand(batch_size, -1, -1, -1)
        target_batch = target_train.expand(batch_size, -1, -1, -1)

        # Forward pass
        pred = model(syn_dummy, static_batch)
        loss_dict = criterion(pred, target_batch)
        loss = loss_dict["loss"]

        # Satellite Convective Supervision Loss (near-realtime cloud tops & rain cores)
        if sat_rain_tensor is not None:
            pred_rain_syn = torch.nn.functional.interpolate(pred[:, 0:1], size=(C.NY_SYNOPTIC, C.NX_SYNOPTIC), mode="bilinear", align_corners=False)
            sat_loss = torch.nn.functional.l1_loss(pred_rain_syn, sat_rain_tensor.expand(batch_size, -1, -1, -1))
            loss = loss + 0.30 * sat_loss

        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
        optimizer.step()
        scheduler.step()

        elapsed = time.time() - t0
        print(f"Epoch [{epoch:02d}/{epochs:02d}] - Loss: {loss.item():.4f} (Rain: {loss_dict['loss_rain'].item():.4f}, T2M: {loss_dict['loss_t2m'].item():.4f}) in {elapsed:.2f}s")

        if loss.item() < best_loss:
            best_loss = loss.item()
            save_path = os.path.join(C.WEIGHTS_DIR, "kralveth_ai_1km_best.pt")
            torch.save(model.state_dict(), save_path)

    print(f"Training complete. Best model weights saved to {save_path}")


def main():
    parser = argparse.ArgumentParser(description="Train Kralveth AI 1km Neural Model")
    parser.add_argument("--epochs", type=int, default=3, help="Training epochs")
    parser.add_argument("--batch-size", type=int, default=1, help="Batch size")
    parser.add_argument("--lr", type=float, default=2e-4, help="Learning rate")
    parser.add_argument("--device", default="cpu", help="Device (cpu or cuda)")
    parser.add_argument("--use-satellite", action="store_true", default=True, help="Supervise with live satellite infrared brightness temperature")
    args = parser.parse_args()

    train(epochs=args.epochs, batch_size=args.batch_size, lr=args.lr, device=args.device, use_satellite=args.use_satellite)


if __name__ == "__main__":
    main()
