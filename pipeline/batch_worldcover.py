"""Batch process ESA WorldCover land cover downscaling for all domain terrain tiles.

Attaches the ESA WorldCover 10 m (sampled to 90 m L0, 270 m L1, 1.08 km L2) Alpha channel
to every terrain tile in Atmos's forecast domain (Lat 2..20 N, Lon 70..99 E).
"""
import glob, json, os, re, shutil, sys, time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import fetch_worldcover as W

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data", "terrain")
PUBLIC_DIR = os.path.join(HERE, "..", "public", "terrain")
DIST_DIR = os.path.join(HERE, "..", "dist", "weather-platform", "browser", "terrain")
CACHE_DIR = os.path.join(HERE, "cache", "worldcover")

LEVELS = {0: 1200, 1: 400, 2: 100}


def get_all_tiles():
    files = glob.glob(os.path.join(DATA_DIR, "L0", "*.webp"))
    tiles = []
    for f in sorted(files):
        base = os.path.basename(f)
        m = re.match(r"N(\d+)E(\d+)\.webp", base)
        if m:
            tiles.append((int(m.group(1)), int(m.group(2)), base[:-5]))
    return tiles


def process_cog_group(cog_name, sw_lat, sw_lon, tiles_in_cog):
    # Check if all tiles in this group are already RGBA
    all_done = True
    for lat, lon, tile_name in tiles_in_cog:
        l0_file = os.path.join(DATA_DIR, "L0", f"{tile_name}.webp")
        if not os.path.exists(l0_file):
            continue
        try:
            with Image.open(l0_file) as im:
                if im.mode != "RGBA":
                    all_done = False
                    break
        except Exception:
            all_done = False
            break
    if all_done:
        print(f"Skipping COG {cog_name}: all {len(tiles_in_cog)} tiles already RGBA.", flush=True)
        return len(tiles_in_cog)

    t0 = time.time()
    print(f"\nProcessing COG: {cog_name} for {len(tiles_in_cog)} tiles...", flush=True)
    full_3deg = W.fetch_worldcover_cog_subgrid(sw_lat, sw_lon, cog_name, cache_dir=CACHE_DIR, page=3)
    fetch_dt = time.time() - t0
    
    if full_3deg is None:
        print(f"  [sea/nodata] {cog_name} is open water or unavailable ({fetch_dt:.1f}s)", flush=True)
        # For sea tiles, ensure RGBA exists with alpha=0
        for lat, lon, tile_name in tiles_in_cog:
            for lvl, per_deg in LEVELS.items():
                update_tile_alpha(tile_name, lvl, np.zeros((per_deg, per_deg), dtype=np.uint8))
        return len(tiles_in_cog)

    cells_per_deg = full_3deg.shape[0] // 3
    print(f"  Loaded {cog_name} ({cells_per_deg}/deg) in {fetch_dt:.1f}s", flush=True)

    for lat, lon, tile_name in tiles_in_cog:
        r0 = (sw_lat + 2 - lat) * cells_per_deg
        r1 = r0 + cells_per_deg
        c0 = (lon - sw_lon) * cells_per_deg
        c1 = c0 + cells_per_deg
        sub_deg = full_3deg[r0:r1, c0:c1]

        for lvl, per_deg in LEVELS.items():
            if sub_deg.size == 0 or np.all(sub_deg == 0):
                lc = np.zeros((per_deg, per_deg), dtype=np.uint8)
            else:
                im = Image.fromarray(sub_deg)
                resized = im.resize((per_deg, per_deg), Image.Resampling.NEAREST)
                lc = np.array(resized, dtype=np.uint8)
            update_tile_alpha(tile_name, lvl, lc)

    print(f"  Completed {len(tiles_in_cog)} tiles for {cog_name}", flush=True)
    return len(tiles_in_cog)


def update_tile_alpha(tile_name, level, lc_array):
    src_path = os.path.join(DATA_DIR, f"L{level}", f"{tile_name}.webp")
    if not os.path.exists(src_path):
        return

    with Image.open(src_path) as im:
        rgb = np.array(im.convert("RGB"))

    rgba = np.zeros((rgb.shape[0], rgb.shape[1], 4), dtype=np.uint8)
    rgba[..., :3] = rgb
    rgba[..., 3] = lc_array

    out_im = Image.fromarray(rgba)
    out_im.save(src_path, format="WEBP", lossless=True, method=4)

    # Copy to public/terrain/
    if os.path.exists(PUBLIC_DIR):
        pub_path = os.path.join(PUBLIC_DIR, f"L{level}", f"{tile_name}.webp")
        os.makedirs(os.path.dirname(pub_path), exist_ok=True)
        shutil.copyfile(src_path, pub_path)

    # Copy to dist/ if present
    if os.path.exists(DIST_DIR):
        dist_path = os.path.join(DIST_DIR, f"L{level}", f"{tile_name}.webp")
        os.makedirs(os.path.dirname(dist_path), exist_ok=True)
        shutil.copyfile(src_path, dist_path)


def update_index_json():
    idx_path = os.path.join(DATA_DIR, "index.json")
    if os.path.exists(idx_path):
        with open(idx_path, "r", encoding="utf-8") as f:
            idx = json.load(f)
        idx["version"] = 3
        idx["lulc"] = {
            "source": "ESA WorldCover 10m 2021 v200",
            "coverage": "Full forecast domain (Lat 2..20 N, Lon 70..99 E)",
            "classes": W.ESA_NAMES
        }
        with open(idx_path, "w", encoding="utf-8") as f:
            json.dump(idx, f, indent=2)
        if os.path.exists(PUBLIC_DIR):
            pub_idx = os.path.join(PUBLIC_DIR, "index.json")
            shutil.copyfile(idx_path, pub_idx)
        if os.path.exists(DIST_DIR):
            dist_idx = os.path.join(DIST_DIR, "index.json")
            shutil.copyfile(idx_path, dist_idx)
        print("Updated index.json to version 3 with full domain LULC coverage metadata.")


def main():
    tiles = get_all_tiles()
    print(f"Total tiles in domain L0: {len(tiles)}")

    # Group by COG
    cogs = defaultdict(list)
    for lat, lon, name in tiles:
        sw_lat, sw_lon, cog_name = W.worldcover_cog_name(lat, lon)
        cogs[(cog_name, sw_lat, sw_lon)].append((lat, lon, name))

    print(f"Grouped into {len(cogs)} unique 3x3 COG blocks.")
    total_processed = 0
    t_start = time.time()

    for (cog_name, sw_lat, sw_lon), tile_list in cogs.items():
        count = process_cog_group(cog_name, sw_lat, sw_lon, tile_list)
        total_processed += count

    total_time = time.time() - t_start
    print(f"\n==========================================")
    print(f"Finished batch downscaling {total_processed} tiles in {total_time:.1f}s ({total_time/60:.2f} min).")
    print(f"==========================================")

    update_index_json()


if __name__ == "__main__":
    main()
