/**
 * Writes an RGBA picture as a PNG without going through a canvas. A canvas keeps its pixels premultiplied (8 bits), so the colour of
 * a faint pixel is rounded to a few levels and comes back as bands; written here, the colour of every pixel is exactly what was
 * computed, whatever its opacity.
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

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export async function pngBytes(rgba: Uint8ClampedArray, width: number, height: number): Promise<Uint8Array<ArrayBuffer>> {
  const rowBytes = width * 4;
  const raw = new Uint8Array((rowBytes + 1) * height); // each row starts with filter type 0 (none)
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  // the "deflate" stream of CompressionStream is the zlib format a PNG's IDAT holds
  const zlib = new Uint8Array(await new Response(new Response(raw).body!.pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  const parts = [signature, chunk('IHDR', header), chunk('IDAT', zlib), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export async function encodePng(rgba: Uint8ClampedArray, width: number, height: number): Promise<Blob> {
  return new Blob([await pngBytes(rgba, width, height)], { type: 'image/png' });
}
