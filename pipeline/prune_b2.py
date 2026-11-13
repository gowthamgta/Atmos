"""Prune old forecast cycles from Backblaze B2 so the bucket stays bounded.

With Backblaze B2, old cycles remain indefinitely unless removed. This keeps the latest
`keep_cycles` (default 2) for each model so active sessions never hit 404s, while older
cycles are deleted to prevent file and storage accumulation.

  python prune_b2.py --bucket nwp-atmos-storage --endpoint https://s3.eu-central-003.backblazeb2.com
"""
from __future__ import annotations
import argparse
import os
import re
import subprocess
import sys

DEFAULT_MODELS = ("blend", "ecmwf_ifs", "aifs")
CYCLE_RE = re.compile(r"PRE\s+(\d{8}T\d{2}Z)/")


def list_cycles(bucket: str, model: str, endpoint: str) -> list[str]:
    """Return all timestamp cycles for `model` in `bucket` sorted oldest to newest."""
    cmd = ["aws", "s3", "ls", f"s3://{bucket}/{model}/", "--endpoint-url", endpoint]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []
    cycles = []
    for line in res.stdout.splitlines():
        m = CYCLE_RE.search(line)
        if m:
            cycles.append(m.group(1))
    return sorted(cycles)


def delete_cycle(bucket: str, model: str, cycle: str, endpoint: str) -> bool:
    """Delete all files under s3://bucket/model/cycle/."""
    target = f"s3://{bucket}/{model}/{cycle}/"
    print(f"Pruning stale cycle: {target}")
    cmd = ["aws", "s3", "rm", target, "--recursive", "--endpoint-url", endpoint]
    try:
        subprocess.run(cmd, check=True)
        return True
    except subprocess.CalledProcessError as e:
        print(f"::warning::Failed to prune {target}: {e}")
        return False


def prune_model(bucket: str, model: str, endpoint: str, keep: int = 2) -> int:
    """Keep the newest `keep` cycles for `model`, deleting the rest. Returns deleted count."""
    cycles = list_cycles(bucket, model, endpoint)
    if len(cycles) <= keep:
        return 0
    stale = cycles[:-keep]
    deleted = 0
    for cycle in stale:
        if delete_cycle(bucket, model, cycle, endpoint):
            deleted += 1
    return deleted


def prune_all(bucket: str, endpoint: str, keep: int = 2, models=DEFAULT_MODELS) -> int:
    """Prune all listed models. Returns total pruned cycles."""
    total = 0
    for model in models:
        total += prune_model(bucket, model, endpoint, keep=keep)
    return total


def main() -> int:
    ap = argparse.ArgumentParser(description="Prune old cycles in B2")
    ap.add_argument("--bucket", required=True, help="B2 bucket name")
    ap.add_argument("--endpoint", required=True, help="S3 endpoint URL")
    ap.add_argument("--keep", type=int, default=2, help="Number of latest cycles to retain per model (default: 2)")
    ap.add_argument("--models", nargs="*", default=list(DEFAULT_MODELS), help="Models to prune")
    args = ap.parse_args()

    pruned = prune_all(args.bucket, args.endpoint, keep=args.keep, models=args.models)
    print(f"Pruned {pruned} old model cycles from s3://{args.bucket}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
