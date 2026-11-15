import type { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import type { AmvGeoJson, AmvVectorProperties, AmvStyle } from '../satellite/amv.service';

export const AMV_SOURCE_ID = 'amv-vectors-source';
export const AMV_SYMBOLS_LAYER_ID = 'amv-vectors-symbols';

/** Generate clean directional wind arrow with shaft and arrowhead (pointing UP/forward, 0 deg) */
function createArrowImageData(): ImageData {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  // Arrowhead tip at top center (pointing in direction of flow)
  ctx.moveTo(16, 2);
  ctx.lineTo(24, 13);
  ctx.lineTo(18, 11);
  ctx.lineTo(18, 29);
  ctx.lineTo(14, 29);
  ctx.lineTo(14, 11);
  ctx.lineTo(8, 13);
  ctx.closePath();
  ctx.fill();

  return ctx.getImageData(0, 0, size, size);
}

/**
 * Generate standard meteorological wind barb with 5-kt half-barb, 10-kt full-barb, 50-kt pennant.
 * The staff base is centered at (cx, cy) = (18, 18) for pinpoint rotation around the grid point.
 * Feathers point to the right (upwind Northern Hemisphere convention), matching operational charts.
 */
function createBarbImageData(speedKt: number): ImageData {
  const size = 36;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const cx = 18;
  const cy = 18; // Base pinned at center for rotation around station
  const tipY = 3;
  const s = Math.round(speedKt / 5) * 5;

  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (s < 3) {
    // Calm circle centered at (cx, cy)
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, 2 * Math.PI);
    ctx.stroke();
    return ctx.getImageData(0, 0, size, size);
  }

  // Main staff extending upwind
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, tipY);
  ctx.stroke();

  const pennants = Math.floor(s / 50);
  const rem = s % 50;
  const fullBarbs = Math.floor(rem / 10);
  const halfBarbs = Math.floor((rem % 10) / 5);

  let currY = tipY;
  const barbDx = 9;
  const barbDy = 4;

  for (let i = 0; i < pennants; i++) {
    ctx.beginPath();
    ctx.moveTo(cx, currY);
    ctx.lineTo(cx + barbDx, currY + barbDy);
    ctx.lineTo(cx, currY + 2 * barbDy);
    ctx.closePath();
    ctx.fill();
    currY += 2 * barbDy + 1;
  }

  for (let i = 0; i < fullBarbs; i++) {
    ctx.beginPath();
    ctx.moveTo(cx, currY);
    ctx.lineTo(cx + barbDx, currY + barbDy);
    ctx.stroke();
    currY += 3.5;
  }

  for (let i = 0; i < halfBarbs; i++) {
    if (pennants === 0 && fullBarbs === 0) {
      currY += 3; // offset 5-kt half barb slightly from tip
    }
    ctx.beginPath();
    ctx.moveTo(cx, currY);
    ctx.lineTo(cx + barbDx * 0.55, currY + barbDy * 0.55);
    ctx.stroke();
    currY += 3.5;
  }

  return ctx.getImageData(0, 0, size, size);
}

/** Register all barb icons (barb-0 through barb-100) and arrow in MapLibre */
function ensureAmvIcons(map: MapLibreMap): void {
  if (!map.hasImage('amv-arrow')) {
    try {
      map.addImage('amv-arrow', createArrowImageData(), { sdf: true });
    } catch {}
  }

  for (let kt = 0; kt <= 100; kt += 5) {
    const id = `barb-${kt}`;
    if (!map.hasImage(id)) {
      try {
        map.addImage(id, createBarbImageData(kt), { sdf: true });
      } catch {}
    }
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
    ? 0.90
    : [
        'interpolate', ['linear'], ['get', 'speed'],
        3, 0.50,
        15, 0.75,
        35, 1.10
      ];

  // Coloring:
  // In Barbs mode: >= 20 kt is green (#00e676), < 20 kt is dark slate (#334155) matching reference image
  // In Arrows mode: High (<400 hPa) is cyan, Mid (400-700) is green, Low (>700) is orange
  const iconColorExpr: any = isBarbs
    ? ['case', ['>=', ['coalesce', ['get', 'speed_kt'], ['*', ['get', 'speed'], 1.94384]], 20.0], '#00e676', '#334155']
    : [
        'match',
        ['get', 'layer'],
        'high', '#00e5ff',
        'mid', '#00e676',
        'low', '#ff9100',
        '#ffffff'
      ];

  const iconHaloColorExpr: any = isBarbs
    ? 'rgba(255, 255, 255, 0.95)'
    : '#000000';

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
        'icon-allow-overlap': true,
        'icon-ignore-placement': true
      },
      paint: {
        'icon-color': iconColorExpr,
        'icon-halo-color': iconHaloColorExpr,
        'icon-halo-width': 1.5,
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
    map.setPaintProperty(AMV_SYMBOLS_LAYER_ID, 'icon-color', iconColorExpr);
    map.setPaintProperty(AMV_SYMBOLS_LAYER_ID, 'icon-halo-color', iconHaloColorExpr);
    map.setPaintProperty(AMV_SYMBOLS_LAYER_ID, 'icon-halo-width', 1.5);
  }

  if (visible) {
    ensureAmvOnTop(map);
  }
}
