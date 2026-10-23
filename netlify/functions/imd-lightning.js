// Netlify Serverless Function: IMD's lightning of the last ten minutes (India Meteorological Department, satellite meteorology division),
// read from the map IMD publishes (red stars over the INSAT-3DS/3DR picture, about every 15 to 30 minutes, some 10 minutes after the
// strokes). IMD gives no list of strokes, so the stars are found on the picture and their centres turned into places: the map spans
// 65-99 E and 5-40 N in plain latitude and longitude (checked against India's outline on it: Kutch, Arunachal, Ladakh, Great Nicobar), a
// pixel is about 8 km, so a place is good to about that much. The app shows these as past strokes where ILDN has none (lightning.ts).
//
// Answer: { time: ISO time of the map's strokes (their newest), windowMin: 10, points: [[lat, lon], ...] }, kept at the edge for 5 minutes.

const zlib = require('zlib');

const SOURCE = 'https://internal.imd.gov.in/section/satmet/lightning/Last10_BT.png';
// the picture's plot area (pixels) and what it covers
const FRAME = { x0: 161, x1: 637, y0: 97, y1: 586, west: 65, east: 99, north: 40, south: 5 };
// the legend box ("Last 10min" with its own star), inside the plot area
const LEGEND = { x0: 455, x1: 625, y0: 108, y1: 150 };
// IMD's map shows the strokes up to about this long before it is saved
const LAG_MS = 9 * 60_000;

/** A PNG's pixels as RGB (8-bit truecolour or truecolour with alpha, not interlaced: what IMD's maps are). */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let w = 0, h = 0, type = 0, depth = 0, interlace = 0;
  const idat = [];
  for (let o = 8; o < buf.length; ) {
    const len = buf.readUInt32BE(o);
    const kind = buf.toString('ascii', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (kind === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    o += 12 + len;
  }
  if (depth !== 8 || (type !== 2 && type !== 6) || interlace) throw new Error(`PNG type ${type}/${depth}/${interlace} not handled`);
  const bpp = type === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * 3);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      if (f === 1) line[i] = (line[i] + a) & 255;
      else if (f === 2) line[i] = (line[i] + b) & 255;
      else if (f === 3) line[i] = (line[i] + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    for (let x = 0; x < w; x++) {
      out[(y * w + x) * 3] = line[x * bpp];
      out[(y * w + x) * 3 + 1] = line[x * bpp + 1];
      out[(y * w + x) * 3 + 2] = line[x * bpp + 2];
    }
    prev = line;
  }
  return { w, h, rgb: out };
}

/**
 * The stars' centres. A star is about 7 x 7 pixels; overlapping stars make a blob, so a centre is a pixel whose 7 x 7 neighbourhood is
 * mostly red, taken greedily from the reddest, no two closer than 5 pixels (about a star apart).
 */
function stars({ w, h, rgb }) {
  const red = new Uint8Array(w * h);
  for (let y = FRAME.y0; y < FRAME.y1; y++) {
    for (let x = FRAME.x0; x < FRAME.x1; x++) {
      if (x >= LEGEND.x0 && x <= LEGEND.x1 && y >= LEGEND.y0 && y <= LEGEND.y1) continue;
      const o = (y * w + x) * 3;
      if (rgb[o] > 180 && rgb[o + 1] < 90 && rgb[o + 2] < 90) red[y * w + x] = 1;
    }
  }
  const cand = [];
  for (let y = FRAME.y0; y < FRAME.y1; y++) {
    for (let x = FRAME.x0; x < FRAME.x1; x++) {
      if (!red[y * w + x]) continue;
      let n = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) n += red[(y + dy) * w + x + dx] || 0;
      if (n >= 20) cand.push({ x, y, n });
    }
  }
  cand.sort((a, b) => b.n - a.n);
  const picked = [];
  for (const c of cand) if (picked.every(p => (p.x - c.x) ** 2 + (p.y - c.y) ** 2 >= 25)) picked.push(c);
  return picked.map(({ x, y }) => [
    +(FRAME.north - ((y + 0.5 - FRAME.y0) / (FRAME.y1 - FRAME.y0)) * (FRAME.north - FRAME.south)).toFixed(3),
    +(FRAME.west + ((x + 0.5 - FRAME.x0) / (FRAME.x1 - FRAME.x0)) * (FRAME.east - FRAME.west)).toFixed(3),
  ]);
}

exports.decodePng = decodePng;
exports.stars = stars;

exports.handler = async function () {
  try {
    const response = await fetch(SOURCE, {
      headers: { 'User-Agent': 'AtmosIQ-personal (non-commercial; lightning of the last minutes; see atmosradar.netlify.app)', Accept: 'image/png' },
    });
    if (!response.ok) {
      return { statusCode: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: `IMD answered ${response.status}` }) };
    }
    const saved = Date.parse(response.headers.get('last-modified') || '') || Date.now();
    const points = stars(decodePng(Buffer.from(await response.arrayBuffer())));
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=60',
        'Netlify-CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=300',
      },
      body: JSON.stringify({ time: new Date(saved - LAG_MS).toISOString(), windowMin: 10, points }),
    };
  } catch (e) {
    return { statusCode: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: String(e) }) };
  }
};
