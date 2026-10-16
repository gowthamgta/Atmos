/**
 * The address of a view, as on windy.com and meteoblue.com: the layer, model, altitude, place, map position and overlays go into the part of
 * the address after "#", so a link shows the same view. Everything read from an address is checked: a value that does not fit is ignored.
 */
export interface ViewState {
  layer?: string;
  model?: string;
  level?: string;
  place?: { lat: number; lon: number; name?: string };
  camera?: { lat: number; lon: number; zoom: number };
  /** The overlays that are on, out of OVERLAYS. Absent in an address that does not say (the defaults then apply). */
  overlays?: string[];
}

/** The overlays that can be switched, with the order they are written in. */
export const OVERLAYS = ['particles', 'isobars', 'stations', 'cyclones', 'lightning', 'districts', 'relief'] as const;

const ID = /^[a-z0-9_-]{1,40}$/i;
const LEVELS = new Set(['surface', '925', '850', '800', '700', '600', '500', '300', '250', '200']);

function num(text: string | undefined, lo: number, hi: number): number | null {
  if (text === undefined || text.trim() === '') return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}

function pair(text: string | undefined): { lat: number; lon: number; rest: string[] } | null {
  const parts = (text ?? '').split(',');
  const lat = num(parts[0], -90, 90);
  const lon = num(parts[1], -180, 180);
  return lat === null || lon === null ? null : { lat, lon, rest: parts.slice(2) };
}

/** Reads a view from the part of an address after "#" (with or without the "#"). */
export function parseViewState(hash: string): ViewState {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const view: ViewState = {};
  const layer = params.get('l');
  if (layer && ID.test(layer)) view.layer = layer;
  const model = params.get('m');
  if (model && ID.test(model)) view.model = model;
  const level = params.get('lv');
  if (level && LEVELS.has(level)) view.level = level;
  const place = pair(params.get('p') ?? undefined);
  if (place) {
    const name = params.get('n');
    view.place = { lat: place.lat, lon: place.lon, ...(name ? { name: name.slice(0, 60) } : {}) };
  }
  const cam = pair(params.get('c') ?? undefined);
  const zoom = cam ? num(cam.rest[0], 1, 18) : null;
  if (cam && zoom !== null) view.camera = { lat: cam.lat, lon: cam.lon, zoom };
  const overlays = params.get('o');
  if (overlays !== null) view.overlays = overlays.split(',').filter(o => (OVERLAYS as readonly string[]).includes(o));
  return view;
}

const round = (n: number, digits: number): string => String(Number(n.toFixed(digits)));

/** The part of an address after "#" for a view (without the "#"). */
export function formatViewState(view: ViewState): string {
  const params = new URLSearchParams();
  if (view.layer) params.set('l', view.layer);
  if (view.model) params.set('m', view.model);
  if (view.level) params.set('lv', view.level);
  if (view.place) {
    params.set('p', `${round(view.place.lat, 4)},${round(view.place.lon, 4)}`);
    if (view.place.name) params.set('n', view.place.name);
  }
  if (view.camera) params.set('c', `${round(view.camera.lat, 3)},${round(view.camera.lon, 3)},${round(view.camera.zoom, 2)}`);
  if (view.overlays) params.set('o', view.overlays.filter(o => (OVERLAYS as readonly string[]).includes(o)).join(','));
  return params.toString().replace(/%2C/g, ',');
}
