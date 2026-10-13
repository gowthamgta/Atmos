import { describe, expect, it } from 'vitest';
import { SATELLITE_BOUNDS } from './satellite.config';
import {
  REFERENCE_KM_PER_PX,
  SatelliteWindow,
  WINDOW_KM_PER_PX,
  WINDOW_LOSSLESS_MAX_PX,
  chooseWindow,
  kmPerPixel,
  metresPerPixel,
  pictureScale,
} from './satellite-window';

const PHONE = { maxPx: 1024, globalKmPerPx: kmPerPixel(SATELLITE_BOUNDS, 1000) };
const DESKTOP = { maxPx: 1600, globalKmPerPx: kmPerPixel(SATELLITE_BOUNDS, 2000) };
const view = (lat: number, lon: number, zoom: number, width = 412, height = 800) => ({ lat, lon, zoom, width, height });

describe('the scale of the map and of the pictures', () => {
  it('has a screen pixel halve with each zoom, and shrink with the cosine of the latitude', () => {
    expect(metresPerPixel(0, 0)).toBeCloseTo(40_075_016.686 / 512, 1);
    expect(metresPerPixel(0, 5)).toBeCloseTo(metresPerPixel(0, 4) / 2, 6);
    expect(metresPerPixel(60, 7)).toBeCloseTo(metresPerPixel(0, 7) / 2, 3);
  });

  it('puts the whole-India picture at about 1.5 km a pixel on a desktop and 3 km on a phone', () => {
    expect(REFERENCE_KM_PER_PX).toBeGreaterThan(1.45);
    expect(REFERENCE_KM_PER_PX).toBeLessThan(1.6);
    expect(DESKTOP.globalKmPerPx).toBeCloseTo(REFERENCE_KM_PER_PX, 6);
    expect(PHONE.globalKmPerPx).toBeCloseTo(2 * REFERENCE_KM_PER_PX, 6);
  });

  it('scales the picture processing by how fine the pixels are: 1 for the desktop picture, a half for the phone, a little over 1 for a window', () => {
    expect(pictureScale(SATELLITE_BOUNDS, 2000)).toBeCloseTo(1, 6);
    expect(pictureScale(SATELLITE_BOUNDS, 1000)).toBeCloseTo(0.5, 6);
    const w = chooseWindow(view(11.2, 78.4, 7.5), PHONE)!;
    expect(pictureScale(w.bounds, w.size.width)).toBeGreaterThan(1);
    expect(pictureScale(w.bounds, w.size.width)).toBeLessThan(1.5);
  });

  it('asks for no finer pixel than the satellite has: the service pads a finer picture with repeated pixels, which show as streaks', () => {
    expect(WINDOW_KM_PER_PX).toBeGreaterThanOrEqual(1.2);
    expect(WINDOW_KM_PER_PX).toBeLessThanOrEqual(1.5);
  });
});

describe('chooseWindow', () => {
  it('wants none while the map is zoomed out: the main picture is as fine as a window could be', () => {
    expect(chooseWindow(view(20, 80, 3.5), PHONE)).toBeNull();
    expect(chooseWindow(view(20, 80, 4.5), PHONE)).toBeNull();
    expect(chooseWindow(view(20, 80, 5), DESKTOP, null)).toBeNull();
  });

  it('never gives a desktop a window: its 1.5 km picture is already as fine as the satellite is', () => {
    for (const z of [4, 6, 7, 8.5, 10, 12]) expect(chooseWindow(view(11.2, 78.4, z, 1400, 800), DESKTOP)).toBeNull();
  });

  it('gives a phone a window at the zoom of a state, at about the satellite pixel', () => {
    const w = chooseWindow(view(11.2, 78.4, 7.5), PHONE)!;
    expect(w).not.toBeNull();
    expect(w.kmPerPx).toBeLessThan(WINDOW_KM_PER_PX * 1.15);
    expect(w.kmPerPx).toBeGreaterThanOrEqual(WINDOW_KM_PER_PX - 0.01);
    expect(w.size.width).toBeLessThanOrEqual(PHONE.maxPx);
    expect(w.size.height).toBeLessThanOrEqual(PHONE.maxPx * 1.05);
    // finer than the 3 km of the phone's main picture by more than twice
    expect(PHONE.globalKmPerPx / w.kmPerPx).toBeGreaterThan(2.2);
  });

  it('keeps a deep-zoom window small enough to come as a lossless PNG, and a state-sized one is a JPEG', () => {
    const deep = chooseWindow(view(11.7, 79, 10), PHONE)!;
    expect(deep.size.width * deep.size.height).toBeLessThanOrEqual(WINDOW_LOSSLESS_MAX_PX);
    const state = chooseWindow(view(11.2, 78.4, 7.5), PHONE)!;
    expect(state.size.width * state.size.height).toBeGreaterThan(WINDOW_LOSSLESS_MAX_PX);
  });

  it('holds the whole view with room to spare on every side', () => {
    const v = view(11.2, 78.4, 7.5);
    const w = chooseWindow(v, PHONE)!;
    const kmPerPx = metresPerPixel(v.lat, v.zoom) / 1000;
    const latHalf = (v.height * kmPerPx) / 2 / 111.32;
    const lonHalf = (v.width * kmPerPx) / 2 / (111.32 * Math.cos((v.lat * Math.PI) / 180));
    expect(w.bounds.south).toBeLessThan(v.lat - latHalf);
    expect(w.bounds.north).toBeGreaterThan(v.lat + latHalf);
    expect(w.bounds.west).toBeLessThan(v.lon - lonHalf);
    expect(w.bounds.east).toBeGreaterThan(v.lon + lonHalf);
  });

  it('stays inside the satellite picture, sliding at the edge instead of running off it', () => {
    for (const [lat, lon] of [[5.6, 68.4], [37, 97], [6, 96.5], [36.5, 69]]) {
      const w = chooseWindow(view(lat, lon, 7), PHONE)!;
      expect(w).not.toBeNull();
      expect(w.bounds.south).toBeGreaterThanOrEqual(SATELLITE_BOUNDS.south);
      expect(w.bounds.north).toBeLessThanOrEqual(SATELLITE_BOUNDS.north);
      expect(w.bounds.west).toBeGreaterThanOrEqual(SATELLITE_BOUNDS.west);
      expect(w.bounds.east).toBeLessThanOrEqual(SATELLITE_BOUNDS.east);
    }
  });

  it('asks for a picture whose pixels are square on the ground', () => {
    const w = chooseWindow(view(11.2, 78.4, 7.5), PHONE)!;
    const eastWest = ((w.bounds.east - w.bounds.west) * 111.32 * Math.cos((((w.bounds.north + w.bounds.south) / 2) * Math.PI) / 180)) / w.size.width;
    const northSouth = ((w.bounds.north - w.bounds.south) * 111.32) / w.size.height;
    expect(eastWest).toBeCloseTo(northSouth, 1);
  });

  it('keeps the same window while the view moves about inside it, so a pan does not fetch', () => {
    const first = chooseWindow(view(11.2, 78.4, 7.5), PHONE)!;
    for (const [dLat, dLon, dz] of [[0.2, 0, 0], [0, -0.3, 0], [0.15, 0.2, 0.2], [-0.2, 0.1, -0.2]]) {
      expect(chooseWindow(view(11.2 + dLat, 78.4 + dLon, 7.5 + dz), PHONE, first)).toBe(first);
    }
  });

  it('chooses another window when the view leaves it, or is zoomed out past it', () => {
    const first = chooseWindow(view(11.2, 78.4, 7.5), PHONE)!;
    const moved = chooseWindow(view(11.2 + 4, 78.4, 7.5), PHONE, first)!;
    expect(moved.id).not.toBe(first.id);
    const zoomedOut = chooseWindow(view(11.2, 78.4, 6.6), PHONE, first)!;
    expect(zoomedOut.id).not.toBe(first.id);
    expect(zoomedOut.spanKm).toBeGreaterThan(first.spanKm);
  });

  it('keeps a window that is already as fine as the data goes when the map zooms in further, and replaces a coarse one', () => {
    const fine = chooseWindow(view(11.2, 78.4, 7.5), PHONE)!;
    expect(fine.kmPerPx).toBeLessThan(WINDOW_KM_PER_PX * 1.15);
    expect(chooseWindow(view(11.2, 78.4, 9.5), PHONE, fine)).toBe(fine);
    // made zoomed out, where the biggest picture a phone asks for is spread over a wide window, so its pixel is coarser
    const coarse = chooseWindow(view(11.2, 78.4, 6), PHONE)!;
    expect(coarse.kmPerPx).toBeGreaterThan(WINDOW_KM_PER_PX * 1.5);
    const zoomedIn = chooseWindow(view(11.2, 78.4, 8.5), PHONE, coarse)!;
    expect(zoomedIn.id).not.toBe(coarse.id);
    expect(zoomedIn.kmPerPx).toBeLessThan(coarse.kmPerPx);
  });

  it('gives the same window to nearby views, and names it by its box', () => {
    const a = chooseWindow(view(11.21, 78.41, 7.5), PHONE)!;
    const b = chooseWindow(view(11.3, 78.5, 7.5), PHONE)!;
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^[\d.]+,[\d.]+,[\d.]+,[\d.]+$/);
    const far = chooseWindow(view(15, 74, 7.5), PHONE)!;
    expect(far.id).not.toBe(a.id);
  });

  it('is no coarser as the zoom grows', () => {
    let last: SatelliteWindow | null = null;
    for (const z of [6.5, 7, 7.5, 8, 9, 10]) {
      const w = chooseWindow(view(11.2, 78.4, z), PHONE)!;
      expect(w).not.toBeNull();
      if (last) expect(w.kmPerPx).toBeLessThanOrEqual(last.kmPerPx + 0.01); // pixel counts are whole numbers, so the pixel size wobbles a little
      last = w;
    }
  });
});
