"""16-bit quantised fields stored as 8-bit RGB PNG (R = high byte, G = low byte, B = 0).

Plain 8-bit PNG decodes identically in every browser via createImageBitmap, unlike 16-bit grayscale PNG.
value = lo + (R*256 + G) / 65535 * (hi - lo); NaN encodes as 65535 with B = 255 (the "no data" flag).
"""
from __future__ import annotations
import io
import numpy as np
from PIL import Image


def encode_field(values: np.ndarray, lo: float, hi: float) -> bytes:
    nan = ~np.isfinite(values)
    q = np.clip(np.round((np.nan_to_num(values, nan=lo) - lo) / (hi - lo) * 65535), 0, 65535).astype(np.uint16)
    q[nan] = 65535
    rgb = np.zeros(values.shape + (3,), np.uint8)
    rgb[..., 0] = q >> 8
    rgb[..., 1] = q & 255
    rgb[..., 2] = np.where(nan, 255, 0)
    buf = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buf, "PNG", optimize=True, compress_level=9)
    return buf.getvalue()


def decode_field(png: bytes, lo: float, hi: float) -> np.ndarray:
    rgb = np.asarray(Image.open(io.BytesIO(png)).convert("RGB"))
    q = rgb[..., 0].astype(np.uint32) * 256 + rgb[..., 1]
    out = lo + q / 65535.0 * (hi - lo)
    return np.where(rgb[..., 2] == 255, np.nan, out).astype(np.float32)
