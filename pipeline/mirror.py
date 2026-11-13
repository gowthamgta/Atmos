"""Copy models that were not rebuilt in this workflow run from the live Pages site into the site folder.

A Pages deployment replaces the whole site, so a deploy triggered by one model must still carry the others.
Mirroring them from the live site is cheap (about 30 MB per model from GitHub's CDN) compared with rebuilding.

  python mirror.py --site site --base-url https://<user>.github.io/<repo> --models ecmwf_ifs ukmo
"""
from __future__ import annotations
import argparse, json, os, shutil, sys
from concurrent.futures import ThreadPoolExecutor
from typing import Callable
import requests
from requests.adapters import HTTPAdapter
from urllib3.util import Retry

PUBLISHED_VARS_FILE = "manifest.json"


def get_default_session() -> requests.Session:
    session = requests.Session()
    retries = Retry(total=5, backoff_factor=0.3, status_forcelist=[429, 500, 502, 503, 504])
    adapter = HTTPAdapter(max_retries=retries, pool_connections=32, pool_maxsize=32)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


_GLOBAL_SESSION: requests.Session | None = None


def session_get(url: str, **kwargs) -> requests.Response:
    global _GLOBAL_SESSION
    if _GLOBAL_SESSION is None:
        _GLOBAL_SESSION = get_default_session()
    return _GLOBAL_SESSION.get(url, **kwargs)


class NotLive(Exception):
    """The model has no live copy (its latest.json is not on the site): nothing to carry over."""


def _fetch(get: Callable, url: str, retries: int = 3) -> bytes:
    last = None
    for _ in range(retries):
        try:
            r = get(url, timeout=60)
            if r.status_code == 200:
                return r.content
            if r.status_code == 404:
                raise NotLive(url)        # nothing at that address: not a reason to try again
            last = RuntimeError(f"{r.status_code} {url}")
        except requests.RequestException as e:
            last = e
    raise last  # type: ignore[misc]


def mirror_status(site: str, base_url: str, model: str, get: Callable = session_get, workers: int = 16) -> str:
    """Download the live run of `model` into site/<model>. Returns "mirrored", "absent" (the model is not live yet: nothing to
    carry over) or "failed" (it is live but could not be copied completely; nothing is left behind)."""
    if model == "blend":
        return "mirrored"  # blend is built locally, never mirror from live site
    root = os.path.join(site, model)
    try:
        try:
            latest_raw = _fetch(get, f"{base_url}/{model}/latest.json", retries=2)
        except NotLive:
            print(f"{model} is not live yet: nothing to mirror")
            return "absent"
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
        return "mirrored"
    except Exception as e:  # noqa: BLE001 - live but not copied completely
        print(f"could not mirror {model}: {e}")
        shutil.rmtree(root, ignore_errors=True)
        return "failed"


def mirror_model(site: str, base_url: str, model: str, get: Callable = session_get, workers: int = 16) -> bool:
    """True when the live run of `model` was copied into site/<model>."""
    return mirror_status(site, base_url, model, get, workers) == "mirrored"

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True)
    ap.add_argument("--base-url", required=True, help="live site root, e.g. https://user.github.io/repo")
    ap.add_argument("--models", nargs="+", required=True)
    args = ap.parse_args()
    failed = []
    for model in args.models:
        if model == "blend":
            continue
        if os.path.exists(os.path.join(args.site, model, "latest.json")):
            continue  # built in this run
        if mirror_status(args.site, args.base_url.rstrip("/"), model) == "failed":
            failed.append(model)
    if failed:
        # a deploy replaces the whole site: with a live model missing it would be dropped, so the caller must not deploy
        print(f"could not copy the live model(s): {', '.join(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
