import type { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import type { AmvGeoJson, AmvVectorProperties } from '../satellite/amv.service';

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
  // Right wing
  ctx.lineTo(24, 13);
  // Right inner barb
  ctx.lineTo(18, 11);
  // Right shaft down to bottom
  ctx.lineTo(18, 29);
  // Shaft base
  ctx.lineTo(14, 29);
  // Left shaft up
  ctx.lineTo(14, 11);
  // Left wing
  ctx.lineTo(8, 13);
  ctx.closePath();
  ctx.fill();

  return ctx.getImageData(0, 0, size, size);
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
  _beforeLayerId?: string,
  onHover?: (props: AmvVectorProperties | null) => void
): void {
  if (!map) return;

  // Ensure directional arrow icon is registered
  if (!map.hasImage('amv-arrow')) {
    try {
      map.addImage('amv-arrow', createArrowImageData(), { sdf: true });
    } catch {
      // already added or context not ready
    }
  }

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

  // Add rotated arrow symbol layer on top if missing
  if (!map.getLayer(AMV_SYMBOLS_LAYER_ID)) {
    const symbolSpec: any = {
      id: AMV_SYMBOLS_LAYER_ID,
      type: 'symbol',
      source: AMV_SOURCE_ID,
      layout: {
        visibility: visible ? 'visible' : 'none',
        'icon-image': 'amv-arrow',
        'icon-size': [
          'interpolate', ['linear'], ['get', 'speed'],
          3, 0.50,
          15, 0.75,
          35, 1.10
        ],
        // Flow direction: arrow points in the direction the wind/cloud is traveling
        'icon-rotate': ['+', ['get', 'dir'], 180],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true
      },
      paint: {
        'icon-color': [
          'match',
          ['get', 'layer'],
          'high', '#00e5ff',
          'mid', '#00e676',
          'low', '#ff9100',
          '#ffffff'
        ],
        'icon-halo-color': '#000000',
        'icon-halo-width': 1.5,
        'icon-opacity': 0.95
      }
    };

    // Add directly to top so satellite image raster never covers the vectors
    map.addLayer(symbolSpec);

    // Attach hover listener directly to the arrows
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
  }

  if (visible) {
    ensureAmvOnTop(map);
  }
}
