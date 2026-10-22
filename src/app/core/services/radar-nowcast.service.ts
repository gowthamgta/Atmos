import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { SteeringWindService } from '../forecast/steering-wind.service';
import { MapLayerService } from './map-layer.service';
import { MotionBox, MotionField, kmhToDegPerHour, uniformMotionField } from './radar-motion';
import { FieldBox, NOWCAST_LEADS_MIN, NowcastSkill, TrackFrame, motionBetween, verifyNowcast } from './radar-nowcast';
import { NowcastFrame, RadarService } from './radar.service';
import { windToMotion } from './storm-tracking';

const yieldToBrowser = () => new Promise<void>(r => setTimeout(r, 0));
const MINUTE = 60_000;

/** How the rain is moving, and where that came from. */
export interface RainMotion {
  field: MotionField;
  /** `radar`: followed between two radar pictures; `wind`: no earlier picture to follow it by, so it moves with the forecast steering wind. */
  source: 'radar' | 'wind';
  /** The time between the two pictures (radar only). */
  minutes: number | null;
  /** The time of the live picture it was found for. */
  atMs: number;
}

/**
 * Where the rain is going: its motion over the radar picture, found between the live picture and one 15 to 40 minutes older (from the last-hour
 * loop, or from live pictures kept since the page opened), or from the steering wind when there is none. While the radar is on it also slides
 * the live picture ahead (the nowcast, handed to RadarService for the map and the time bar) and checks how that guess would have done on the
 * last hour. Whatever needs the motion without the radar on (the rain line of the place card) asks to keep it with `wanted`.
 */
@Injectable({ providedIn: 'root' })
export class RadarNowcastService {
  private readonly radar = inject(RadarService);
  private readonly layers = inject(MapLayerService);
  private readonly steering = inject(SteeringWindService);

  readonly motion = signal<RainMotion | null>(null);
  readonly skill = signal<NowcastSkill | null>(null);
  readonly working = signal(false);
  /** Set by anything that needs the motion while the radar layer is off. */
  readonly wanted = signal(false);

  private readonly radarOn = computed(() => this.layers.layers().some(l => l.id === 'radar' && l.active));
  /** Live pictures seen since the page opened, for the motion before the loop has been built. */
  private readonly recent: TrackFrame[] = [];
  private token = 0;
  private lastKey = '';

  constructor() {
    effect(() => {
      const on = this.radarOn();
      const keep = this.wanted();
      const liveMs = this.radar.compositeMosaic()?.timing?.epochMs ?? null;
      const loop = this.radar.history().length;
      if (!(on || keep) || liveMs === null) {
        untracked(() => this.clear());
        return;
      }
      untracked(() => void this.update(liveMs, loop, on));
    });
  }

  private clear(): void {
    this.token++;
    this.lastKey = '';
    this.motion.set(null);
    this.skill.set(null);
    this.working.set(false);
    if (this.radar.nowcast().length > 0) this.radar.nowcast.set([]);
    if (this.radar.leadIndex() !== null) this.radar.leadIndex.set(null);
  }

  private remember(frame: TrackFrame): void {
    const last = this.recent[this.recent.length - 1];
    if (last && frame.timeMs - last.timeMs < 4 * MINUTE) return;
    this.recent.push(frame);
    while (this.recent.length > 8 || (this.recent.length > 1 && frame.timeMs - this.recent[0].timeMs > 2 * 60 * MINUTE)) this.recent.shift();
  }

  private async update(liveMs: number, loop: number, withFrames: boolean): Promise<void> {
    const key = `${this.radar.activeProduct()}|${liveMs}|${loop}|${withFrames}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const my = ++this.token;
    this.working.set(true);
    try {
      const live = this.radar.liveTrack();
      const mosaic = this.radar.compositeMosaic();
      if (!live || !mosaic?.displayField) return;
      this.remember(live);
      const grid = this.radar.trackGrid();
      const box: MotionBox = { south: grid.north - grid.ny * grid.step, west: grid.west, north: grid.north, east: grid.west + grid.nx * grid.step };
      const others: TrackFrame[] = [
        ...this.radar.history().map(f => ({ timeMs: f.timeMs, track: f.track })),
        ...this.recent.filter(f => f.timeMs < live.timeMs),
      ];
      // the older picture: about half an hour before, and at least a quarter of an hour
      const aim = live.timeMs - 30 * MINUTE;
      const prev = others.filter(f => live.timeMs - f.timeMs >= 15 * MINUTE).sort((a, b) => Math.abs(a.timeMs - aim) - Math.abs(b.timeMs - aim))[0];
      await yieldToBrowser();
      if (my !== this.token) return;
      let found: RainMotion | null = null;
      if (prev) {
        const minutes = (live.timeMs - prev.timeMs) / MINUTE;
        const field = motionBetween(prev.track, live.track, grid, minutes, box);
        if (field) found = { field, source: 'radar', minutes, atMs: live.timeMs };
      }
      if (!found) {
        const lat = (box.south + box.north) / 2;
        const wind = await this.steering.at(lat, (box.west + box.east) / 2, live.timeMs);
        if (my !== this.token) return;
        if (wind) {
          const m = windToMotion(wind[0], wind[1]);
          const d = kmhToDegPerHour(m.speedKmh, m.towardsDeg, lat);
          found = { field: uniformMotionField(box, d.u, d.v), source: 'wind', minutes: null, atMs: live.timeMs };
        }
      }
      this.motion.set(found);
      if (!withFrames || !found) {
        if (this.radar.nowcast().length > 0) this.radar.nowcast.set([]);
        this.skill.set(null);
        return;
      }
      const c = mosaic.coordinates;
      const fieldBox: FieldBox = { west: c[0][0], north: c[0][1], east: c[1][0], south: c[2][1], width: mosaic.fieldData.cropW, height: mosaic.fieldData.cropH };
      // all the leads at once, off the main thread (radar-compute.ts)
      const pictures = await this.radar.compute.nowcast({ field: mosaic.displayField, box: fieldBox, motion: found.field, leads: NOWCAST_LEADS_MIN, outScale: 2 });
      if (my !== this.token) return;
      const frames: NowcastFrame[] = pictures.map(pic => ({
        field: pic.field, width: pic.width, height: pic.height, coordinates: mosaic.coordinates, timeMs: live.timeMs + pic.lead * MINUTE, leadMin: pic.lead,
      }));
      this.radar.nowcast.set(frames);
      this.skill.set(others.length >= 3 ? verifyNowcast([...others, live], grid, box, 30) : null);
    } finally {
      if (my === this.token) this.working.set(false);
    }
  }
}
