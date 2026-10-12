"""Pack a built model run into per-variable `.pack` bundles and upload it to Backblaze B2.

Instead of uploading ~5,000 tiny `.png` files per model run (which would consume ~100,000 Class A/C transactions a day),
all forecast steps of each variable are concatenated into `<var>.pack` (~5–15 MB) and their `[offset, length]` byte ranges
are recorded in `manifest.json` under `"packs"`. The browser fetches individual steps directly from Backblaze B2 using
standard HTTP `Range: bytes=start-end` requests.

Environment variables used when CLI flags are omitted:
  B2_KEY_ID          Backblaze application key ID (default: 0030521106176d60000000001)
  B2_APPLICATION_KEY Backblaze application key secret
  B2_BUCKET          Backblaze bucket name (default: nwp-atmos-storage)
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import queue
import shutil
import sys
import time
from typing import Callable
from urllib.parse import quote
import requests

DEFAULT_KEY_ID = "0030521106176d60000000001"
DEFAULT_BUCKET = "nwp-atmos-storage"
B2_AUTH_URL = "https://api.backblazeb2.com/b2api/v2/b2_authorize_account"

CORS_RULES = [
    {
        "corsRuleName": "allow-browser-range-fetch",
        "allowedOrigins": ["*"],
        "allowedOperations": ["b2_download_file_by_name", "b2_download_file_by_id", "s3_get", "s3_head"],
        "allowedHeaders": ["*"],
        "exposeHeaders": ["content-length", "content-range", "etag"],
        "maxAgeSeconds": 86400,
    }
]

LIFECYCLE_RULES = [
    {
        "fileNamePrefix": "",
        "daysFromHidingToDeleting": 1,
        "daysFromUploadingToHiding": None,
    }
]


def pack_model_run(run_dir: str) -> dict[str, list[int]]:
    """Concatenate `<run_dir>/<var>/<h:03d>.png` into `<run_dir>/<var>.pack` and update `manifest.json` with byte ranges."""
    manifest_path = os.path.join(run_dir, "manifest.json")
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    packs: dict[str, list[int]] = dict(manifest.get("packs") or {})
    steps = [int(s["h"]) for s in manifest.get("steps", [])]

    for var_id in manifest.get("vars", {}):
        var_dir = os.path.join(run_dir, var_id)
        pack_path = os.path.join(run_dir, f"{var_id}.pack")
        if not os.path.isdir(var_dir):
            continue
        offset = 0
        chunks: list[bytes] = []
        for h in steps:
            rel = f"{var_id}/{h:03d}.png"
            png_path = os.path.join(var_dir, f"{h:03d}.png")
            if not os.path.isfile(png_path):
                continue
            with open(png_path, "rb") as pf:
                data = pf.read()
            chunks.append(data)
            packs[rel] = [offset, len(data)]
            offset += len(data)
        with open(pack_path, "wb") as out:
            for c in chunks:
                out.write(c)
        shutil.rmtree(var_dir, ignore_errors=True)

    manifest["pack"] = "{var}.pack"
    manifest["packs"] = packs
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, separators=(",", ":"))
    return packs


class B2Client:
    """Minimal, dependency-free Backblaze B2 Native API v2 client using `requests`."""

    def __init__(self, key_id: str, app_key: str, bucket_name: str = DEFAULT_BUCKET, session: requests.Session | None = None) -> None:
        self.key_id = key_id
        self.app_key = app_key
        self.bucket_name = bucket_name
        self.http = session or requests.Session()
        self.api_url = ""
        self.auth_token = ""
        self.account_id = ""
        self.bucket_id = ""
        self.download_url = ""
        self._upload_slots: queue.Queue[tuple[str, str]] = queue.Queue()

    def authorize(self) -> None:
        r = self.http.get(B2_AUTH_URL, auth=(self.key_id, self.app_key), timeout=30)
        r.raise_for_status()
        info = r.json()
        self.api_url = info["apiUrl"]
        self.auth_token = info["authorizationToken"]
        self.account_id = info["accountId"]
        self.download_url = info["downloadUrl"]
        allowed = info.get("allowed") or {}
        if allowed.get("bucketId") and (not allowed.get("bucketName") or allowed.get("bucketName") == self.bucket_name):
            self.bucket_id = allowed["bucketId"]
        else:
            self.bucket_id = self._find_bucket_id()

    def _post(self, endpoint: str, payload: dict) -> dict:
        r = self.http.post(
            f"{self.api_url}/b2api/v2/{endpoint}",
            headers={"Authorization": self.auth_token},
            json=payload,
            timeout=60,
        )
        r.raise_for_status()
        return r.json()

    def _find_bucket_id(self) -> str:
        res = self._post("b2_list_buckets", {"accountId": self.account_id, "bucketName": self.bucket_name})
        for b in res.get("buckets", []):
            if b["bucketName"] == self.bucket_name:
                return b["bucketId"]
        raise RuntimeError(f"Backblaze B2 bucket '{self.bucket_name}' not found")

    def ensure_public_cors(self) -> None:
        """Ensure the bucket is public ('allPublic') with browser CORS and 1-day hidden-file cleanup rules."""
        try:
            self._post(
                "b2_update_bucket",
                {
                    "accountId": self.account_id,
                    "bucketId": self.bucket_id,
                    "bucketType": "allPublic",
                    "corsRules": CORS_RULES,
                    "lifecycleRules": LIFECYCLE_RULES,
                },
            )
        except requests.RequestException as e:
            print(f"notice: could not update bucket settings ({e}); continuing with existing bucket settings", flush=True)

    def _get_upload_slot(self) -> tuple[str, str]:
        try:
            return self._upload_slots.get_nowait()
        except queue.Empty:
            res = self._post("b2_get_upload_url", {"bucketId": self.bucket_id})
            return res["uploadUrl"], res["authorizationToken"]

    def upload_bytes(self, remote_name: str, data: bytes, content_type: str = "application/octet-stream", retries: int = 4) -> None:
        sha1 = hashlib.sha1(data).hexdigest()
        encoded_name = quote(remote_name.replace("\\", "/"), safe="/")
        last_err: Exception | None = None
        for attempt in range(retries):
            upload_url, upload_token = self._get_upload_slot()
            try:
                r = self.http.post(
                    upload_url,
                    headers={
                        "Authorization": upload_token,
                        "X-Bz-File-Name": encoded_name,
                        "Content-Type": content_type,
                        "Content-Length": str(len(data)),
                        "X-Bz-Content-Sha1": sha1,
                        "X-Bz-Info-b2-cache-control": "public, max-age=60" if remote_name.endswith("latest.json") else "public, max-age=31536000, immutable",
                    },
                    data=data,
                    timeout=180,
                )
                if r.status_code == 200:
                    self._upload_slots.put((upload_url, upload_token))
                    return
                last_err = RuntimeError(f"B2 upload {r.status_code}: {r.text[:200]}")
            except requests.RequestException as e:
                last_err = e
            time.sleep(1.5 * (attempt + 1))
        raise last_err or RuntimeError(f"Failed to upload {remote_name}")

    def cleanup_old_runs(self, model_id: str, keep_run: str) -> int:
        """Delete previous runs of `model_id` and superseded versions of `latest.json` so storage stays under 10 GB."""
        prefix = f"{model_id}/"
        keep_prefix = f"{model_id}/{keep_run}/"
        latest_key = f"{model_id}/latest.json"
        start_name: str | None = prefix
        start_id: str | None = None
        to_delete: list[tuple[str, str]] = []
        seen_latest = False

        while start_name is not None:
            payload: dict = {"bucketId": self.bucket_id, "prefix": prefix, "maxFileCount": 1000}
            if start_name:
                payload["startFileName"] = start_name
            if start_id:
                payload["startFileId"] = start_id
            res = self._post("b2_list_file_versions", payload)
            for f in res.get("files", []):
                fname = f["fileName"]
                fid = f["fileId"]
                if fname == latest_key:
                    if seen_latest:
                        to_delete.append((fname, fid))
                    else:
                        seen_latest = True
                elif not fname.startswith(keep_prefix):
                    to_delete.append((fname, fid))
            start_name = res.get("nextFileName")
            start_id = res.get("nextFileId")

        def delete_one(item: tuple[str, str]) -> None:
            fname, fid = item
            try:
                self._post("b2_delete_file_version", {"fileName": fname, "fileId": fid})
            except requests.RequestException as e:
                print(f"  warning: could not delete old B2 file {fname}: {e}", flush=True)

        if to_delete:
            with ThreadPoolExecutor(8) as pool:
                list(pool.map(delete_one, to_delete))
        return len(to_delete)


def sync_model_to_b2(site_dir: str, model_id: str, client: B2Client, workers: int = 8, remove_local: bool = True) -> None:
    """Pack `site_dir/<model_id>/<run>` into `.pack` files, upload to B2 (`latest.json` last), and clean up old runs."""
    model_dir = os.path.join(site_dir, model_id)
    latest_path = os.path.join(model_dir, "latest.json")
    if not os.path.isfile(latest_path):
        print(f"{model_id}: no local latest.json in {model_dir}; skipping B2 sync", flush=True)
        return

    with open(latest_path, "rb") as f:
        latest_bytes = f.read()
    latest = json.loads(latest_bytes)
    run_id = latest["run"]
    run_dir = os.path.join(model_dir, run_id)
    if not os.path.isdir(run_dir):
        print(f"{model_id}: run dir {run_dir} not found; skipping B2 sync", flush=True)
        return

    packs = pack_model_run(run_dir)
    pack_files = sorted(f for f in os.listdir(run_dir) if f.endswith(".pack"))
    print(f"{model_id}: packed {len(packs)} slices into {len(pack_files)} .pack files; uploading to B2://{client.bucket_name}...", flush=True)

    def upload_pack(fname: str) -> None:
        local = os.path.join(run_dir, fname)
        with open(local, "rb") as pf:
            data = pf.read()
        client.upload_bytes(f"{model_id}/{run_id}/{fname}", data, "application/octet-stream")

    with ThreadPoolExecutor(workers) as pool:
        list(pool.map(upload_pack, pack_files))

    manifest_path = os.path.join(run_dir, "manifest.json")
    with open(manifest_path, "rb") as mf:
        client.upload_bytes(f"{model_id}/{run_id}/manifest.json", mf.read(), "application/json")

    # Upload latest.json last so the run is advertised only after every .pack and manifest.json is live
    client.upload_bytes(f"{model_id}/latest.json", latest_bytes, "application/json")
    removed = client.cleanup_old_runs(model_id, keep_run=run_id)
    print(f"{model_id}: run {run_id} live on B2 (cleaned up {removed} old file versions)", flush=True)

    if remove_local:
        shutil.rmtree(model_dir, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Pack and upload model runs to Backblaze B2")
    ap.add_argument("--site", required=True, help="local site directory containing <model>/<run>")
    ap.add_argument("--models", nargs="+", required=True, help="model IDs to sync")
    ap.add_argument("--bucket", default=os.environ.get("B2_BUCKET", DEFAULT_BUCKET))
    ap.add_argument("--key-id", default=os.environ.get("B2_KEY_ID", DEFAULT_KEY_ID))
    ap.add_argument("--app-key", default=os.environ.get("B2_APPLICATION_KEY", ""))
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--keep-local", action="store_true", help="keep local model files after uploading")
    args = ap.parse_args(argv)

    if not args.app_key:
        print("error: B2_APPLICATION_KEY is required to upload to Backblaze B2", file=sys.stderr)
        return 1

    client = B2Client(args.key_id, args.app_key, args.bucket)
    client.authorize()
    client.ensure_public_cors()

    for model_id in args.models:
        sync_model_to_b2(args.site, model_id, client, workers=args.workers, remove_local=not args.keep_local)
    return 0


if __name__ == "__main__":
    sys.exit(main())
