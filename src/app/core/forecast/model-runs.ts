/**
 * What a visitor needs to judge how current a forecast is, for one model: when its run began (initialisation), the newest run that exists
 * upstream, which forecast hour the time on the bar is for that run, when the pictures on screen were published, and whether anything newer
 * is on its way. All of it is worked out here from plain numbers, so it is tested without a browser.
 *
 * Words used on screen, and what they mean:
 *   run        the model's start: its initialisation time (the model begins from the weather observed then). In UTC, as "06Z".
 *   +12 h      the forecast hour: how far from the run's start the time on the bar is.
 *   valid      the time the forecast is for (the time on the bar).
 *   published  when this site finished building the pictures of the run.
 */

import type { ForecastModelDef } from './forecast-models';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** The models start a run every 6 hours (00, 06, 12 and 18 UTC). */
export const CYCLE_MS = 6 * HOUR_MS;
/** How long after a newer run appears upstream the site is given to publish it before it is called late: the build runs every 3 h and takes a while. */
export const PUBLISH_GRACE_MS = 4 * HOUR_MS;
/** When a dataset does not say when its run landed, the run is taken to have landed this long after it began (ECMWF's 9 km run takes about 6 h). */
export const TYPICAL_DELIVERY_MS = 8 * HOUR_MS;
/** A published run older than this, when upstream cannot be reached to say otherwise, is called out of date (the oldest run a healthy site shows is under 12 h). */
export const STALE_AFTER_MS = 16 * HOUR_MS;

/** Epoch ms of a run id such as 20261010T00Z (null when it does not parse). */
export function runIdToMs(run: string | null | undefined): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})?Z$/.exec(run ?? '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], m[5] ? +m[5] : 0) : null;
}

/** Epoch ms of a build id such as 20261012T033652Z (the moment the site finished a run; null when it does not parse). */
export function buildIdToMs(build: string | null | undefined): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(build ?? '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

/** "06Z" for a run's hour. */
export function runHourLabel(initMs: number): string {
  return `${String(new Date(initMs).getUTCHours()).padStart(2, '0')}Z`;
}

/** Hours from the run's start to a time (whole hours, as the bar steps in hours). */
export function leadHours(initMs: number, validMs: number): number {
  return Math.round((validMs - initMs) / HOUR_MS);
}

/** "+12 h" (or "−3 h" for a time before the run began, which the bar can show before the first step). */
export function leadLabel(hours: number): string {
  return `${hours < 0 ? '−' : '+'}${Math.abs(hours)} h`;
}

const IST = (opt: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, ...opt });

/** "12 Oct, 11:30 IST": a moment, in the time of the place this app is for. */
export function istStamp(ms: number): string {
  return `${IST({ day: 'numeric', month: 'short' }).format(ms)}, ${IST({ hour: '2-digit', minute: '2-digit' }).format(ms)} IST`;
}

/** "Mon 12 Oct, 15:00 IST": a valid time. */
export function istValid(ms: number): string {
  return `${IST({ weekday: 'short', day: 'numeric', month: 'short' }).format(ms)}, ${IST({ hour: '2-digit', minute: '2-digit' }).format(ms)} IST`;
}

/** "12 Oct 06:00 UTC": the same moment in UTC, which is how the models' runs are named. */
export function utcStamp(ms: number): string {
  const d = new Date(ms);
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(d);
  return `${date} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

/** How long ago, in the largest sensible unit: "just now", "25 min ago", "5 h ago", "2 days ago". A time ahead says "soon". */
export function agoLabel(ms: number, nowMs: number): string {
  const diff = nowMs - ms;
  if (diff < -MINUTE_MS) return 'soon';
  if (diff < 2 * MINUTE_MS) return 'just now';
  if (diff < HOUR_MS) return `${Math.round(diff / MINUTE_MS)} min ago`;
  if (diff < 48 * HOUR_MS) return `${Math.round(diff / HOUR_MS)} h ago`;
  return `${Math.round(diff / (24 * HOUR_MS))} days ago`;
}

/** What Open-Meteo says about one dataset's newest run: its status file (api.open-meteo.com/data/<dataset>/static/meta.json). */
export interface DatasetRun {
  /** When the run began. */
  initMs: number;
  /** When its data became available to read. */
  availableMs: number | null;
  /** How often a new run comes (the update interval; 6 h for every model here). */
  intervalMs: number;
  /** The last moment the run covers. */
  endMs: number | null;
}

/** Reads a dataset's status file (null when it is not what was expected). */
export function parseDatasetRun(json: unknown): DatasetRun | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as Record<string, unknown>;
  const num = (key: string): number | null => (typeof j[key] === 'number' && Number.isFinite(j[key]) ? (j[key] as number) * 1000 : null);
  const init = num('last_run_initialisation_time');
  if (init === null) return null;
  return { initMs: init, availableMs: num('last_run_availability_time'), intervalMs: num('update_interval_seconds') ?? CYCLE_MS, endMs: num('data_end_time') };
}

/** The newest run a model can be built from. */
export interface Upstream {
  /** The newest run every dataset of the model has. */
  latestInitMs: number;
  /** When the last of its datasets had it (null when not known). */
  availableMs: number | null;
  /** About when the next run is due: one update interval after this one landed. */
  nextExpectedMs: number | null;
  /** The last moment the run covers. */
  endMs: number | null;
}

/**
 * The newest run a model can be built from is the oldest of its datasets' newest runs: a model made of two datasets (ECMWF IFS: the 9 km surface
 * fields and the 0.25° pressure levels) has nothing newer to show until both have the run. Null when any dataset could not be read.
 */
export function combineUpstream(parts: readonly (DatasetRun | null)[]): Upstream | null {
  if (parts.length === 0 || parts.some(p => p === null)) return null;
  const known = parts as DatasetRun[];
  const latestInitMs = Math.min(...known.map(p => p.initMs));
  const same = known.filter(p => p.initMs === latestInitMs);
  const avail = same.map(p => p.availableMs);
  const availableMs = avail.every(m => m !== null) ? Math.max(...(avail as number[])) : null;
  const interval = Math.min(...known.map(p => p.intervalMs));
  const ends = known.map(p => p.endMs);
  return {
    latestInitMs,
    availableMs,
    nextExpectedMs: availableMs !== null ? availableMs + interval : null,
    endMs: ends.every(e => e !== null) ? Math.min(...(ends as number[])) : null,
  };
}

export type RunStatus =
  /** The run on screen is the newest one that exists. */
  | 'current'
  /** A newer run exists upstream and the site has had little time to publish it. */
  | 'updating'
  /** A newer run exists upstream and the site has had longer than it should need. */
  | 'late'
  /** Upstream cannot be reached and the run is old. */
  | 'stale'
  /** Upstream cannot be reached; nothing says the run is old. */
  | 'unknown'
  /** The model has no published run at all. */
  | 'missing';

/** The state of one model's data. */
export function runStatus(publishedInitMs: number | null, upstream: Upstream | null, nowMs: number): RunStatus {
  if (publishedInitMs === null) return 'missing';
  if (upstream) {
    if (upstream.latestInitMs <= publishedInitMs) return 'current';
    const landed = upstream.availableMs ?? upstream.latestInitMs + TYPICAL_DELIVERY_MS;
    return nowMs - landed > PUBLISH_GRACE_MS ? 'late' : 'updating';
  }
  return nowMs - publishedInitMs > STALE_AFTER_MS ? 'stale' : 'unknown';
}

export type Tone = 'ok' | 'warn' | 'bad' | 'none';

/** The words for a status: the badge, and the sentence under it. `newerInitMs` is the upstream run the site is waiting to publish. */
export function statusText(status: RunStatus, newerInitMs: number | null): { badge: string; detail: string; tone: Tone } {
  const when = newerInitMs !== null ? `${runHourLabel(newerInitMs)} run of ${new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(newerInitMs)}` : 'newer run';
  switch (status) {
    case 'current':
      return { badge: 'Latest run', detail: 'The newest run that exists.', tone: 'ok' };
    case 'updating':
      return { badge: 'Update coming', detail: `The ${when} is out and is being published here.`, tone: 'warn' };
    case 'late':
      return { badge: 'Update late', detail: `The ${when} is out but not published here yet; the next scheduled build picks it up.`, tone: 'bad' };
    case 'stale':
      return { badge: 'May be out of date', detail: 'The run is old, and the source could not be reached to check for a newer one.', tone: 'bad' };
    case 'unknown':
      return { badge: 'Not checked', detail: 'The source could not be reached to check for a newer run.', tone: 'none' };
    case 'missing':
      return { badge: 'No run', detail: 'This model has no published run right now.', tone: 'bad' };
  }
}

/** How a run covers the time on the bar. */
export interface Coverage {
  /** The forecast hour of the time on the bar for this run. */
  hours: number;
  /** True when the run has begun by that time and reaches it (its last step is at or after it). */
  covered: boolean;
}

export function coverage(initMs: number | null, lastStepHours: number | null, validMs: number | null): Coverage | null {
  if (initMs === null || validMs === null) return null;
  const hours = leadHours(initMs, validMs);
  return { hours, covered: hours >= 0 && (lastStepHours === null || hours <= lastStepHours) };
}

// ---- one model, as the model buttons and the list say it -------------------------------------------------------------------

/** What is known about one model's run on the site. */
export interface PublishedRun {
  run: string;
  initMs: number;
  /** When the site finished building it (from the build id); null when not known. */
  builtMs: number | null;
  /** False when the run went out with some data missing (it is built again at the next update). */
  complete: boolean;
  /** The last forecast hour of the run. */
  reachHours: number;
}

/** Everything the model buttons, the list and the footer say about one model's run. */
export interface ModelRunInfo {
  model: ForecastModelDef;
  published: PublishedRun | null;
  upstream: Upstream | null;
  status: RunStatus;
  badge: string;
  detail: string;
  tone: Tone;
}

/** Builds the info of a model from what is known of its run on the site and upstream. */
export function modelRunInfo(model: ForecastModelDef, published: PublishedRun | null, upstream: Upstream | null, nowMs: number): ModelRunInfo {
  const status = runStatus(published?.initMs ?? null, upstream, nowMs);
  const words = statusText(status, upstream?.latestInitMs ?? null);
  const gaps = published && !published.complete ? ' Some data of this run is missing; it is built again at the next update.' : '';
  return { model, published, upstream, status, badge: words.badge, detail: words.detail + gaps, tone: published && !published.complete && words.tone === 'ok' ? 'warn' : words.tone };
}

/** The lines a model row is written in. */
export interface RunLines {
  /** "Run 18Z · 11 Oct, 23:30 IST". */
  run: string;
  /** "+15 h" at the chosen time, "not reached" when the run ends before it, "–" when nothing is known. */
  hour: string;
  /** False when the run does not cover the chosen time. */
  covered: boolean;
  /** "Published 5 h ago · reaches +144 h". */
  published: string;
  /** "Next run due about 12:55 IST" while the run on screen is the newest one (empty otherwise). */
  next: string;
}

/** The words of a model row for the time on the bar. */
export function runLines(info: ModelRunInfo, validMs: number | null, nowMs: number): RunLines {
  const p = info.published;
  if (!p) return { run: 'No run published', hour: '–', covered: false, published: '', next: '' };
  const cover = coverage(p.initMs, p.reachHours, validMs);
  const bits = [p.builtMs !== null ? `Published ${agoLabel(p.builtMs, nowMs)}` : '', `reaches ${leadLabel(p.reachHours)}`].filter(Boolean);
  const next = info.status === 'current' && info.upstream?.nextExpectedMs && info.upstream.nextExpectedMs > nowMs ? `Next run due about ${istClock(info.upstream.nextExpectedMs)}` : '';
  return {
    run: `Run ${runHourLabel(p.initMs)} · ${istStamp(p.initMs)}`,
    hour: cover ? (cover.covered ? leadLabel(cover.hours) : cover.hours < 0 ? 'not begun' : 'not reached') : '–',
    covered: cover?.covered ?? false,
    published: bits.join(' · '),
    next,
  };
}

/** "12:55 IST". */
export function istClock(ms: number): string {
  return `${IST({ hour: '2-digit', minute: '2-digit' }).format(ms)} IST`;
}
