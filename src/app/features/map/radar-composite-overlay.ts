import type { Map as MapLibreMap, ImageSource } from 'maplibre-gl';

export const RADAR_COMPOSITE_LAYER_ID = 'radar-composite';
export const RADAR_COMPOSITE_SOURCE_ID = 'radar-composite';

export interface RadarCompositeOverlay {
  url: string;
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
}

/**
 * Renders the preprocessed All-India transparent composite radar overlay directly onto the map.
 * Replaces client-side manual multi-station downloading and decoding with instant static PNG rendering.
 */
export function syncRadarCompositeLayer(
  map: MapLibreMap,
  overlay: RadarCompositeOverlay | null,
  visible: boolean,
  opacity: number,
  before: string | undefined
): void {
  if (!visible || !overlay) {
    if (map.getLayer(RADAR_COMPOSITE_LAYER_ID)) map.removeLayer(RADAR_COMPOSITE_LAYER_ID);
    if (map.getSource(RADAR_COMPOSITE_SOURCE_ID)) map.removeSource(RADAR_COMPOSITE_SOURCE_ID);
    return;
  }

  const src = map.getSource(RADAR_COMPOSITE_SOURCE_ID) as (ImageSource | undefined);
  if (!src) {
    map.addSource(RADAR_COMPOSITE_SOURCE_ID, {
      type: 'image',
      url: overlay.url,
      coordinates: overlay.coordinates,
    });
  } else if (typeof (src as unknown as { updateImage: (opt: { url: string }) => void }).updateImage === 'function') {
    (src as unknown as { updateImage: (opt: { url: string }) => void }).updateImage({ url: overlay.url });
  }

  if (!map.getLayer(RADAR_COMPOSITE_LAYER_ID)) {
    map.addLayer(
      {
        id: RADAR_COMPOSITE_LAYER_ID,
        type: 'raster',
        source: RADAR_COMPOSITE_SOURCE_ID,
        paint: {
          'raster-opacity': opacity,
          'raster-fade-duration': 200,
          'raster-resampling': 'linear',
        },
      },
      before && map.getLayer(before) ? before : undefined,
    );
  } else {
    map.setPaintProperty(RADAR_COMPOSITE_LAYER_ID, 'raster-opacity', opacity);
  }
}
