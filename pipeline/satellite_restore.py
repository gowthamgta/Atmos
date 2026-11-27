"""The frames already published, fetched back before a run of the satellite workflow adds the new ones.

The brightness temperatures (satellite_bt.py, himawari_bt.py) are served by GitHub Pages from their own repository (gowthamgta/atmos-satellite):
a Pages deployment replaces the whole site and keeps nothing in git, so each run first downloads the live index of every folder and the frames
it lists, adds the new ones, and deploys the lot. Anything that cannot be fetched is simply left out (the next run rebuilds what it needs).

  python satellite_restore.py --base https://gowthamgta.github.io/atmos-satellite/ --out site
"""
from __future__ import annotations
import argparse, json, os, sys

import requests

FOLDERS = ("bt", "bt-h9", "bt-global", "rgb-global", "rgb-h9", "rgb-msg", "amv")


def _fetch_all(urls: list[str], get) -> dict[str, bytes]:
    if get is requests.get and len(urls) > 2:
        from concurrent.futures import ThreadPoolExecutor

        def fetch_one(u: str) -> tuple[str, bytes | None]:
            try:
                r = get(u, timeout=60)
                return (u, r.content if r.status_code == 200 else None)
            except requests.RequestException:
                return (u, None)

        with ThreadPoolExecutor(12) as pool:
            return {u: body for u, body in pool.map(fetch_one, urls) if body is not None}

    got: dict[str, bytes] = {}
    for u in urls:
        try:
            r = get(u, timeout=60)
            if r.status_code == 200:
                got[u] = r.content
        except requests.RequestException:
            pass
    return got


def restore(base: str, out: str, folders=FOLDERS, get=requests.get) -> int:
    """Download each folder's index.json and its frames (plus HD tiles) into `out`; returns how many frames were restored."""
    count = 0
    root = base.rstrip("/")
    for folder in folders:
        try:
            res = get(f"{root}/{folder}/index.json", timeout=30)
            if res.status_code != 200:
                continue
            index = res.json()
        except (requests.RequestException, ValueError):
            continue
        os.makedirs(os.path.join(out, folder), exist_ok=True)
        kept = []
        for frame in index.get("frames", []):
            # a frame is one file ("file") or several ("files": {product: file}); it is kept only when all of them come back
            names = [os.path.basename(n) for n in ([frame["file"]] if "file" in frame else list(frame.get("files", {}).values()))]
            if not names or not all(n.endswith((".png", ".webp", ".json")) for n in names):
                continue
            tile_entries = [t for t in frame.get("tiles", []) if isinstance(t, dict) and str(t.get("file", "")).endswith((".png", ".webp"))]
            tile_names = [os.path.basename(t["file"]) for t in tile_entries]
            urls = [f"{root}/{folder}/{n}" for n in names + tile_names]
            got = _fetch_all(urls, get)
            if not all(f"{root}/{folder}/{n}" in got for n in names):
                continue
            for n in names:
                with open(os.path.join(out, folder, n), "wb") as f:
                    f.write(got[f"{root}/{folder}/{n}"])
            if tile_entries:
                kept_tiles = []
                for t in tile_entries:
                    tn = os.path.basename(t["file"])
                    body = got.get(f"{root}/{folder}/{tn}")
                    if body is None:
                        continue
                    with open(os.path.join(out, folder, tn), "wb") as f:
                        f.write(body)
                    kept_tiles.append(t)
                frame = {**frame, "tiles": kept_tiles}
            kept.append(frame)
            count += 1
        index["frames"] = kept
        with open(os.path.join(out, folder, "index.json"), "w") as f:
            json.dump(index, f, separators=(",", ":"))
    return count


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    print(f"{restore(args.base, args.out)} frames restored from {args.base}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
