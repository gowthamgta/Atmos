"""Our own satellite pictures from Himawari-9's raw bands (NOAA's open copy on AWS), for the app's satellite panel.

Instead of EUMETView's finished, heavily compressed pictures, each 10-minute Himawari scan is made into, on one Web Mercator grid at 1 km
over the part of India and the seas that Himawari sees well (75-97.5 E, 5-30 N; see himawari_bt.py for why the west is left out):

- truecolor   true colour, Rayleigh-corrected (Satpy's `true_color`: bands 1-4, 0.5-1 km), by day
- sandwich    the visible picture's texture (band 3, 0.5 km) coloured where the top is colder than -38 C (yellow, orange, red, dark red,
              violet at -85 C), the overshooting tops of storms standing out, by day
- convection  Satpy's severe convection RGB (6.9-7.3 um, 3.9-10.4 um, 1.6-0.64 um), by day
- nightmicro  Satpy's tropical night microphysics RGB (12.4-10.4 um, 10.4-3.9 um, 10.4 um): low cloud and fog against high cloud, day and night
- data        a lossless PNG of brightness temperatures for the browser to colour itself and read on hover: red 10.4 um, green 6.2 um,
              blue 7.3 um, kelvin = 180 + value x 140/255 (0 = no data), at 2 km

The pictures are WebP with transparency (nothing where there is no data, where Himawari sees too slantwise, or, for the daytime ones,
where the sun is down). Every layer is parallax-corrected as the temperatures are (himawari_bt.parallax_correct). An index lists the
last hour's frames (`rgb-h9/index.json`).

Only the area is resampled first and the composites made on it afterwards: making them on the full width of the disk's segments took
about 3.5 minutes for true colour alone, on the area about 10 seconds.

  python himawari_rgb.py --out site [--max-new 1] [--files <one scan's local segment files>]
"""
from __future__ import annotations
import argparse, json, math, os, sys, tempfile
from datetime import datetime, timedelta, timezone

import numpy as np

import himawari_bt as H
import satellite_bt as S
from net import download

FOLDER = "rgb-h9"
WEST, EAST, SOUTH, NORTH = 75.0, 97.5, 5.0, 30.0
RES_M = 1000                    # the pictures (Web Mercator metres at the equator)
DATA_RES_M = 2000               # the data pack: the infrared's own pixel
SEGMENTS = ("03", "04", "05")   # 5-30 N
BANDS = ("B01", "B02", "B03", "B04", "B05", "B07", "B08", "B09", "B10", "B13", "B15")
DATA_MIN_K, DATA_SPAN_K = 180.0, 140.0
DAY_PRODUCTS = ("truecolor", "sandwich", "convection")
SATPY = {"truecolor": "true_color", "convection": "convection", "nightmicro": "night_microphysics_tropical"}
R_EARTH_M = 6378137.0
# the cold-top colour table of the sandwich (kelvin, rgb)
SANDWICH_STOPS = [(188, (150, 60, 200)), (198, (120, 10, 30)), (205, (220, 30, 30)), (213, (255, 110, 20)), (225, (255, 200, 40)), (235, (255, 255, 120))]


def merc_y(lat: np.ndarray | float) -> np.ndarray | float:
    return R_EARTH_M * np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))


def grid(res_m: float, box: tuple[float, float, float, float] = (WEST, EAST, SOUTH, NORTH)) -> dict:
    """The Mercator grid over a box (west, east, south, north): its size, extent (metres), each cell's centre (lat, lon) and a place ->
    (row, col) function."""
    west, east, south, north = box
    x0, x1 = R_EARTH_M * math.radians(west), R_EARTH_M * math.radians(east)
    y0, y1 = merc_y(south), merc_y(north)
    cols, rows = round((x1 - x0) / res_m), round((y1 - y0) / res_m)
    dx, dy = (x1 - x0) / cols, (y1 - y0) / rows
    xs = x0 + (np.arange(cols) + 0.5) * dx
    ys = y1 - (np.arange(rows) + 0.5) * dy
    lon = np.degrees(xs / R_EARTH_M)
    lat = np.degrees(2 * np.arctan(np.exp(ys / R_EARTH_M)) - np.pi / 2)
    LAT, LON = np.meshgrid(lat, lon, indexing="ij")

    def to_rc(la, lo):
        return (y1 - merc_y(la)) / dy - 0.5, (R_EARTH_M * np.radians(lo) - x0) / dx - 0.5

    return {"rows": rows, "cols": cols, "extent": [x0, y0, x1, y1], "lat": LAT, "lon": LON, "to_rc": to_rc}


def sun_zenith(t: datetime, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """The sun's zenith angle (degrees) at each cell (a solar-position formula good to about a degree)."""
    doy = t.timetuple().tm_yday
    g = 2 * math.pi / 365 * (doy - 1 + (t.hour - 12) / 24)
    decl = 0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g) + 0.000907 * math.sin(2 * g)
    eqt = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g) - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))
    minutes = t.hour * 60 + t.minute + eqt + 4 * lon
    ha = np.radians(minutes / 4 - 180)
    phi = np.radians(lat)
    cos_z = np.sin(phi) * math.sin(decl) + np.cos(phi) * math.cos(decl) * np.cos(ha)
    return np.degrees(np.arccos(np.clip(cos_z, -1, 1)))


def smooth(lo: float, hi: float, v: np.ndarray) -> np.ndarray:
    x = np.clip((v - lo) / (hi - lo), 0, 1)
    return x * x * (3 - 2 * x)


def sandwich(vis: np.ndarray, bt: np.ndarray) -> np.ndarray:
    """The visible texture (reflectance 0..1), coloured by the cold-top table where the top is colder than 235 K; rgb 0..1."""
    base = np.clip(np.nan_to_num(vis), 0, 1) ** (1 / 1.4)
    t = np.nan_to_num(bt, nan=300.0)
    col = np.stack([np.interp(t, [s[0] for s in SANDWICH_STOPS], [s[1][k] for s in SANDWICH_STOPS]) / 255 for k in range(3)], -1)
    cold = np.clip((235 - t) / 6, 0, 1)[..., None]
    return base[..., None] * ((1 - cold) + cold * col)


def fill_specks(rgb: np.ndarray) -> np.ndarray:
    """Single empty pixels inside a picture (where a correction gives no value) take the mean of their filled neighbours."""
    bad = ~np.isfinite(rgb).all(-1)
    if not bad.any():
        return rgb
    out = rgb.copy()
    rows, cols = bad.shape
    acc = np.zeros_like(rgb)
    n = np.zeros((rows, cols))
    good = ~bad
    src = np.pad(np.where(good[..., None], rgb, 0), ((1, 1), (1, 1), (0, 0)))
    pg = np.pad(good, 1)
    for dr in (0, 1, 2):
        for dc in (0, 1, 2):
            acc += src[dr:dr + rows, dc:dc + cols]
            n += pg[dr:dr + rows, dc:dc + cols]
    fill = bad & (n >= 6)       # a speck inside data (most neighbours filled), not the edge of the data
    out[fill] = acc[fill] / n[fill][:, None]
    return out


def save_webp(path: str, rgb: np.ndarray, alpha: np.ndarray) -> None:
    from PIL import Image
    a = np.clip(alpha, 0, 1) * np.isfinite(rgb).all(-1)
    px = np.zeros(rgb.shape[:2] + (4,), np.uint8)
    px[..., :3] = (np.clip(np.nan_to_num(rgb), 0, 1) * 255).round().astype(np.uint8)
    px[..., 3] = (a * 255).round().astype(np.uint8)
    Image.fromarray(px, "RGBA").save(path, "WEBP", quality=88, method=4)


def encode_data(k: np.ndarray) -> np.ndarray:
    v = np.round((np.asarray(k, float) - DATA_MIN_K) / DATA_SPAN_K * 255)
    out = np.clip(v, 1, 255).astype(np.uint8)
    out[~np.isfinite(k)] = 0
    return out


def area_def(g: dict, name: str):
    from pyresample import create_area_def
    return create_area_def(name, "EPSG:3857", area_extent=g["extent"], shape=(g["rows"], g["cols"]))


def enhanced(local, name: str) -> np.ndarray:
    """A Satpy composite as the RGB its recipe (enhancement) gives, 0..1, NaN where it has no value."""
    from satpy.writers import get_enhanced_image
    img = get_enhanced_image(local[name])
    arr = np.asarray(img.data.transpose("y", "x", "bands").values, float)[..., :3]
    return arr


def make_scan(files: list[str], t: datetime, folder: str) -> dict:
    """All products of one scan's segment files, written to `folder`; returns the frame's {product: file name}."""
    from satpy import Scene
    g = grid(RES_M)
    gd = grid(DATA_RES_M)
    scn = Scene(reader="ahi_hsd", filenames=files)
    sza = sun_zenith(t, g["lat"], g["lon"])
    day = float((sza < 88).mean()) > 0.02
    composites = [SATPY["nightmicro"]] + ([SATPY["truecolor"], SATPY["convection"]] if day else [])
    # the bands are cut to the area first; the composites (and their corrections) are made on it afterwards
    scn.load(composites + ["B03", "B13", "B08", "B10"], generate=False)
    local = scn.resample(area_def(g, "rgb"), resampler="gradient_search")
    local.load(composites)
    local_data = scn.resample(area_def(gd, "data"), resampler="gradient_search")
    bt = np.asarray(local["B13"].values, float)
    stamp = t.strftime("%Y%m%dT%H%MZ")
    out: dict[str, str] = {}

    pictures = {"nightmicro": enhanced(local, SATPY["nightmicro"])}
    if day:
        pictures["truecolor"] = fill_specks(enhanced(local, SATPY["truecolor"]))
        pictures["convection"] = enhanced(local, SATPY["convection"])
        pictures["sandwich"] = sandwich(np.asarray(local["B03"].values, float) / 100, bt)
    # all moved back to where the clouds are, with the 10.4 um temperatures giving each pixel's height
    names = list(pictures)
    channels = [pictures[n][..., k] for n in names for k in range(3)]
    bt_c, channels = H.parallax_correct(bt, channels, g["lat"], g["lon"], g["to_rc"])
    zenith, _ = H.view_geometry(g["lat"], g["lon"])
    view = 1 - smooth(H.MAX_VIEW_DEG - 2, H.MAX_VIEW_DEG, zenith)
    daylight = 1 - smooth(80, 88, sza)
    for i, n in enumerate(names):
        rgb = np.stack(channels[3 * i:3 * i + 3], -1)
        alpha = view * (daylight if n in DAY_PRODUCTS else 1)
        out[n] = f"{n}-{stamp}.webp"
        save_webp(os.path.join(folder, out[n]), rgb, alpha)

    if day:
        # the HRV Cloud picture (the app colours it in Windy's way): the 0.5 km visible band in place of Meteosat's HRV
        def make(gl):
            area = latlon_area(gl, f"h9_ll_{gl['step']}")
            ll = scn.resample(area, resampler="gradient_search", datasets=["B03", "B13"])
            cos_z = np.cos(np.radians(np.minimum(sun_zenith(t, gl["lat"], gl["lon"]), 85)))
            vis = np.asarray(ll["B03"].values, float) / 100 / cos_z
            b13 = np.asarray(ll["B13"].values, float)
            b13c, (visc,) = H.parallax_correct(b13, [vis], gl["lat"], gl["lon"])
            return visc, b13c
        out.update(save_hrv_clouds(folder, stamp, make))

    # the data pack, on its own coarser grid
    from PIL import Image
    d13 = np.asarray(local_data["B13"].values, float)
    d08 = np.asarray(local_data["B08"].values, float)
    d10 = np.asarray(local_data["B10"].values, float)
    d13, (d08, d10) = H.parallax_correct(d13, [d08, d10], gd["lat"], gd["lon"], gd["to_rc"])
    px = np.stack([encode_data(d13), encode_data(d08), encode_data(d10)], -1)
    out["data"] = f"data-{stamp}.png"
    Image.fromarray(px, "RGB").save(os.path.join(folder, out["data"]), optimize=True)
    return out


# ── the HRV Cloud picture: what EUMETView serves as its HRV RGB (rgb_eview), which the app colours in Windy's way ──
# EUMETSAT's HRV Cloud RGB (Satpy's hrv_clouds): red and green the high-resolution visible reflectance (sun-normalised, 0-100 %), blue the
# 10.8 um brightness temperature from 323 K (0) to 203 K (255). Checked on 23 Oct 01:30 UTC against EUMETView's rgb_eview over India: its blue
# matches this to a pixel value or two at every temperature (correlation 0.98), so the app's agreed Windy colouring (satellite-image.ts), tuned
# on EUMETView's picture, takes this picture as it is, but uncompressed and at the satellite's own resolution. Made on the app's satellite box
# (68-97.5 E, 5-37.5 N, latitude rows as EUMETView's) at two sizes: full (about 1.25 km) and a lighter one for phones (about 2.5 km).
APP_BOX = (68.0, 97.5, 5.0, 37.5)
HRV_STEP_DEG = {"rgb": 0.0125, "rgb_lo": 0.025}


def latlon_grid(step: float, box: tuple[float, float, float, float] = APP_BOX) -> dict:
    """A regular latitude/longitude grid over a box (rows north to south), as EUMETView's pictures are."""
    west, east, south, north = box
    cols, rows = round((east - west) / step), round((north - south) / step)
    lat = north - (np.arange(rows) + 0.5) * step
    lon = west + (np.arange(cols) + 0.5) * step
    LAT, LON = np.meshgrid(lat, lon, indexing="ij")
    return {"rows": rows, "cols": cols, "lat": LAT, "lon": LON, "box": box, "step": step}


def latlon_area(g: dict, name: str):
    from pyresample import create_area_def
    west, east, south, north = g["box"]
    return create_area_def(name, "EPSG:4326", area_extent=[west, south, east, north], shape=(g["rows"], g["cols"]), units="degrees")


EVIEW_IN = [0, 12, 37, 62, 87, 112, 137, 162, 187, 212, 237, 255]
EVIEW_OUT = [40, 63, 87, 113, 135, 154, 175, 192, 209, 224, 240, 255]


def hrv_clouds_rgb(vis: np.ndarray, bt: np.ndarray) -> np.ndarray:
    """EUMETSAT's HRV Cloud RGB as bytes: red = green = the visible reflectance (0..1, sun-normalised), blue = (323 K - BT) / 120 K. Where the
    visible has no value (outside its scan) red and green are 0 and the blue stays (the app then shows the infrared there, as with EUMETView);
    where neither has one, all 0 (nothing drawn)."""
    v = np.clip(np.nan_to_num(vis, nan=0.0), 0, 1) * 255
    # EUMETView's brightness curve for the visible (it brightens the dark end): measured 23 Oct 02:00 UTC over India, the median of its
    # rgb_eview red for each 25-step bin of ours (1.4 million pixels). The app's Windy colours and ground removal were tuned on its picture.
    v = np.interp(v, EVIEW_IN, EVIEW_OUT)
    v[~np.isfinite(vis)] = 0
    b = np.clip((323.0 - bt) / 120.0, 0, 1)
    out = np.zeros(vis.shape + (3,), np.uint8)
    out[..., 0] = out[..., 1] = np.round(v).astype(np.uint8)
    out[..., 2] = np.where(np.isfinite(bt), np.round(np.nan_to_num(b) * 255), 0).astype(np.uint8)
    return out


def save_hrv_clouds(folder: str, stamp: str, make) -> dict:
    """The HRV Cloud picture at both sizes as high-quality WebP; `make(grid)` returns its (visible, BT) on a grid. Returns {kind: file}."""
    from PIL import Image
    out = {}
    for kind, step in HRV_STEP_DEG.items():
        gl = latlon_grid(step)
        vis, bt = make(gl)
        name = f"{kind}-{stamp}.webp"
        Image.fromarray(hrv_clouds_rgb(vis, bt), "RGB").save(os.path.join(folder, name), "WEBP", quality=92, method=4)
        out[kind] = name
    return out


def update_index(folder: str, new: list[tuple[datetime, dict]], now: datetime, box: tuple[float, float, float, float] = (WEST, EAST, SOUTH, NORTH),
                 res: tuple[float, float] = (RES_M, DATA_RES_M),
                 source: str = "JMA Himawari-9 AHI (NOAA open data on AWS); parallax-corrected; empty beyond 72 degrees view angle",
                 channels: dict | None = None) -> dict:
    """The index with the new frames and without those older than the hour (their files deleted)."""
    path = os.path.join(folder, "index.json")
    frames: dict[str, dict] = {}
    if os.path.exists(path):
        try:
            for f in json.load(open(path))["frames"]:
                frames[f["time"]] = f["files"]
        except (ValueError, KeyError):
            frames = {}
    for t, files in new:
        frames[t.strftime("%Y-%m-%dT%H:%M:%SZ")] = files
    keep = {}
    for time, files in frames.items():
        when = datetime.strptime(time, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        if now - when <= timedelta(minutes=S.KEEP_MINUTES) and all(os.path.exists(os.path.join(folder, f)) for f in files.values()):
            keep[time] = files
    used = {f for files in keep.values() for f in files.values()}
    for name in os.listdir(folder):
        if name != "index.json" and name not in used:
            os.remove(os.path.join(folder, name))
    g, gd = grid(res[0], box), grid(res[1], box)
    index = {
        "version": 1,
        "source": source,
        "bounds": {"west": box[0], "east": box[1], "south": box[2], "north": box[3]},
        "projection": "EPSG:3857",
        "size": {"pictures": [g["cols"], g["rows"]], "data": [gd["cols"], gd["rows"]]},
        "data": {"minK": DATA_MIN_K, "spanK": DATA_SPAN_K, "channels": channels or {"r": "B13 10.4 um", "g": "B08 6.2 um", "b": "B10 7.3 um"}},
        "frames": [{"time": t, "files": keep[t]} for t in sorted(keep)],
    }
    with open(path, "w") as f:
        json.dump(index, f, separators=(",", ":"))
    return index


def scan_keys(t: datetime) -> list[str]:
    keys = H.list_keys(f"{H.PREFIX}/{t:%Y/%m/%d/%H%M}/")
    want = [k for k in keys if any(f"_{b}_FLDK_" in k and f"_S{s}10" in k for b in BANDS for s in SEGMENTS)]
    return want if len(want) == len(BANDS) * len(SEGMENTS) else []


def fetch_new(folder: str, max_new: int, now: datetime) -> list[tuple[datetime, dict]]:
    done = set(os.listdir(folder))
    new = []
    t = now.replace(minute=now.minute - now.minute % 10, second=0, microsecond=0)
    oldest = now - timedelta(minutes=S.KEEP_MINUTES)
    while t >= oldest and len(new) < max_new:
        if f"nightmicro-{t:%Y%m%dT%H%MZ}.webp" not in done:
            keys = scan_keys(t)
            if keys:
                with tempfile.TemporaryDirectory() as tmp:
                    paths = []
                    for k in keys:
                        p = os.path.join(tmp, os.path.basename(k))
                        download(f"{H.BUCKET}/{k}", p)
                        paths.append(p)
                    files = make_scan(paths, t, folder)
                new.append((t, files))
                print(f"{t:%Y-%m-%d %H:%M}Z: {', '.join(sorted(files))}")
        t -= timedelta(minutes=10)
    return new


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-new", type=int, default=1)
    ap.add_argument("--files", nargs="*", help="one scan's local segment files instead (a test)")
    args = ap.parse_args()
    folder = os.path.join(args.out, FOLDER)
    os.makedirs(folder, exist_ok=True)
    now = datetime.now(timezone.utc)
    try:
        if args.files:
            name = os.path.basename(args.files[0])
            t = datetime.strptime(name[7:20], "%Y%m%d_%H%M").replace(tzinfo=timezone.utc)
            new = [(t, make_scan(args.files, t, folder))]
            now = t
        else:
            new = fetch_new(folder, args.max_new, now)
    except Exception as e:
        import traceback
        where = traceback.extract_tb(e.__traceback__)[-1]
        print(f"::error::Himawari RGB: {type(e).__name__}: {e} (at {os.path.basename(where.filename)}:{where.lineno} {where.name})")
        raise
    index = update_index(folder, new, now)
    print(f"{len(new)} new, {len(index['frames'])} kept")
    return 0


if __name__ == "__main__":
    sys.exit(main())
