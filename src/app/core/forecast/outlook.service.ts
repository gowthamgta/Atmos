import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { sampleRg16Bitmap } from './bitmap-sampler';
import { FieldLoaderService } from './field-loader.service';
import { ForecastCatalogService } from './forecast-catalog.service';
import { ForecastInspectorService } from './forecast-inspector.service';
import { ForecastManifest } from './forecast.model';
import { DayOutlook, istMidnight, outlookIcon } from './outlook';
import { applyTerrain } from './terrain-correction';
import { TerrainService } from './terrain.service';

const DAYS = 5;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** A step further than this from the wanted time is not used (the 6-hourly models are 3 h from their nearest step at worst). */
const MAX_GAP_MS = 3.5 * HOUR_MS;

/**
 * The outlook strip of the place card: for each of the next days the highest and lowest temperature, the rain and the cloud at midday, from
 * the shown model's own daily pictures (tmax24, tmin24, rain24, cloud). A day the model does not reach is left out. Temperatures are moved
 * onto the 90 m ground like everywhere else.
 */
@Injectable({ providedIn: 'root' })
export class OutlookService {
  private readonly inspector = inject(ForecastInspectorService);
  private readonly catalog = inject(ForecastCatalogService);
  private readonly loader = inject(FieldLoaderService);
  private readonly terrain = inject(TerrainService);

  readonly days = signal<DayOutlook[]>([]);
  readonly busy = signal(false);

  private token = 0;

  constructor() {
    effect(() => {
      const sel = this.inspector.selected();
      const manifest = this.catalog.manifest();
      if (!sel || !manifest) {
        this.days.set([]);
        return;
      }
      untracked(() => void this.compute(sel.lat, sel.lon, manifest));
    });
  }

  private async compute(lat: number, lon: number, manifest: ForecastManifest): Promise<void> {
    const my = ++this.token;
    const g = manifest.grid;
    if (lat > g.latMax || lat < g.latMin || lon < g.lonMin || lon > g.lonMax) {
      this.days.set([]);
      return;
    }
    this.busy.set(true);
    try {
      await this.terrain.ensureLoaded().then(() => this.terrain.prepareAt(lat, lon)).catch(() => null); // the ground is optional
      const dz = this.terrain.pointTerrain(lat, lon, this.catalog.model().gridKm)?.dz ?? null;
      const valid = manifest.steps.map(s => Date.parse(s.valid));
      const nearest = (t: number): number => {
        let best = -1;
        let gap = Infinity;
        valid.forEach((v, i) => {
          if (Math.abs(v - t) < gap) {
            gap = Math.abs(v - t);
            best = i;
          }
        });
        return gap <= MAX_GAP_MS ? best : -1;
      };
      const read = async (id: string, t: number): Promise<number | null> => {
        const info = manifest.vars[id];
        const i = nearest(t);
        if (!info || i < 0) return null;
        const bitmap = await this.loader.get(id, manifest.steps[i].h);
        const v = sampleRg16Bitmap(bitmap, g, lat, lon, info.min, info.max);
        return Number.isNaN(v) ? null : v;
      };
      const today = istMidnight(Date.now());
      const weekday = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short' });
      const days = await Promise.all(
        Array.from({ length: DAYS }, async (_, d): Promise<DayOutlook | null> => {
          const dayStart = today + d * DAY_MS;
          const from = Math.max(dayStart, valid[0]); // today starts at the run's first step when the run began after midnight
          const [hi, lo, rain, cloud] = await Promise.all([read('tmax24', from), read('tmin24', from), read('rain24', from), read('cloud', Math.max(dayStart + 12 * HOUR_MS, valid[0]))]);
          if (hi === null && lo === null && rain === null) return null;
          const adjust = (c: number | null) => (c === null ? null : applyTerrain('temperature', c, dz));
          return { startMs: dayStart, weekday: weekday.format(dayStart + 12 * HOUR_MS).toUpperCase(), tmax: adjust(hi), tmin: adjust(lo), rainMm: rain, cloud, icon: outlookIcon(rain, cloud) };
        })
      );
      if (my === this.token) this.days.set(days.filter((x): x is DayOutlook => x !== null));
    } catch (err) {
      console.warn('[forecast] outlook failed', err);
    } finally {
      if (my === this.token) this.busy.set(false);
    }
  }
}
