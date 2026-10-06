"""One forecast from all the models: a weighted average of every model's published fields.

Each model's run is a folder of encoded images (see run.py). This reads them back, takes for every forecast time the
weighted mean of the models that have the variable at that time, and writes the result as one more model, `blend`,
in the same format, so the app treats it like any other.

  - Models are lined up by *valid time*, not by step number: their runs started at different hours, so a step of one
    model is another model's step plus an offset. A time that falls between two of a model's steps (a 6-hourly model
    on a 3-hourly axis) is linearly interpolated, but only when both steps have data.
  - Wind is averaged as u and v components, which is the right vector mean (strongly disagreeing models cancel out).
  - Weights favour the models that verify best here (ECMWF IFS first); a model that stops early (UK Met Office at
    +60 h) simply drops out and the rest carry on.
  - The ensemble rain chances are not blended: attach.py adds them to this model like any other.

  python blend.py --site site              # writes site/blend (reads every model folder in site)
"""
from __future__ import annotations
import argparse, json, os, shutil, sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import numpy as np

import config as C
from encode import decode_field, encode_field

BLEND_ID = "blend"
LABEL = "All models (blend)"
STEP_HOURS = 3
# Relative weights. IFS is the best global model for this region; AIFS, ICON and the UKMO model are close behind.
WEIGHTS: dict[str, float] = {
    "ecmwf_ifs": 3.0, "gfs": 2.0, "ukmo": 2.0, "ecmwf_aifs": 1.5, "dwd_icon": 1.5, "gdps": 1.0, "cma_grapes": 1.0,
}
NOT_BLENDED = {"px65", "px115", "px204"}     # added to every model by attach.py
NOT_MODELS = {BLEND_ID, "ens"}                # folders in the site that are products, not forecast models


def parse_valid(text: str) -> datetime:
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def parse_run(run_id: str) -> datetime:
    return datetime.strptime(run_id, "%Y%m%dT%HZ").replace(tzinfo=timezone.utc)


@dataclass
class Component:
    model: str
    run_id: str
    run: datetime
    root: str
    steps: dict[datetime, int]     # valid time -> step hour of that model
    vars: dict[str, dict]
    weight: float


def load_component(site: str, model: str) -> Component | None:
    root = os.path.join(site, model)
    try:
        run_id = json.load(open(os.path.join(root, "latest.json")))["run"]
        manifest = json.load(open(os.path.join(root, run_id, "manifest.json")))
        run = parse_run(run_id)
    except (OSError, ValueError, KeyError):
        return None
    steps = {parse_valid(s["valid"]): int(s["h"]) for s in manifest["steps"]}
    return Component(model, run_id, run, os.path.join(root, run_id), steps, manifest["vars"], WEIGHTS.get(model, 1.0))


def read_field(c: Component, var: str, step: int) -> np.ndarray:
    info = c.vars[var]
    with open(os.path.join(c.root, var, f"{step:03d}.png"), "rb") as f:
        return decode_field(f.read(), info["min"], info["max"])


def field_at_valid(c: Component, var: str, valid: datetime, max_gap_h: float = 6.0) -> np.ndarray | None:
    """The model's field at a valid time: its own step, or a linear mix of the two around it. None if it has neither."""
    if var not in c.vars:
        return None
    if valid in c.steps:
        return read_field(c, var, c.steps[valid])
    before = [t for t in c.steps if t < valid]
    after = [t for t in c.steps if t > valid]
    if not before or not after:
        return None
    t0, t1 = max(before), min(after)
    if (t1 - t0).total_seconds() / 3600 > max_gap_h:
        return None
    w = (valid - t0).total_seconds() / (t1 - t0).total_seconds()
    return (read_field(c, var, c.steps[t0]) * (1 - w) + read_field(c, var, c.steps[t1]) * w).astype(np.float32)


def weighted_mean(parts: list[tuple[float, np.ndarray]]) -> np.ndarray:
    """Weighted mean over models; where a model has NaN it is left out of that cell (NaN only where nobody has data)."""
    if not parts:
        raise ValueError("nothing to average")
    total = np.zeros(parts[0][1].shape, np.float64)
    weight = np.zeros(parts[0][1].shape, np.float64)
    for w, field in parts:
        ok = np.isfinite(field)
        total += np.where(ok, field, 0.0) * w
        weight += np.where(ok, w, 0.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.where(weight > 0, total / weight, np.nan)
    return out.astype(np.float32)


def blend_axis(components: list[Component], step_hours: int = STEP_HOURS) -> tuple[datetime, list[datetime]]:
    """Reference time (the newest model run) and the valid times to publish: every `step_hours` from it to the last any model has."""
    ref = max(c.run for c in components)
    last = max(max(c.steps) for c in components)
    n = int((last - ref).total_seconds() // 3600 // step_hours)
    return ref, [ref + timedelta(hours=step_hours * i) for i in range(n + 1)]


def blend_step(components: list[Component], variables: list[str], valid: datetime) -> dict[str, np.ndarray]:
    out: dict[str, np.ndarray] = {}
    for var in variables:
        parts = []
        for c in components:
            field = field_at_valid(c, var, valid)
            if field is not None:
                parts.append((c.weight, field))
        out[var] = weighted_mean(parts) if parts else np.full((C.NY, C.NX), np.nan, np.float32)
    return out


def write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def run_id_now(now: datetime | None = None) -> str:
    """The blend's run id is when it was assembled, so any change of its inputs gets new URLs (nothing stale is served)."""
    return (now or datetime.now(timezone.utc)).strftime("%Y%m%dT%H%MZ")


def components_of(site: str) -> list[Component]:
    models = [d for d in sorted(os.listdir(site)) if d not in NOT_MODELS and os.path.isdir(os.path.join(site, d))]
    return [c for c in (load_component(site, m) for m in models) if c is not None]


def build(site: str, workers: int = 4, steps_limit: int | None = None) -> str | None:
    components = components_of(site)
    if len(components) < 2:
        print(f"blend: only {len(components)} model(s) available; nothing to blend")
        return None
    ref, axis = blend_axis(components)
    if steps_limit:
        axis = axis[:steps_limit]
    variables = sorted({v for c in components for v in c.vars} - NOT_BLENDED)
    published = [v for v in variables if v in C.VARS]
    runs = {c.model: c.run_id for c in components}
    run_id = run_id_now()
    run_dir = os.path.join(site, BLEND_ID, run_id)
    print(f"blend: {len(components)} models ({', '.join(runs)}), {len(axis)} steps, {len(published)} variables", flush=True)

    def one(i: int):
        fields = blend_step(components, published, axis[i])
        return i, {v: encode_field(fields[v], C.VARS[v].lo, C.VARS[v].hi, C.VARS[v].bits) for v in published}

    steps = []
    with ThreadPoolExecutor(workers) as pool:
        for i, pngs in pool.map(one, range(len(axis))):
            h = int((axis[i] - ref).total_seconds() // 3600)
            for v, png in pngs.items():
                write(os.path.join(run_dir, v, f"{h:03d}.png"), png)
            steps.append({"h": h, "valid": f"{axis[i]:%Y-%m-%dT%H:%M:%SZ}"})
    manifest = {
        "model": BLEND_ID,
        "run": run_id,
        "reference": f"{ref:%Y%m%dT%HZ}",
        "components": runs,
        "weights": {c.model: c.weight for c in components},
        "grid": {"latMax": C.LAT_MAX, "latMin": C.LAT_MIN, "lonMin": C.LON_MIN, "lonMax": C.LON_MAX,
                 "step": C.STEP_DEG, "nx": C.NX, "ny": C.NY},
        "steps": steps,
        "vars": {v: {"unit": C.VARS[v].unit, "min": C.VARS[v].lo, "max": C.VARS[v].hi, "encoding": "rg16"} for v in published},
        "levels": list(C.LEVELS),
        "path": "{var}/{h:03d}.png",
        "notes": {"precip": "mm/h: weighted mean of the models' own rain rates",
                  "blend": "weighted mean of the models listed in 'components', lined up by valid time"},
    }
    write(os.path.join(run_dir, "manifest.json"), json.dumps(manifest).encode())
    for old in os.listdir(os.path.join(site, BLEND_ID)):   # only the newest assembly is kept (a mirrored older one, say)
        if old != run_id and os.path.isdir(os.path.join(site, BLEND_ID, old)):
            shutil.rmtree(os.path.join(site, BLEND_ID, old), ignore_errors=True)
    write(os.path.join(site, BLEND_ID, "latest.json"), json.dumps({"model": BLEND_ID, "run": run_id, "components": runs}).encode())
    return run_id


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True)
    ap.add_argument("--live-url", help="latest.json of the deployed blend; skip when its inputs are unchanged")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--steps", type=int, help="only the first N steps (local tests)")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()
    comps = components_of(args.site)
    if not args.force and args.live_url:
        try:
            import requests
            live = requests.get(args.live_url, timeout=30).json()
            if live.get("components") == {c.model: c.run_id for c in comps}:
                print("blend: inputs unchanged since the live blend; nothing to do")
                return 0
        except Exception:
            pass
    return 0 if build(args.site, args.workers, args.steps) or len(comps) < 2 else 1


if __name__ == "__main__":
    sys.exit(main())
