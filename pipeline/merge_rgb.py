"""The merged RGB (the owner, 3 Nov 2026: "merge all these things to create a high quality RGB ... windy rgb look but cloud tops shape
should be visible. keep infrared same"): Meteosat-9 (over 45.5 E) and Himawari-9 (over 140.7 E) HRV Cloud pictures, which both satellites'
scripts already write on the same latitude/longitude grid over the app's box (himawari_rgb.save_hrv_clouds), made into one.

Each place takes the satellite that sees it more directly: the two pictures are weighted by cos(view zenith) ** WEIGHT_POWER, so the west of
India comes from Meteosat, the Bay of Bengal and the north-east from Himawari (its 0.5 km visible band, sharper cloud tops), with a smooth
blend between them and no seam. A satellite counts only where its own picture has a value. Himawari's visible (0.64 um) is brighter or
darker than Meteosat's HRV (a broad band): its brightness is first matched to Meteosat's where both see the place well (GAIN_*). The blue,
the 10.8 / 10.4 um temperature, is on the same scale in both and is blended as it is.

Only times both satellites have a day picture for are merged; at other times Meteosat's own picture is used. Every frame keeps Meteosat's data
pack (the infrared, the hover readout, the 3D clouds), so the infrared is the same as Meteosat's. The app colours the merged picture with its
agreed Windy colours (satellite-image.ts), which keep the picture's brightness detail: the shapes of the cloud tops show.

  python merge_rgb.py --out site        (after satellite_bt.py --pictures and himawari_rgb.py have written site/rgb-msg and site/rgb-h9)
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys

import numpy as np

import himawari_bt as H
import himawari_rgb as G

FOLDER = "rgb-merged"
MSG_FOLDER, H9_FOLDER = "rgb-msg", "rgb-h9"
MSG_SUB_LON, H9_SUB_LON = 45.5, H.SUB_LON
KINDS = ("rgb", "rgb_lo")
WEIGHT_POWER = 4
# Himawari's brightness matched to Meteosat's over pixels both see well (each weight at least GAIN_MIN_WEIGHT of the pair) with a visible
# value in GAIN_RANGE (not dark sea, not saturated tops); from at least GAIN_MIN_PIXELS of them, else left as it is
GAIN_MIN_WEIGHT = 0.25
GAIN_RANGE = (40, 220)
GAIN_MIN_PIXELS = 2000
GAIN_LIMITS = (0.6, 1.6)
SOURCE = ("Meteosat-9 SEVIRI (EUMETSAT, 45.5 E) and Himawari-9 AHI (JMA, NOAA open data), merged by view angle; parallax-corrected; "
          "the data pack is Meteosat's")


def view_weights(lat: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """How directly each satellite sees each place: cos(view zenith) ** WEIGHT_POWER, 0 beyond each one's usable angle."""
    zm, _ = H.view_geometry(lat, lon, MSG_SUB_LON)
    zh, _ = H.view_geometry(lat, lon, H9_SUB_LON)
    wm = np.where(zm < 80.0, np.cos(np.radians(zm)) ** WEIGHT_POWER, 0.0)
    wh = np.where(zh < H.MAX_VIEW_DEG, np.cos(np.radians(zh)) ** WEIGHT_POWER, 0.0)
    return wm, wh


def brightness_gain(msg_vis: np.ndarray, h9_vis: np.ndarray, wm: np.ndarray, wh: np.ndarray) -> float:
    """The factor that brings Himawari's visible to Meteosat's (the median ratio where both see the place well), 1 when too few pixels."""
    total = wm + wh
    with np.errstate(invalid="ignore", divide="ignore"):
        both = (wm / total >= GAIN_MIN_WEIGHT) & (wh / total >= GAIN_MIN_WEIGHT)
    lo, hi = GAIN_RANGE
    ok = both & (msg_vis >= lo) & (msg_vis <= hi) & (h9_vis >= lo) & (h9_vis <= hi)
    if ok.sum() < GAIN_MIN_PIXELS:
        return 1.0
    return float(np.clip(np.median(msg_vis[ok] / h9_vis[ok]), *GAIN_LIMITS))


def merge_pictures(msg: np.ndarray, h9: np.ndarray, lat: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, float]:
    """The two HRV Cloud pictures (rows x cols x 3 bytes, red = green = visible, blue = temperature) as one, and the gain used."""
    wm, wh = view_weights(lat, lon)
    mv, hv = msg[..., 0].astype(float), h9[..., 0].astype(float)
    mb, hb = msg[..., 2].astype(float), h9[..., 2].astype(float)
    gain = brightness_gain(mv, hv, wm, wh)
    hv = np.clip(hv * gain, 0, 255)

    def blend(a: np.ndarray, b: np.ndarray, a_ok: np.ndarray, b_ok: np.ndarray) -> np.ndarray:
        wa, wb = np.where(a_ok, wm, 0.0), np.where(b_ok, wh, 0.0)
        total = wa + wb
        with np.errstate(invalid="ignore", divide="ignore"):
            out = (a * wa + b * wb) / total
        return np.where(total > 0, out, 0.0)

    vis = blend(mv, hv, mv > 0, hv > 0)
    temp = blend(mb, hb, mb > 0, hb > 0)
    out = np.zeros(msg.shape, np.uint8)
    out[..., 0] = out[..., 1] = np.round(vis).astype(np.uint8)
    out[..., 2] = np.round(temp).astype(np.uint8)
    return out, gain


def merge_file(msg_path: str, h9_path: str, kind: str, out_path: str) -> float:
    """Merges one pair of pictures (rgb or rgb_lo) into out_path; returns the gain."""
    from PIL import Image
    msg = np.asarray(Image.open(msg_path).convert("RGB"))
    h9 = np.asarray(Image.open(h9_path).convert("RGB"))
    g = G.latlon_grid(G.HRV_STEP_DEG[kind])
    if msg.shape[:2] != (g["rows"], g["cols"]) or h9.shape != msg.shape:
        raise ValueError(f"{kind}: picture sizes {msg.shape} / {h9.shape} are not the grid's {(g['rows'], g['cols'])}")
    merged, gain = merge_pictures(msg, h9, g["lat"], g["lon"])
    Image.fromarray(merged, "RGB").save(out_path, "WEBP", quality=92, method=4)
    return gain


def build(site: str) -> dict | None:
    """Writes site/rgb-merged (its pictures and index.json) from site/rgb-msg and site/rgb-h9; returns its index, None without Meteosat."""
    msg_dir, h9_dir, out_dir = (os.path.join(site, f) for f in (MSG_FOLDER, H9_FOLDER, FOLDER))
    try:
        msg_index = json.load(open(os.path.join(msg_dir, "index.json")))
    except (OSError, ValueError):
        return None
    try:
        h9_frames = {f["time"]: f["files"] for f in json.load(open(os.path.join(h9_dir, "index.json")))["frames"]}
    except (OSError, ValueError, KeyError):
        h9_frames = {}
    os.makedirs(out_dir, exist_ok=True)
    frames, used, merged = [], set(), 0
    for frame in msg_index.get("frames", []):
        files = frame["files"]
        if "data" not in files:
            continue
        out_files: dict[str, str] = {}
        h9 = h9_frames.get(frame["time"], {})
        for kind in KINDS:
            if kind not in files:
                continue
            msg_path = os.path.join(msg_dir, files[kind])
            if not os.path.exists(msg_path):
                continue
            h9_path = os.path.join(h9_dir, h9[kind]) if kind in h9 else ""
            if h9_path and os.path.exists(h9_path):
                name = f"{kind}-merged-{os.path.basename(files[kind]).split('-', 1)[1]}"
                if not os.path.exists(os.path.join(out_dir, name)):   # restored from the live site: already made
                    try:
                        gain = merge_file(msg_path, h9_path, kind, os.path.join(out_dir, name))
                        merged += 1
                        print(f"merged {frame['time']} {kind} (Himawari brightness x{gain:.2f})", flush=True)
                    except (OSError, ValueError) as e:
                        print(f"::warning::{frame['time']} {kind} not merged: {e}", flush=True)
                        name = os.path.basename(files[kind])
                        shutil.copyfile(msg_path, os.path.join(out_dir, name))
            else:
                name = os.path.basename(files[kind])
                if not os.path.exists(os.path.join(out_dir, name)):
                    shutil.copyfile(msg_path, os.path.join(out_dir, name))
            out_files[kind] = name
        data_src = os.path.join(msg_dir, files["data"])
        if not os.path.exists(data_src):
            continue
        data_name = os.path.basename(files["data"])
        if not os.path.exists(os.path.join(out_dir, data_name)):
            shutil.copyfile(data_src, os.path.join(out_dir, data_name))
        out_files["data"] = data_name
        frames.append({"time": frame["time"], "files": out_files})
        used.update(out_files.values())
    for name in os.listdir(out_dir):
        if name != "index.json" and name not in used:
            os.remove(os.path.join(out_dir, name))
    index = {**msg_index, "source": SOURCE, "frames": frames}
    with open(os.path.join(out_dir, "index.json"), "w") as f:
        json.dump(index, f, separators=(",", ":"))
    print(f"rgb-merged: {len(frames)} frames, {merged} pictures merged this run", flush=True)
    return index


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="the site folder holding rgb-msg and rgb-h9")
    args = ap.parse_args()
    return 0 if build(args.out) is not None else 1


if __name__ == "__main__":
    sys.exit(main())
