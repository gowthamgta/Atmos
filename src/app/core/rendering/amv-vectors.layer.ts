import type { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import type { AmvGeoJson, AmvVectorProperties, AmvStyle } from '../satellite/amv.service';

export const AMV_SOURCE_ID = 'amv-vectors-source';
export const AMV_SYMBOLS_LAYER_ID = 'amv-vectors-symbols';

/** Generate clean, thin directional wind arrow (slender shaft + aerodynamic arrowhead) */
function createArrowImageData(): ImageData {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const cx = 16;
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 1. Thin, straight shaft
  ctx.beginPath();
  ctx.moveTo(cx, 27);
  ctx.lineTo(cx, 6);
  ctx.stroke();

  // 2. Slender arrowhead wings pointing in flow direction
  ctx.beginPath();
  ctx.moveTo(cx - 5, 13);
  ctx.lineTo(cx, 5);
  ctx.lineTo(cx + 5, 13);
  ctx.stroke();

  return ctx.getImageData(0, 0, size, size);
}

/**
 * Generate standard meteorological wind barb with 5-kt half-barb, 10-kt full-barb, 50-kt pennant.
 * Designed with clean line separation and slender strokes so barbs never blur or clutter.
 * Base is pinned at (cx, cy) = (22, 22) for exact rotation around the station grid point.
 */
function createBarbImageData(speedKt: number): ImageData {
  const size = 44;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const cx = 22;
  const cy = 22; // Base pinned at center for rotation around station
  const tipY = 3;
  const s = Math.round(speedKt / 5) * 5;

  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (s < 3) {
    // Calm circle centered at (cx, cy)
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, 2 * Math.PI);
    ctx.lineWidth = 1.25;
    ctx.stroke();
    return ctx.getImageData(0, 0, size, size);
  }

  // Slender main staff extending upwind
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, tipY);
  ctx.stroke();

  const pennants = Math.floor(s / 50);
  const rem = s % 50;
  const fullBarbs = Math.floor(rem / 10);
  const halfBarbs = Math.floor((rem % 10) / 5);

  let currY = tipY;
  const barbDx = 9.5;
  const barbDy = 4.5;

  for (let i = 0; i < pennants; i++) {
    ctx.beginPath();
    ctx.moveTo(cx, currY);
    ctx.lineTo(cx + barbDx, currY + barbDy);
    ctx.lineTo(cx, currY + 2 * barbDy);
    ctx.closePath();
    ctx.fill();
    currY += 2 * barbDy + 2;
  }

  for (let i = 0; i < fullBarbs; i++) {
    ctx.beginPath();
    ctx.moveTo(cx, currY);
    ctx.lineTo(cx + barbDx, currY + barbDy);
    ctx.stroke();
    currY += 4.5;
  }

  for (let i = 0; i < halfBarbs; i++) {
    if (pennants === 0 && fullBarbs === 0) {
      currY += 3.5; // offset 5-kt half barb slightly from tip
    }
    ctx.beginPath();
    ctx.moveTo(cx, currY);
    ctx.lineTo(cx + barbDx * 0.55, currY + barbDy * 0.55);
    ctx.stroke();
    currY += 4.5;
  }

  return ctx.getImageData(0, 0, size, size);
}

/** Register all barb icons (barb-0 through barb-100) and arrow in MapLibre */
function ensureAmvIcons(map: MapLibreMap): void {
  // Always update icons to ensure latest thin geometry
  try {
    if (map.hasImage('amv-arrow')) map.removeImage('amv-arrow');
    map.addImage('amv-arrow', createArrowImageData(), { sdf: true });
  } catch {}

  for (let kt = 0; kt <= 100; kt += 5) {
    const id = `barb-${kt}`;
    try {
      if (map.hasImage(id)) map.removeImage(id);
      map.addImage(id, createBarbImageData(kt), { sdf: true });
    } catch {}
  }
}

/** Keep AMV vectors on top of all underlying raster layers (satellite images, radar, terrain) */
export function ensureAmvOnTop(map: MapLibreMap): void {
  if (map && map.getLayer(AMV_SYMBOLS_LAYER_ID)) {
    try {
      map.moveLayer(AMV_SYMBOLS_LAYER_ID);
    } catch {
      // ignore if context not ready
    }
  }
}

/** Synchronize AMV GeoJSON data and layers on the MapLibre map */
export function syncAmvLayer(
  map: MapLibreMap,
  geoJson: AmvGeoJson | null,
  visible: boolean,
  style: AmvStyle = 'barbs',
  _beforeLayerId?: string,
  onHover?: (props: AmvVectorProperties | null) => void
): void {
  if (!map) return;

  // Register wind barbs and arrow icons
  ensureAmvIcons(map);

  // Remove legacy circle layer if it exists
  if (map.getLayer('amv-vectors-circles')) {
    try {
      map.removeLayer('amv-vectors-circles');
    } catch {}
  }

  const existingSource = map.getSource(AMV_SOURCE_ID) as GeoJSONSource | undefined;
  const emptyGeoJson: AmvGeoJson = { type: 'FeatureCollection', time: '', count: 0, features: [] };
  const data = (visible && geoJson) ? geoJson : emptyGeoJson;

  if (existingSource) {
    existingSource.setData(data as any);
  } else {
    map.addSource(AMV_SOURCE_ID, {
      type: 'geojson',
      data: data as any
    });
  }

  const isBarbs = style === 'barbs';

  const iconImageExpr: any = isBarbs
    ? ['coalesce', ['get', 'barb_id'], 'barb-10']
    : 'amv-arrow';

  // Rotation: Barbs point upwind (dir deg), Arrows point downwind / flow (dir + 180 deg)
  const iconRotateExpr: any = isBarbs
    ? ['get', 'dir']
    : ['+', ['get', 'dir'], 180];

  const iconSizeExpr: any = isBarbs
    ? 0.85
    : [
        'interpolate', ['linear'], ['get', 'speed'],
        3, 0.65,
        15, 0.85,
        35, 1.05
      ];

  const speedKtExpr: any = ['coalesce', ['get', 'speed_kt'], ['*', ['get', 'speed'], 1.94384]];

  // Speed-based color gradient: Black (<10 kt) -> Green (10-20 kt) -> Yellow (20-30 kt) -> Orange (30-40 kt) -> Red (>=40 kt)
  const arrowSpeedColorExpr: any = [
    'step',
    speedKtExpr,
    '#0f172a',       // < 10 kt: Black / deep charcoal
    10.0, '#00e676', // 10-20 kt: Green
    20.0, '#ffea00', // 20-30 kt: Yellow
    30.0, '#ff9100', // 30-40 kt: Orange
    40.0, '#ff1744'  // >= 40 kt: Red
  ];

  const iconColorExpr: any = isBarbs
    ? ['case', ['>=', speedKtExpr, 20.0], '#00e676', '#cbd5e1']
    : arrowSpeedColorExpr;

  // Halo: white halo for black arrows (<10 kt) so they stay crisp on dark ocean/night map;
  // dark halo (#000000) for bright colored arrows to pop against white satellite clouds.
  const iconHaloColorExpr: any = [
    'case',
    ['<', speedKtExpr, 10.0],
    'rgba(255, 255, 255, 0.90)',
    '#000000'
  ];
  const iconHaloWidth: number = 1.2;

  if (!map.getLayer(AMV_SYMBOLS_LAYER_ID)) {
    const symbolSpec: any = {
      id: AMV_SYMBOLS_LAYER_ID,
      type: 'symbol',
      source: AMV_SOURCE_ID,
      layout: {
        visibility: visible ? 'visible' : 'none',
        'icon-image': iconImageExpr,
        'icon-size': iconSizeExpr,
        'icon-rotate': iconRotateExpr,
        'icon-rotation-alignment': 'map',
        // Collision prevention: keeps barbs cleanly spaced and simple without chaotic overlapping
        'icon-allow-overlap': false,
        'icon-ignore-placement': false,
        'icon-padding': 3,
        // Sort key: gale and strong winds get display placement priority
        'symbol-sort-key': ['-', 1000, ['coalesce', ['get', 'speed_kt'], ['*', ['get', 'speed'], 1.94384]]]
      },
      paint: {
        'icon-color': iconColorExpr,
        'icon-halo-color': iconHaloColorExpr,
        'icon-halo-width': iconHaloWidth,
        'icon-opacity': 0.95
      }
    };

    map.addLayer(symbolSpec);

    if (onHover) {
      map.on('mousemove', AMV_SYMBOLS_LAYER_ID, (e: any) => {
        const feat = e.features?.[0];
        if (feat && feat.properties) {
          map.getCanvas().style.cursor = 'pointer';
          onHover(feat.properties as any);
        }
      });
      map.on('mouseleave', AMV_SYMBOLS_LAYER_ID, () => {
        map.getCanvas().style.cursor = '';
        onHover(null);
      });
    }
  } else {
    map.setLayoutProperty(AMV_SYMBOLS_LAYER_ID, 'visibility', visible ? 'visible' : 'none');
    map.setLayoutProperty(AMV_SYMBOLS_LAYER_ID, 'icon-image', iconImageExpr);
    map.setLayoutProperty(AMV_SYMBOLS_LAYER_ID, 'icon-rotate', iconRotateExpr);
    map.setLayoutProperty(AMV_SYMBOLS_LAYER_ID, 'icon-size', iconSizeExpr);
    map.setLayoutProperty(AMV_SYMBOLS_LAYER_ID, 'icon-allow-overlap', false);
    map.setLayoutProperty(AMV_SYMBOLS_LAYER_ID, 'icon-ignore-placement', false);
    map.setLayoutProperty(AMV_SYMBOLS_LAYER_ID, 'icon-padding', 3);
    map.setPaintProperty(AMV_SYMBOLS_LAYER_ID, 'icon-color', iconColorExpr);
    map.setPaintProperty(AMV_SYMBOLS_LAYER_ID, 'icon-halo-color', iconHaloColorExpr);
    map.setPaintProperty(AMV_SYMBOLS_LAYER_ID, 'icon-halo-width', iconHaloWidth);
  }

  if (visible) {
    ensureAmvOnTop(map);
  }
}
