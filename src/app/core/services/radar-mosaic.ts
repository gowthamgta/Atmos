/**
 * Merging radar scans into one picture (pure, so it can be tested).
 *
 * Each source is a processed scan of one station and product: an intensity field on that scan's own square, with its
 * geographic bounds. A station's scans (CAZ and PPZ) are merged by taking the strongest value, so the picture reaches
 * as far as the furthest scan and keeps the near-range detail of the other; the stations are then blended where they
 * overlap, keeping storm cores. PPI is displayed separately.
 */
import type { ProcessedRadarResult, RadarObservationTiming, RadarProductKey, RadarStationConfig } from '../domain/models/radar.model';
import { quantizeRadarField } from './radar-field';

/** The live scans merged into the one composite picture: CAZ (column maximum, 250 km) and PPZ (reflectivity Z, 150 km).
 *  Where both see rain the strongest value wins. PPI is available as a separate scan menu. */
export const MERGED_PRODUCTS: readonly RadarProductKey[] = ['caz', 'ppz'];

/** PPZ is merged with CAZ only when the two scans of a station are less than this many minutes apart. */
export const MAX_MERGE_GAP_MIN = 20;

/** A live scan older than this many minutes is not drawn (the radar is stale or stuck, the picture would mislead). */
export const MAX_SCAN_AGE_MIN = 45;

/** Resolution of the composite: 0.5 km per pixel. */
export const MOSAIC_KM_PER_PX = 0.5;

/**
 * One picture from every station's scans. Keys are `stationId` (CAZ) or `stationId:product`.
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

  const activeStations: {
    station: RadarStationConfig;
    stationIndex: number;
    productOrder: number;
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
  }[] = [];

  let latestTiming: RadarObservationTiming | null = null;

  for (const [key, res] of allResults) {
    if (res.isDisplayed === false || !res.fieldData) continue;
    if (nowMs != null && res.timing?.epochMs && nowMs - res.timing.epochMs > MAX_SCAN_AGE_MIN * 60_000) continue;
    const [stId, prodSuffix] = key.split(':') as [string, RadarProductKey | undefined];
    const productKey = prodSuffix || defaultProduct;
    const stationIndex = stations.findIndex(s => s.id === stId);
    if (stationIndex < 0) continue;
    const st = stations[stationIndex];

    const b = res.fieldData.bounds;
    activeStations.push({
      station: st,
      stationIndex,
      productOrder: Math.max(0, MERGED_PRODUCTS.indexOf(productKey)),
      rangeKm: st.products[productKey]?.rangeKm ?? st.operationalRangeKm,
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

  // PPZ is only merged where it is as fresh as the CAZ scan of the same station (closer than MAX_MERGE_GAP_MIN); an older
  // or newer PPZ, or one with no CAZ to compare with, is left out and CAZ stands alone.
  const cazTime = new Map<number, number | null>();
  for (const a of activeStations) if (a.productOrder === 0) cazTime.set(a.stationIndex, a.res.timing?.epochMs ?? null);
  for (let i = activeStations.length - 1; i >= 0; i--) {
    const a = activeStations[i];
    if (a.productOrder === 0) continue;
    const caz = cazTime.get(a.stationIndex);
    const own = a.res.timing?.epochMs;
    if (caz == null || own == null || Math.abs(own - caz) >= MAX_MERGE_GAP_MIN * 60_000) activeStations.splice(i, 1);
  }

  if (activeStations.length === 0) return null;
  // a station's scans one after another, widest first, so each pixel can settle one station before the next
  activeStations.sort((a, b) => a.stationIndex - b.stationIndex || a.productOrder - b.productOrder);

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

  const compositeField = new Float32Array(outW * outH);

  // 3. Composite. Each radar only visits the pixels inside its own footprint and adds its contribution to
  // per-pixel accumulators; a second pass then merges them. (Looping every pixel over every radar did the
  // same arithmetic six times over for pixels most radars cannot even see.)
  const lngSpan = maxLng - minLng;
  const latSpan = maxLat - minLat;
  const total = outW * outH;
  const peak = new Float32Array(total);        // strongest echo over this pixel
  const weightedSum = new Float32Array(total); // sum of value * distance weight
  const weightTotal = new Float32Array(total);
  const radarCount = new Uint8Array(total);    // how many radars see an echo here
  // One station's scans (CAZ, PPI, SRI) are merged by taking the strongest value before the stations are blended:
  // the running best of the station being drawn at each pixel, which station it belongs to, and its distance weight.
  const stationOf = new Int16Array(total).fill(-1);
  const stationVal = new Float32Array(total);
  const stationWeight = new Float32Array(total);
  const commit = (i: number): void => {
    const v = stationVal[i];
    if (stationOf[i] < 0 || v <= 0) return;
    if (v > peak[i]) peak[i] = v;
    weightedSum[i] += v * stationWeight[i];
    weightTotal[i] += stationWeight[i];
    radarCount[i]++;
  };

  for (const s of activeStations) {
    const x0 = Math.max(0, Math.floor(((s.west - minLng) / lngSpan) * (outW - 1)));
    const x1 = Math.min(outW - 1, Math.ceil(((s.east - minLng) / lngSpan) * (outW - 1)));
    const y0 = Math.max(0, Math.floor(((maxLat - s.north) / latSpan) * (outH - 1)));
    const y1 = Math.min(outH - 1, Math.ceil(((maxLat - s.south) / latSpan) * (outH - 1)));
    const f = s.field;
    const cx = s.cropW / 2;
    const cy = s.cropH / 2;
    const range = s.rangeKm;

    for (let y = y0; y <= y1; y++) {
      const lat = maxLat - (y / (outH - 1)) * latSpan;
      if (lat < s.south || lat > s.north) continue;
      const dLat = (lat - s.station.lat) * 111.32;
      const v = (s.north - lat) / (s.north - s.south);
      const fy = v * (s.cropH - 1);
      const yA = Math.floor(fy);
      const yB = Math.min(yA + 1, s.cropH - 1);
      const wy = fy - yA;
      const rowOffset = y * outW;

      for (let x = x0; x <= x1; x++) {
        const lng = minLng + (x / (outW - 1)) * lngSpan;
        if (lng < s.west || lng > s.east) continue;

        // Normalised coordinates in the station crop, and the four source pixels around this point. Most of the picture
        // has no rain, so empty ones are skipped before any distance maths.
        const fx = ((lng - s.west) / (s.east - s.west)) * (s.cropW - 1);
        const xA = Math.floor(fx);
        const xB = Math.min(xA + 1, s.cropW - 1);
        const f00 = f[yA * s.cropW + xA];
        const f10 = f[yA * s.cropW + xB];
        const f01 = f[yB * s.cropW + xA];
        const f11 = f[yB * s.cropW + xB];
        if (f00 === 0 && f10 === 0 && f01 === 0 && f11 === 0) continue;

        // Distance to the station centre (the radar's operational range)
        const dLng = (lng - s.station.lng) * 111.32 * s.cosLat;
        const distKm = Math.sqrt(dLat * dLat + dLng * dLng);
        if (distKm > range) continue;
        const cDist = Math.sqrt((fx - cx) * (fx - cx) + (fy - cy) * (fy - cy));
        if (cDist > cx - 2) continue;

        // Bilinear sample from the station field
        const wx = fx - xA;
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
            // weighted by the widest scan's distance (CAZ, the first one drawn for this station)
            stationWeight[i] = Math.max(0.1, 1 - distKm / s.rangeKm);
          }
          if (val > stationVal[i]) stationVal[i] = val;
        }
      }
    }
  }

  for (let i = 0; i < total; i++) commit(i); // settle the last station at every pixel

  // 4. Merge overlapping radars (the GPU layer does the colouring, from the merged intensity)
  for (let i = 0; i < total; i++) {
    const count = radarCount[i];
    if (count === 0) continue;

    let mergedVal = peak[i];
    if (count > 1) {
      // Merge overlapping radars: preserve peak storm core while smoothly blending surrounding contours
      const avgVal = weightTotal[i] > 0 ? weightedSum[i] / weightTotal[i] : peak[i];
      mergedVal = 0.80 * peak[i] + 0.20 * avgVal;
    }

    compositeField[i] = mergedVal;
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

