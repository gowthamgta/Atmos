/**
 * Quality control of the radar against our own satellite (the radar workflow: scripts/radar-pipeline.ts). Rain falls from cloud; an echo
 * under a clear sky is not rain: ground clutter near a radar, clear-air echo, a picture misread (its map's colours taken for echo) or a
 * picture of yesterday whose file IMD keeps re-saving. Our Meteosat data packs give the cloud-top temperature every 15 minutes; where no top
 * within a few kilometres is colder than CLEAR_SKY_K, the sky is clear (the ground and the sea are warmer than that; a cloud that rains is
 * colder: even a warm shower's top is below about 280 K).
 *
 * Two checks, both erring on the side of keeping rain:
 *  - a radar product whose echo is mostly under a clear sky is misread or stale, and left out (productClearShare);
 *  - in the composite, a patch of echo (connected pixels) is removed only when every pixel of it is under a clear sky; a patch that touches
 *    cloud anywhere stays whole (removeClearPatches), so rain a little off its cloud (the satellite is up to 30 minutes older than the radar,
 *    and a high top is seen a few kilometres off by parallax) is kept.
 * (The research behind it: Lakshmanan and Valente 2004, infrared with radar to remove non-precipitating echo; Meteosat used the same way for
 * radar composites; GOES-16 with NEXRAD.)
 */

/** No cloud top colder than this nearby: a clear sky. */
export const CLEAR_SKY_K = 283;
/** How far around a pixel a colder top keeps it (km): the satellite's lag and parallax. */
export const CLOUD_NEAR_KM = 10;
/** A product is left out when this share of its echo is under a clear sky, from at least PRODUCT_MIN_ECHO pixels of echo. */
export const PRODUCT_MAX_CLEAR_SHARE = 0.85;
export const PRODUCT_MIN_ECHO = 3000;

/** The coldest cloud top near each pixel of a Web Mercator grid (K, Infinity where there is no data near). */
export interface CloudMap {
  coldest: Float32Array;
  nx: number;
  ny: number;
  /** The grid's box (degrees): columns even in longitude, rows even in Mercator y. */
  west: number;
  east: number;
  south: number;
  north: number;
}

const mercY = (lat: number): number => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

/**
 * The cloud map from one or more frames of 10.8 um temperatures on the same grid (K, 0 or NaN = no data): the coldest of the frames at each
 * pixel (a cloud in either), then the coldest within `nearKm` (a square of that half-width, `kmPerPx` the grid's pixel near the middle).
 */
export function buildCloudMap(frames: readonly Float32Array[], nx: number, ny: number, box: { west: number; east: number; south: number; north: number }, kmPerPx: number, nearKm = CLOUD_NEAR_KM): CloudMap {
  const n = nx * ny;
  const top = new Float32Array(n).fill(Infinity);
  for (const f of frames) for (let i = 0; i < n; i++) if (f[i] > 0 && f[i] < top[i]) top[i] = f[i];
  const r = Math.max(1, Math.round(nearKm / kmPerPx));
  // a min filter: rows then columns
  const rows = new Float32Array(n);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      let m = Infinity;
      for (let k = Math.max(0, x - r); k <= Math.min(nx - 1, x + r); k++) if (top[y * nx + k] < m) m = top[y * nx + k];
      rows[y * nx + x] = m;
    }
  }
  const coldest = new Float32Array(n);
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) {
      let m = Infinity;
      for (let k = Math.max(0, y - r); k <= Math.min(ny - 1, y + r); k++) if (rows[k * nx + x] < m) m = rows[k * nx + x];
      coldest[y * nx + x] = m;
    }
  }
  return { coldest, nx, ny, ...box };
}

/** Whether the sky is clear at a place (no top colder than `clearK` near it); false outside the map or where it has no data (not known). */
export function isClearSky(map: CloudMap, lat: number, lon: number, clearK = CLEAR_SKY_K): boolean {
  if (lat < map.south || lat > map.north || lon < map.west || lon > map.east) return false;
  const x = Math.min(map.nx - 1, Math.floor(((lon - map.west) / (map.east - map.west)) * map.nx));
  const y = Math.min(map.ny - 1, Math.floor(((mercY(lat) - mercY(map.north)) / (mercY(map.south) - mercY(map.north))) * map.ny));
  const c = map.coldest[y * map.nx + x];
  return Number.isFinite(c) && c >= clearK;
}

/** A field even in latitude and longitude, row 0 at the north: its size and box. */
export interface LatLonGrid {
  width: number;
  height: number;
  south: number;
  west: number;
  north: number;
  east: number;
}

/** How much of a field's echo (values above 0) is under a clear sky: { echo, clear } pixel counts (sampled every `step` pixels). */
export function productClearShare(field: ArrayLike<number>, grid: LatLonGrid, map: CloudMap, step = 2, clearK = CLEAR_SKY_K): { echo: number; clear: number } {
  let echo = 0, clear = 0;
  for (let y = 0; y < grid.height; y += step) {
    const lat = grid.north - ((y + 0.5) / grid.height) * (grid.north - grid.south);
    for (let x = 0; x < grid.width; x += step) {
      if (!(field[y * grid.width + x] > 0)) continue;
      echo++;
      if (isClearSky(map, lat, grid.west + ((x + 0.5) / grid.width) * (grid.east - grid.west), clearK)) clear++;
    }
  }
  return { echo: echo * step * step, clear: clear * step * step };
}

/** Whether a product's echo is mostly under a clear sky (misread or stale): see productClearShare. */
export function productLooksWrong(share: { echo: number; clear: number }): boolean {
  return share.echo >= PRODUCT_MIN_ECHO && share.clear >= PRODUCT_MAX_CLEAR_SHARE * share.echo;
}

/**
 * Removes the patches of echo (8-connected pixels above 0) of which every pixel is under a clear sky, in each of `fields` (the same grid: the
 * first decides, the others follow, e.g. the intensity, its byte copy and its fade). Returns the number of pixels removed.
 */
export function removeClearPatches(fields: readonly { [i: number]: number; length: number }[], grid: LatLonGrid, map: CloudMap, clearK = CLEAR_SKY_K): number {
  const field = fields[0];
  const { width: w, height: h } = grid;
  // whether each column/row is clear is worked out per pixel only where there is echo (most of the grid has none)
  const lonOf = (x: number) => grid.west + ((x + 0.5) / w) * (grid.east - grid.west);
  const latOf = (y: number) => grid.north - ((y + 0.5) / h) * (grid.north - grid.south);
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const members: number[] = [];
  let removed = 0;
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || !(field[start] > 0)) continue;
    let top = 0, allClear = true;
    stack[top++] = start;
    seen[start] = 1;
    members.length = 0;
    while (top > 0) {
      const i = stack[--top];
      members.push(i);
      const x = i % w, y = (i - x) / w;
      if (allClear && !isClearSky(map, latOf(y), lonOf(x), clearK)) allClear = false;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (!seen[j] && field[j] > 0) {
            seen[j] = 1;
            stack[top++] = j;
          }
        }
      }
    }
    if (!allClear) continue;
    for (const i of members) for (const f of fields) f[i] = 0;
    removed += members.length;
  }
  return removed;
}
