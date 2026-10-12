import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { PointSeriesService } from '../meteogram/point-series.service';
import { sampleRg16Bitmap } from './bitmap-sampler';
import { FieldLoaderService } from './field-loader.service';
import { ForecastCatalogService } from './forecast-catalog.service';
import { ForecastInspectorService } from './forecast-inspector.service';
import { ForecastManifest } from './forecast.model';
import { DayOutlook, istMidnight, outlookFromSeries, outlookIcon } from './outlook';
import { applyTerrain } from './terrain-correction';
import { TerrainService } from './terrain.service';

const DAYS = 5;
const OUTLOOK_DELAY_MS = 300;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** A step further than this from the wanted time is not used (the 6-hourly models are 3 h from their nearest step at worst). */
const MAX_GAP_MS = 3.5 * HOUR_MS;

/** A place as the series service keys it: to two decimals (about a kilometre). */
const placeKey = (lat: number, lon: number): string => `${lat.toFixed(2)},${lon.toFixed(2)}`;

/**
 * The outlook strip of the place card: for each of the next days the highest and lowest temperature, the rain and the cloud by day. It comes
 * from the hourly forecast of the shown model at the place (one answer of about 12 KB, the same one the meteogram uses), so the strip no longer
 * costs the twenty map pictures (3 MB) it took from the model's own daily fields. Only when that forecast cannot be had does it fall back to
 * those pictures (tmax24, tmin24, rain24, cloud), with the temperatures moved onto the 90 m ground. A day the model does not reach is left out.
 */
@Injectable({ providedIn: 'root' })
export class OutlookService {
  private readonly inspector = inject(ForecastInspectorService);
  private readonly catalog = inject(ForecastCatalogService);
  private readonly loader = inject(FieldLoaderService);
  private readonly terrain = inject(TerrainService);
  private readonly series = inject(PointSeriesService);

  readonly days = signal<DayOutlook[]>([]);
  readonly busy = signal(false);

  private token = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The place the fallback pictures were last read for (so a change of time or model does not read them again and again). */
  private fallbackFor = '';
  /** The place the strip on show belongs to ("11.74,78.96"). */
  private daysFor = '';

  constructor() {
    // a place is chosen: its hourly forecast is asked for, after a moment (and again after another, if the place changes meanwhile)
    effect(() => {
      const sel = this.inspector.selected();
      if (!sel) {
        this.cancel();
        this.busy.set(false);
        this.days.set([]);
        return;
      }
      untracked(() => this.schedule(sel.lat, sel.lon));
    });
    // the forecast of that place arrives (or does not): the strip is made from it, or from the pictures when it could not be had
    effect(() => {
      const sel = this.inspector.selected();
      const data = this.series.data();
      const status = this.series.status();
      const model = this.catalog.activeModelId();
      const manifest = this.catalog.manifest();
      if (!sel) return;
      const here = placeKey(sel.lat, sel.lon);
      const failed = this.series.failedFor() === here;
      const same = data && placeKey(data.lat, data.lon) === here;
      untracked(() => {
        if (same && status === 'ready') {
          this.fallbackFor = '';
          this.daysFor = here;
          this.days.set(outlookFromSeries(data, model, Date.now(), DAYS));
          this.busy.set(false);
        } else if (failed && status === 'error' && manifest && this.fallbackFor !== `${here},${manifest.run},${manifest.build}`) {
          this.fallbackFor = `${here},${manifest.run},${manifest.build}`;
          this.daysFor = here;
          void this.computeFromFields(sel.lat, sel.lon, manifest);
        }
      });
    });
  }

  /** Asks for the hourly forecast of the place; clicking about the map asks only for the place it comes to rest on. */
  private schedule(lat: number, lon: number): void {
    this.cancel();
    if (placeKey(lat, lon) !== this.daysFor) this.days.set([]);   // the days of another place are not shown while these come
    this.busy.set(this.days().length === 0);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.series.load(lat, lon);
    }, OUTLOOK_DELAY_MS);
  }

  private cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.token++; // a download already on its way is dropped when it ends
  }

  /** The fallback: the model's own daily pictures at the place (twenty of them), when the hourly forecast is not to be had. */
  private async computeFromFields(lat: number, lon: number, manifest: ForecastManifest): Promise<void> {
    const my = ++this.token;
    const g = manifest.grid;
    if (lat > g.latMax || lat < g.latMin || lon < g.lonMin || lon > g.lonMax) {
      this.days.set([]);
      this.busy.set(false);
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
        const bitmap = await this.loader.get(id, manifest.steps[i].h, 'low');
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
