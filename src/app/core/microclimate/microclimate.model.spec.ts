import { describe, expect, it } from 'vitest';
import {
  DistrictMicroclimate,
  MicroclimateData,
  compassPoint,
  districtNames,
  floodTone,
  heatTone,
  istLabel,
  rainSentence,
  seaBreezeSentence,
  stepIndex,
  valuesAt,
  metricById,
  METRIC_LAYER,
} from './microclimate.model';

const times = ['2026-10-08T00:00:00Z', '2026-10-08T03:00:00Z', '2026-10-08T06:00:00Z'];

const chennai: DistrictMicroclimate = {
  name: 'Chennai', lat: 13, lon: 80.2, coastal: true,
  series: {
    tempC: [28, 30, 32], heatIndexC: [30, 33, 37], rhPct: [80, 70, 60], windMs: [3, 4, null], windFromDeg: [90, 85, 80],
    precipMmH: [0, 0.6, 0], rain24Mm: [5, 9, 12],
  },
  indicators: {
    heat: { peakC: 37, peakTime: '2026-10-08T06:00:00Z', band: 'Extreme caution' },
    rain: { start: '2026-10-08T03:00:00Z', end: null, ongoing: false, peakMmH: 0.6, peakTime: '2026-10-08T03:00:00Z' },
    seaBreeze: { likely: true, from: '2026-10-08T06:00:00Z', peakOnshoreMs: 3.8 },
    flood: { band: 'Low', peakMm: 12, peakTime: '2026-10-08T06:00:00Z' },
  },
};

describe('microclimate model', () => {
  it('takes the last step at or before the time, and the first step for earlier times', () => {
    const t = Date.parse('2026-10-08T04:30:00Z');
    expect(stepIndex(times, t)).toBe(1);
    expect(stepIndex(times, Date.parse('2026-10-07T00:00:00Z'))).toBe(0);
    expect(stepIndex(times, Date.parse('2026-10-09T00:00:00Z'))).toBe(2);
  });

  it('reads one step of a district, and gives null past the end of a series', () => {
    expect(valuesAt(chennai, 2).tempC).toBe(32);
    expect(valuesAt(chennai, 2).windMs).toBeNull();
    expect(valuesAt(chennai, 9).tempC).toBeNull();
  });

  it('names the wind side as a compass point', () => {
    expect(compassPoint(0)).toBe('N');
    expect(compassPoint(90)).toBe('E');
    expect(compassPoint(225)).toBe('SW');
    expect(compassPoint(359)).toBe('N');
    expect(compassPoint(null)).toBe('');
  });

  it('shows India time, with the date when it is not today', () => {
    const now = Date.parse('2026-10-08T05:00:00Z');
    expect(istLabel('2026-10-08T09:00:00Z', now)).toBe('14:30 IST');
    expect(istLabel('2026-10-09T09:00:00Z', now)).toBe('9 Oct, 14:30 IST');
  });

  it('maps the bands to tones, and sorts the names', () => {
    expect(heatTone('Extreme caution')).toBe('warn');
    expect(heatTone('Danger')).toBe('alert');
    expect(heatTone('nonsense')).toBe('none');
    expect(floodTone('Heavy rain')).toBe('watch');
    const data = { districts: [chennai, { ...chennai, name: 'Ariyalur' }] } as unknown as MicroclimateData;
    expect(districtNames(data)).toEqual(['Ariyalur', 'Chennai']);
  });

  it('writes the rain and sea-breeze indicators as sentences', () => {
    const now = Date.parse('2026-10-08T00:00:00Z');
    expect(rainSentence({ ...chennai.indicators.rain, start: null })).toContain('No significant rain');
    expect(rainSentence({ ...chennai.indicators.rain, ongoing: true, end: '2026-10-08T06:00:00Z' }, now)).toBe('Rain now, until 11:30 IST');
    expect(rainSentence(chennai.indicators.rain, now)).toBe('Rain from 08:30 IST');
    expect(seaBreezeSentence(null)).toBe('Not a coastal district');
    expect(seaBreezeSentence({ likely: false, from: null, peakOnshoreMs: 1.2 })).toContain('No sea breeze expected');
    expect(seaBreezeSentence(chennai.indicators.seaBreeze, now)).toBe('Sea breeze likely from 11:30 IST, up to 3.8 m/s');
  });
});

describe('microclimate map colours', () => {
  it('reads each metric from the step values', () => {
    const v = valuesAt(chennai, 2);
    expect(metricById('feels').value(v)).toBe(37);
    expect(metricById('temp').value(v)).toBe(32);
    expect(metricById('wind').value(v)).toBeNull();
    expect(metricById('wind').value(valuesAt(chennai, 0))).toBeCloseTo(3 * 3.6);
  });
  it('points each field at its 1 km forecast layer', () => {
    expect(METRIC_LAYER.feels).toBe('feels');
    expect(METRIC_LAYER.rainNow).toBe('rain');
  });
});
