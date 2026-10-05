"""Small HTTP helper shared by the model fetchers."""
from __future__ import annotations
import time
import requests


def download(url: str, dest: str, retries: int = 4) -> None:
    """Stream `url` to `dest`, retrying with a growing pause on network errors and bad statuses."""
    for attempt in range(retries):
        try:
            with requests.get(url, stream=True, timeout=60) as r:
                r.raise_for_status()
                with open(dest, "wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
            return
        except requests.RequestException:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt * 3)
