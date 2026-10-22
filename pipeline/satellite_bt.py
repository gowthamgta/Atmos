"""Real cloud-top temperatures over India from Meteosat's raw SEVIRI data (EUMETSAT Data Store), for the app's 3D clouds.

The app's satellite pictures come from EUMETView's WMS as finished images, whose grey levels are not documented as temperatures, so the
app had to assume one (30 - 115 x brightness, in degrees C). This script gets the calibrated brightness temperatures themselves: it
downloads the newest High Rate SEVIRI Level 1.5 file of the Indian Ocean service (Meteosat at 45.5 E), reads the 10.8 and 3.9 micrometre
channels with Satpy (calibrated to brightness temperature, kelvin), puts them on a regular latitude/longitude grid over the box the app's
satellite pictures cover (68-97.5 E, 5-37.5 N, the same box, so the two line up by position), and writes each frame as a small PNG:

  red   10.8 um brightness temperature, kelvin = OFFSET_K + value x STEP_K (0 = no data)
  green  3.9 um brightness temperature, the same scale

with an index of the last hour's frames (`bt/index.json`). The workflow (.github/workflows/satellite.yml) publishes the folder to the
`satellite-data` branch, which the app reads from raw.githubusercontent.com.

The EUMETSAT Data Store needs a (free) consumer key and secret: they are read from the environment (EUMETSAT_CONSUMER_KEY,
EUMETSAT_CONSUMER_SECRET, set as repository secrets) and never written anywhere. Without them the script says so and does nothing.

  python satellite_bt.py --out bt-site [--max-new 2]
"""
from __future__ import annotations
import argparse, json, os, sys, tempfile
from datetime import datetime, timedelta, timezone

import numpy as np

VERSION = 1
COLLECTION = os.environ.get("EUMETSAT_COLLECTION", "EO:EUM:DAT:MSG:HRSEVIRI-IODC")
# the box of the app's satellite pictures (satellite.config.ts SATELLITE_BOUNDS)
WEST, EAST, SOUTH, NORTH = 68.0, 97.5, 5.0, 37.5
STEP_DEG = 0.03                 # about 3 km: the infrared channels' own pixel over India
OFFSET_K = 180.0
STEP_K = 0.5                    # 180 K .. 307.5 K in 255 steps
KEEP_MINUTES = 75               # the app's loop is the last hour, every 15 minutes
FOLDER = "bt"


def grid_shape() -> tuple[int, int]:
    """Rows (north to south) and columns (west to east) of the published grid."""
    return round((NORTH - SOUTH) / STEP_DEG), round((EAST - WEST) / STEP_DEG)


def encode_bt(kelvin: np.ndarray) -> np.ndarray:
    """Brightness temperatures (kelvin, NaN where there is none) as bytes: 0 no data, else 1..255."""
    v = np.round((np.asarray(kelvin, float) - OFFSET_K) / STEP_K)
    out = np.clip(v, 1, 255).astype(np.uint8)
    out[~np.isfinite(kelvin)] = 0
    return out


def decode_bt(byte: np.ndarray) -> np.ndarray:
    """The inverse of encode_bt (NaN for no data)."""
    k = OFFSET_K + byte.astype(float) * STEP_K
    k[byte == 0] = np.nan
    return k


def frame_name(t: datetime) -> str:
    return t.strftime("%Y%m%dT%H%MZ") + ".png"


def write_frame(folder: str, t: datetime, ir108: np.ndarray, ir039: np.ndarray) -> str:
    """One frame as an RGB PNG (10.8 um in red, 3.9 um in green); returns its file name."""
    from PIL import Image
    rgb = np.zeros((*ir108.shape, 3), np.uint8)
    rgb[..., 0] = encode_bt(ir108)
    rgb[..., 1] = encode_bt(ir039)
    name = frame_name(t)
    Image.fromarray(rgb, "RGB").save(os.path.join(folder, name), optimize=True)
    return name


def update_index(folder: str, new: list[tuple[datetime, str]], now: datetime) -> dict:
    """The index with the new frames added and those older than KEEP_MINUTES left out (their files deleted)."""
    path = os.path.join(folder, "index.json")
    frames: dict[str, str] = {}
    if os.path.exists(path):
        try:
            for f in json.load(open(path))["frames"]:
                frames[f["time"]] = f["file"]
        except (ValueError, KeyError):
            frames = {}
    for t, name in new:
        frames[t.strftime("%Y-%m-%dT%H:%M:%SZ")] = name
    keep = {}
    for time, name in frames.items():
        when = datetime.strptime(time, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        if now - when <= timedelta(minutes=KEEP_MINUTES) and os.path.exists(os.path.join(folder, name)):
            keep[time] = name
    for name in os.listdir(folder):
        if name.endswith(".png") and name not in keep.values():
            os.remove(os.path.join(folder, name))
    rows, cols = grid_shape()
    index = {
        "version": VERSION,
        "source": "EUMETSAT, Meteosat SEVIRI Level 1.5 (Indian Ocean service), brightness temperature",
        "bounds": {"west": WEST, "east": EAST, "south": SOUTH, "north": NORTH},
        "rows": rows, "cols": cols, "offsetK": OFFSET_K, "stepK": STEP_K,
        "channels": {"r": "IR_108", "g": "IR_039"},
        "frames": [{"time": t, "file": keep[t]} for t in sorted(keep)],
    }
    with open(path, "w") as f:
        json.dump(index, f, separators=(",", ":"))
    return index


def read_native(path: str) -> tuple[np.ndarray, np.ndarray]:
    """10.8 and 3.9 um brightness temperatures (kelvin) of a SEVIRI native file on the published grid."""
    from satpy import Scene
    from pyresample import create_area_def
    scn = Scene(reader="seviri_l1b_native", filenames=[path])
    scn.load(["IR_108", "IR_039"], calibration="brightness_temperature")
    scn = scn.crop(ll_bbox=(WEST - 1, SOUTH - 1, EAST + 1, NORTH + 1))
    rows, cols = grid_shape()
    area = create_area_def("india_ll", "EPSG:4326", area_extent=[WEST, SOUTH, EAST, NORTH], shape=(rows, cols), units="degrees")
    local = scn.resample(area, resampler="nearest", radius_of_influence=6000)
    return np.asarray(local["IR_108"].values, float), np.asarray(local["IR_039"].values, float)


def fetch_new(folder: str, max_new: int, now: datetime) -> list[tuple[datetime, str]]:
    """Download and grid the newest products not yet in the folder (at most max_new)."""
    import eumdac
    key, secret = os.environ.get("EUMETSAT_CONSUMER_KEY"), os.environ.get("EUMETSAT_CONSUMER_SECRET")
    token = eumdac.AccessToken((key, secret))
    try:
        print(f"token valid until {token.expiration}")   # asks for the token: a wrong key or secret fails here
    except Exception as e:
        raise SystemExit(f"::error::EUMETSAT refused the key and secret ({type(e).__name__}: {e})")
    store = eumdac.DataStore(token)
    # the client's examples search with plain UTC times
    start = (now - timedelta(minutes=KEEP_MINUTES)).replace(tzinfo=None)
    end = now.replace(tzinfo=None)
    try:
        collection = store.get_collection(COLLECTION)
        products = list(collection.search(dtstart=start, dtend=end))
    except Exception as e:
        names = [f"{c} ({c.title})" for c in store.collections if any(w in str(c.title).upper() for w in ("SEVIRI", "IODC", "INDIAN"))]
        raise SystemExit(f"::error::searching {COLLECTION} failed ({type(e).__name__}: {e}); collections that look right: {names}")
    print(f"{len(products)} products of {COLLECTION} in the last {KEEP_MINUTES} min")
    products.sort(key=lambda p: p.sensing_end, reverse=True)
    done = set(os.listdir(folder))
    new = []
    for product in products:
        if len(new) >= max_new:
            break
        t = product.sensing_start.replace(tzinfo=timezone.utc)
        t = t.replace(minute=t.minute - t.minute % 15, second=0, microsecond=0)   # the slot the scan belongs to, as EUMETView names it
        if frame_name(t) in done:
            continue
        entry = next((e for e in product.entries if e.endswith(".nat")), None)
        if entry is None:
            print(f"{product}: no native file in {list(product.entries)}", file=sys.stderr)
            continue
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, os.path.basename(entry))
            with product.open(entry=entry) as src, open(path, "wb") as dst:
                while chunk := src.read(1 << 20):
                    dst.write(chunk)
            ir108, ir039 = read_native(path)
        new.append((t, write_frame(folder, t, ir108, ir039)))
        print(f"{t:%Y-%m-%d %H:%M}Z: written ({np.nanmin(ir108):.0f}-{np.nanmax(ir108):.0f} K at 10.8 um)")
    return new


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="the published folder (the satellite-data branch's working tree)")
    ap.add_argument("--max-new", type=int, default=2)
    args = ap.parse_args()
    if not (os.environ.get("EUMETSAT_CONSUMER_KEY") and os.environ.get("EUMETSAT_CONSUMER_SECRET")):
        print("::notice::EUMETSAT_CONSUMER_KEY / EUMETSAT_CONSUMER_SECRET are not set: nothing to do")
        return 0
    folder = os.path.join(args.out, FOLDER)
    os.makedirs(folder, exist_ok=True)
    now = datetime.now(timezone.utc)
    try:
        new = fetch_new(folder, args.max_new, now)
    except SystemExit:
        raise
    except Exception as e:
        # as an annotation, which the run's public summary page shows (the step's log needs a signed-in viewer)
        import traceback
        where = traceback.extract_tb(e.__traceback__)[-1]
        print(f"::error::{type(e).__name__}: {e} (at {os.path.basename(where.filename)}:{where.lineno} {where.name})")
        raise
    index = update_index(folder, new, now)
    print(f"{len(new)} new, {len(index['frames'])} kept")
    return 0


if __name__ == "__main__":
    sys.exit(main())
