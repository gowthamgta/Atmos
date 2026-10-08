from datetime import datetime, timezone

import numpy as np
import requests

import fetch_ifs
import run

RUN = datetime(2026, 10, 7, 0, tzinfo=timezone.utc)


class _Resp:
    def __init__(self, status=200, payload=None):
        self.status_code = status
        self.ok = status == 200
        self._payload = payload or {}

    def json(self):
        return self._payload


def test_a_run_is_not_started_before_the_025_degree_levels_are_published(monkeypatch):
    monkeypatch.setattr(fetch_ifs.requests, "get", lambda *a, **k: _Resp(200, {"completed": True, "reference_time": "2026-10-07T00:00:00Z"}))
    seen = []
    monkeypatch.setattr(fetch_ifs.requests, "head", lambda url, **k: (seen.append(url), _Resp(404))[1])
    try:
        fetch_ifs.latest_run()
        raise AssertionError("should have waited for the levels")
    except RuntimeError as e:
        assert "pressure-level" in str(e)
    assert "ecmwf_ifs025" in seen[0] and "2026-10-13T0000" in seen[0]          # the last step (+144 h) of the 0.25 degree dataset
    monkeypatch.setattr(fetch_ifs.requests, "head", lambda url, **k: _Resp(200))
    assert fetch_ifs.latest_run() == RUN


def test_a_step_whose_levels_cannot_be_read_is_recorded(monkeypatch, tmp_path):
    fetch_ifs._level_gaps.clear()

    def boom(*a, **k):
        raise requests.ConnectionError("down")

    monkeypatch.setattr(fetch_ifs, "download", boom)
    monkeypatch.setattr(fetch_ifs.fetch_regular, "dataset_info", lambda name: type("I", (), {"bbox": (-90, -180, 90, 179.75)})())
    out = fetch_ifs._levels_aloft(RUN, 12, str(tmp_path))
    assert all(np.isnan(v).all() for v in out.values())
    assert fetch_ifs.incomplete_steps() == [12]
    fetch_ifs._level_gaps.clear()


def test_live_run_ignores_incomplete_and_old_format_runs(monkeypatch):
    def serve(payload):
        monkeypatch.setattr(run.requests, "get", lambda *a, **k: _Resp(200, payload))
    serve({"run": "20261007T00Z", "domain": run.C.DOMAIN})
    assert run.live_run("u") == "20261007T00Z"                                  # no format asked for: as before
    assert run.live_run("u", fmt=2) is None                                    # IFS wants format 2: the old live copy is rebuilt
    serve({"run": "20261007T00Z", "format": 2, "domain": run.C.DOMAIN})
    assert run.live_run("u", fmt=2) == "20261007T00Z"
    serve({"run": "20261007T00Z", "format": 2, "domain": run.C.DOMAIN, "complete": False})
    assert run.live_run("u", fmt=2) is None                                    # published with gaps: built again
    assert run.live_run("u") is None
    serve({"run": "20261007T00Z", "format": 2})
    assert run.live_run("u", fmt=2) is None                                    # published for another domain: built again


def test_a_newer_run_the_model_does_not_use_steps_back_to_its_last_run(monkeypatch):
    # the newest run is 06Z (not one of RUN_HOURS): the 00Z run before it is the one to build
    monkeypatch.setattr(fetch_ifs.requests, "get", lambda *a, **k: _Resp(200, {"completed": True, "reference_time": "2026-10-07T06:00:00Z"}))
    monkeypatch.setattr(fetch_ifs.requests, "head", lambda url, **k: _Resp(200))
    assert fetch_ifs.latest_run() == RUN
    monkeypatch.setattr(fetch_ifs.requests, "get", lambda *a, **k: _Resp(200, {"completed": True, "reference_time": "2026-10-07T18:00:00Z"}))
    assert fetch_ifs.latest_run() == datetime(2026, 10, 7, 12, tzinfo=timezone.utc)
