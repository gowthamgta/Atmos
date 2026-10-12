import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import b2_sync


def test_pack_model_run_concatenates_pngs_and_records_byte_ranges(tmp_path):
    run_dir = tmp_path / "ecmwf_ifs" / "20261012T00Z"
    (run_dir / "t2m").mkdir(parents=True)
    (run_dir / "rh").mkdir(parents=True)

    (run_dir / "t2m" / "000.png").write_bytes(b"PNG-T2M-000")
    (run_dir / "t2m" / "003.png").write_bytes(b"PNG-T2M-003-LONGER")
    (run_dir / "rh" / "000.png").write_bytes(b"RH0")
    (run_dir / "rh" / "003.png").write_bytes(b"RH33")

    manifest = {
        "model": "ecmwf_ifs",
        "run": "20261012T00Z",
        "steps": [{"h": 0, "valid": "2026-10-12T00:00:00Z"}, {"h": 3, "valid": "2026-10-12T03:00:00Z"}],
        "vars": {"t2m": {"unit": "°C", "min": -60, "max": 55, "encoding": "rg16"}, "rh": {"unit": "%", "min": 0, "max": 100, "encoding": "rg16"}},
    }
    (run_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    packs = b2_sync.pack_model_run(str(run_dir))
    assert packs["t2m/000.png"] == [0, 11]
    assert packs["t2m/003.png"] == [11, 18]
    assert packs["rh/000.png"] == [0, 3]
    assert packs["rh/003.png"] == [3, 4]

    t2m_pack = (run_dir / "t2m.pack").read_bytes()
    assert t2m_pack[0:11] == b"PNG-T2M-000"
    assert t2m_pack[11:29] == b"PNG-T2M-003-LONGER"
    assert not (run_dir / "t2m").exists()

    updated = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))
    assert updated["pack"] == "{var}.pack"
    assert updated["packs"]["t2m/003.png"] == [11, 18]


def test_sync_model_uploads_packs_manifest_and_latest_last(tmp_path):
    model_dir = tmp_path / "ukmo"
    run_dir = model_dir / "20261012T06Z"
    (run_dir / "t2m").mkdir(parents=True)
    (run_dir / "t2m" / "000.png").write_bytes(b"ABC")
    manifest = {"model": "ukmo", "run": "20261012T06Z", "steps": [{"h": 0}], "vars": {"t2m": {}}}
    (run_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (model_dir / "latest.json").write_text(json.dumps({"model": "ukmo", "run": "20261012T06Z"}), encoding="utf-8")

    uploaded: list[tuple[str, bytes, str]] = []
    cleaned: list[tuple[str, str]] = []

    class FakeB2:
        bucket_name = "nwp-atmos-storage"

        def upload_bytes(self, name: str, data: bytes, content_type: str = "") -> None:
            uploaded.append((name, data, content_type))

        def cleanup_old_runs(self, model_id: str, keep_run: str) -> int:
            cleaned.append((model_id, keep_run))
            return 2

    b2_sync.sync_model_to_b2(str(tmp_path), "ukmo", FakeB2(), workers=2, remove_local=True)  # type: ignore[arg-type]
    names = [u[0] for u in uploaded]
    assert names == [
        "ukmo/20261012T06Z/t2m.pack",
        "ukmo/20261012T06Z/manifest.json",
        "ukmo/latest.json",
    ]
    assert cleaned == [("ukmo", "20261012T06Z")]
    assert not model_dir.exists()
