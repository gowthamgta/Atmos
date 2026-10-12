import { WINDY_TEMP } from './windy-palettes';

/** The picture standing for a day on the outlook strip (names from shared/icons.ts). */
export type OutlookIcon = 'sun' | 'partly' | 'cloud' | 'rain' | 'rain24';

export interface DayOutlook {
  /** The IST midnight the day starts at. */
  startMs: number;
  weekday: string;
  tmax: number | null;
  tmin: number | null;
  rainMm: number | null;
  cloud: number | null;
  icon: OutlookIcon;
}

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3_600_000;

/** The IST midnight at or before a time. */
export function istMidnight(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

/** The picture of a day from its rain (mm over 24 h) and its midday cloud cover (%): rain first, then how cloudy. */
export function outlookIcon(rainMm: number | null, cloud: number | null): OutlookIcon {
  if (rainMm !== null && rainMm >= 15) return 'rain24';
  if (rainMm !== null && rainMm >= 2) return 'rain';
  if (cloud !== null && cloud >= 70) return 'cloud';
  if (cloud !== null && cloud >= 30) return 'partly';
  return 'sun';
}

/** The picture of the sky at a time at a place: rain now first (mm/h), then the cloud, and a moon instead of a sun between 18:00 and 06:00 IST. */
export function currentIcon(precipMmPerHour: number | null, cloud: number | null, timeMs: number): OutlookIcon | 'moon' {
  if (precipMmPerHour !== null && precipMmPerHour >= 4) return 'rain24';
  if (precipMmPerHour !== null && precipMmPerHour >= 0.3) return 'rain';
  if (cloud !== null && cloud >= 70) return 'cloud';
  if (cloud !== null && cloud >= 30) return 'partly';
  const hour = new Date(timeMs + IST_OFFSET_MS).getUTCHours();
  return hour < 6 || hour >= 18 ? 'moon' : 'sun';
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The colour of the temperature palette at a temperature (in °C, over the range the temperature layer is drawn in). */
export function temperatureColor(c: number, lo = 18, hi = 42): string {
  const t = Math.min(Math.max((c - lo) / (hi - lo), 0), 1) * (WINDY_TEMP.length - 1);
  const k = Math.min(Math.floor(t), WINDY_TEMP.length - 2);
  const f = t - k;
  const a = hexToRgb(WINDY_TEMP[k]);
  const b = hexToRgb(WINDY_TEMP[k + 1]);
  const rgb = a.map((x, i) => Math.round(x * (1 - f) + b[i] * f));
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

/** The thin bar under a day on the strip, from the colour of its low to the colour of its high (as on windy.com). */
export function temperatureBar(lowC: number | null, highC: number | null): string {
  if (lowC === null && highC === null) return 'transparent';
  const low = lowC ?? highC!;
  const high = highC ?? lowC!;
  return `linear-gradient(to right, ${temperatureColor(low)}, ${temperatureColor(high)})`;
}
