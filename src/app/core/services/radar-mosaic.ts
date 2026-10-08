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

/** One station's scan being composed: where it lies and its intensity field. */
interface ActiveStation {
  station: RadarStationConfig;
  stationIndex: number;
  rangeKm: number;
  res: ProcessedRadarResult;
  south: number;
  west: number;
  north: number;
  east: number;
  cropW: number;
  cropH: number;
  field: Float32Array;
  cosLat: number;
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
  let any = false;
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
    if (lo >= 0) any = true;
  }
  if (!any) return null;
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
 * One picture from every station's scan. Keys are station ids; every scan is of `defaultProduct`, whose range sets how far
 * each station's scan reaches.
 */
export function composeRadarMosaic(
  stations: readonly RadarStationConfig[],
  allResults: Iterable<[string, ProcessedRadarResult]>,
  kmPerPixel = MOSAIC_KM_PER_PX,
  maxPixels = 2800,
  defaultProduct: RadarProductKey = 'caz',
  /** When set, scans whose timestamp is more than MAX_SCAN_AGE_MIN before this time are left out (live view only). */
  nowMs?: number,
): ProcessedRadarResult | null {

  const activeStations: ActiveStation[] = [];

  let latestTiming: RadarObservationTiming | null = null;

  for (const [stId, res] of allResults) {
    if (res.isDisplayed === false || !res.fieldData) continue;
    if (nowMs != null && res.timing?.epochMs && nowMs - res.timing.epochMs > MAX_SCAN_AGE_MIN * 60_000) continue;
    const stationIndex = stations.findIndex(s => s.id === stId);
    if (stationIndex < 0) continue;
    const st = stations[stationIndex];

    const b = res.fieldData.bounds;
    activeStations.push({
      station: st,
      stationIndex,
      rangeKm: st.products[defaultProduct]?.rangeKm ?? st.operationalRangeKm,
      res,
      south: b[0][0],
      west: b[0][1],
      north: b[1][0],
      east: b[1][1],
      cropW: res.fieldData.cropW,
      cropH: res.fieldData.cropH,
      field: res.fieldData.field,
      cosLat: Math.cos((st.lat * Math.PI) / 180)
    });

    if (res.timing && (!latestTiming || (res.timing.epochMs && (!latestTiming.epochMs || res.timing.epochMs > latestTiming.epochMs)))) {
      latestTiming = res.timing;
    }
  }

  if (activeStations.length === 0) return null;
  // the stations one after another, so each pixel can settle one station before the next
  activeStations.sort((a, b) => a.stationIndex - b.stationIndex);

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
  const commit = (i: number): void => {
    const v = stationVal[i];
    if (stationOf[i] < 0 || v <= 0) return;
    if (v > peak[i]) peak[i] = v;
    weightedSum[i] += v * stationWeight[i];
    weightTotal[i] += stationWeight[i];
    radarCount[i]++;
  };

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
    let touched = false;

    for (const g of preps) {
      if (!g) continue;
      const s = g.s;
      const f = s.field;
      const cx = s.cropW / 2;
      const cy = s.cropH / 2;
      const range = s.rangeKm;

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
          const distKm = Math.sqrt(dLat * dLat + dLng * dLng);
          if (distKm > range) continue;
          const fx = g.fx[x];
          const cDist = Math.sqrt((fx - cx) * (fx - cx) + (fy - cy) * (fy - cy));
          if (cDist > cx - 2) continue;

          // Bilinear sample from the station field
          const wx = g.wx[x];
          let val = (f00 * (1 - wx) + f10 * wx) * (1 - wy) + (f01 * (1 - wx) + f11 * wx) * wy;

          // Smooth dish edge feathering so range boundaries never show seams
          const dishEdgeDist = (cx - 2) - cDist;
          if (dishEdgeDist < 8) val *= Math.max(0, dishEdgeDist / 8);

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

    // 4. Merge overlapping radars (the GPU layer does the colouring, from the merged intensity)
    const base = yb * outW;
    for (let i = 0; i < n; i++) {
      const count = radarCount[i];
      if (count === 0) continue;

      let mergedVal = peak[i];
      if (count > 1) {
        // Merge overlapping radars: preserve peak storm core while smoothly blending surrounding contours
        const avgVal = weightTotal[i] > 0 ? weightedSum[i] / weightTotal[i] : peak[i];
        mergedVal = 0.80 * peak[i] + 0.20 * avgVal;
      }

      compositeField[base + i] = mergedVal;
    }
  }

  const result: ProcessedRadarResult = {
    stationId: 'composite-mosaic',
    dataUrl: '',
    displayField: quantizeRadarField(compositeField),
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

