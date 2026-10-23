import type { Map as MapLibreMap, ImageSource } from 'maplibre-gl';

/**
 * A light grey over the map wherever no working radar reaches (the owner, 23 Oct: "make the uncovered areas a little grey so we will know
 * where the radar coverage is"): a picture over South Asia, grey outside every working radar's range for the product on the map, clear
 * inside. A radar that is down, too old or turned off leaves its ground grey too. Drawn under the echoes.
 */
export const REACH_LAYER_ID = 'radar-reach';

/** The picture's box (degrees): all of India and its seas, with room around. */
export const REACH_BOX = { west: 55, east: 110, south: -5, north: 42 };
/** Its width in pixels (about 3 km a pixel; the edges are smooth at any zoom with linear resampling). */
const REACH_WIDTH = 2000;
/** The grey: a little, so the map stays readable under it. */
export const REACH_GREY = 'rgba(120, 124, 132, 0.38)';

export interface ReachDisc {
  lat: number;
  lng: number;
  rangeKm: number;
}

const EARTH_KM = 40_075.017;
const mercX = (lng: number): number => (lng + 180) / 360;
const mercY = (lat: number): number => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

/** The picture's size, and each disc as a circle in its pixels (Mercator is conformal, so a range circle stays a circle). */
export function reachGeometry(discs: readonly ReachDisc[], width = REACH_WIDTH): { width: number; height: number; circles: { x: number; y: number; r: number }[] } {
  const x0 = mercX(REACH_BOX.west), x1 = mercX(REACH_BOX.east);
  const y0 = mercY(REACH_BOX.north), y1 = mercY(REACH_BOX.south);
  const perPx = (x1 - x0) / width;
  const height = Math.round((y1 - y0) / perPx);
  const circles = discs.map(d => ({
    x: (mercX(d.lng) - x0) / perPx,
    y: (mercY(d.lat) - y0) / perPx,
    r: d.rangeKm / (EARTH_KM * Math.cos((d.lat * Math.PI) / 180)) / perPx,
  }));
  return { width, height, circles };
}

/** The grey picture as a PNG address, or null where there is no canvas. */
export function drawReach(discs: readonly ReachDisc[]): string | null {
  if (typeof document === 'undefined') return null;
  const g = reachGeometry(discs);
  const canvas = document.createElement('canvas');
  canvas.width = g.width;
  canvas.height = g.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = REACH_GREY;
  ctx.fillRect(0, 0, g.width, g.height);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000';
  for (const c of g.circles) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r, 0, 2 * Math.PI);
    ctx.fill();
  }
  return canvas.toDataURL('image/png');
}

const CORNERS: [[number, number], [number, number], [number, number], [number, number]] = [
  [REACH_BOX.west, REACH_BOX.north],
  [REACH_BOX.east, REACH_BOX.north],
  [REACH_BOX.east, REACH_BOX.south],
  [REACH_BOX.west, REACH_BOX.south],
];

/** Puts the grey on the map (or updates it), or takes it off when url is null. `before`: the layer it goes under (the echoes). */
export function syncReachLayer(map: MapLibreMap, url: string | null, before: string | undefined): void {
  if (!url) {
    if (map.getLayer(REACH_LAYER_ID)) map.removeLayer(REACH_LAYER_ID);
    if (map.getSource(REACH_LAYER_ID)) map.removeSource(REACH_LAYER_ID);
    return;
  }
  const source = map.getSource(REACH_LAYER_ID) as ImageSource | undefined;
  if (source) source.updateImage({ url, coordinates: CORNERS });
  else map.addSource(REACH_LAYER_ID, { type: 'image', url, coordinates: CORNERS });
  if (!map.getLayer(REACH_LAYER_ID)) {
    map.addLayer(
      { id: REACH_LAYER_ID, type: 'raster', source: REACH_LAYER_ID, paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } },
      before && map.getLayer(before) ? before : undefined,
    );
  }
}
