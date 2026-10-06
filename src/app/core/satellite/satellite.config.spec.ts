import { describe, expect, it } from 'vitest';
import {
  EUMETVIEW_WMS,
  FY4B_BASE,
  FY4B_IR,
  FY4B_RGB,
  type Fy4Frame,
  fy4PictureUrl,
  fy4ProductFor,
  parseFy4State,
  SATELLITE_FRAME_COUNT,
  SATELLITE_HRV,
  SATELLITE_IR,
  SATELLITE_LAG_MIN,
  frameTimes,
  latestFrameTime,
  parseNewestTime,
  satelliteCapabilitiesUrl,
  productForTime,
  satelliteFrameUrl,
  sunElevationDeg,
} from './satellite.config';

const T = (iso: string) => Date.parse(iso);

describe('latestFrameTime', () => {
  it('lags the clock and lands on a 15-minute slot', () => {
    expect(latestFrameTime(T('2026-10-05T06:29:00Z'))).toBe(T('2026-10-05T06:00:00Z'));
    expect(latestFrameTime(T('2026-10-05T06:40:00Z'))).toBe(T('2026-10-05T06:15:00Z'));
    expect(latestFrameTime(T('2026-10-05T06:39:59Z'))).toBe(T('2026-10-05T06:00:00Z'));
  });

  it('never returns a frame younger than the lag', () => {
    for (let min = 0; min < 24 * 60; min += 7) {
      const now = T('2026-10-05T00:00:00Z') + min * 60_000;
      const latest = latestFrameTime(now);
      expect(now - latest).toBeGreaterThanOrEqual(SATELLITE_LAG_MIN * 60_000);
      expect(now - latest).toBeLessThan((SATELLITE_LAG_MIN + 15) * 60_000);
      expect(latest % (15 * 60_000)).toBe(0);
    }
  });
});

describe('frameTimes', () => {
  it('covers exactly the last hour: five pictures, 15 minutes apart', () => {
    expect(SATELLITE_FRAME_COUNT).toBe(5);
    const times = frameTimes(T('2026-10-05T06:15:00Z'));
    expect(times.at(-1)! - times[0]).toBe(60 * 60_000);
  });

  it('lists the loop oldest first, 15 minutes apart, ending on the latest', () => {
    const latest = T('2026-10-05T05:45:00Z');
    const times = frameTimes(latest);
    expect(times).toHaveLength(SATELLITE_FRAME_COUNT);
    expect(times.at(-1)).toBe(latest);
    expect(times[0]).toBe(latest - 4 * 15 * 60_000);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBe(15 * 60_000);
  });
});

describe('sunElevationDeg and productForTime', () => {
  it('has the sun high at local noon and well below the horizon at local midnight over South India', () => {
    // local solar noon at 79 E is about 06:45 UTC
    expect(sunElevationDeg(T('2026-10-05T06:45:00Z'), 13, 79)).toBeGreaterThan(65);
    expect(sunElevationDeg(T('2026-10-04T18:45:00Z'), 13, 79)).toBeLessThan(-55);
  });

  it('matches the equinox geometry (noon sun on the equator is overhead in March)', () => {
    expect(sunElevationDeg(T('2026-03-20T12:00:00Z'), 0, 0)).toBeGreaterThan(87);
  });

  it('uses HRV in daylight and infrared at night, in Indian time', () => {
    expect(productForTime(T('2026-10-05T05:30:00Z'))).toBe(SATELLITE_HRV); // 11:00 IST
    expect(productForTime(T('2026-10-05T20:00:00Z'))).toBe(SATELLITE_IR); // 01:30 IST
    expect(productForTime(T('2026-10-05T14:00:00Z'))).toBe(SATELLITE_IR); // 19:30 IST, dark
  });

  it('switches to HRV after sunrise and back to infrared by evening', () => {
    // in early October the sun rises near 06:00 IST (00:30 UTC) and sets near 18:00 IST (12:30 UTC)
    expect(productForTime(T('2026-10-05T00:00:00Z'))).toBe(SATELLITE_IR); // 05:30 IST
    expect(productForTime(T('2026-10-05T02:00:00Z'))).toBe(SATELLITE_HRV); // 07:30 IST
    expect(productForTime(T('2026-10-05T11:00:00Z'))).toBe(SATELLITE_HRV); // 16:30 IST
    expect(productForTime(T('2026-10-05T13:00:00Z'))).toBe(SATELLITE_IR); // 18:30 IST
  });
});

describe('satelliteFrameUrl', () => {
  const url = new URL(satelliteFrameUrl(SATELLITE_HRV, T('2026-10-05T05:30:00Z')));

  it('asks the public EUMETView map service for the HRV RGB at an explicit time', () => {
    expect(`${url.origin}${url.pathname}`).toBe(EUMETVIEW_WMS);
    expect(url.searchParams.get('layers')).toBe('msg_iodc:rgb_eview');
    expect(url.searchParams.get('time')).toBe('2026-10-05T05:30:00Z');
    expect(url.searchParams.get('request')).toBe('GetMap');
    expect(url.searchParams.get('format')).toBe('image/jpeg');
  });

  it('uses the infrared layer for night frames', () => {
    expect(new URL(satelliteFrameUrl(SATELLITE_IR, T('2026-10-05T20:00:00Z'))).searchParams.get('layers')).toBe('msg_iodc:ir108');
  });

  it('orders the box south, west, north, east as WMS 1.3.0 needs for EPSG:4326', () => {
    expect(url.searchParams.get('crs')).toBe('EPSG:4326');
    expect(url.searchParams.get('bbox')).toBe('4,68,22,90');
  });

  it('never contains a key, token or secret', () => {
    for (const p of [SATELLITE_HRV, SATELLITE_IR]) {
      expect(satelliteFrameUrl(p, T('2026-10-05T05:30:00Z')).toLowerCase()).not.toMatch(/key|token|secret|auth/);
    }
  });
});

describe('parseNewestTime', () => {
  it('reads the end of the time range the service lists', () => {
    const xml = '<Layer><Dimension name="time" default="2026-10-05T06:15:00Z" units="ISO8601" nearestValue="1">2022-03-29T00:00:00.000Z/2026-10-05T06:15:00.000Z/PT15M</Dimension></Layer>';
    expect(parseNewestTime(xml)).toBe(T('2026-10-05T06:15:00Z'));
  });

  it('reads a plain list of times and picks the newest', () => {
    const xml = '<Dimension name="time" units="ISO8601">2026-10-05T05:45:00Z,2026-10-05T06:15:00Z,2026-10-05T06:00:00Z</Dimension>';
    expect(parseNewestTime(xml)).toBe(T('2026-10-05T06:15:00Z'));
  });

  it('returns null when there is no time dimension or it cannot be read', () => {
    expect(parseNewestTime('<Capabilities></Capabilities>')).toBeNull();
    expect(parseNewestTime('<Dimension name="time">not a date</Dimension>')).toBeNull();
    expect(parseNewestTime('')).toBeNull();
  });

  it('asks the capabilities of the layer being shown', () => {
    expect(satelliteCapabilitiesUrl(SATELLITE_IR)).toContain('/msg_iodc/ir108/ows?');
    expect(satelliteCapabilitiesUrl(SATELLITE_HRV)).toContain('/msg_iodc/rgb_eview/ows?');
  });
});

describe('FY-4B pictures', () => {
  const frame = (time: string, extra: object = {}) => ({ time, kind: 'day', hd: `${time.slice(0, 10)}.jpg`, lite: `${time.slice(0, 10)}_lite.jpg`, ...extra });

  it('keeps the frames that are readable, oldest first', () => {
    const state = {
      frames: [
        frame('2026-10-06T05:30:00Z'),
        frame('2026-10-06T05:15:00Z'),
        frame('not a time'),
        frame('2026-10-06T05:45:00Z', { kind: 'dusk' }),
        frame('2026-10-06T05:00:00Z', { hd: '../secret.jpg' }),
        frame('2026-10-06T05:20:00Z', { lite: undefined }),
      ],
    };
    expect(parseFy4State(state).map(f => f.time)).toEqual(['2026-10-06T05:15:00Z', '2026-10-06T05:30:00Z']);
    expect(parseFy4State(null)).toEqual([]);
    expect(parseFy4State({ frames: 'x' })).toEqual([]);
  });

  it('picks the picture size by device and the product by day or night', () => {
    const f = frame('2026-10-06T05:15:00Z') as Fy4Frame;
    expect(fy4PictureUrl(f, false)).toBe(`${FY4B_BASE}/${f.hd}`);
    expect(fy4PictureUrl(f, true)).toBe(`${FY4B_BASE}/${f.lite}`);
    expect(fy4ProductFor(f)).toBe(FY4B_RGB);
    expect(fy4ProductFor({ ...f, kind: 'night' })).toBe(FY4B_IR);
    expect(FY4B_RGB.source).toBe('fy4b');
    expect(SATELLITE_HRV.source).toBe('meteosat');
  });
});
