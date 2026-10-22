import json, os

import satellite_restore as R


class Res:
    def __init__(self, status, body=b"", js=None):
        self.status_code, self.content, self._js = status, body, js

    def json(self):
        return self._js


def test_restores_listed_frames_and_skips_missing(tmp_path):
    site = {
        "https://x/bt-h9/index.json": Res(200, js={"version": 1, "frames": [{"time": "t1", "file": "a.png"}, {"time": "t2", "file": "b.png"}]}),
        "https://x/bt-h9/a.png": Res(200, b"PNG-A"),
        "https://x/bt-h9/b.png": Res(404),
        "https://x/bt/index.json": Res(404),
    }
    n = R.restore("https://x/", str(tmp_path), get=lambda url, timeout: site[url])
    assert n == 1
    assert open(tmp_path / "bt-h9" / "a.png", "rb").read() == b"PNG-A"
    index = json.load(open(tmp_path / "bt-h9" / "index.json"))
    assert [f["file"] for f in index["frames"]] == ["a.png"]   # the frame that could not be fetched is not listed
    assert not os.path.exists(tmp_path / "bt")
