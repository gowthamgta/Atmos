import type { Map as MapLibreMap } from 'maplibre-gl';
import type { CoverageOverlay } from '../../core/services/radar-coverage.service';

export const COVERAGE_LAYER_ID = 'radar-coverage';

/**
 * Puts the haze of the radar coverage (a faint picture of where the radars see little) on the map, or takes it off. `before` is the layer it goes
 * under: the radar echoes, so the haze never covers them.
 */
export function syncCoverageLayer(map: MapLibreMap, overlay: CoverageOverlay | null, visible: boolean, before: string | undefined): void {
  if (!visible || !overlay) {
    if (map.getLayer(COVERAGE_LAYER_ID)) map.removeLayer(COVERAGE_LAYER_ID);
    if (map.getSource(COVERAGE_LAYER_ID)) map.removeSource(COVERAGE_LAYER_ID);
    return;
  }
  if (map.getLayer(COVERAGE_LAYER_ID)) return;
  if (!map.getSource(COVERAGE_LAYER_ID)) map.addSource(COVERAGE_LAYER_ID, { type: 'image', url: overlay.url, coordinates: overlay.coordinates });
  map.addLayer(
    { id: COVERAGE_LAYER_ID, type: 'raster', source: COVERAGE_LAYER_ID, paint: { 'raster-opacity': 1, 'raster-fade-duration': 250, 'raster-resampling': 'linear' } },
    before && map.getLayer(before) ? before : undefined,
  );
}
