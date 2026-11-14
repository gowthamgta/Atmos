import type { Map as MapLibreMap, GeoJSONSource, MapMouseEvent } from 'maplibre-gl';
import type { AmvGeoJson, AmvVectorProperties } from '../satellite/amv.service';

export const AMV_SOURCE_ID = 'amv-vectors-source';
export const AMV_SYMBOLS_LAYER_ID = 'amv-vectors-symbols';
export const AMV_CIRCLES_LAYER_ID = 'amv-vectors-circles';

/** Generate clean white directional arrow icon (pointing UP, 0 deg) for MapLibre icon-image */
function createArrowImageData(): ImageData {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(16, 3);
  ctx.lineTo(25, 25);
  ctx.lineTo(16, 20);
  ctx.lineTo(7, 25);
  ctx.closePath();
  ctx.fill();

  return ctx.getImageData(0, 0, size, size);
}

/** Synchronize AMV GeoJSON data and layers on the MapLibre map */
export function syncAmvLayer(
  map: MapLibreMap,
  geoJson: AmvGeoJson | null,
  visible: boolean,
  beforeLayerId?: string,
  onHover?: (props: AmvVectorProperties | null) => void
): void {
  if (!map) return;

  // Ensure arrow icon is registered
  if (!map.hasImage('amv-arrow')) {
    try {
      map.addImage('amv-arrow', createArrowImageData(), { sdf: true });
    } catch {
      // already added or context not ready
    }
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

  // Add circle dots layer if missing
  if (!map.getLayer(AMV_CIRCLES_LAYER_ID)) {
    const layerSpec: any = {
      id: AMV_CIRCLES_LAYER_ID,
      type: 'circle',
      source: AMV_SOURCE_ID,
      layout: {
        visibility: visible ? 'visible' : 'none'
      },
      paint: {
        'circle-radius': [
          'interpolate', ['linear'], ['get', 'speed'],
          5, 2.5,
          20, 4.0,
          35, 5.5
        ],
        'circle-color': [
          'match',
          ['get', 'layer'],
          'high', '#00e5ff',
          'mid', '#00e676',
          'low', '#ff9100',
          '#ffffff'
        ],
        'circle-stroke-width': 1,
        'circle-stroke-color': '#000000',
        'circle-opacity': 0.9
      }
    };
    if (beforeLayerId && map.getLayer(beforeLayerId)) {
      map.addLayer(layerSpec, beforeLayerId);
    } else {
      map.addLayer(layerSpec);
    }
  } else {
    map.setLayoutProperty(AMV_CIRCLES_LAYER_ID, 'visibility', visible ? 'visible' : 'none');
  }

  // Add rotated arrow symbol layer if missing
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
          5, 0.45,
          15, 0.65,
          30, 0.9
        ],
        'icon-rotate': ['get', 'dir'],
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
        'icon-opacity': 0.95
      }
    };
    if (beforeLayerId && map.getLayer(beforeLayerId)) {
      map.addLayer(symbolSpec, beforeLayerId);
    } else {
      map.addLayer(symbolSpec);
    }

    // Attach hover listener
    if (onHover) {
      map.on('mousemove', AMV_CIRCLES_LAYER_ID, (e: any) => {
        const feat = e.features?.[0];
        if (feat && feat.properties) {
          map.getCanvas().style.cursor = 'pointer';
          onHover(feat.properties as any);
        }
      });
      map.on('mouseleave', AMV_CIRCLES_LAYER_ID, () => {
        map.getCanvas().style.cursor = '';
        onHover(null);
      });
    }
  } else {
    map.setLayoutProperty(AMV_SYMBOLS_LAYER_ID, 'visibility', visible ? 'visible' : 'none');
  }
}
