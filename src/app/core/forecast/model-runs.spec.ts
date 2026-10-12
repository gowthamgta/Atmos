import { describe, expect, it } from 'vitest';
import { FORECAST_MODELS, forecastModelById } from './forecast-models';
import {
  PUBLISH_GRACE_MS,
  STALE_AFTER_MS,
  agoLabel,
  buildIdToMs,
  combineUpstream,
  coverage,
  istClock,
  istStamp,
  istValid,
  leadHours,
  leadLabel,
  modelRunInfo,
  parseDatasetRun,
  runHourLabel,
  runIdToMs,
  runLines,
  runStatus,
  statusText,
  utcStamp,
} from './model-runs';

const H = 3_600_000;
const sec = (iso: string) => Date.parse(iso) / 1000;

/** The status files Open-Meteo served on 12 Oct 2026 at 05:00 UTC (the run began 18:00 UTC on the 11th). */
const IFS_STATUS = { last_run_initialisation_time: sec('2026-10-11T18:00:00Z'), last_run_availability_time: sec('2026-10-12T01:01:15Z'), data_end_time: sec('2026-10-17T19:00:00Z'), update_interval_seconds: 21600 };
const AIGFS_STATUS = { last_run_initialisation_time: sec('2026-10-12T00:00:00Z'), last_run_availability_time: sec('2026-10-12T04:27:35Z'), data_end_time: sec('2026-10-28T06:00:00Z'), update_interval_seconds: 21600 };

describe('run and build ids', () => {
  it('turns a run id into the moment the run began', () => {
    expect(runIdToMs('20261011T18Z')).toBe(Date.UTC(2026, 9, 11, 18));
    expect(runIdToMs('20261011T1830Z')).toBe(Date.UTC(2026, 9, 11, 18, 30));
    expect(runIdToMs('nonsense')).toBeNull();
    expect(runIdToMs(undefined)).toBeNull();
  });

  it('turns a build id into the moment the site finished the run', () => {
    expect(buildIdToMs('20261012T033652Z')).toBe(Date.UTC(2026, 9, 12, 3, 36, 52));
    expect(buildIdToMs('20261012T03Z')).toBeNull();
    expect(buildIdToMs(null)).toBeNull();
  });

  it('names a run by its hour, and a forecast hour with a sign', () => {
    expect(runHourLabel(Date.UTC(2026, 9, 11, 6))).toBe('06Z');
    expect(runHourLabel(Date.UTC(2026, 9, 11, 18))).toBe('18Z');
    expect(leadHours(Date.UTC(2026, 9, 11, 18), Date.UTC(2026, 9, 12, 9))).toBe(15);
    expect(leadLabel(15)).toBe('+15 h');
    expect(leadLabel(0)).toBe('+0 h');
    expect(leadLabel(-3)).toBe('−3 h');
  });
});

describe('moments in IST and UTC', () => {
  it('writes the 18Z run in the time of India, five and a half hours ahead of UTC', () => {
    const run = Date.UTC(2026, 9, 11, 18);
    expect(istStamp(run)).toBe('11 Oct, 23:30 IST');
    expect(istStamp(run + 1 * H)).toBe('12 Oct, 00:30 IST');            // past midnight there, the date moves on
    expect(utcStamp(run)).toBe('11 Oct 18:00 UTC');
    expect(istValid(Date.UTC(2026, 9, 12, 9, 30))).toBe('Mon, 12 Oct, 15:00 IST');
  });

  it('says how long ago in the largest sensible unit', () => {
    const now = Date.UTC(2026, 9, 12, 12);
    expect(agoLabel(now - 30_000, now)).toBe('just now');
    expect(agoLabel(now - 25 * 60_000, now)).toBe('25 min ago');
    expect(agoLabel(now - 5 * H, now)).toBe('5 h ago');
    expect(agoLabel(now - 47 * H, now)).toBe('47 h ago');
    expect(agoLabel(now - 72 * H, now)).toBe('3 days ago');
    expect(agoLabel(now + 3 * H, now)).toBe('soon');
  });
});

describe('what Open-Meteo says about the newest run', () => {
  it('reads a status file', () => {
    const run = parseDatasetRun(IFS_STATUS)!;
    expect(run.initMs).toBe(Date.parse('2026-10-11T18:00:00Z'));
    expect(run.availableMs).toBe(Date.parse('2026-10-12T01:01:15Z'));
    expect(run.intervalMs).toBe(6 * H);
    expect(run.endMs).toBe(Date.parse('2026-10-17T19:00:00Z'));
  });

  it('refuses a file that is not a status file', () => {
    expect(parseDatasetRun(null)).toBeNull();
    expect(parseDatasetRun({ error: true, reason: 'Something went wrong.' })).toBeNull();
    expect(parseDatasetRun({ last_run_initialisation_time: 'yesterday' })).toBeNull();
  });

  it('takes the newest run every dataset of a model has', () => {
    const older = parseDatasetRun(IFS_STATUS)!;
    const newer = parseDatasetRun({ ...IFS_STATUS, last_run_initialisation_time: sec('2026-10-12T00:00:00Z'), last_run_availability_time: sec('2026-10-12T06:10:00Z') })!;
    // the 9 km surface data has the 00Z run, the 0.25° levels do not yet: there is nothing newer to build from
    const up = combineUpstream([newer, older])!;
    expect(up.latestInitMs).toBe(older.initMs);
    expect(up.availableMs).toBe(older.availableMs);
    expect(up.nextExpectedMs).toBe(older.availableMs! + 6 * H);
  });

  it('is unknown when any dataset could not be read', () => {
    expect(combineUpstream([parseDatasetRun(IFS_STATUS), null])).toBeNull();
    expect(combineUpstream([])).toBeNull();
  });
});

describe('how current a model is', () => {
  const now = Date.parse('2026-10-12T05:00:00Z');
  const ifs = combineUpstream([parseDatasetRun(IFS_STATUS)])!;
  const aigfs = combineUpstream([parseDatasetRun(AIGFS_STATUS)])!;
  const run18 = Date.parse('2026-10-11T18:00:00Z');

  it('calls the newest run the latest', () => {
    expect(runStatus(run18, ifs, now)).toBe('current');
  });

  it('calls a newer upstream run an update on its way while the site has had time, and late after', () => {
    expect(runStatus(run18, aigfs, now)).toBe('updating');                                        // the 00Z run landed 33 minutes ago
    expect(runStatus(run18, aigfs, aigfs.availableMs! + PUBLISH_GRACE_MS - 1)).toBe('updating');
    expect(runStatus(run18, aigfs, aigfs.availableMs! + PUBLISH_GRACE_MS + 1)).toBe('late');
  });

  it('judges by age when upstream cannot be read', () => {
    expect(runStatus(run18, null, run18 + 6 * H)).toBe('unknown');
    expect(runStatus(run18, null, run18 + STALE_AFTER_MS + 1)).toBe('stale');
  });

  it('has nothing to say about a model without a run', () => {
    expect(runStatus(null, ifs, now)).toBe('missing');
  });

  it('puts each state in words, and the colour of its tone', () => {
    expect(statusText('current', null)).toMatchObject({ badge: 'Latest run', tone: 'ok' });
    expect(statusText('updating', Date.parse('2026-10-12T00:00:00Z')).detail).toContain('00Z run of 12 Oct');
    expect(statusText('late', null).tone).toBe('bad');
    expect(statusText('unknown', null).tone).toBe('none');
    expect(statusText('stale', null).tone).toBe('bad');
  });

  it('puts it together for a model, noting a run published with gaps', () => {
    const model = forecastModelById('aigfs');
    const run = { run: '20261011T18Z', initMs: run18, builtMs: Date.parse('2026-10-12T03:39:35Z'), complete: true, reachHours: 384 };
    const info = modelRunInfo(model, run, aigfs, now);
    expect(info.status).toBe('updating');
    expect(info.tone).toBe('warn');
    const gappy = modelRunInfo(forecastModelById('ecmwf_ifs'), { ...run, complete: false }, ifs, now);
    expect(gappy.status).toBe('current');
    expect(gappy.tone).toBe('warn');                    // current, but with data missing
    expect(gappy.detail).toContain('missing');
  });
});

describe('how a run covers the time on the bar', () => {
  const init = Date.UTC(2026, 9, 11, 18);

  it('gives the forecast hour, and whether the run reaches that far', () => {
    expect(coverage(init, 144, Date.UTC(2026, 9, 12, 9))).toEqual({ hours: 15, covered: true });
    expect(coverage(init, 60, Date.UTC(2026, 9, 17, 18))).toEqual({ hours: 144, covered: false });      // the Met Office run ends at +60 h
    expect(coverage(init, 144, init - 3 * H)).toEqual({ hours: -3, covered: false });                    // before the run began
    expect(coverage(init, null, Date.UTC(2026, 9, 20))).toMatchObject({ covered: true });               // reach unknown: assumed
    expect(coverage(null, 144, init)).toBeNull();
  });
});

describe('the model list', () => {
  it('gives every model a centre, a status dataset and a colour that follows its centre', () => {
    for (const m of FORECAST_MODELS) {
      expect(m.datasets.length).toBeGreaterThan(0);
      expect(m.apiId).toBeTruthy();
      expect(m.reachHours).toBeGreaterThan(0);
    }
    expect(FORECAST_MODELS.filter(m => m.ai).map(m => m.id).sort()).toEqual(['aifs', 'aigfs']);
    expect(forecastModelById('aifs').centre).toBe('ECMWF');
    expect(forecastModelById('aigfs').centre).toBe('NOAA');
  });
});

describe('the lines of a model row', () => {
  const now = Date.parse('2026-10-12T05:00:00Z');
  const run18 = Date.parse('2026-10-11T18:00:00Z');
  const published = { run: '20261011T18Z', initMs: run18, builtMs: Date.parse('2026-10-12T02:26:23Z'), complete: true, reachHours: 144 };
  const ifsUp = combineUpstream([parseDatasetRun(IFS_STATUS)])!;

  it('says the run, the hour of the chosen time in it, and when it was published', () => {
    const info = modelRunInfo(forecastModelById('ecmwf_ifs'), published, ifsUp, now);
    const lines = runLines(info, Date.parse('2026-10-12T09:30:00Z'), now);
    expect(lines.run).toBe('Run 18Z · 11 Oct, 23:30 IST');
    expect(lines.hour).toBe('+16 h');
    expect(lines.covered).toBe(true);
    expect(lines.published).toBe('Published 3 h ago · reaches +144 h');
    expect(lines.next).toBe('Next run due about 12:31 IST');             // 01:01 UTC availability plus the 6 h update interval
  });

  it('says when the run does not reach the chosen time, or has not begun', () => {
    const info = modelRunInfo(forecastModelById('ukmo'), { ...published, reachHours: 60 }, ifsUp, now);
    expect(runLines(info, run18 + 100 * H, now)).toMatchObject({ hour: 'not reached', covered: false });
    expect(runLines(info, run18 - 3 * H, now)).toMatchObject({ hour: 'not begun', covered: false });
    expect(runLines(info, null, now)).toMatchObject({ hour: '–', covered: false });
  });

  it('does not promise a next run while an update is already on its way', () => {
    const aigfsUp = combineUpstream([parseDatasetRun(AIGFS_STATUS)])!;
    const info = modelRunInfo(forecastModelById('aigfs'), published, aigfsUp, now);
    expect(runLines(info, run18 + 5 * H, now).next).toBe('');
  });

  it('has nothing to say for a model without a run', () => {
    expect(runLines(modelRunInfo(forecastModelById('gfs'), null, null, now), run18, now)).toMatchObject({ run: 'No run published', hour: '–' });
  });

  it('writes a time of day in India', () => {
    expect(istClock(Date.parse('2026-10-12T07:25:00Z'))).toBe('12:55 IST');
  });
});
