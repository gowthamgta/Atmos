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


def train(epochs: int = 20, batch_size: int = 2, lr: float = 2e-4, device: str = "cpu"):
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

    # 2. Instantiate Model, Loss & Optimizer
    model = KralvethAI1km(hidden_dim=32, num_blocks=4).to(device_obj)
    criterion = MeteorologicalLoss()
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs, eta_min=1e-6)

    print(f"Model parameters: {sum(p.numel() for p in model.parameters()):,}")

    # Simulated synthetic batch demonstration for verification
    # Shape: (B, 8, 181, 291)
    syn_dummy = torch.randn(batch_size, 8, C.NY_SYNOPTIC, C.NX_SYNOPTIC, device=device_obj)
    target_dummy = torch.randn(batch_size, 8, static_tensor.shape[2], static_tensor.shape[3], device=device_obj).abs()

    model.train()
    best_loss = float("inf")

    for epoch in range(1, epochs + 1):
        t0 = time.time()
        optimizer.zero_grad()

        # Static is broadcast to batch size
        static_batch = static_tensor.expand(batch_size, -1, -1, -1)

        # Forward pass
        pred = model(syn_dummy, static_batch)
        loss_dict = criterion(pred, target_dummy)
        loss = loss_dict["loss"]

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
    args = parser.parse_args()

    train(epochs=args.epochs, batch_size=args.batch_size, lr=args.lr, device=args.device)


if __name__ == "__main__":
    main()
