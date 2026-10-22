import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { SteeringWindService } from '../forecast/steering-wind.service';
import { BOT_CAPTURE, NowcastCell, publishNowcast } from '../ui/bot-capture';
import { isPhone } from '../ui/device-profile';
import { MapLayerService } from './map-layer.service';
import { RadarService } from './radar.service';
import {
  CONE_MINUTES,
  MAX_STORM_SPEED_KMH,
  StormCell,
  cellPlace,
  detectCells,
  displacementToMotion,
  estimateMotion,
  motionAt,
  offset,
  stormCone,
  windToMotion,
} from './storm-tracking';

type Position = [number, number];
interface Feature {
  type: 'Feature';
  geometry: { type: 'Polygon'; coordinates: Position[][] } | { type: 'LineString'; coordinates: Position[] } | { type: 'Point'; coordinates: Position };
  properties: Record<string, string | number | boolean>;
}
export interface StormFeatureCollection {
  type: 'FeatureCollection';
  features: Feature[];
}

/** How the storms' motion was found: by following them on the radar, or from the forecast steering wind. */
export type MotionSource = 'radar' | 'wind';

export interface StormSummary {
  count: number;
  source: MotionSource | null;
}

/** Storms slower than this are drawn without a cone (their position barely changes in an hour). */
const MIN_CONE_SPEED_KMH = 5;
/** Older frame used for motion: about half an hour before, and at least a quarter of an hour. */
const MOTION_LOOKBACK_MIN = 30;
const MOTION_MIN_GAP_MIN = 15;
const MAX_CELLS = 30;
const EMPTY: StormFeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * Storm cells on the radar picture being shown (live or a loop frame) and the cone each one is expected to sweep over
 * the next hour. Results are cached per picture, so playing the loop does not recompute them.
 */
@Injectable({ providedIn: 'root' })
export class StormTracksService {
  private readonly radar = inject(RadarService);
  private readonly layers = inject(MapLayerService);
  private readonly steering = inject(SteeringWindService);

  readonly enabled = signal(true);
  readonly geojson = signal<StormFeatureCollection>(EMPTY);
  readonly summary = signal<StormSummary>({ count: 0, source: null });
  readonly visible = computed(() => this.enabled() && this.layers.layers().some(l => l.id === 'radar' && l.active));

  private readonly cache = new Map<string, { geojson: StormFeatureCollection; summary: StormSummary; cells: NowcastCell[] }>();
  private token = 0;

  /**
   * The loop is loaded once, in the background, so the cells move the way the radar shows them and not with the forecast wind. Not on a phone:
   * the two animations are about 8 MB of mobile data (measured, e2e/perf.mjs); there the cells move with the steering wind until the live pictures
   * kept as they arrive (or Play) give the radar's own motion.
   */
  private loopRequested = false;

  constructor() {
    effect(() => {
      const on = this.visible();
      const live = this.radar.compositeMosaic();
      if (!on || !live || this.loopRequested || (isPhone() && !BOT_CAPTURE)) return;
      untracked(() => {
        if (this.radar.history().length > 0 || this.radar.historyLoading()) return;
        this.loopRequested = true;
        void this.radar.loadHistory();
      });
    });
    effect(() => {
      const on = this.visible();
      const index = this.radar.playIndex();
      const history = this.radar.history();
      const live = this.radar.compositeMosaic();
      if (!on) return;
      untracked(() => void this.update(index, history.length, live?.timing?.epochMs ?? null));
    });
  }

  toggle(): void {
    this.enabled.update(v => !v);
  }

  private async update(index: number | null, historyLength: number, liveMs: number | null): Promise<void> {
    const my = ++this.token;
    const history = this.radar.history();
    const current = index !== null && history[index] ? history[index] : this.radar.liveTrack();
    if (!current) {
      this.publish(EMPTY, { count: 0, source: null });
      return;
    }
    const key = `${this.radar.activeProduct()}|${current.timeMs}|${historyLength}|${liveMs}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.publish(hit.geojson, hit.summary);
      if (index === null) this.publishLive(current.timeMs, hit.summary, history.length, hit.cells);
      return;
    }

    const grid = this.radar.trackGrid();
    const cells = detectCells(current.track, grid.nx, grid.ny).slice(0, MAX_CELLS);

    // motion from the radar itself when an older picture of the loop is available
    const target = current.timeMs - MOTION_LOOKBACK_MIN * 60_000;
    const prev = history
      .filter(f => current.timeMs - f.timeMs >= MOTION_MIN_GAP_MIN * 60_000)
      .sort((a, b) => Math.abs(a.timeMs - target) - Math.abs(b.timeMs - target))[0];
    let motion: ((c: StormCell, lat: number) => { speedKmh: number; towardsDeg: number } | null) | null = null;
    let source: MotionSource | null = null;
    if (prev && cells.length > 0) {
      const minutes = (current.timeMs - prev.timeMs) / 60_000;
      const maxShift = Math.ceil((MAX_STORM_SPEED_KMH * minutes) / 60 / (grid.step * 111.2));
      const vectors = estimateMotion(prev.track, current.track, grid.nx, grid.ny, maxShift);
      motion = (c, lat) => {
        const m = motionAt(c.x, c.y, vectors);
        return m ? displacementToMotion(m.dx, m.dy, minutes, grid, lat) : null;
      };
      source = 'radar';
    }

    const features: Feature[] = [];
    const found: NowcastCell[] = [];
    let usedWind = false;
    for (const c of cells) {
      const { lat, lon, radiusKm } = cellPlace(c, grid);
      let m = motion?.(c, lat) ?? null;
      if (!m) {
        const wind = await this.steering.at(lat, lon, current.timeMs);
        if (my !== this.token) return;
        if (wind) {
          m = windToMotion(wind[0], wind[1]);
          usedWind = true;
        }
      }
      features.push(...this.stormFeatures(c, lat, lon, m, grid.step));
      found.push({
        lat, lon, dbz: Math.round(12 + c.peak * 9.6), radiusKm,
        speedKmh: m ? Math.round(m.speedKmh) : null, towardsDeg: m ? Math.round(m.towardsDeg) : null,
      });
    }
    if (my !== this.token) return;
    const summary: StormSummary = { count: cells.length, source: source ?? (usedWind ? 'wind' : null) };
    const geojson: StormFeatureCollection = { type: 'FeatureCollection', features };
    if (this.cache.size > 40) this.cache.clear();
    this.cache.set(key, { geojson, summary, cells: found });
    this.publish(geojson, summary);
    if (index === null) this.publishLive(current.timeMs, summary, history.length, found);
  }

  /** The live picture's cells, for the nowcast bot (only in bot mode, see bot-capture.ts). */
  private publishLive(timeMs: number, summary: StormSummary, historyLength: number, cells: NowcastCell[]): void {
    publishNowcast({ radarTimeMs: timeMs, motionSource: summary.source, loopLoaded: historyLength > 0, cells });
  }

  private publish(geojson: StormFeatureCollection, summary: StormSummary): void {
    this.geojson.set(geojson);
    this.summary.set(summary);
  }

  /** Cone, track line, 15-minute marks and the storm's label. */
  private stormFeatures(c: StormCell, lat: number, lon: number, m: { speedKmh: number; towardsDeg: number } | null, step: number): Feature[] {
    const radiusKm = Math.max(3, c.radius * step * 111.2);
    const dbz = Math.round(12 + c.peak * 9.6);
    const severe = c.peak >= 4.4;
    const out: Feature[] = [];
    const moving = m !== null && m.speedKmh >= MIN_CONE_SPEED_KMH;
    if (moving) {
      out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [stormCone(lat, lon, radiusKm, m!.speedKmh, m!.towardsDeg)] }, properties: { kind: 'cone', severe } });
      const end = offset(lat, lon, (m!.speedKmh * CONE_MINUTES) / 60, m!.towardsDeg);
      out.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[lon, lat], end] }, properties: { kind: 'track', severe } });
      for (const min of [15, 30, 45, 60]) {
        out.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: offset(lat, lon, (m!.speedKmh * min) / 60, m!.towardsDeg) },
          properties: { kind: 'tick', label: `${min}′`, severe },
        });
      }
    }
    const speed = m ? `${Math.round(m.speedKmh)} km/h → ${compass(m.towardsDeg)}` : '';
    out.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { kind: 'cell', severe, label: moving ? `${dbz} dBZ · ${speed}` : `${dbz} dBZ${m ? ' · slow' : ''}` },
    });
    return out;
  }
}

function compass(deg: number): string {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}
