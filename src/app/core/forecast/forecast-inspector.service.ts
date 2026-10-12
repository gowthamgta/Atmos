import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { DistrictLookupService } from '../geo/district-lookup.service';
import { FieldLoaderService } from './field-loader.service';
import { ForecastCatalogService } from './forecast-catalog.service';
import { ForecastStateService } from './forecast-state.service';
import { bracketSteps } from './forecast.model';
import { sampleRg16Bitmap } from './bitmap-sampler';
import { PointForecast, blendTime, buildPointRows, inspectVars } from './point-forecast';
import { TerrainService } from './terrain.service';
import { ConsensusService } from './consensus.service';
import { HOME } from '../geo/home';
import { UnitsService } from '../units/units.service';
import { INDIA_GRID, nearestValue } from './derived-fields';

/** Click-to-inspect: reads every forecast variable at a point, blended to the selected time. */
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
  private homeDone = false;
  readonly busy = signal(false);

  private token = 0;

  constructor() {
    // Recompute whenever the point, the time or the model run changes (e.g. while scrubbing).
    effect(() => {
      const sel = this.selected();
      this.state.timeMs();
      this.state.level();
      this.catalog.manifest();
      this.state.activeLayerId(); // the rain period and the all-models category are worked out only while their layer is on
      this.state.rangeStartMs();
      this.state.rangeEndMs();
      this.unitsService.units(); // the rows are text in the chosen units
      if (!sel) {
        this.point.set(null);
        return;
      }
      void this.compute(sel.lat, sel.lon);
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
      const values: Record<string, number> = {};
      await Promise.all(
        inspectVars(level).map(async id => {
          const info = manifest.vars[id];
          if (!info) {
            values[id] = NaN; // this model does not publish the variable (e.g. gusts on AIFS)
            return;
          }
          const [bmpA, bmpB] = await Promise.all([this.loader.get(id, hA), this.loader.get(id, hB)]);
          values[id] = blendTime(
            sampleRg16Bitmap(bmpA, g, lat, lon, info.min, info.max),
            sampleRg16Bitmap(bmpB, g, lat, lon, info.min, info.max),
            mix
          );
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
      if (layerId === 'extreme') {
        const agreed = await this.consensus.compute(time);
        if (agreed) values['extreme'] = nearestValue(agreed.values, INDIA_GRID, lat, lon);
      }
      if (my !== this.token) return; // a newer request replaced this one
      const ground = this.terrain.pointTerrain(lat, lon, this.catalog.model().gridKm);
      this.point.set({
        lat,
        lon,
        district: place.district,
        state: place.state,
        elevationM: ground?.fine ?? null,
        timeMs: time,
        rows: buildPointRows(values, ground, level, { timeMs: time, lat, lon }, this.unitsService.units()),
        values: { ...values },
      });
    } catch (err) {
      console.warn('[forecast] inspect failed', err);
    } finally {
      if (my === this.token) this.busy.set(false);
    }
  }
}
