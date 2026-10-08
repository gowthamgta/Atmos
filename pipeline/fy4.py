"""FY-4B (China's geostationary weather satellite at 105 E) pictures of South India, from NSMC's public picture server.

NSMC publishes, for each 15-minute slot, one grey picture per AGRI channel for its China region, in plain latitude/longitude:
channel 2 (0.65 um, red) at 0.5 km, channels 1 (0.47 um, blue) and 3 (0.825 um, near infrared) at 1 km, channel 13 (10.8 um,
infrared) at 4 km. Their coastlines are burned into the pictures. This script
  - picks the newest slots that have all the channels it needs (visible by day, infrared at night),
  - cuts out the app's domain, paints the burned-in coastlines out (filling from the pixels beside them),
  - merges the three visible channels into a true-colour picture whose detail comes from the 0.5 km red channel,
  - writes a full-size and a phone-size JPEG of each slot, and a small `latest.json` listing them.

  python fy4.py --out site --force                       # newest slots into ./site/fy4
  python fy4.py --out site --live-url <.../fy4/latest.json>   # exits quietly if that slot is already live

Pictures are (c) NSMC / CMA; the coastline file is Natural Earth (public domain).
"""
from __future__ import annotations
import argparse, json, math, os, re, shutil, sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from io import BytesIO

import numpy as np

import config as C
from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None

PRODUCT_ID = "fy4"
BASE = "http://img.nsmc.org.cn"
XML = BASE + "/PORTAL/NSMC/XML/FY4B/FY4B_AGRI_IMG_REGI_GRA_GLL_{band}.xml"
UA = {"User-Agent": "Mozilla/5.0"}

# Where the pictures sit on the globe (fitted to the coastlines burned into them): the top-left corner of the picture in degrees,
# and degrees per pixel of the 0.5 km channel. The 1 km and 4 km pictures cover the same area with 2x and 8x bigger pixels.
ORIGIN_LON, ORIGIN_LAT = 60.215, 53.79
DEG_05KM = 0.005
GRID_DEG = {"C01": 2 * DEG_05KM, "C02": DEG_05KM, "C03": 2 * DEG_05KM, "C13": 8 * DEG_05KM}

# The domain published: the same as the app's satellite pictures.
WEST, EAST, SOUTH, NORTH = C.LON_MIN, C.LON_MAX, C.LAT_MIN, C.LAT_MAX
# the picture at the 0.5 km channel's own pixels (0.005 degrees) over the domain, and half of that for the phone picture
SIZE_HD = (round((EAST - WEST) / DEG_05KM), round((NORTH - SOUTH) / DEG_05KM))
SIZE_LITE = (SIZE_HD[0] // 2, SIZE_HD[1] // 2)
FRAME_COUNT = 5
SLOT_MIN = 15
VERSION = 1                                   # bump when the picture method changes, so a slot that is live is rebuilt
DAY_MIN_ELEVATION_DEG = 8.0
CENTRE = (13.0, 79.0)
COAST_FILE = os.path.join(os.path.dirname(__file__), "data", "coast.json")

# the picture method
LINE_HALF_WIDTH_PX = {"C02": 5, "C01": 4, "C03": 4, "C13": 2}   # how far from a coastline the burned-in line can be
FILL_SIGMA_PX = {"C02": 3.0, "C01": 2.0, "C03": 2.0, "C13": 1.5}
LINE_MARGIN = 8                                # a pixel this much brighter than the local background (0-255) beside a coastline is the line
GAMMA = 0.62
GAIN = 1.0


# --- geometry ------------------------------------------------------------------------------------------------------

def window(band: str) -> tuple[int, int, int, int]:
    """(x0, y0, x1, y1) of the domain in a channel's own picture; y1 may be past the picture's last row (south of its coverage)."""
    d = GRID_DEG[band]
    return (round((WEST - ORIGIN_LON) / d), round((ORIGIN_LAT - NORTH) / d), round((EAST - ORIGIN_LON) / d), round((ORIGIN_LAT - SOUTH) / d))


def crop_domain(img: Image.Image, band: str) -> np.ndarray:
    """The domain from a channel's picture as a grey float32 array; rows south of the picture's coverage are 0."""
    x0, y0, x1, y1 = window(band)
    w, h = x1 - x0, y1 - y0
    grey = np.zeros((h, w), np.float32)
    part = np.asarray(img.convert("L").crop((x0, y0, x1, min(y1, img.height))), np.float32)
    grey[: part.shape[0]] = part
    return grey


def coast_lines() -> list[list[list[float]]]:
    with open(COAST_FILE) as f:
        return json.load(f)


def coast_mask(band: str, shape: tuple[int, int], lines=None, half_width: int | None = None) -> np.ndarray:
    """Boolean mask of the pixels within `half_width` of a coastline, on a channel's cropped domain."""
    lines = coast_lines() if lines is None else lines
    d = GRID_DEG[band]
    x0, y0, _, _ = window(band)
    hw = LINE_HALF_WIDTH_PX[band] if half_width is None else half_width
    img = Image.new("L", (shape[1], shape[0]), 0)
    draw = ImageDraw.Draw(img)
    for line in lines:
        pts = [((lo - ORIGIN_LON) / d - x0, (ORIGIN_LAT - la) / d - y0) for lo, la in line]
        draw.line(pts, fill=255, width=2 * hw + 1)
    return np.asarray(img) > 0


def gaussian_blur(a: np.ndarray, sigma: float) -> np.ndarray:
    from scipy.ndimage import gaussian_filter
    return gaussian_filter(a, sigma, mode="nearest")


def remove_lines(grey: np.ndarray, band: str, mask: np.ndarray | None = None) -> np.ndarray:
    """Paints the burned-in coastlines out: pixels beside a known coastline that are brighter than their surroundings are
    replaced by the (normalised, blurred) average of the pixels around them that are not part of the line."""
    if mask is None:
        mask = coast_mask(band, grey.shape)
    sigma = FILL_SIGMA_PX[band]
    from scipy.ndimage import uniform_filter
    local = uniform_filter(grey, 2 * LINE_HALF_WIDTH_PX[band] * 2 + 1)
    line = mask & (grey > local + LINE_MARGIN)
    # also take the one-pixel halo of the line, where the line's soft edge is
    from scipy.ndimage import binary_dilation
    line = binary_dilation(line, iterations=2) & mask
    keep = (~line).astype(np.float32)
    num = gaussian_blur(grey * keep, sigma)
    den = gaussian_blur(keep, sigma)
    fill = num / np.maximum(den, 1e-3)
    out = grey.copy()
    out[line] = fill[line]
    return out


# --- sun -----------------------------------------------------------------------------------------------------------

def sun_elevation_deg(when: datetime, lat, lon):
    """Height of the sun above the horizon (degrees) for arrays of latitude and longitude (simple solar-position formula)."""
    rad = math.pi / 180
    doy = when.timetuple().tm_yday
    gamma = 2 * math.pi / 365 * (doy - 1)
    decl = (0.006918 - 0.399912 * math.cos(gamma) + 0.070257 * math.sin(gamma) - 0.006758 * math.cos(2 * gamma)
            + 0.000907 * math.sin(2 * gamma) - 0.002697 * math.cos(3 * gamma) + 0.00148 * math.sin(3 * gamma))
    eqt = 229.18 * (0.000075 + 0.001868 * math.cos(gamma) - 0.032077 * math.sin(gamma)
                    - 0.014615 * math.cos(2 * gamma) - 0.040849 * math.sin(2 * gamma))
    minutes = when.hour * 60 + when.minute
    hour_angle = ((minutes + eqt + 4 * np.asarray(lon)) / 4 - 180) * rad
    lat_r = np.asarray(lat) * rad
    sin_el = np.sin(lat_r) * math.sin(decl) + np.cos(lat_r) * math.cos(decl) * np.cos(hour_angle)
    return np.degrees(np.arcsin(np.clip(sin_el, -1, 1)))


def is_day(when: datetime) -> bool:
    return float(sun_elevation_deg(when, CENTRE[0], CENTRE[1])) >= DAY_MIN_ELEVATION_DEG


# --- the picture ---------------------------------------------------------------------------------------------------

def resize(a: np.ndarray, size: tuple[int, int], resample=Image.BICUBIC) -> np.ndarray:
    return np.asarray(Image.fromarray(a, "F").resize(size, resample), np.float32)


def true_colour(red: np.ndarray, blue: np.ndarray, nir: np.ndarray, when: datetime) -> np.ndarray:
    """Merge the three visible channels into an RGB uint8 picture the size of `red` (the 0.5 km channel).

    The detail is the red channel's; the blue and near-infrared channels (1 km) are enlarged to match. There is no green
    channel, so green is made from the other three (the near-infrared one makes vegetation green). The picture is brightened
    for the sun's height, so the morning and evening pictures are as bright as noon, and given a gamma.
    """
    h, w = red.shape
    blue_up = resize(blue, (w, h))
    nir_up = resize(nir, (w, h))
    lat = NORTH - (np.arange(h) + 0.5) / h * (NORTH - SOUTH)
    lon = WEST + (np.arange(w) + 0.5) / w * (EAST - WEST)
    el = sun_elevation_deg(when, lat[:, None], lon[None, :])
    cos_sza = np.clip(np.sin(np.radians(el)), 0.2, 1.0)
    lift = (1.0 / cos_sza) ** 0.8
    r = red / 255.0
    b = blue_up / 255.0
    n = nir_up / 255.0
    g = 0.45 * r + 0.4 * b + 0.15 * n
    rgb = np.stack([r, g, b], -1) * lift[..., None] * GAIN
    rgb = np.clip(rgb, 0, 1) ** GAMMA
    return (rgb * 255 + 0.5).astype(np.uint8)


def infrared_picture(ir: np.ndarray) -> np.ndarray:
    """The infrared channel (bright where the cloud is cold) as a grey RGB picture of the domain, enlarged smoothly."""
    return np.repeat(ir[..., None], 3, -1).clip(0, 255).astype(np.uint8)


def to_jpeg(rgb: np.ndarray, size: tuple[int, int], quality: int) -> bytes:
    img = Image.fromarray(rgb, "RGB")
    if img.size != size:
        img = img.resize(size, Image.LANCZOS)
    buf = BytesIO()
    img.save(buf, "JPEG", quality=quality, optimize=True, progressive=True)
    return buf.getvalue()


# --- the server ----------------------------------------------------------------------------------------------------

def slot_time(token: str) -> datetime:
    return datetime.strptime(token, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)


def parse_slots(xml_text: str) -> dict[str, str]:
    """{start of the slot as YYYYMMDDHHMMSS: picture address} from an NSMC picture list (thumbnails left out)."""
    out: dict[str, str] = {}
    for url in re.findall(r'url="([^"]+)"', xml_text):
        if "thumb" in url.lower():
            continue
        m = re.search(r"_GLL_(\d{14})_\d{14}_", url)
        if m:
            out[m.group(1)] = ("http:" + url) if url.startswith("//") else url
    return out


def fetch_slots(band: str) -> dict[str, str]:
    import requests
    r = requests.get(XML.format(band=band), headers=UA, timeout=60)
    r.raise_for_status()
    return parse_slots(r.text)


def fetch_picture(url: str) -> Image.Image:
    import requests
    r = requests.get(url, headers=UA, timeout=240)
    r.raise_for_status()
    return Image.open(BytesIO(r.content))


def choose_slots(lists: dict[str, dict[str, str]], count: int = FRAME_COUNT) -> list[tuple[str, str]]:
    """The newest `count` slots as (token, "day" or "night"), newest first. A day slot needs the three visible channels, a night
    slot the infrared one; a daytime slot that lacks a channel is left out."""
    tokens = sorted(set().union(*[set(v) for v in lists.values()]), reverse=True)
    out: list[tuple[str, str]] = []
    for t in tokens:
        kind = "day" if is_day(slot_time(t)) else "night"
        need = ("C01", "C02", "C03") if kind == "day" else ("C13",)
        if all(t in lists.get(b, {}) for b in need):
            out.append((t, kind))
        if len(out) == count:
            break
    return out


def build_slot(token: str, kind: str, lists: dict[str, dict[str, str]]) -> tuple[bytes, bytes]:
    """(full-size JPEG, phone-size JPEG) of one slot."""
    when = slot_time(token)
    bands = ("C01", "C02", "C03") if kind == "day" else ("C13",)
    with ThreadPoolExecutor(len(bands)) as pool:
        images = dict(zip(bands, pool.map(lambda b: fetch_picture(lists[b][token]), bands)))
    grey = {}
    for b in bands:
        crop = crop_domain(images[b], b)
        images[b].close()
        grey[b] = remove_lines(crop, b)
    if kind == "day":
        rgb = true_colour(grey["C02"], grey["C01"], grey["C03"], when)
    else:
        big = resize(grey["C13"], SIZE_HD)
        rgb = infrared_picture(big)
    return to_jpeg(rgb, SIZE_HD, 84), to_jpeg(rgb, SIZE_LITE, 82)


def write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def live_state(url: str) -> dict | None:
    import requests
    try:
        r = requests.get(url, timeout=30)
        return r.json() if r.ok else None
    except Exception:
        return None


def mirror_live(live_url: str, out: str) -> bool:
    """Copies the pictures that are already live (named by `latest.json` at `live_url`) into `out`, so a deploy that does not
    rebuild them (nothing new yet, or NSMC unreachable) keeps them. Returns whether anything was copied."""
    import requests
    state = live_state(live_url)
    if not state or not state.get("frames"):
        return False
    base = live_url.rsplit("/", 1)[0]
    root = os.path.join(out, PRODUCT_ID)
    try:
        for fr in state["frames"]:
            for name in (fr["hd"], fr["lite"]):
                r = requests.get(f"{base}/{name}", timeout=60)
                r.raise_for_status()
                write(os.path.join(root, name), r.content)
    except Exception as e:                      # a half-copied set is worse than none
        print(f"fy4: could not copy the live pictures ({e})")
        shutil.rmtree(root, ignore_errors=True)
        return False
    write(os.path.join(root, "latest.json"), json.dumps(state).encode())
    write(os.path.join(out, ".nojekyll"), b"")
    return True


def keep_live(args) -> int:
    """Nothing new to build: the pictures that are live stay in the deploy."""
    if args.live_url and mirror_live(args.live_url, args.out):
        print("fy4: kept the live pictures")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--live-url", help="latest.json of the deployed product, to skip a slot that is already live")
    ap.add_argument("--count", type=int, default=FRAME_COUNT)
    args = ap.parse_args()

    try:
        lists = {b: fetch_slots(b) for b in ("C01", "C02", "C03", "C13")}
    except Exception as e:
        print(f"fy4: NSMC's picture lists are not reachable ({e})")
        return keep_live(args)
    chosen = choose_slots(lists, args.count)
    if not chosen:
        print("fy4: no slot has all its channels yet")
        return keep_live(args)
    newest = chosen[0][0]
    live = live_state(args.live_url) if args.live_url else None
    if not args.force and live and live.get("version") == VERSION and live.get("newest") == newest:
        print(f"fy4: slot {newest} is already live; keeping it")
        return keep_live(args)
    print(f"fy4: {len(chosen)} slots, newest {newest}", flush=True)

    root = os.path.join(args.out, PRODUCT_ID)
    frames = []
    for token, kind in reversed(chosen):       # oldest first, as the app plays them
        try:
            full, lite = build_slot(token, kind, lists)
        except Exception as e:                 # one slot failing (a picture not served yet) must not lose the others
            print(f"  {token} skipped ({e})", flush=True)
            continue
        write(os.path.join(root, f"{token}.jpg"), full)
        write(os.path.join(root, f"{token}_lite.jpg"), lite)
        frames.append({"time": slot_time(token).strftime("%Y-%m-%dT%H:%M:%SZ"), "kind": kind, "hd": f"{token}.jpg", "lite": f"{token}_lite.jpg"})
        print(f"  {token} {kind} done ({len(full) // 1024} KB, {len(lite) // 1024} KB)", flush=True)
    if not frames:
        shutil.rmtree(root, ignore_errors=True)
        return keep_live(args)
    state = {"version": VERSION, "newest": frames[-1]["time"].translate(str.maketrans("", "", "-:TZ")), "frames": frames,
             "bounds": {"west": WEST, "east": EAST, "south": SOUTH, "north": NORTH}, "credit": "FY-4B AGRI, NSMC / CMA"}
    write(os.path.join(root, "latest.json"), json.dumps(state).encode())
    write(os.path.join(args.out, ".nojekyll"), b"")
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
