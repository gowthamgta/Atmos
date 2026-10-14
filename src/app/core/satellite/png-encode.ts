/**
 * Writes an RGBA picture as a PNG without going through a canvas. A canvas keeps its pixels premultiplied (8 bits), so the colour of
 * a faint pixel is rounded to a few levels and comes back as bands; written here, the colour of every pixel is exactly what was
 * computed, whatever its opacity.
 *
 * The picture goes into the PNG uncompressed (deflate "stored" blocks): compressing 16 MB took close to a second per picture, the
 * browser reads an uncompressed PNG at once, and the picture only travels from the worker to the map in this page.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crcUpdate(crc: number, bytes: Uint8Array, from = 0, to = bytes.length): number {
  let c = crc;
  for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c;
}

const STORED_BLOCK = 65535;

/** The zlib stream of `raw` as stored (uncompressed) blocks, with its Adler-32. */
function zlibStored(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const blocks = Math.max(1, Math.ceil(raw.length / STORED_BLOCK));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  let a = 1;
  let b = 0;
  for (let from = 0; from < raw.length || from === 0; from += STORED_BLOCK) {
    const len = Math.min(STORED_BLOCK, raw.length - from);
    out[at++] = from + len >= raw.length ? 1 : 0; // final block flag, stored type
    out[at++] = len & 0xff;
    out[at++] = len >>> 8;
    out[at++] = ~len & 0xff;
    out[at++] = (~len >>> 8) & 0xff;
    out.set(raw.subarray(from, from + len), at);
    at += len;
    for (let i = from; i < from + len; ) {
      // Adler-32 in runs short enough that the sums cannot overflow
      const stop = Math.min(from + len, i + 5552);
      for (; i < stop; i++) {
        a += raw[i];
        b += a;
      }
      a %= 65521;
      b %= 65521;
    }
    if (len === 0) break;
  }
  const adler = ((b << 16) | a) >>> 0;
  out[at++] = adler >>> 24;
  out[at++] = (adler >>> 16) & 0xff;
  out[at++] = (adler >>> 8) & 0xff;
  out[at++] = adler & 0xff;
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, (crcUpdate(0xffffffff, out, 4, 8 + data.length) ^ 0xffffffff) >>> 0);
  return out;
}

export function pngBytes(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array<ArrayBuffer> {
  const rowBytes = width * 4;
  const raw = new Uint8Array((rowBytes + 1) * height); // each row starts with filter type 0 (none)
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  const parts = [signature, chunk('IHDR', header), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function encodePng(rgba: Uint8ClampedArray, width: number, height: number): Blob {
  return new Blob([pngBytes(rgba, width, height)], { type: 'image/png' });
}
