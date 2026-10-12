import type { PointSeries } from '../meteogram/point-series';
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

/** An IST day needs this many hours of temperature before it is shown (the end of a short run leaves a part of a day, which is no day's outlook). */
const MIN_HOURS_OF_DAY = 18;

/**
 * The next days of the strip from the hourly forecast of one model at the place (Open-Meteo's point forecast): the highest and lowest
 * temperature of each IST day, its rain, and the cloud over its daylight hours (06:00 to 18:00 IST). One small answer replaces the twenty
 * pictures the same strip took from the map's own fields. A day the model does not cover whole is left out.
 */
export function outlookFromSeries(series: PointSeries, modelId: string, nowMs: number, days = 5): DayOutlook[] {
  const m = series.models[modelId];
  if (!m) return [];
  const weekday = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short' });
  const today = istMidnight(nowMs);
  const out: DayOutlook[] = [];
  for (let d = 0; d < days; d++) {
    const start = today + d * DAY_MS;
    const end = start + DAY_MS;
    let hi = -Infinity;
    let lo = Infinity;
    let hours = 0;
    let rain = 0;
    let rainHours = 0;
    let cloud = 0;
    let cloudHours = 0;
    for (let i = 0; i < series.times.length; i++) {
      const t = series.times[i];
      if (t < start || t >= end) continue;
      const temp = m.temp[i];
      if (temp !== null) {
        hi = Math.max(hi, temp);
        lo = Math.min(lo, temp);
        hours++;
      }
      const r = m.rain[i];
      if (r !== null) {
        rain += r;
        rainHours++;
      }
      const c = m.cloud[i];
      const istHour = new Date(t + IST_OFFSET_MS).getUTCHours();
      if (c !== null && istHour >= 6 && istHour < 18) {
        cloud += c;
        cloudHours++;
      }
    }
    if (hours < MIN_HOURS_OF_DAY) continue;
    const rainMm = rainHours >= MIN_HOURS_OF_DAY ? rain : null;
    const cloudMean = cloudHours > 0 ? cloud / cloudHours : null;
    out.push({ startMs: start, weekday: weekday.format(start + 12 * 3_600_000).toUpperCase(), tmax: hi, tmin: lo, rainMm, cloud: cloudMean, icon: outlookIcon(rainMm, cloudMean) });
  }
  return out;
}
