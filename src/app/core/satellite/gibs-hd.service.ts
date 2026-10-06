import { Injectable, computed, signal } from '@angular/core';
import {
  GIBS_DEFAULT_SENSOR,
  GIBS_PROBE_TILE,
  GIBS_SENSORS,
  GibsSensor,
  gibsDate,
  gibsTemplate,
  gibsTileUrl,
  isEmptyTile,
} from './gibs-hd';

/** Days back the picture can be set to, counting today. */
export const GIBS_DAYS = [0, 1, 2] as const;

/**
 * State of the high-detail satellite layer: which instrument, which day, opacity. A day's picture only exists once the
 * satellite has passed over (and its data is processed, a few hours later), so when the layer is switched on, or the
 * instrument changed, the newest day that already has a picture is chosen.
 */
@Injectable({ providedIn: 'root' })
export class GibsHdService {
  readonly sensorId = signal(GIBS_DEFAULT_SENSOR);
  /** 0 is today (UTC), 1 yesterday... */
  readonly daysAgo = signal(1);
  readonly opacity = signal(1);
  /** True while the newest day with a picture is being looked for. */
  readonly checking = signal(false);
  private readonly now = signal(Date.now());
  private token = 0;

  readonly sensor = computed<GibsSensor>(() => GIBS_SENSORS.find(s => s.id === this.sensorId()) ?? GIBS_SENSORS[0]);
  readonly date = computed(() => gibsDate(this.now(), this.daysAgo()));
  /** Tile template for the map. */
  readonly template = computed(() => gibsTemplate(this.sensor().layer, this.date()));
  readonly days = computed(() => GIBS_DAYS.map(d => ({ daysAgo: d, date: gibsDate(this.now(), d) })));

  /** Choose the newest day that has a picture (today, else yesterday, else the day before). */
  async pickNewestDay(): Promise<void> {
    const token = ++this.token;
    this.now.set(Date.now());
    this.checking.set(true);
    try {
      for (const d of GIBS_DAYS) {
        if (await this.hasPicture(this.sensor(), gibsDate(this.now(), d))) {
          if (token === this.token) this.daysAgo.set(d);
          return;
        }
      }
      if (token === this.token) this.daysAgo.set(1);
    } finally {
      if (token === this.token) this.checking.set(false);
    }
  }

  async setSensor(id: string): Promise<void> {
    if (id === this.sensorId()) return;
    this.sensorId.set(id);
    await this.pickNewestDay();
  }

  setDay(daysAgo: number): void {
    this.token++; // a manual choice wins over a search in progress
    this.checking.set(false);
    this.daysAgo.set(daysAgo);
  }

  /** Whether the instrument has a picture over the region on a date: a tile in the middle of it is not empty. */
  private async hasPicture(sensor: GibsSensor, date: string): Promise<boolean> {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return true;
    try {
      const { z, x, y } = GIBS_PROBE_TILE;
      const res = await fetch(gibsTileUrl(sensor.layer, date, z, x, y));
      if (!res.ok) return false;
      const bitmap = await createImageBitmap(await res.blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0);
      const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      bitmap.close();
      return !isEmptyTile(px);
    } catch {
      return true; // cannot tell (offline?): do not skip a day because of it
    }
  }
}
