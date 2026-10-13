"""run.py publishes only the variables that have data: a source with no 800 hPa level must not get an empty 800 hPa picture
(the app builds that level from the ones either side, but only when the manifest does not list it)."""
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np
import pytest

import run as R
from fetch_regular import Grid

GRID = Grid(10.0, 10.3, 78.0, 78.4, 0.1, "test-domain")        # 4 rows by 5 columns
RUN = datetime(2026, 10, 13, 0, tzinfo=timezone.utc)
SHAPE = (GRID.ny, GRID.nx)


def field(value: float) -> np.ndarray:
    return np.full(SHAPE, value, np.float32)


class FakeModel:
    """A model whose source has the 850 and 700 hPa levels but no 800 hPa, and no rain at the analysis hour."""
    MODEL_ID = "fake"
    LABEL = "Fake"
    RUN_HOURS = (0,)
    STEP_HOURS = [0, 3]
    UNAVAILABLE_VARS: frozenset[str] = frozenset()
    PRECIP_NOTE = "mm/h"
    GRID = GRID

    def latest_run(self):
        return RUN

    def precip_window_hours(self, h):
        return 3

    def read_step(self, run, h, workdir=None):
        raw = {
            "temperature_2m": field(30), "dew_point_2m": field(20),
            "wind_u_component_10m": field(2), "wind_v_component_10m": field(1), "wind_gusts_10m": field(6),
            "pressure_msl": field(101300), "precipitation": field(np.nan if h == 0 else 0.6), "cloud_cover": field(40),
            "cape": field(300), "total_column_integrated_water_vapour": field(45),
        }
        for lvl, (u, t) in {850: (8, 19), 700: (12, 9)}.items():
            raw[f"wind_u_component_{lvl}hPa"] = field(u)
            raw[f"wind_v_component_{lvl}hPa"] = field(-u / 2)
            raw[f"temperature_{lvl}hPa"] = field(t)
        return raw


@pytest.fixture
def published(tmp_path, monkeypatch):
    monkeypatch.setitem(R.MODELS, "fake", FakeModel())
    monkeypatch.setattr(sys, "argv", ["run.py", "--model", "fake", "--out", str(tmp_path), "--force"])
    assert R.main() == 0
    run_dir = tmp_path / "fake" / "20261013T00Z"
    return run_dir, json.loads((run_dir / "manifest.json").read_text())


def test_a_level_the_source_does_not_have_is_neither_listed_nor_written(published):
    run_dir, manifest = published
    for vid in ("u800", "v800", "t800", "gh800", "u925"):
        assert vid not in manifest["vars"], vid
        assert not (run_dir / vid).exists(), vid


def test_a_level_it_has_is_published_with_a_picture_for_every_step(published):
    run_dir, manifest = published
    for vid in ("u850", "v700", "t850", "vo850"):
        assert vid in manifest["vars"], vid
        assert sorted(p.name for p in (run_dir / vid).iterdir()) == ["000.png", "003.png"], vid


def test_a_variable_that_lacks_only_some_steps_stays(published):
    """Rain has no value at the analysis hour: its picture there says "no data", and the app expects a picture for every step."""
    run_dir, manifest = published
    assert "precip" in manifest["vars"]
    assert sorted(p.name for p in (run_dir / "precip").iterdir()) == ["000.png", "003.png"]


def test_the_variables_made_across_steps_are_not_judged_by_their_steps(published):
    run_dir, manifest = published
    for vid in ("rain24", "raintot"):
        assert vid in manifest["vars"], vid
        assert (run_dir / vid).is_dir(), vid

