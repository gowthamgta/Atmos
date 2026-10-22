import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { MapLayerService } from './map-layer.service';
import { CoverageGrid, coverageAt, coverageCorners, coverageHaze, parseCoverageMeta } from './radar-coverage';

/** Width of the haze picture: about 1 km a pixel, plenty for a haze whose edges are soft anyway. */
const HAZE_WIDTH = 1100;

export interface CoverageOverlay {
  /** The haze as a PNG data address for the map's image source. */
  url: string;
  /** Corners [lng, lat]: NW, NE, SE, SW. */
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
}

/**
 * Where the radars can see low rain (see radar-coverage.ts). The small grid is loaded the first time the radar is shown; the haze over the
 * map is no longer drawn (its switch was taken out of the radar panel).
 */
@Injectable({ providedIn: 'root' })
export class RadarCoverageService {
  private readonly layers = inject(MapLayerService);

  /** The haze is not drawn any more (the switch left the radar panel); the grid is still used for the rain line on the place card. */
  readonly enabled = signal(false);
  readonly grid = signal<CoverageGrid | null>(null);
  private readonly radarOn = computed(() => this.layers.layers().some(l => l.id === 'radar' && l.active));
  /** The haze is drawn while the radar is on and the switch is on. */
  readonly visible = computed(() => this.enabled() && this.radarOn());
  /** The haze picture for the map (null until the grid has loaded). */
  readonly overlay = computed<CoverageOverlay | null>(() => {
    // drawn only while it is shown: the picture took a third of a second on a phone (measured), for a haze that is switched off
    if (!this.visible()) return null;
    const grid = this.grid();
    return grid ? drawHaze(grid) : null;
  });
  private loading: Promise<void> | null = null;

  constructor() {
    effect(() => {
      if (this.radarOn()) void this.load();
    });
  }

  /** How well the radars see low rain at a place (a COVERAGE_* class), or null while the grid is not loaded. */
  classAt(lat: number, lon: number): number | null {
    const grid = this.grid();
    return grid ? coverageAt(grid, lat, lon) : null;
  }

  load(): Promise<void> {
    this.loading ??= this.fetchGrid().catch(() => {
      this.loading = null; // try again the next time the radar is shown
    });
    return this.loading;
  }

  private async fetchGrid(): Promise<void> {
    const [metaRes, pngRes] = await Promise.all([fetch('/data/radar-coverage.json'), fetch('/data/radar-coverage.png')]);
    if (!metaRes.ok || !pngRes.ok) throw new Error('radar coverage not available');
    const meta = parseCoverageMeta(await metaRes.json());
    if (!meta) throw new Error('radar coverage: unreadable description');
    const bitmap = await createImageBitmap(await pngRes.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    if (bitmap.width !== meta.nx || bitmap.height !== meta.ny) throw new Error('radar coverage: picture and description disagree');
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bitmap.width, bitmap.height) : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
    ctx.drawImage(bitmap, 0, 0); // 1:1, so the class numbers survive
    const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const classes = new Uint8Array(meta.nx * meta.ny);
    for (let i = 0; i < classes.length; i++) classes[i] = Math.min(3, Math.round(px[i * 4]));
    this.grid.set({ meta, classes });
  }
}

function drawHaze(grid: CoverageGrid): CoverageOverlay | null {
  if (typeof document === 'undefined') return null;
  const { width, height, pixels } = coverageHaze(grid, HAZE_WIDTH);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  return { url: canvas.toDataURL('image/png'), coordinates: coverageCorners(grid.meta) };
}
