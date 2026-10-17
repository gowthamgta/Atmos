/**
 * Where to ask EUMETView for a closer picture.
 *
 * The whole-India picture is asked for at 1.5 km a pixel on a desktop and 3 km on a phone, but the high-resolution visible channel
 * (HRV) is built from pixels about 1.2-1.5 km wide. So a phone's picture throws away half of what the satellite has, and when the
 * map is zoomed in a small window of the same picture is fetched at the satellite's own pixel and drawn over the main one, which
 * stays underneath for everything outside the window. (A desktop's picture is only a little coarser, 1.5 km, so its window is the same HD picture, 1.25 km, at the most it can be asked for.)
 * The window follows the map: it is chosen from the view, snapped so a small pan keeps it, and replaced only when the view leaves it.
 *
 * It must not be asked for any finer than the satellite's pixel: the service then pads the picture by repeating its pixels, which
 * is not detail but a pattern of rectangles that shows as vertical and horizontal streaks as soon as the map is zoomed in. (An
 * earlier version asked for 0.8 km a pixel and the Kallakurichi view was streaked with them.)
 *
 * Everything here is plain arithmetic on the map's position; nothing is fetched.
 */
import { GeoBounds, SATELLITE_BOUNDS } from './satellite.config';

const RAD = Math.PI / 180;
/** Kilometres in a degree of latitude (and of longitude at the equator). */
const KM_PER_DEG = 111.32;

/** Pixel size (km) of a window: about the satellite's own (HRV pixels are 1.2-1.5 km wide over India). */
export const WINDOW_KM_PER_PX = 1.25;
/** A window with no more pixels than this is asked for as a lossless PNG (about 200 KB); a bigger one as a JPEG, whose blocks a map zoomed that far out does not show. */
export const WINDOW_LOSSLESS_MAX_PX = 90_000;
/** The smallest window, in km across: below this the map is zoomed in further than the data goes, a bigger picture would add nothing. */
export const WINDOW_MIN_SPAN_KM = 150;
/** The window reaches this fraction of the view beyond it on every side (so it is two screens across). */
export const WINDOW_MARGIN = 0.3;
/** A window is only worth fetching when its pixels are this much finer than the main picture's. */
export const WINDOW_MIN_GAIN = 1.15;
/** An existing window is kept while the view stays this far (fraction of the view) inside it, and is not this much coarser than a fresh one would be. */
export const WINDOW_KEEP_MARGIN = 0.1;
export const WINDOW_KEEP_COARSER = 1.35;

/** How the map is looking: the centre, the zoom and the size of the map on the screen (CSS pixels). */
export interface MapView {
  lat: number;
  lon: number;
  zoom: number;
  width: number;
  height: number;
}

/** What a window costs: the biggest picture to ask for, and the pixel (km) of the main picture it has to beat. */
export interface WindowLimits {
  maxPx: number;
  globalKmPerPx: number;
}

export interface SatelliteWindow {
  /** Names the window by its box, for caching. */
  id: string;
  bounds: GeoBounds;
  /** The picture to ask for (pixels). */
  size: { width: number; height: number };
  /** Kilometres a picture pixel covers, east to west, in the middle of the window. */
  kmPerPx: number;
  /** About how far the window reaches (km), before it was cut to the satellite's box. */
  spanKm: number;
}

/** Metres a screen pixel covers at a latitude and zoom (MapLibre's world is 512 pixels at zoom 0). */
export function metresPerPixel(latDeg: number, zoom: number): number {
  return (40_075_016.686 * Math.cos(latDeg * RAD)) / (512 * 2 ** zoom);
}

/** Kilometres a pixel covers, east to west, in the middle of a picture of `width` pixels covering `bounds`. */
export function kmPerPixel(bounds: GeoBounds, width: number): number {
  const lat = (bounds.north + bounds.south) / 2;
  return ((bounds.east - bounds.west) * KM_PER_DEG * Math.cos(lat * RAD)) / width;
}

/** The pixel of the whole-India picture on a desktop (2000 pixels across): the size the picture processing is tuned for. */
export const REFERENCE_KM_PER_PX = kmPerPixel(SATELLITE_BOUNDS, 2000);

/** How many times finer than the reference a picture's pixels are (the main picture on a phone is 0.5; a window is about 2). */
export function pictureScale(bounds: GeoBounds, width: number): number {
  return REFERENCE_KM_PER_PX / kmPerPixel(bounds, width);
}

/** The ground the view shows, in degrees around its centre. */
function viewExtent(view: MapView): { latHalf: number; lonHalf: number; km: number } {
  const kmPerPx = metresPerPixel(view.lat, view.zoom) / 1000;
  return {
    latHalf: (view.height * kmPerPx) / 2 / KM_PER_DEG,
    lonHalf: (view.width * kmPerPx) / 2 / (KM_PER_DEG * Math.cos(view.lat * RAD)),
    km: Math.max(view.width, view.height) * kmPerPx,
  };
}

/** The next size in the series 150, 212, 300, 424, 600 ... km that reaches `km` (so small zooms do not make a new window each time). */
function quantiseSpan(km: number): number {
  const steps = Math.max(0, Math.ceil(2 * Math.log2(Math.max(km, WINDOW_MIN_SPAN_KM) / WINDOW_MIN_SPAN_KM) - 1e-9));
  return WINDOW_MIN_SPAN_KM * 2 ** (steps / 2);
}

/** True while `window` still holds the view with room to spare, and is not much coarser than a fresh one would be. */
function keeps(window: SatelliteWindow, view: MapView, freshKmPerPx: number): boolean {
  if (window.kmPerPx > freshKmPerPx * WINDOW_KEEP_COARSER) return false;
  const e = viewExtent(view);
  const latMargin = e.latHalf * 2 * WINDOW_KEEP_MARGIN;
  const lonMargin = e.lonHalf * 2 * WINDOW_KEEP_MARGIN;
  const b = window.bounds;
  return (
    view.lat - e.latHalf - latMargin >= b.south &&
    view.lat + e.latHalf + latMargin <= b.north &&
    view.lon - e.lonHalf - lonMargin >= b.west &&
    view.lon + e.lonHalf + lonMargin <= b.east
  );
}

/**
 * The window to show for a view, or null when the main picture is fine (zoomed out, or its pixels are already about as fine).
 * `current`, the window now on the map, is returned again while it still serves, so panning does not refetch.
 */
export function chooseWindow(view: MapView, limits: WindowLimits, current: SatelliteWindow | null = null): SatelliteWindow | null {
  const extent = viewExtent(view);
  const spanKm = quantiseSpan(extent.km * (1 + 2 * WINDOW_MARGIN));
  const px = Math.min(limits.maxPx, Math.round(spanKm / WINDOW_KM_PER_PX));
  const kmPerPx = spanKm / px;
  if (limits.globalKmPerPx / kmPerPx < WINDOW_MIN_GAIN) return null;
  if (current && keeps(current, view, kmPerPx)) return current;

  // centre snapped to a quarter of the window, so a small pan lands on the same window
  const snapKm = spanKm / 4;
  const lat0 = (Math.round((view.lat * KM_PER_DEG) / snapKm) * snapKm) / KM_PER_DEG;
  const lonStep = snapKm / (KM_PER_DEG * Math.cos(lat0 * RAD));
  const lon0 = Math.round(view.lon / lonStep) * lonStep;
  const latHalf = spanKm / 2 / KM_PER_DEG;
  const lonHalf = spanKm / 2 / (KM_PER_DEG * Math.cos(lat0 * RAD));

  const box = SATELLITE_BOUNDS;
  // slide the window inside the satellite's box rather than cutting it, and cut only what still does not fit
  const place = (centre: number, half: number, lo: number, hi: number): [number, number] => {
    let a = centre - half;
    let b = centre + half;
    if (a < lo) {
      b += lo - a;
      a = lo;
    }
    if (b > hi) {
      a -= b - hi;
      b = hi;
    }
    return [Math.max(a, lo), Math.min(b, hi)];
  };
  const [south, north] = place(lat0, latHalf, box.south, box.north);
  const [west, east] = place(lon0, lonHalf, box.west, box.east);
  const bounds: GeoBounds = { west, east, south, north };
  const midLat = (south + north) / 2;
  const width = Math.round(((east - west) * KM_PER_DEG * Math.cos(midLat * RAD)) / kmPerPx);
  const height = Math.round(((north - south) * KM_PER_DEG) / kmPerPx);
  if (width < 64 || height < 64) return null;
  const f = (v: number) => v.toFixed(2);
  return { id: `${f(south)},${f(west)},${f(north)},${f(east)}`, bounds, size: { width, height }, kmPerPx, spanKm };
}
