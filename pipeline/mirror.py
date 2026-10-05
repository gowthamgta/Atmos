"""Copy models that were not rebuilt in this workflow run from the live Pages site into the site folder.

A Pages deployment replaces the whole site, so a deploy triggered by one model must still carry the others.
Mirroring them from the live site is cheap (about 30 MB per model from GitHub's CDN) compared with rebuilding.

  python mirror.py --site site --base-url https://<user>.github.io/<repo> --models ecmwf_ifs gfs
"""
from __future__ import annotations
import argparse, json, os, shutil, sys
from concurrent.futures import ThreadPoolExecutor
from typing import Callable
import requests

PUBLISHED_VARS_FILE = "manifest.json"


def _fetch(get: Callable, url: str, retries: int = 3) -> bytes:
    last = None
    for _ in range(retries):
        try:
            r = get(url, timeout=60)
            if r.status_code == 200:
                return r.content
            last = RuntimeError(f"{r.status_code} {url}")
        except requests.RequestException as e:
            last = e
    raise last  # type: ignore[misc]


def mirror_model(site: str, base_url: str, model: str, get: Callable = requests.get, workers: int = 16) -> bool:
    """Download the live run of `model` into site/<model>. Returns False (and leaves nothing behind) on failure."""
    root = os.path.join(site, model)
    try:
        latest_raw = _fetch(get, f"{base_url}/{model}/latest.json")
        run = json.loads(latest_raw)["run"]
        manifest_raw = _fetch(get, f"{base_url}/{model}/{run}/manifest.json")
        manifest = json.loads(manifest_raw)

        files = [f"{var}/{step['h']:03d}.png" for var in manifest["vars"] for step in manifest["steps"]]

        def pull(rel: str) -> None:
            path = os.path.join(root, run, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(_fetch(get, f"{base_url}/{model}/{run}/{rel}"))

        with ThreadPoolExecutor(workers) as pool:
            list(pool.map(pull, files))
        os.makedirs(os.path.join(root, run), exist_ok=True)
        with open(os.path.join(root, run, PUBLISHED_VARS_FILE), "wb") as f:
            f.write(manifest_raw)
        with open(os.path.join(root, "latest.json"), "wb") as f:  # last, so a partial copy is never advertised
            f.write(latest_raw)
        print(f"mirrored {model} run {run}: {len(files)} files")
        return True
    except Exception as e:  # a model that is not live yet (first deploy) or a transient error: skip it
        print(f"could not mirror {model}: {e}")
        shutil.rmtree(root, ignore_errors=True)
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True)
    ap.add_argument("--base-url", required=True, help="live site root, e.g. https://user.github.io/repo")
    ap.add_argument("--models", nargs="+", required=True)
    args = ap.parse_args()
    for model in args.models:
        if os.path.exists(os.path.join(args.site, model, "latest.json")):
            continue  # built in this run
        mirror_model(args.site, args.base_url.rstrip("/"), model)
    return 0


if __name__ == "__main__":
    sys.exit(main())
