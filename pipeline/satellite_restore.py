"""The frames already published, fetched back before a run of the satellite workflow adds the new ones.

The brightness temperatures (satellite_bt.py, himawari_bt.py) are served by GitHub Pages from their own repository (gowthamgta/atmos-satellite):
a Pages deployment replaces the whole site and keeps nothing in git, so each run first downloads the live index of every folder and the frames
it lists, adds the new ones, and deploys the lot. Anything that cannot be fetched is simply left out (the next run rebuilds what it needs).

  python satellite_restore.py --base https://gowthamgta.github.io/atmos-satellite/ --out site
"""
from __future__ import annotations
import argparse, json, os, sys

import requests

FOLDERS = ("bt", "bt-h9")


def restore(base: str, out: str, folders=FOLDERS, get=requests.get) -> int:
    """Download each folder's index.json and its frames into `out`; returns how many frames were restored."""
    count = 0
    for folder in folders:
        try:
            res = get(f"{base.rstrip('/')}/{folder}/index.json", timeout=30)
            if res.status_code != 200:
                continue
            index = res.json()
        except (requests.RequestException, ValueError):
            continue
        os.makedirs(os.path.join(out, folder), exist_ok=True)
        kept = []
        for frame in index.get("frames", []):
            name = os.path.basename(frame.get("file", ""))
            if not name.endswith(".png"):
                continue
            try:
                r = get(f"{base.rstrip('/')}/{folder}/{name}", timeout=60)
            except requests.RequestException:
                continue
            if r.status_code != 200:
                continue
            with open(os.path.join(out, folder, name), "wb") as f:
                f.write(r.content)
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
