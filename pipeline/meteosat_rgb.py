"""Our own satellite pictures from Meteosat's raw SEVIRI data (Indian Ocean service, over 45.5 E), for the app's satellite panel.

The same idea as himawari_rgb.py, from the High Rate SEVIRI Level 1.5 file satellite_bt.py already downloads for the temperatures (so the
~250 MB file is fetched once). Meteosat sees all of India from the west at a moderate angle, so the box is the app's whole satellite box
(68-97.5 E, 5-37.5 N), on a Web Mercator grid at 1.25 km (the HRV's own pixel over India: finer only repeats pixels):

- hrv         the High Resolution Visible channel itself, uncompressed and with its full brightness range (EUMETView's pictures are 8-bit
              JPEGs), sun-normalised, in grey, by day
- natural     natural colour (0.6, 0.8, 1.6 um, Satpy's `natural_color`, 3 km) sharpened with the HRV: each pixel's colour kept, its
              brightness detail taken from the HRV, by day
- sandwich    the HRV's texture coloured where the 10.8 um top is colder than -38 C (as himawari_rgb.sandwich), by day
- convection  Satpy's severe convection RGB, by day
- nightmicro  Satpy's tropical night microphysics RGB, day and night
- data        lossless PNG of brightness temperatures at 3 km: red 10.8 um, green 6.2 um, blue 7.3 um, kelvin = 180 + v x 140/255

Parallax-corrected as the Himawari pictures are, for a satellite over 45.5 E (cloud tops are seen displaced eastward over India).
Where the HRV has no data (its scan does not cover the whole disc), the 0.6 um channel stands in for it.
"""
from __future__ import annotations
import os

import numpy as np

import himawari_bt as H
import himawari_rgb as G

FOLDER = "rgb-msg"
BOX = (68.0, 97.5, 5.0, 37.5)
RES_M = 1250
DATA_RES_M = 3000
SUB_LON = 45.5
MAX_VIEW_DEG = 80.0
DAY_PRODUCTS = ("hrv", "natural", "sandwich", "convection")
SOURCE = "EUMETSAT Meteosat SEVIRI Level 1.5 (Indian Ocean service, 45.5 E); parallax-corrected"


def box_blur(a: np.ndarray, r: int) -> np.ndarray:
    """The mean over a (2r+1)^2 window, leaving out NaN (NaN where the whole window is)."""
    ok = np.isfinite(a)
    v = np.where(ok, a, 0.0)
    rows, cols = a.shape
    pv = np.pad(v, r)
    pk = np.pad(ok.astype(float), r)
    acc = np.zeros_like(v)
    n = np.zeros_like(v)
    for dr in range(2 * r + 1):
        for dc in range(2 * r + 1):
            acc += pv[dr:dr + rows, dc:dc + cols]
            n += pk[dr:dr + rows, dc:dc + cols]
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(n > 0, acc / n, np.nan)


def sharpen(rgb: np.ndarray, hrv: np.ndarray, r: int = 2) -> np.ndarray:
    """Ratio sharpening: each colour multiplied by the HRV over its local mean (about the 3 km pixel of the colour channels), so the
    colour stays and the HRV's detail comes in; unchanged where the HRV has no data."""
    ratio = (hrv + 0.02) / (box_blur(hrv, r) + 0.02)
    ratio = np.where(np.isfinite(ratio), np.clip(ratio, 0.4, 2.5), 1.0)
    return np.clip(rgb * ratio[..., None], 0, 1)


def make_scan(path: str, t, folder: str) -> dict:
    """All products of one SEVIRI native file, written to `folder`; returns the frame's {product: file name}."""
    from satpy import Scene
    from PIL import Image
    os.makedirs(folder, exist_ok=True)
    g = G.grid(RES_M, BOX)
    gd = G.grid(DATA_RES_M, BOX)
    sza = G.sun_zenith(t, g["lat"], g["lon"])
    day = float((sza < 88).mean()) > 0.02
    composites = ["night_microphysics_tropical"] + (["natural_color", "convection"] if day else [])
    scn = Scene(reader="seviri_l1b_native", filenames=[path])
    scn.load(composites + ["VIS006", "IR_108", "WV_062", "WV_073"], generate=False)
    local = scn.resample(G.area_def(g, "msg"), resampler="gradient_search")
    local.load(composites)
    local_data = scn.resample(G.area_def(gd, "msg_data"), resampler="gradient_search")
    # the HRV is stored as two stacked windows, which the gradient search cannot take: it is resampled on its own, nearest pixel
    hrv_raw = None
    if day:
        scn_hrv = Scene(reader="seviri_l1b_native", filenames=[path])
        scn_hrv.load(["HRV"])
        hrv_raw = np.asarray(scn_hrv.resample(G.area_def(g, "msg_hrv"), resampler="nearest", radius_of_influence=2500)["HRV"].values, float)
    bt = np.asarray(local["IR_108"].values, float)
    stamp = t.strftime("%Y%m%dT%H%MZ")
    pictures = {"nightmicro": G.enhanced(local, "night_microphysics_tropical")}
    if day:
        # the visible brightness, sun-normalised (a low sun no longer darkens it), HRV where it has data, 0.6 um elsewhere
        cos_z = np.cos(np.radians(np.minimum(sza, 85)))
        hrv = hrv_raw / 100 / cos_z
        vis = np.asarray(local["VIS006"].values, float) / 100 / cos_z
        vis_hr = np.where(np.isfinite(hrv), hrv, vis)
        grey = np.clip(np.nan_to_num(vis_hr), 0, 1.2) / 1.2
        pictures["hrv"] = np.repeat((grey ** (1 / 1.5))[..., None], 3, -1)
        pictures["natural"] = sharpen(G.fill_specks(G.enhanced(local, "natural_color")), vis_hr)
        pictures["sandwich"] = G.sandwich(vis_hr, bt)
        pictures["convection"] = G.enhanced(local, "convection")
    names = list(pictures)
    channels = [pictures[n][..., k] for n in names for k in range(3)]
    _, channels = H.parallax_correct(bt, channels, g["lat"], g["lon"], g["to_rc"], sub_lon=SUB_LON, max_view=MAX_VIEW_DEG)
    zenith, _ = H.view_geometry(g["lat"], g["lon"], SUB_LON)
    view = 1 - G.smooth(MAX_VIEW_DEG - 3, MAX_VIEW_DEG, zenith)
    daylight = 1 - G.smooth(80, 88, sza)
    out: dict[str, str] = {}
    for i, n in enumerate(names):
        rgb = np.stack(channels[3 * i:3 * i + 3], -1)
        out[n] = f"{n}-{stamp}.webp"
        G.save_webp(os.path.join(folder, out[n]), rgb, view * (daylight if n in DAY_PRODUCTS else 1))
    d108 = np.asarray(local_data["IR_108"].values, float)
    d062 = np.asarray(local_data["WV_062"].values, float)
    d073 = np.asarray(local_data["WV_073"].values, float)
    d108, (d062, d073) = H.parallax_correct(d108, [d062, d073], gd["lat"], gd["lon"], gd["to_rc"], sub_lon=SUB_LON, max_view=MAX_VIEW_DEG)
    px = np.stack([G.encode_data(d108), G.encode_data(d062), G.encode_data(d073)], -1)
    out["data"] = f"data-{stamp}.png"
    Image.fromarray(px, "RGB").save(os.path.join(folder, out["data"]), optimize=True)
    return out


def update_index(folder: str, new: list, now) -> dict:
    return G.update_index(folder, new, now, box=BOX, res=(RES_M, DATA_RES_M), source=SOURCE,
                          channels={"r": "IR_108 10.8 um", "g": "WV_062 6.2 um", "b": "WV_073 7.3 um"})
