/**
 * Composing the radars into one picture (pure, so it can be tested).
 *
 * Each source is one station's scan of the product on show (CAZ, PPZ or PPI): an intensity field on that scan's own
 * square, with its geographic bounds. The stations are blended where they overlap, keeping storm cores.
 */
import type { ProcessedRadarResult, RadarObservationTiming, RadarProductKey, RadarStationConfig } from '../domain/models/radar.model';
import { quantizeRadarField } from './radar-field';

/** A live scan older than this many minutes is not drawn (the radar is stale or stuck, the picture would mislead). */
export const MAX_SCAN_AGE_MIN = 45;

/** Resolution of the composite: 0.5 km per pixel. */
export const MOSAIC_KM_PER_PX = 0.5;

/**
 * Where radars overlap and one scanned later than another, the older radar's echo is drawn fainter: the rain has moved on since. Scans
 * less than this many minutes apart are the same moment (the radars scan every 10 minutes, a little out of step with each other).
 */
export const OVERLAP_STALE_MIN = 8;
/** How faint an older echo is drawn (its opacity, 0..1): one scan behind, and this much older or more. */
export const OVERLAP_FADE_ONE_SCAN = 0.6;
export const OVERLAP_FADE_OLDEST = 0.35;
export const OVERLAP_FADE_OLDEST_MIN = 30;
/** Over this much of the newer radar's range (km, inward from its edge) the fade sets in, so its edge draws no line on the map. */
export const OVERLAP_FADE_EDGE_KM = 10;

/**
 * Where a source is one ring of a station's stack (the All view, the owner, 24 Oct 2026): it is drawn only between `innerKm` and its own
 * range from the radar, as a circle (a PPI too), so each station shows its PPI inside, its CAZ around it and its PPZ outside. Without it a
 * source is the station's whole picture of the product on show.
 */
export interface MosaicRing {
  product: RadarProductKey;
  innerKm: number;
  /** The outermost ring of its station: only its outer edge is feathered (an inner ring meets the next one without a seam). */
  outermost: boolean;
}

/** The key of one ring's source in the mosaic: `stationId:product`. */
export const ringKey = (stationId: string, product: RadarProductKey): string => `${stationId}:${product}`;

/** One station's scan being composed: where it lies and its intensity field. */
interface ActiveStation {
  station: RadarStationConfig;
  /** This source's place in the list (a station of the stack has one per ring). */
  stationIndex: number;
  /** The station's place in the network (the order the stations are drawn in). */
  networkIndex: number;
  rangeKm: number;
  /** Echo nearer the radar than this is left to the station's inner ring (0: none). */
  innerKm: number;
  /** A square picture whose corners are kept (the PPI shown on its own); every other picture is cut to its range circle. */
  square: boolean;
  /** Its picture's edge is feathered so the range boundary draws no seam. */
  feather: boolean;
  res: ProcessedRadarResult;
  south: number;
  west: number;
  north: number;
  east: number;
  cropW: number;
  cropH: number;
  field: Float32Array;
  cosLat: number;
  /** When it scanned (epoch ms), NaN when that is not known. */
  timeMs: number;
}

/** What one scan needs at every output column (it does not change from row to row), and where its picture has echo. */
interface StationPrep {
  s: ActiveStation;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  xA: Int32Array;
  xB: Int32Array;
  fx: Float64Array;
  wx: Float64Array;
  dLng: Float64Array;
  lngOk: Uint8Array;
  /** Per source row: the first and last column that holds echo, -1 when the row is empty. */
  rowMin: Int32Array;
  rowMax: Int32Array;
}

function prepareStation(
  s: ActiveStation,
  minLng: number, maxLng: number, minLat: number, maxLat: number,
  outW: number, outH: number, lngSpan: number, latSpan: number,
): StationPrep | null {
  const x0 = Math.max(0, Math.floor(((s.west - minLng) / lngSpan) * (outW - 1)));
  const x1 = Math.min(outW - 1, Math.ceil(((s.east - minLng) / lngSpan) * (outW - 1)));
  const y0 = Math.max(0, Math.floor(((maxLat - s.north) / latSpan) * (outH - 1)));
  const y1 = Math.min(outH - 1, Math.ceil(((maxLat - s.south) / latSpan) * (outH - 1)));
  const rowMin = new Int32Array(s.cropH).fill(-1);
  const rowMax = new Int32Array(s.cropH).fill(-1);
  for (let r = 0; r < s.cropH; r++) {
    const o = r * s.cropW;
    let lo = -1;
    let hi = -1;
    for (let c = 0; c < s.cropW; c++) {
      if (s.field[o + c] !== 0) {
        if (lo < 0) lo = c;
        hi = c;
      }
    }
    rowMin[r] = lo;
    rowMax[r] = hi;
  }
  // a scan with no echo at all still counts: it is the closest radar for its points, which stay dry
  const xA = new Int32Array(outW);
  const xB = new Int32Array(outW);
  const fx = new Float64Array(outW);
  const wx = new Float64Array(outW);
  const dLng = new Float64Array(outW);
  const lngOk = new Uint8Array(outW);
  for (let x = x0; x <= x1; x++) {
    const lng = minLng + (x / (outW - 1)) * lngSpan;
    if (lng < s.west || lng > s.east) continue;
    lngOk[x] = 1;
    const f = ((lng - s.west) / (s.east - s.west)) * (s.cropW - 1);
    fx[x] = f;
    xA[x] = Math.floor(f);
    xB[x] = Math.min(xA[x] + 1, s.cropW - 1);
    wx[x] = f - xA[x];
    dLng[x] = (lng - s.station.lng) * 111.32 * s.cosLat;
  }
  // columns outside the scan's footprint must not satisfy the search below: keep the arrays monotonic over [x0, x1]
  let lastA = 0;
  let lastB = 0;
  for (let x = x0; x <= x1; x++) {
    if (lngOk[x] === 0) { xA[x] = lastA; xB[x] = lastB; } else { lastA = xA[x]; lastB = xB[x]; }
  }
  return { s, x0, x1, y0, y1, xA, xB, fx, wx, dLng, lngOk, rowMin, rowMax };
}

/** The first column in [from, to] whose value is at least `value` (`to + 1` when there is none); `values` never decreases. */
function firstColumn(values: Int32Array, from: number, to: number, value: number): number {
  let lo = from;
  let hi = to + 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] >= value) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * One picture from every station's scan. Keys are station ids, and every scan is of `defaultProduct`, whose range sets how far each
 * station's scan reaches; or, for the stack, `stationId:product` with the ring each draws (`rings`, by key).
 */
export function composeRadarMosaic(
  stations: readonly RadarStationConfig[],
  allResults: Iterable<[string, ProcessedRadarResult]>,
  kmPerPixel = MOSAIC_KM_PER_PX,
  maxPixels = 2800,
  defaultProduct: RadarProductKey = 'caz',
  /** When set, scans whose timestamp is more than MAX_SCAN_AGE_MIN before this time are left out (live view only). */
  nowMs?: number,
  rings?: ReadonlyMap<string, MosaicRing>,
): ProcessedRadarResult | null {

  const activeStations: ActiveStation[] = [];

  let latestTiming: RadarObservationTiming | null = null;

  for (const [stId, res] of allResults) {
    if (res.isDisplayed === false || !res.fieldData) continue;
    if (nowMs != null && res.timing?.epochMs && nowMs - res.timing.epochMs > MAX_SCAN_AGE_MIN * 60_000) continue;
    const ring = rings?.get(stId);
    const networkIndex = stations.findIndex(s => s.id === (ring ? stId.slice(0, stId.lastIndexOf(':')) : stId));
    if (networkIndex < 0) continue;
    const st = stations[networkIndex];
    const product = ring?.product ?? defaultProduct;

    const b = res.fieldData.bounds;
    activeStations.push({
      station: st,
      stationIndex: 0,
      networkIndex,
      rangeKm: st.products[product]?.rangeKm ?? st.operationalRangeKm,
      innerKm: ring?.innerKm ?? 0,
      square: !ring && product === 'ppi',
      feather: !ring || ring.outermost,
      res,
      south: b[0][0],
      west: b[0][1],
      north: b[1][0],
      east: b[1][1],
      cropW: res.fieldData.cropW,
      cropH: res.fieldData.cropH,
      field: res.fieldData.field,
      cosLat: Math.cos((st.lat * Math.PI) / 180),
      timeMs: res.timing?.epochMs ?? NaN,
    });

    if (res.timing && (!latestTiming || (res.timing.epochMs && (!latestTiming.epochMs || res.timing.epochMs > latestTiming.epochMs)))) {
      latestTiming = res.timing;
    }
  }

  if (activeStations.length === 0) return null;
  // the stations one after another (a stack's rings inside out), so each pixel can settle one source before the next
  activeStations.sort((a, b) => a.networkIndex - b.networkIndex || a.innerKm - b.innerKm);
  activeStations.forEach((s, i) => (s.stationIndex = i));

  // 1. Calculate combined bounding box of all active stations
  let minLng = 180, maxLng = -180, minLat = 90, maxLat = -90;
  for (const s of activeStations) {
    if (s.west < minLng) minLng = s.west;
    if (s.east > maxLng) maxLng = s.east;
    if (s.south < minLat) minLat = s.south;
    if (s.north > maxLat) maxLat = s.north;
  }

  // 2. Composite resolution: 0.5 km per pixel, the same as the stations' own fields
  const midLat = (minLat + maxLat) / 2;
  const cosMidLat = Math.cos((midLat * Math.PI) / 180);
  const dLngKm = (maxLng - minLng) * 111.32 * cosMidLat;
  const dLatKm = (maxLat - minLat) * 111.32;

  const px = (km: number) => Math.min(maxPixels, Math.max(512, Math.round(km / kmPerPixel)));
  const outW = px(dLngKm);
  const outH = px(dLatKm);

  const total = outW * outH;
  const compositeField = new Float32Array(total);

  // 3. Composite. Each radar only visits the pixels inside its own footprint, and within that only where its picture has
  // echo (rows and columns without any are skipped before any maths), adding its contribution to per-pixel accumulators;
  // a second pass per band merges them. Working a band of rows at a time keeps the accumulators small enough for the
  // processor's cache (the whole picture at once is a quarter of a gigabyte of arrays) and gives the same result.
  const lngSpan = maxLng - minLng;
  const latSpan = maxLat - minLat;
  const preps = activeStations.map(s => prepareStation(s, minLng, maxLng, minLat, maxLat, outW, outH, lngSpan, latSpan));

  const bandRows = 48;
  const peak = new Float32Array(outW * bandRows);        // strongest echo over this pixel
  const weightedSum = new Float32Array(outW * bandRows); // sum of value * distance weight
  const weightTotal = new Float32Array(outW * bandRows);
  const radarCount = new Uint8Array(outW * bandRows);    // how many radars see an echo here
  // Each station's scan is settled at a pixel before the next station is drawn there: the running best of the station being
  // drawn at each pixel, which station it belongs to, and its distance weight.
  const stationOf = new Int16Array(outW * bandRows);
  const stationVal = new Float32Array(outW * bandRows);
  const stationWeight = new Float32Array(outW * bandRows);
  // for the fade of older echoes: which station gave the peak, and the newest scan with echo here and its strength
  const peakStation = new Int16Array(outW * bandRows);
  const newestEchoTime = new Float64Array(outW * bandRows);
  const newestEchoVal = new Float32Array(outW * bandRows);
  const timeOf = new Float64Array(activeStations.length).fill(NaN);
  for (const s of activeStations) timeOf[s.stationIndex] = s.timeMs;
  const commit = (i: number): void => {
    const v = stationVal[i];
    const st = stationOf[i];
    if (st < 0 || v <= 0) return;
    if (v > peak[i]) {
      peak[i] = v;
      peakStation[i] = st;
    }
    const t = timeOf[st];
    if (t > newestEchoTime[i]) {
      newestEchoTime[i] = t;
      newestEchoVal[i] = v;
    } else if (t === newestEchoTime[i] && v > newestEchoVal[i]) {
      newestEchoVal[i] = v;
    }
    weightedSum[i] += v * stationWeight[i];
    weightTotal[i] += stationWeight[i];
    radarCount[i]++;
  };
  // the fade of every pixel (255: drawn in full); only made when some echo is older than a radar that covers it
  let fade: Uint8Array | null = null;
  const timed = activeStations.filter(s => !Number.isNaN(s.timeMs));
  const newestScan = timed.reduce((m, s) => Math.max(m, s.timeMs), -Infinity);
  const staleMs = OVERLAP_STALE_MIN * 60_000;

  for (let yb = 0; yb < outH; yb += bandRows) {
    const ye = Math.min(outH, yb + bandRows);
    const n = (ye - yb) * outW;
    peak.fill(0, 0, n);
    weightedSum.fill(0, 0, n);
    weightTotal.fill(0, 0, n);
    radarCount.fill(0, 0, n);
    stationOf.fill(-1, 0, n);
    stationVal.fill(0, 0, n);
    stationWeight.fill(0, 0, n);
    peakStation.fill(-1, 0, n);
    newestEchoTime.fill(-Infinity, 0, n);
    newestEchoVal.fill(0, 0, n);
    let touched = false;

    for (const g of preps) {
      if (!g) continue;
      const s = g.s;
      const f = s.field;
      const cx = s.cropW / 2;
      const cy = s.cropH / 2;
      const range = s.rangeKm;
      const inner = s.innerKm;
      const square = s.square;

      for (let y = Math.max(yb, g.y0); y <= Math.min(ye - 1, g.y1); y++) {
        const lat = maxLat - (y / (outH - 1)) * latSpan;
        if (lat < s.south || lat > s.north) continue;
        const dLat = (lat - s.station.lat) * 111.32;
        const v = (s.north - lat) / (s.north - s.south);
        const fy = v * (s.cropH - 1);
        const yA = Math.floor(fy);
        const yB = Math.min(yA + 1, s.cropH - 1);
        const wy = fy - yA;
        // the source columns that have echo in the two rows this row reads; nothing to do when neither row has any
        let spanMin = g.rowMin[yA];
        let spanMax = g.rowMax[yA];
        if (g.rowMin[yB] >= 0) {
          spanMin = spanMin < 0 ? g.rowMin[yB] : Math.min(spanMin, g.rowMin[yB]);
          spanMax = Math.max(spanMax, g.rowMax[yB]);
        }
        if (spanMin < 0) continue;
        const xFrom = firstColumn(g.xB, g.x0, g.x1, spanMin);           // first output column whose right neighbour reaches the echo
        const xTo = firstColumn(g.xA, g.x0, g.x1, spanMax + 1) - 1;     // last output column whose left neighbour is not past it
        const rowOffset = (y - yb) * outW;

        for (let x = xFrom; x <= xTo; x++) {
          if (g.lngOk[x] === 0) continue;
          // the four source pixels around this point; most of the picture has no rain, so empty ones are skipped first
          const xA = g.xA[x];
          const xB = g.xB[x];
          const f00 = f[yA * s.cropW + xA];
          const f10 = f[yA * s.cropW + xB];
          const f01 = f[yB * s.cropW + xA];
          const f11 = f[yB * s.cropW + xB];
          if (f00 === 0 && f10 === 0 && f01 === 0 && f11 === 0) continue;

          // Distance to the station centre (the radar's operational range)
          const dLng = g.dLng[x];
          // the PPI is a square picture (its corners are kept), every other product a circle
          const distKm = square ? Math.max(Math.abs(dLat), Math.abs(dLng)) : Math.sqrt(dLat * dLat + dLng * dLng);
          if (distKm > range || (inner > 0 && distKm <= inner)) continue;
          const fx = g.fx[x];
          const cDist = square ? Math.max(Math.abs(fx - cx), Math.abs(fy - cy)) : Math.sqrt((fx - cx) * (fx - cx) + (fy - cy) * (fy - cy));
          // the picture's last pixels are its border; an inner ring of the stack reads to its range, where the next ring takes over
          if (cDist > (s.feather ? cx - 2 : cx)) continue;

          // Bilinear sample from the station field
          const wx = g.wx[x];
          let val = (f00 * (1 - wx) + f10 * wx) * (1 - wy) + (f01 * (1 - wx) + f11 * wx) * wy;

          // Smooth dish edge feathering so range boundaries never show seams
          const dishEdgeDist = (cx - 2) - cDist;
          if (s.feather && dishEdgeDist < 8) val *= Math.max(0, dishEdgeDist / 8);

          if (val > 0) {
            const i = rowOffset + x;
            if (stationOf[i] !== s.stationIndex) {
              commit(i); // the previous station is finished at this pixel
              stationOf[i] = s.stationIndex;
              stationVal[i] = 0;
              // weighted by distance from its radar: 1 at the radar, 0.1 at the edge of its range
              stationWeight[i] = Math.max(0.1, 1 - distKm / s.rangeKm);
            }
            if (val > stationVal[i]) stationVal[i] = val;
            touched = true;
          }
        }
      }
    }
    if (!touched) continue;

    for (let i = 0; i < n; i++) commit(i); // settle the last station at every pixel

    // 4. The composite (the GPU layer does the colouring, from the intensity)
    const base = yb * outW;
    for (let i = 0; i < n; i++) {
      const count = radarCount[i];
      if (count === 0) continue;

      // Where radars overlap, the strongest echo of any of them (this is a maximum-reflectivity picture: the column maximum of the
      // combined volume is the larger of the two), never a blend, so no cell is weaker than on either radar's own picture
      compositeField[base + i] = peak[i];

      // an echo from a scan older than another radar's that covers this place is drawn fainter (see OVERLAP_STALE_MIN)
      const peakTime = peakStation[i] >= 0 ? timeOf[peakStation[i]] : NaN;
      if (!(peakTime < newestScan - staleMs)) continue; // the newest there is, or its time is not known
      const x = i % outW;
      const y = yb + Math.floor(i / outW);
      const lat = maxLat - (y / (outH - 1)) * latSpan;
      const lng = minLng + (x / (outW - 1)) * lngSpan;
      let coverTime = -Infinity;
      let cover = 0;
      for (const s of timed) {
        if (!(s.timeMs > peakTime + staleMs)) continue;
        const dLat = (lat - s.station.lat) * 111.32;
        const dLng = (lng - s.station.lng) * 111.32 * s.cosLat;
        const dist = s.square ? Math.max(Math.abs(dLat), Math.abs(dLng)) : Math.sqrt(dLat * dLat + dLng * dLng);
        if (s.innerKm > 0 && dist <= s.innerKm) continue; // that place is its station's inner ring's
        const c = Math.min(1, (s.rangeKm - dist) / OVERLAP_FADE_EDGE_KM);
        if (c <= 0) continue;
        if (s.timeMs > coverTime) coverTime = s.timeMs;
        if (c > cover) cover = c;
      }
      if (cover <= 0) continue;
      const f = overlapFade(peak[i], peakTime, coverTime, newestEchoTime[i] >= coverTime - staleMs ? newestEchoVal[i] : 0, cover);
      if (f >= 1) continue;
      if (!fade) fade = new Uint8Array(total).fill(255);
      fade[base + i] = Math.round(f * 255);
    }
  }

  const result: ProcessedRadarResult = {
    stationId: 'composite-mosaic',
    dataUrl: '',
    displayField: quantizeRadarField(compositeField),
    ...(fade ? { displayFade: fade } : {}),
    coordinates: [
      [minLng, maxLat], // NW
      [maxLng, maxLat], // NE
      [maxLng, minLat], // SE
      [minLng, minLat]  // SW
    ],
    fieldData: {
      field: compositeField,
      cropW: outW,
      cropH: outH,
      cx: outW / 2,
      cy: outH / 2,
      radius: Math.hypot(outW, outH) / 2,
      bounds: [[minLat, minLng], [maxLat, maxLng]]
    },
    timing: latestTiming,
    isDisplayed: true
  };

  return result;
}

/**
 * The opacity (0..1) of an echo of strength `peak` from a scan at `peakTime`, where a radar that scanned at `coverTime` (later) covers the
 * place and saw `fresh` there (0: dry). One scan behind it is OVERLAP_FADE_ONE_SCAN, fading on to OVERLAP_FADE_OLDEST at
 * OVERLAP_FADE_OLDEST_MIN older; where the newer radar sees rain too the echo fades less (it is still there). `cover` (0..1) eases the
 * fade in from the edge of the newer radar's range.
 */
export function overlapFade(peak: number, peakTime: number, coverTime: number, fresh: number, cover: number): number {
  const olderMin = (coverTime - peakTime) / 60_000;
  if (!(olderMin > OVERLAP_STALE_MIN) || peak <= 0) return 1;
  const k = Math.min(1, Math.max(0, (olderMin - 10) / (OVERLAP_FADE_OLDEST_MIN - 10)));
  const floor = OVERLAP_FADE_ONE_SCAN + (OVERLAP_FADE_OLDEST - OVERLAP_FADE_ONE_SCAN) * k;
  const target = floor + (1 - floor) * Math.min(1, fresh / peak);
  return 1 + (target - 1) * Math.min(1, Math.max(0, cover));
}
