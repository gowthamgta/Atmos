"""Attach the ECMWF-ensemble rain chances (ens.py) to every model's own timeline.

The chance of extreme rain in the next 24 hours does not depend on which model is shown, so the app's layer should work
with any of them. For each published model run, every forecast step gets the chance for *its* valid time: the ensemble
product has an image every 6 h (starts), and a step in between is the linear mix of the two around it. Steps before the
ensemble run began or after its last start get a "no data" image. The model's manifest then lists the chance variables (px2, px16, px65, px115).

Running it again replaces the images and the manifest entries, so it is safe to run on every deploy.

  python attach.py --site site
"""
from __future__ import annotations
import argparse, json, os, sys
from datetime import datetime, timedelta, timezone

import numpy as np

import config as C
from encode import decode_field, encode_field

ENS_ID = "ens"
SKIP = {ENS_ID}


def parse_valid(text: str) -> datetime:
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def parse_run(run_id: str) -> datetime:
    return datetime.strptime(run_id, "%Y%m%dT%HZ").replace(tzinfo=timezone.utc)


def load_ens(site: str) -> tuple[datetime, dict[str, dict[int, np.ndarray]]] | None:
    """(run time, {variable: {start hour: field}}) of the ensemble product in the site folder, or None if there is none."""
    root = os.path.join(site, ENS_ID)
    try:
        run_id = json.load(open(os.path.join(root, "latest.json")))["run"]
        manifest = json.load(open(os.path.join(root, run_id, "manifest.json")))
    except (OSError, ValueError, KeyError):
        return None
    fields: dict[str, dict[int, np.ndarray]] = {}
    for name, info in manifest["vars"].items():
        fields[name] = {}
        for step in manifest["steps"]:
            with open(os.path.join(root, run_id, name, f"{step['h']:03d}.png"), "rb") as f:
                fields[name][step["h"]] = decode_field(f.read(), info["min"], info["max"])
    return parse_run(run_id), fields


def field_at(starts: dict[int, np.ndarray], hours: float) -> np.ndarray:
    """The field `hours` after the ensemble run began: an exact start, a linear mix of the two around it, or NaN."""
    shape = next(iter(starts.values())).shape
    if hours in starts:
        return starts[int(hours)]
    below = [h for h in starts if h < hours]
    above = [h for h in starts if h > hours]
    if not below or not above:
        return np.full(shape, np.nan, np.float32)
    h0, h1 = max(below), min(above)
    w = (hours - h0) / (h1 - h0)
    return (starts[h0] * (1 - w) + starts[h1] * w).astype(np.float32)


def attach_model(site: str, model: str, ens_run: datetime, ens_fields: dict[str, dict[int, np.ndarray]]) -> bool:
    root = os.path.join(site, model)
    try:
        run_id = json.load(open(os.path.join(root, "latest.json")))["run"]
        manifest_path = os.path.join(root, run_id, "manifest.json")
        manifest = json.load(open(manifest_path))
    except (OSError, ValueError, KeyError):
        return False
    for name, starts in ens_fields.items():
        if name not in C.VARS:      # an older ensemble product (live site) may carry a variable that no longer exists
            continue
        var = C.VARS[name]
        for step in manifest["steps"]:
            hours = (parse_valid(step["valid"]) - ens_run).total_seconds() / 3600.0
            png = encode_field(field_at(starts, hours), var.lo, var.hi, var.bits)
            path = os.path.join(root, run_id, name, f"{step['h']:03d}.png")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(png)
        manifest["vars"][name] = {"unit": var.unit, "min": var.lo, "max": var.hi, "encoding": "rg16"}
    manifest.setdefault("notes", {})["px"] = f"chance (%) of heavy rain in the next 24 h from the ECMWF ensemble run {ens_run:%Y%m%dT%HZ}"
    with open(manifest_path, "w") as f:
        json.dump(manifest, f)
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True)
    args = ap.parse_args()
    ens = load_ens(args.site)
    if ens is None:
        print("no ensemble product in the site folder; nothing to attach")
        return 0
    ens_run, fields = ens
    models = sorted(d for d in os.listdir(args.site) if d not in SKIP and os.path.isdir(os.path.join(args.site, d)))
    done = [m for m in models if attach_model(args.site, m, ens_run, fields)]
    print(f"attached the {ens_run:%Y%m%dT%HZ} ensemble rain chances to: {', '.join(done) or 'no model'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
