import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { DistrictLookupService } from '../geo/district-lookup.service';
import { FieldLoaderService } from './field-loader.service';
import { ForecastCatalogService } from './forecast-catalog.service';
import { ForecastStateService } from './forecast-state.service';
import { bracketSteps, sampleGrid } from './forecast.model';
import { sampleRg16Bitmap } from './bitmap-sampler';
import { PointForecast, blendTime, buildPointRows, inspectVars, summaryVars } from './point-forecast';
import { TerrainService } from './terrain.service';
import { ConsensusService } from './consensus.service';
import { HOME } from '../geo/home';
import { UnitsService } from '../units/units.service';
import { INDIA_GRID } from './derived-fields';

/** How often the card is worked out again while only the time changes: dragging the time bar, and playing the forecast. */
export const SCRUB_INTERVAL_MS = 140;
export const PLAY_INTERVAL_MS = 900;
/** The full list of values is much bigger (every variable at two steps), so it follows the time bar more slowly. */
export const DETAIL_INTERVAL_MS = 350;

/** Click-to-inspect: reads the forecast variables at a point, blended to the selected time. */
@Injectable({ providedIn: 'root' })
export class ForecastInspectorService {
  private readonly catalog = inject(ForecastCatalogService);
  private readonly loader = inject(FieldLoaderService);
  private readonly state = inject(ForecastStateService);
  private readonly terrain = inject(TerrainService);
  private readonly districts = inject(DistrictLookupService);
  private readonly consensus = inject(ConsensusService);
  private readonly unitsService = inject(UnitsService);

  /** The clicked location, or null when nothing is selected. */
  readonly selected = signal<{ lat: number; lon: number } | null>(null);
  readonly point = signal<PointForecast | null>(null);
  /** The name of the place when it was chosen by name (a search result); null when the point was clicked on the map. */
  readonly label = signal<string | null>(null);
  /** The full list of values is wanted (the place card has "All values" open). Otherwise only the summary is read. */
  readonly detail = signal(false);
  private homeDone = false;
  readonly busy = signal(false);
  /** How many of the variables wanted for the full list have been read (the card says so while it waits). */
  readonly progress = signal<{ done: number; total: number }>({ done: 0, total: 0 });

  private token = 0;
  private lastKey = '';
  private lastRunAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Recompute whenever the point, the time or the model run changes (e.g. while scrubbing).
    effect(() => {
      const sel = this.selected();
      const time = this.state.timeMs();
      const level = this.state.level();
      const manifest = this.catalog.manifest();
      const layerId = this.state.activeLayerId(); // the rain period and the all-models category are worked out only while their layer is on
      this.state.rangeStartMs(); // dragging the ends of the period moves the card like the time does: rate-limited, not in the key
      this.state.rangeEndMs();
      const detail = this.detail();
      const units = Object.values(this.unitsService.units()).join(','); // the rows are text in the chosen units
      if (!sel) {
        this.cancelPending();
        this.point.set(null);
        return;
      }
      // anything but the time is a new question and is answered at once; the time alone moves a lot (a drag, a play) and is rate-limited
      const key = [sel.lat, sel.lon, level, manifest?.run, manifest?.build, layerId, detail, units].join('|');
      const onlyTime = key === this.lastKey && time !== null;
      this.lastKey = key;
      untracked(() => this.request(onlyTime));
    });
    // the card opens on the home place the first time a forecast is on screen (windy.com starts on a place too), and never again after
    // it has been closed
    effect(() => {
      if (this.homeDone || this.catalog.status() !== 'ready' || !this.state.forecastActive() || this.selected()) return;
      untracked(() => {
        this.homeDone = true;
        this.select(HOME.lat, HOME.lon, HOME.name);
      });
    });
    // Switching every forecast overlay off closes the card.
    effect(() => {
      if (!this.state.forecastActive()) this.close();
    });
  }

  /** A place was chosen another way (a shared link): the card does not open on the home place as well. */
  skipHome(): void {
    this.homeDone = true;
  }

  select(lat: number, lon: number, label: string | null = null): void {
    this.label.set(label);
    this.selected.set({ lat, lon });
  }

  close(): void {
    this.selected.set(null);
    this.label.set(null);
    this.detail.set(false);
  }

  /** Works out the card now, or (when only the time has moved and it was worked out a moment ago) once the interval is over. */
  private request(onlyTime: boolean): void {
    const interval = this.state.playing() ? PLAY_INTERVAL_MS : this.detail() ? DETAIL_INTERVAL_MS : SCRUB_INTERVAL_MS;
    const due = this.lastRunAt + interval - performance.now();
    if (!onlyTime || due <= 0) {
      this.cancelPending();
      this.run();
    } else if (this.timer === null) {
      // one trailing run is enough: it reads the time as it is when it runs
      this.timer = setTimeout(() => {
        this.timer = null;
        this.run();
      }, due);
    }
  }

  private cancelPending(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private run(): void {
    const sel = this.selected();
    this.lastRunAt = performance.now();
    if (sel) void this.compute(sel.lat, sel.lon);
  }

  private async compute(lat: number, lon: number): Promise<void> {
    const manifest = this.catalog.manifest();
    const time = this.state.timeMs();
    if (!manifest || time === null) return;
    const g = manifest.grid;
    if (lat > g.latMax || lat < g.latMin || lon < g.lonMin || lon > g.lonMax) {
      this.point.set(null); // outside the forecast domain
      return;
    }
    const my = ++this.token;
    this.busy.set(true);
    try {
      const { a, b, mix } = bracketSteps(this.catalog.validTimes(), time);
      const hA = manifest.steps[a].h;
      const hB = manifest.steps[b].h;
      const [place] = await Promise.all([
        this.districts.lookup(lat, lon),
        this.terrain.ensureLoaded().then(() => this.terrain.prepareAt(lat, lon)).catch(() => null), // terrain is optional; values fall back to model resolution
      ]);
      const level = this.state.level();
      const detailed = this.detail();
      const wanted = detailed ? inspectVars(level) : summaryVars(this.state.activeLayer());
      const values: Record<string, number> = {};
      let done = 0;
      if (detailed) this.progress.set({ done: 0, total: wanted.length });
      await Promise.all(
        wanted.map(async id => {
          const info = manifest.vars[id];
          if (!info) {
            values[id] = NaN; // this model does not publish the variable (e.g. gusts on AIFS)
          } else {
            const [bmpA, bmpB] = await Promise.all([this.loader.get(id, hA, 'low'), this.loader.get(id, hB, 'low')]);
            values[id] = blendTime(
              sampleRg16Bitmap(bmpA, g, lat, lon, info.min, info.max),
              sampleRg16Bitmap(bmpB, g, lat, lon, info.min, info.max),
              mix
            );
          }
          done++;
          if (detailed && my === this.token) this.progress.set({ done, total: wanted.length });
        })
      );
      // the two layers worked out in the browser: the rain in the chosen period, and the category every model agrees on
      const layerId = this.state.activeLayerId();
      const from = this.state.rangeStartMs();
      const to = this.state.rangeEndMs();
      const totalInfo = manifest.vars['raintot'];
      if (layerId === 'raintot' && totalInfo && from !== null && to !== null) {
        const validTimes = this.catalog.validTimes();
        const totalAt = async (t: number): Promise<number> => {
          const s = bracketSteps(validTimes, t);
          const [x, y] = await Promise.all([this.loader.get('raintot', manifest.steps[s.a].h), this.loader.get('raintot', manifest.steps[s.b].h)]);
          return blendTime(sampleRg16Bitmap(x, g, lat, lon, totalInfo.min, totalInfo.max), sampleRg16Bitmap(y, g, lat, lon, totalInfo.min, totalInfo.max), s.mix);
        };
        const [atEnd, atStart] = await Promise.all([totalAt(to), totalAt(from)]);
        values['rainrange'] = Math.max(0, atEnd - atStart);
      }
      if (layerId === 'extreme' || detailed) {
        const agreed = await this.consensus.compute(time);
        if (agreed) values['extreme'] = sampleGrid(agreed.values, agreed.grid ?? INDIA_GRID, lat, lon);
      }
      if (my !== this.token) return; // a newer request replaced this one
      const ground = this.terrain.pointTerrain(lat, lon, this.catalog.model().groundKm, manifest.grid);
      this.point.set({
        lat,
        lon,
        district: place.district,
        state: place.state,
        elevationM: ground?.fine ?? null,
        timeMs: time,
        rows: buildPointRows(values, ground, level, { timeMs: time, lat, lon }, this.unitsService.units()),
        values: { ...values },
        detailed,
      });
    } catch (err) {
      console.warn('[forecast] inspect failed', err);
    } finally {
      if (my === this.token) this.busy.set(false);
    }
  }
}
