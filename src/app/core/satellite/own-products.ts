/**
 * Our own satellite pictures, made from the raw data of two satellites by the satellite workflow (published by gowthamgta/atmos-satellite
 * with GitHub Pages): Meteosat-9 (pipeline/meteosat_rgb.py: all of India, the HRV at 1.25 km) and Himawari-9 (pipeline/himawari_rgb.py: the
 * east only, true colour at 1 km). Some pictures are made in the pipeline, three are drawn in the browser from the frame's data pack
 * (brightness temperatures; see rendering/satellite-data.layer.ts). EUMETView's pictures (the agreed look) stay the default source.
 */
import { mercatorUnitY } from '../forecast/forecast.model';
import type { GeoBounds } from './satellite.config';

const SITE = 'https://gowthamgta.github.io/atmos-satellite/';

export type OwnKind = 'hrv' | 'natural' | 'truecolor' | 'sandwich' | 'convection' | 'nightmicro' | 'infrared' | 'wvdiff' | 'custom';
export type OwnSatellite = 'msg' | 'h9';

/** The two satellites' published folders and what each makes. */
export const OWN_SATELLITES: Record<OwnSatellite, { name: string; base: string; kinds: readonly OwnKind[]; ir: string; note: string }> = {
  msg: {
    name: 'Meteosat-9', base: SITE + 'rgb-msg/', ir: '10.8',
    kinds: ['natural', 'hrv', 'sandwich', 'convection', 'infrared', 'nightmicro', 'wvdiff', 'custom'],
    note: 'From Meteosat-9\'s raw SEVIRI data (EUMETSAT Data Store), 1.25 km, parallax-corrected, all of India.',
  },
  h9: {
    name: 'Himawari-9', base: SITE + 'rgb-h9/', ir: '10.4',
    kinds: ['truecolor', 'sandwich', 'convection', 'infrared', 'nightmicro', 'wvdiff', 'custom'],
    note: 'From Himawari-9\'s raw bands, 1 km, parallax-corrected. It covers 75–97.5°E, 5–30°N: it sees the west of India too slantwise.',
  },
};
/** Where the satellite panel's pictures come from: EUMETView (default) or one of ours. */
export type SatelliteSource = 'eumetview' | OwnKind;

export const OWN_KINDS: readonly { id: OwnKind; label: string; title: string; day?: boolean; shader?: boolean }[] = [
  { id: 'hrv', label: 'HRV', day: true, title: 'The High Resolution Visible channel itself, uncompressed, about 1.2 km, by day' },
  { id: 'natural', label: 'Natural colour', day: true, title: 'Natural colour (0.6, 0.8, 1.6 µm) sharpened with the HRV: ice cloud cyan, water cloud white, land green-brown, by day' },
  { id: 'truecolor', label: 'True colour', day: true, title: 'True colour from the visible bands (Rayleigh-corrected), by day' },
  { id: 'sandwich', label: 'Sandwich', day: true, title: 'The visible texture, coloured where the cloud top is colder than −38 °C: storms and their overshooting tops' },
  { id: 'convection', label: 'Convection', day: true, title: 'Severe convection RGB: strong updrafts with small ice at the top show yellow' },
  { id: 'nightmicro', label: 'Night micro', title: 'Night microphysics (tropical): low cloud and fog against high cloud' },
  { id: 'infrared', label: 'Infrared', shader: true, title: 'Cloud-top temperature in Windy\'s infrared colours, from the measured temperature' },
  { id: 'wvdiff', label: 'WV difference', shader: true, title: '6.2 minus 7.3 µm water vapour: dry air aloft brown, moist upper air blue' },
  { id: 'custom', label: 'Custom RGB', shader: true, title: 'Your own recipe: each colour from a band or a difference, with its range and gamma' },
];

export const isShaderKind = (k: SatelliteSource): k is OwnKind => OWN_KINDS.some(o => o.id === k && o.shader);
export const isDayKind = (k: SatelliteSource): boolean => OWN_KINDS.some(o => o.id === k && o.day);

/** The quantities a custom RGB channel can show (kelvin): the data pack's bands and two differences. */
export const CUSTOM_SOURCES: readonly { id: number; label: string }[] = [
  { id: 0, label: 'IR window' },
  { id: 1, label: 'WV 6.2 µm' },
  { id: 2, label: 'WV 7.3 µm' },
  { id: 3, label: 'WV 6.2 − 7.3' },
  { id: 4, label: 'IR − WV 7.3' },
];

export interface CustomChannel {
  source: number;
  min: number;
  max: number;
  gamma: number;
}

/** The custom recipe's starting point: cloud tops in grey (10.4 um, colder brighter) tinted blue where the upper air is moist (6.2 um). */
export const DEFAULT_CUSTOM: readonly CustomChannel[] = [
  { source: 0, min: 303, max: 203, gamma: 1 },   // red: 10.4 um, warm ground dark, cold tops bright
  { source: 0, min: 303, max: 203, gamma: 1 },   // green: the same, so cloud is grey to white
  { source: 1, min: 243, max: 213, gamma: 1 },   // blue: 6.2 um, moist upper air (cold at 6.2 um) adds blue; dry clear air none
];

/** The WMO RGB formula for one channel: ((v - min) / (max - min)) ^ (1 / gamma), 0..1. */
export function wmoChannel(v: number, c: CustomChannel): number {
  const x = Math.min(1, Math.max(0, (v - c.min) / (c.max - c.min || 1)));
  return Math.pow(x, 1 / Math.max(c.gamma, 0.05));
}

export interface OwnIndex {
  bounds: GeoBounds;
  data: { minK: number; spanK: number };
  frames: { time: string; files: Partial<Record<OwnKind | 'data', string>> }[];
}

/** A decoded data pack: RGB bytes (10.4, 6.2, 7.3 um), Mercator rows over `bounds`. */
export interface DataPack {
  w: number;
  h: number;
  rgb: Uint8Array;
  bounds: GeoBounds;
  minK: number;
  spanK: number;
}

/** The three brightness temperatures (kelvin) at a place, or null outside the pack or where it has no data. */
export function readDataPack(p: DataPack, lat: number, lon: number): { ir: number; wv62: number; wv73: number } | null {
  const b = p.bounds;
  if (lon < b.west || lon > b.east || lat < b.south || lat > b.north) return null;
  const x = Math.min(p.w - 1, Math.floor(((lon - b.west) / (b.east - b.west)) * p.w));
  const yTop = mercatorUnitY(b.north);
  const y = Math.min(p.h - 1, Math.floor(((mercatorUnitY(lat) - yTop) / (mercatorUnitY(b.south) - yTop)) * p.h));
  const o = (y * p.w + x) * 3;
  const k = (v: number) => (v === 0 ? NaN : p.minK + (v / 255) * p.spanK);
  const ir = k(p.rgb[o]);
  if (Number.isNaN(ir)) return null;
  return { ir, wv62: k(p.rgb[o + 1]), wv73: k(p.rgb[o + 2]) };
}

/**
 * The picture's kind to show by default: infrared at night; by day our natural colour (Meteosat) or true colour (Himawari). The owner
 * asked for this (22 Oct): infrared at night on both satellites, our own RGB by day.
 */
export function autoKind(satellite: OwnSatellite, day: boolean): OwnKind {
  if (!day) return 'infrared';
  return satellite === 'msg' ? 'natural' : 'truecolor';
}

/**
 * Recipes for the custom RGB to start from (WMO formula, ranges in kelvin; a range from high to low makes colder brighter):
 * - Cloud tops: the window channel in grey (cold tops white, warm ground dark), blue where the upper air is moist (6.2 um cold).
 * - Storms: red where the top is cold (below about -20 C, full at -80 C), green where 6.2 is as warm as 7.3 or warmer (water vapour
 *   lifted above the 7.3 um level: overshooting tops), blue from the window minus 7.3 um (near nothing in deep cloud, large over low cloud
 *   and clear ground): deep convection red, overshooting tops yellow, low cloud and clear ground blue.
 * - Moisture aloft: red where the mid levels are dry (7.3 um warm), green where the upper levels are moist (6.2 um cold), blue where they
 *   are very moist or cloud tops: dry intrusions red-orange, moist air green, high cloud cyan to white.
 */
export const CUSTOM_PRESETS: readonly { id: string; label: string; title: string; recipe: readonly CustomChannel[] }[] = [
  { id: 'tops', label: 'Cloud tops', title: 'Cold tops white, warm ground dark, moist upper air blue', recipe: DEFAULT_CUSTOM },
  {
    id: 'storms', label: 'Storms', title: 'Deep convection red, its overshooting tops yellow; low cloud and clear ground blue',
    recipe: [{ source: 0, min: 253, max: 193, gamma: 1 }, { source: 3, min: -1, max: 4, gamma: 1 }, { source: 4, min: 8, max: 55, gamma: 1 }],
  },
  {
    id: 'moisture', label: 'Moisture aloft', title: 'Dry air in the middle levels red-orange, moist upper air green, high cloud cyan to white',
    recipe: [{ source: 2, min: 233, max: 258, gamma: 1 }, { source: 1, min: 248, max: 218, gamma: 1 }, { source: 1, min: 228, max: 208, gamma: 1 }],
  },
];
