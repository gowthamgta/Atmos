import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DistrictLookupService } from '../geo/district-lookup.service';
import { METRIC } from '../units/units';
import { UnitsService } from '../units/units.service';
import { ConsensusService } from './consensus.service';
import { encodeFieldPixels } from './derived-fields';
import { FieldLoaderService } from './field-loader.service';
import { ForecastCatalogService } from './forecast-catalog.service';
import { ForecastInspectorService, STALE_AFTER_MS } from './forecast-inspector.service';
import { ForecastStateService } from './forecast-state.service';
import { ForecastManifest } from './forecast.model';
import { TerrainService } from './terrain.service';

const HOUR = 3_600_000;
const RUN_START = Date.parse('2026-10-13T06:00:00Z');
const hourMs = (h: number) => RUN_START + h * HOUR;

const MANIFEST: ForecastManifest = {
  model: 'ecmwf_ifs',
  run: '20261013T06Z',
  build: 'b1',
  grid: { latMax: 12, latMin: 11, lonMin: 78, lonMax: 79, step: 0.25, nx: 5, ny: 5 },
  steps: Array.from({ length: 9 }, (_, i) => ({ h: i * 3, valid: new Date(hourMs(i * 3)).toISOString().replace('.000Z', 'Z') })),
  vars: {
    t2m: { unit: '°C', min: -10, max: 50, encoding: 'rg16' },
    raintot: { unit: 'mm', min: 0, max: 1500, encoding: 'rg16' },
  },
};

/** The picture of a variable at a forecast hour: every cell the same, the running rain total being as many mm as the hour. */
const valueOf = (id: string, hour: number) => (id === 'raintot' ? hour : 20);

/**
 * The inspector, with the things it reads replaced: the pictures come at once ('quick'), only when the test lets them ('slow'), or not
 * at all ('fail'); the rain period is the two signals the test moves. The place card shows `point` and the pin's bubble follows it.
 */
function setup() {
  let mode: 'quick' | 'slow' | 'fail' = 'quick';
  const waiting: (() => void)[] = [];
  const bitmapOf = (id: string, hour: number) => {
    const info = MANIFEST.vars[id];
    return { px: encodeFieldPixels(Float32Array.of(...Array(4).fill(valueOf(id, hour))), info.min, info.max) } as unknown as ImageBitmap;
  };
  const loader = {
    get: vi.fn((id: string, hour: number): Promise<ImageBitmap> => {
      if (mode === 'fail') return Promise.reject(new Error(`500 ${id}/${hour}`));
      if (mode === 'quick') return Promise.resolve(bitmapOf(id, hour));
      return new Promise(resolve => waiting.push(() => resolve(bitmapOf(id, hour))));
    }),
  };
  vi.stubGlobal('OffscreenCanvas', class {
    getContext() {
      let block: Uint8ClampedArray = new Uint8ClampedArray(16);
      return { clearRect: () => undefined, drawImage: (b: { px: Uint8ClampedArray }) => { block = b.px; }, getImageData: () => ({ data: block }) };
    }
  });
  const state = {
    timeMs: signal(hourMs(6)),
    level: signal('surface'),
    activeLayerId: signal<string | null>('raintot'),
    activeLayer: signal({ id: 'raintot', varId: 'raintot', terrain: 'rain' }),
    rangeStartMs: signal<number | null>(hourMs(3)),
    rangeEndMs: signal<number | null>(hourMs(12)),
    playing: signal(false),
    forecastActive: signal(true),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: FieldLoaderService, useValue: loader },
      { provide: ForecastStateService, useValue: state },
      {
        provide: ForecastCatalogService,
        useValue: { manifest: signal(MANIFEST), status: () => 'ready', validTimes: () => MANIFEST.steps.map(s => Date.parse(s.valid)), model: () => ({ groundKm: 9 }) },
      },
      { provide: TerrainService, useValue: { ensureLoaded: () => Promise.resolve({}), prepareAt: () => Promise.resolve(), pointTerrain: () => null } },
      { provide: DistrictLookupService, useValue: { lookup: async () => ({ district: 'Kallakurichi', state: 'Tamil Nadu' }) } },
      { provide: ConsensusService, useValue: { compute: async () => null } },
      { provide: UnitsService, useValue: { units: signal(METRIC) } },
    ],
  });
  const inspector = TestBed.inject(ForecastInspectorService);
  inspector.skipHome();
  const settle = async (ms = 200) => {
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(ms);
  };
  return {
    inspector,
    state,
    settle,
    rain: () => inspector.point()?.values['rainrange'],
    mode: (m: 'quick' | 'slow' | 'fail') => { mode = m; },
    /** The pictures that were being waited for arrive; the ones asked for from now on come at once. */
    release: () => { mode = 'quick'; waiting.splice(0).forEach(arrive => arrive()); },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  TestBed.resetTestingModule();
});

describe('ForecastInspectorService, the rain in the chosen period', () => {
  it('is the running total at the end minus the one at the start, read at the place', async () => {
    vi.useFakeTimers();
    const { inspector, settle, rain } = setup();
    inspector.select(11.5, 78.5);
    await settle();
    expect(rain()).toBeCloseTo(9, 1);              // 12 mm at hour 12, 3 mm at hour 3
    expect(inspector.stale()).toBe(false);
  });

  it('follows the period when an end of it moves, as quickly as the pictures come', async () => {
    vi.useFakeTimers();
    const { inspector, state, settle, rain } = setup();
    inspector.select(11.5, 78.5);
    await settle();
    state.rangeEndMs.set(hourMs(18));
    await settle();
    expect(rain()).toBeCloseTo(15, 1);
    expect(inspector.stale()).toBe(false);
  });
});

describe('ForecastInspectorService, numbers that belong to an earlier period', () => {
  it('are marked out of date when the new ones are slow, so the old number is not taken for the new period; then they are replaced', async () => {
    vi.useFakeTimers();
    const { inspector, state, settle, rain, mode, release } = setup();
    inspector.select(11.5, 78.5);
    await settle();
    expect(rain()).toBeCloseTo(9, 1);

    mode('slow');                                   // the pictures of the new period are still downloading
    state.rangeEndMs.set(hourMs(18));
    await settle(150);                              // the new answer has been asked for
    await vi.advanceTimersByTimeAsync(STALE_AFTER_MS - 200);
    expect(inspector.stale()).toBe(false);          // not long enough to say anything yet
    expect(rain()).toBeCloseTo(9, 1);
    await vi.advanceTimersByTimeAsync(400);
    expect(inspector.stale()).toBe(true);           // the 9 mm is for the old period
    expect(rain()).toBeCloseTo(9, 1);

    release();
    await settle();
    await settle();
    expect(rain()).toBeCloseTo(15, 1);
    expect(inspector.stale()).toBe(false);
  });

  it('stay marked when the new ones could not be read, until a later answer succeeds', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { inspector, state, settle, rain, mode } = setup();
    inspector.select(11.5, 78.5);
    await settle();

    mode('fail');
    state.rangeEndMs.set(hourMs(18));
    await settle(600);
    expect(inspector.stale()).toBe(true);
    expect(rain()).toBeCloseTo(9, 1);
    expect(warn).toHaveBeenCalled();

    mode('quick');
    state.rangeEndMs.set(hourMs(21));
    await settle(600);
    expect(rain()).toBeCloseTo(18, 1);
    expect(inspector.stale()).toBe(false);
  });

  it('are not marked once the card is closed', async () => {
    vi.useFakeTimers();
    const { inspector, settle, mode } = setup();
    inspector.select(11.5, 78.5);
    await settle();
    mode('fail');
    inspector.select(11.6, 78.6);
    await settle(600);
    expect(inspector.stale()).toBe(true);
    inspector.close();
    await settle();
    expect(inspector.point()).toBeNull();
    expect(inspector.stale()).toBe(false);
  });
});
