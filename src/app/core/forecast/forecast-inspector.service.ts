import { Injectable, effect, inject, signal } from '@angular/core';
import { DistrictLookupService } from '../geo/district-lookup.service';
import { FieldLoaderService } from './field-loader.service';
import { ForecastCatalogService } from './forecast-catalog.service';
import { ForecastStateService } from './forecast-state.service';
import { bracketSteps } from './forecast.model';
import { sampleRg16Bitmap } from './bitmap-sampler';
import { PointForecast, blendTime, buildPointRows, inspectVars } from './point-forecast';
import { TerrainService } from './terrain.service';

/** Click-to-inspect: reads every forecast variable at a point, blended to the selected time. */
@Injectable({ providedIn: 'root' })
export class ForecastInspectorService {
  private readonly catalog = inject(ForecastCatalogService);
  private readonly loader = inject(FieldLoaderService);
  private readonly state = inject(ForecastStateService);
  private readonly terrain = inject(TerrainService);
  private readonly districts = inject(DistrictLookupService);

  /** The clicked location, or null when nothing is selected. */
  readonly selected = signal<{ lat: number; lon: number } | null>(null);
  readonly point = signal<PointForecast | null>(null);
  readonly busy = signal(false);

  private token = 0;

  constructor() {
    // Recompute whenever the point, the time or the model run changes (e.g. while scrubbing).
    effect(() => {
      const sel = this.selected();
      this.state.timeMs();
      this.state.level();
      this.catalog.manifest();
      if (!sel) {
        this.point.set(null);
        return;
      }
      void this.compute(sel.lat, sel.lon);
    });
    // Switching every forecast overlay off closes the card.
    effect(() => {
      if (!this.state.forecastActive()) this.close();
    });
  }

  select(lat: number, lon: number): void {
    this.selected.set({ lat, lon });
  }

  close(): void {
    this.selected.set(null);
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
        this.terrain.ensureLoaded().catch(() => null), // terrain is optional; values fall back to model resolution
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
      if (my !== this.token) return; // a newer request replaced this one
      const heights = this.terrain.heightsAt(lat, lon);
      this.point.set({
        lat,
        lon,
        district: place.district,
        state: place.state,
        elevationM: heights?.fine ?? null,
        timeMs: time,
        rows: buildPointRows(values, heights?.delta ?? null, level),
      });
    } catch (err) {
      console.warn('[forecast] inspect failed', err);
    } finally {
      if (my === this.token) this.busy.set(false);
    }
  }
}
