/**
 * MapLibre is about a megabyte of the page, so it is not part of the first bundle: the page (search, layers, time bar) draws first
 * and the map library is fetched next, in its own file. `loadMapLibre()` fetches it once; `maplibre()` is for code that only runs
 * once the map exists (it is already loaded then).
 */
type MapLibre = typeof import('maplibre-gl');

let loaded: MapLibre | null = null;
let pending: Promise<MapLibre> | null = null;

export function loadMapLibre(): Promise<MapLibre> {
  pending ??= import('maplibre-gl').then(m => (loaded = m));
  return pending;
}

/** The library, for code that runs after the map was made. */
export function maplibre(): MapLibre {
  if (!loaded) throw new Error('MapLibre is not loaded yet');
  return loaded;
}
