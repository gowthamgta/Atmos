import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFieldPixels } from './derived-fields';
import { decodeFieldBitmap } from './field-decode';
import { FieldLoaderService } from './field-loader.service';
import { ForecastCatalogService } from './forecast-catalog.service';
import { ForecastManifest } from './forecast.model';

/** What the test "downloads" for a picture: the value of each cell (null is "no data") and the range it is packed in. */
interface Picture {
  values: (number | null)[];
  min: number;
  max: number;
}

interface FakeBitmap {
  width: number;
  height: number;
  px: Uint8ClampedArray;
  close: () => void;
}

const GRID = { latMax: 14, latMin: 13, lonMin: 78, lonMax: 79, step: 1, nx: 2, ny: 2 };
const WIND_RANGE = { min: -90, max: 90 };
const same = (v: number): Picture => ({ values: [v, v, v, v], ...WIND_RANGE });
const noData: Picture = { values: [null, null, null, null], ...WIND_RANGE };

function bitmap(width: number, height: number, px: Uint8ClampedArray): FakeBitmap {
  return { width, height, px, close: vi.fn() };
}

/**
 * The loader on a manifest of ECMWF IFS pictures, with the browser's picture functions replaced: a download answers with the picture
 * the test gave for that variable, and a bitmap is just its packed pixels. The manifest lists the variables the pictures are given for, each
 * with its own range. `asked` lists what was downloaded ("u800/3": variable/hour).
 */
function setup(pictures: Record<string, Picture>, outcome: (attempt: number) => 'ok' | 'network' | number = () => 'ok') {
  let manifest: ForecastManifest = {
    model: 'ecmwf_ifs',
    run: '20261013T00Z',
    build: 'b1',
    grid: GRID,
    steps: [{ h: 0, valid: '2026-10-13T00:00:00Z' }, { h: 3, valid: '2026-10-13T03:00:00Z' }],
    vars: Object.fromEntries(Object.entries(pictures).map(([id, p]) => [id, { unit: '', min: p.min, max: p.max, encoding: 'rg16' as const }])),
  };
  const asked: string[] = [];
  let attempts = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    const [, id, hour] = /\/([a-z0-9]+)\/(\d+)\.png/.exec(url)!;
    asked.push(`${id}/${Number(hour)}`);
    const result = outcome(++attempts);
    if (result === 'network') throw new TypeError('Failed to fetch');
    if (result !== 'ok') return { ok: false, status: result, blob: async () => new Blob() };
    return { ok: true, status: 200, blob: async () => pictures[id] };
  });
  const refresh = vi.fn();
  vi.stubGlobal('createImageBitmap', async (source: Picture | { data: Uint8ClampedArray; width: number; height: number }) => {
    if ('values' in source) return bitmap(GRID.nx, GRID.ny, encodeFieldPixels(Float32Array.from(source.values, v => v ?? NaN), source.min, source.max));
    return bitmap(source.width, source.height, source.data);
  });
  vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
  vi.stubGlobal('OffscreenCanvas', class {
    width = 0;
    height = 0;
    getContext() {
      let drawn: FakeBitmap | null = null;
      return { clearRect: () => undefined, drawImage: (b: FakeBitmap) => { drawn = b; }, getImageData: () => ({ data: drawn!.px }) };
    }
  });
  TestBed.configureTestingModule({
    providers: [{
      provide: ForecastCatalogService,
      useValue: {
        manifest: () => manifest,
        fieldUrl: (id: string, hour: number) => `https://pages.example/ecmwf_ifs/20261013T00Z/${id}/${String(hour).padStart(3, '0')}.png`,
        isSynthesizedVar: () => false,
        refresh,
      },
    }],
  });
  const loader = TestBed.inject(FieldLoaderService);
  const cells = async (id: string, hour: number, range = WIND_RANGE) =>
    [...decodeFieldBitmap((await loader.get(id, hour)) as unknown as ImageBitmap, range.min, range.max)];
  return { loader, asked, cells, refresh, attempts: () => attempts, rebuild: (build: string) => (manifest = { ...manifest, build }) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  TestBed.resetTestingModule();
});

describe('FieldLoaderService, a download that fails', () => {
  it('is tried once more when the connection fails, so a hiccup does not leave the old numbers on the card', async () => {
    vi.useFakeTimers();
    const { cells, attempts } = setup({ t2m: same(30) }, n => (n === 1 ? 'network' : 'ok'));
    const got = cells('t2m', 0);
    await vi.advanceTimersByTimeAsync(500);
    expect((await got).every(v => Math.abs(v - 30) < 0.1)).toBe(true);
    expect(attempts()).toBe(2);
  });

  it('is tried once more when the server answers with an error of its own', async () => {
    vi.useFakeTimers();
    const { cells, attempts } = setup({ t2m: same(30) }, n => (n === 1 ? 503 : 'ok'));
    const got = cells('t2m', 0);
    await vi.advanceTimersByTimeAsync(500);
    expect((await got).length).toBeGreaterThan(0);
    expect(attempts()).toBe(2);
  });

  it('gives up after the second failure, and says why', async () => {
    vi.useFakeTimers();
    const { loader, attempts } = setup({ t2m: same(30) }, () => 500);
    const failed = loader.get('t2m', 0).then(() => 'loaded', (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(500);
    expect(await failed).toMatch(/^500 /);
    expect(attempts()).toBe(2);
  });

  it('is not tried again when the picture is not there (a newer run replaced it): the catalog is asked to look again', async () => {
    const { loader, attempts, refresh } = setup({ t2m: same(30) }, () => 404);
    await expect(loader.get('t2m', 0)).rejects.toThrow(/^404 /);
    expect(attempts()).toBe(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('FieldLoaderService, the levels between two others', () => {
  it('builds 800 hPa from 850 and 700 hPa, in ln p, when its published picture holds no data (the source has no such level)', async () => {
    const { cells } = setup({ u850: same(10), u700: same(20), u800: noData });
    const mix = Math.log(850 / 800) / Math.log(850 / 700);   // about 0.31 of the way up from 850 to 700
    for (const v of await cells('u800', 0)) expect(v).toBeCloseTo(10 + 10 * mix, 1);
  });

  it('uses a published 800 hPa picture that has data as it is, and downloads nothing else', async () => {
    const { cells, asked } = setup({ u800: { values: [5, 6, 7, 8], ...WIND_RANGE }, u850: same(10), u700: same(20) });
    const got = await cells('u800', 0);
    expect(got.map(v => Math.round(v))).toEqual([5, 6, 7, 8]);
    expect(asked).toEqual(['u800/0']);
  });

  it('knows from then on that the level is empty for the run, so its other pictures go straight to the levels either side', async () => {
    const { cells, asked } = setup({ u850: same(10), u700: same(20), u800: noData, v850: same(1), v700: same(3), v800: noData });
    await cells('u800', 0);
    asked.length = 0;
    await cells('u800', 3);
    await cells('v800', 0);
    expect(asked.filter(a => a.startsWith('u800') || a.startsWith('v800'))).toEqual([]);
    expect(asked.sort()).toEqual(['u700/3', 'u850/3', 'v700/0', 'v850/0']);
  });

  it('does the same for 600 hPa, from 700 and 500 hPa', async () => {
    // each level has its own range in a real run's manifest: t600 is packed in -18..12 whatever the levels either side use
    const { cells } = setup({
      t700: { values: [8, 8, 8, 8], min: -8, max: 22 },
      t500: { values: [-6, -6, -6, -6], min: -28, max: 2 },
      t600: { values: [null, null, null, null], min: -18, max: 12 },
    });
    const mix = Math.log(700 / 600) / Math.log(700 / 500);
    for (const v of await cells('t600', 0, { min: -18, max: 12 })) expect(v).toBeCloseTo(8 + (-6 - 8) * mix, 1);
  });

  it('leaves a level that is not between two others as it is, even with no data', async () => {
    const { cells, asked } = setup({ u850: noData, u700: same(20) });
    expect((await cells('u850', 0)).every(Number.isNaN)).toBe(true);
    expect(asked).toEqual(['u850/0']);
  });

  it('keeps the empty picture when the levels either side were not published either', async () => {
    const { cells, asked } = setup({ u800: noData });
    expect((await cells('u800', 0)).every(Number.isNaN)).toBe(true);
    expect(asked).toEqual(['u800/0']);
  });

  it('looks at a run built again afresh, since its source may have the level by then', async () => {
    const pictures: Record<string, Picture> = { u850: same(10), u700: same(20), u800: noData };
    const { cells, asked, rebuild } = setup(pictures);
    await cells('u800', 0);
    pictures['u800'] = { values: [30, 30, 30, 30], ...WIND_RANGE };
    rebuild('b2');
    asked.length = 0;
    for (const v of await cells('u800', 0)) expect(v).toBeCloseTo(30, 1);
    expect(asked).toEqual(['u800/0']);
  });
});
