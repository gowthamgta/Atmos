import type { ProcessedRadarResult, RadarHoverInfo, RadarProductKey, RadarStationConfig } from '../domain/models/radar.model';
import { dequantizeRadar } from './radar-field';
import { LOWEST_SWEEP_DEG, beamsOverPlace, isRainAloft } from './radar-beam';
import type { RadarDisplayFrame } from './radar.service';

/** What the inspector reads: the picture on screen (or, before there is one, each radar's own), and which radars are on. */
export interface RadarInspectInput {
  shown: RadarDisplayFrame | null;
  allResults: ReadonlyMap<string, ProcessedRadarResult>;
  stations: readonly RadarStationConfig[];
  hidden: ReadonlySet<string>;
  unavailable: ReadonlySet<string>;
  product: RadarProductKey;
}

/**
 * The readout under the pointer: the echo (dBZ, rain rate, label; "rain aloft" where only a high beam sees it) and how high each radar's beam
 * passes there, or null outside every radar's picture.
 */
export function inspectRadar(input: RadarInspectInput, lat: number, lng: number, screenPoint: { x: number; y: number }): RadarHoverInfo | null {
  let maxV = 0.0;
  let bestStation: RadarStationConfig | null = null;

  // read the picture on screen: the live mosaic, or the loop frame being played or scrubbed
  const shown = input.shown;
  if (shown) {
    const { field, width: cropW, height: cropH, coordinates } = shown;
    const maxLat = coordinates[0][1];
    const minLat = coordinates[2][1];
    const minLng = coordinates[0][0];
    const maxLng = coordinates[1][0];

    if (lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng) {
      // rows are evenly spaced in latitude, columns in longitude, first and last on the edges
      const srcX = ((lng - minLng) / (maxLng - minLng)) * (cropW - 1);
      const srcY = ((maxLat - lat) / (maxLat - minLat)) * (cropH - 1);

      if (srcX >= 0 && srcX < cropW && srcY >= 0 && srcY < cropH) {
        const x0 = Math.floor(srcX);
        const x1 = Math.min(x0 + 1, cropW - 1);
        const y0 = Math.floor(srcY);
        const y1 = Math.min(y0 + 1, cropH - 1);
        const wx = srcX - x0;
        const wy = srcY - y0;

        const s00 = field[y0 * cropW + x0];
        const s10 = field[y0 * cropW + x1];
        const s01 = field[y1 * cropW + x0];
        const s11 = field[y1 * cropW + x1];
        maxV = dequantizeRadar((s00 * (1 - wx) + s10 * wx) * (1 - wy) + (s01 * (1 - wx) + s11 * wx) * wy);

        // Find closest active station for name attribution
        let minD = Infinity;
        for (const s of input.stations) {
          if (input.hidden.has(s.id)) continue;
          const d = Math.hypot((lat - s.lat) * 111.32, (lng - s.lng) * 111.32 * Math.cos((s.lat * Math.PI) / 180));
          if (d < minD) {
            minD = d;
            bestStation = s;
          }
        }
      }
    }
  } else {
    const all = input.allResults;

    for (const [stationId, res] of all) {
      if (res.isDisplayed === false || !res.fieldData || input.hidden.has(stationId)) continue;
      const { field, cropW, cropH, bounds, cx, cy, radius } = res.fieldData;
      const [southWest, northEast] = bounds;
      const minLat = southWest[0];
      const minLng = southWest[1];
      const maxLat = northEast[0];
      const maxLng = northEast[1];

      if (lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) continue;

      const normY = (maxLat - lat) / (maxLat - minLat);
      const normX = (lng - minLng) / (maxLng - minLng);
      const srcX = normX * (cropW - 1);
      const srcY = normY * (cropH - 1);

      if (srcX < 0 || srcX >= cropW || srcY < 0 || srcY >= cropH) continue;
      const dx = srcX - cx;
      const dy = srcY - cy;
      if (dx * dx + dy * dy > (radius - 2) * (radius - 2)) continue;

      const x0 = Math.floor(srcX);
      const x1 = Math.min(x0 + 1, cropW - 1);
      const y0 = Math.floor(srcY);
      const y1 = Math.min(y0 + 1, cropH - 1);
      const wx = srcX - x0;
      const wy = srcY - y0;

      const s00 = field[y0 * cropW + x0];
      const s10 = field[y0 * cropW + x1];
      const s01 = field[y1 * cropW + x0];
      const s11 = field[y1 * cropW + x1];
      const v = (s00 * (1 - wx) + s10 * wx) * (1 - wy) + (s01 * (1 - wx) + s11 * wx) * wy;

      if (v > maxV) {
        maxV = v;
        bestStation = input.stations.find(s => s.id === stationId) || null;
      }
    }
  }

  const product = input.product;
  const beams = beamsOverPlace(input.stations, product, lat, lng, id => !input.hidden.has(id) && !input.unavailable.has(id));
  const beamNote =
    product === 'caz'
      ? `Column maximum: the strongest echo from the lowest sweep (${LOWEST_SWEEP_DEG}°) upwards`
      : `Lowest sweep (${LOWEST_SWEEP_DEG}°): rain below the beam is not seen`;

  if (maxV >= 0.15 && bestStation) {
    const dbz = Math.min(65, Math.max(12, Math.round(12 + maxV * 9.6)));
    let label = 'Light Echo';
    let color = '#3ad9e4ff'; // Deep Blue
    let rate = '< 1.0 mm/h';

    if (dbz >= 55) {
      label = 'Severe Storm / Hail';
      color = '#a855f7'; // Purple
      rate = '> 50 mm/h';
    } else if (dbz >= 45) {
      label = 'Torrential Rain';
      color = '#ef4444'; // Red
      rate = '30 – 50 mm/h';
    } else if (dbz >= 36) {
      label = 'Heavy Rain';
      color = '#facc15'; // Yellow
      rate = '10 – 30 mm/h';
    } else if (dbz >= 26) {
      label = 'Moderate Rain';
      color = '#afc600ff'; // Green
      rate = '2.5 – 10 mm/h';
    } else if (dbz >= 18) {
      label = 'Light Rain';
      color = '#00a33fff'; // Sky Blue
      rate = '1.0 – 2.5 mm/h';
    } else {
      label = 'Light Echo';
      color = '#3ad9e4ff'; // Deep Blue
      rate = '< 1.0 mm/h';
    }

    const lowest = Math.min(...beams.map(b => b.centreKm));
    const aloft = beams.length > 0 && isRainAloft(dbz, lowest);
    return {
      x: screenPoint.x,
      y: screenPoint.y,
      lat,
      lng,
      dbz,
      label: aloft ? `Rain aloft (${dbz} dBZ): may not reach the ground` : `${label} (${dbz} dBZ)`,
      color,
      rate,
      beams,
      beamNote
    };
  } else if (beams.length > 0) {
    // no echo here, but inside a radar's picture: how high it looks is still worth knowing (a blank far away is not a dry sky)
    return { x: screenPoint.x, y: screenPoint.y, lat, lng, dbz: null, label: 'No echo', color: '#94a3b8', rate: '', beams, beamNote };
  } else {
    return null;
  }
}
