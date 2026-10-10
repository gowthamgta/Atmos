import { describe, expect, it } from 'vitest';
import { MetarRecord, RainGauge, ageLabel, compassPoint, distanceKm, latestReports, nearestAirport, nearestGauge } from './observations';

const gauge = (n: string, la: number, lo: number, t: number | null = 1): RainGauge => ({ n, d: 'X', la, lo, t, pk: null, pt: null, h: 24 });
const report = (station: string, lat: number, lon: number, time = '2026-10-10T06:00:00Z'): MetarRecord => ({
  station, name: station, lat, lon, time, temp_c: 30, dewp_c: 22, rh_pct: 60, wind_dir: 250, wind_kt: 8, gust_kt: null, pressure_hpa: 1010,
});

describe('observations near a point', () => {
  it('measures distance on the globe', () => {
    expect(distanceKm(11, 78, 11, 78)).toBe(0);
    expect(distanceKm(11, 78, 12, 78)).toBeCloseTo(111.2, 0); // one degree of latitude
  });

  it('picks the closest gauge inside the radius, skipping gauges with no reading', () => {
    const gauges = [gauge('far', 11.5, 78), gauge('near', 11.05, 78), gauge('nearer-but-empty', 11.01, 78, null)];
    const hit = nearestGauge(gauges, 11, 78);
    expect(hit?.item.n).toBe('near');
    expect(hit!.km).toBeCloseTo(5.6, 0);
    expect(nearestGauge([gauge('far', 11.5, 78)], 11, 78)).toBeNull(); // 55 km: too far to speak for the point
  });

  it('uses each airport\'s newest report and the closest airport in range', () => {
    const file = {
      stations: {
        VOSM: [report('VOSM', 11.78, 78.07, '2026-10-10T04:00:00Z'), report('VOSM', 11.78, 78.07, '2026-10-10T05:00:00Z')],
        VOMM: [report('VOMM', 13, 80.2)],
        EMPTY: [],
      },
    };
    const reports = latestReports(file);
    expect(reports.map(r => r.time)).toEqual(['2026-10-10T05:00:00Z', '2026-10-10T06:00:00Z']);
    expect(nearestAirport(reports, 11.74, 78.96)?.item.station).toBe('VOSM');
    expect(nearestAirport(reports, 8.5, 77.5)).toBeNull(); // Kanyakumari: no airport in range
  });

  it('names wind directions and ages', () => {
    expect(compassPoint(0)).toBe('N');
    expect(compassPoint(250)).toBe('WSW');
    expect(compassPoint(359)).toBe('N');
    expect(compassPoint('VRB')).toBe('variable');
    expect(compassPoint(null)).toBe('');
    const now = Date.parse('2026-10-10T06:00:00Z');
    expect(ageLabel('2026-10-10T05:20:00Z', now)).toBe('40 min ago');
    expect(ageLabel('2026-10-10T03:00:00Z', now)).toBe('3 h ago');
  });
});
