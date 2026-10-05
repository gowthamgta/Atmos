import { EffectRef, Injectable, Injector, effect, inject } from '@angular/core';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { ScalarFieldLayer } from '../rendering/scalar-field.layer';
import { FieldLoaderService } from './field-loader.service';
import { ForecastCatalogService } from './forecast-catalog.service';
import { ForecastStateService } from './forecast-state.service';
import { bracketSteps } from './forecast.model';

/**
 * Owns the forecast GL layer on the map: mounts it, and keeps it showing the right two field images
 * and blend weight for the selected layer and time. The map component only calls attach()/detach().
 */
@Injectable({ providedIn: 'root' })
export class ForecastMapController {
  private readonly injector = inject(Injector);
  private readonly catalog = inject(ForecastCatalogService);
  private readonly loader = inject(FieldLoaderService);
  private readonly state = inject(ForecastStateService);

  private map: MapLibreMap | null = null;
  private layer: ScalarFieldLayer | null = null;
  private effectRef: EffectRef | null = null;
  /** Bumped on every update so slow downloads for an old selection are dropped. */
  private token = 0;

  /** Mount the layer below `beforeId` (so boundaries and labels stay on top). */
  attach(map: MapLibreMap, beforeId?: string): void {
    this.detach();
    this.map = map;
    this.layer = new ScalarFieldLayer();
    map.addLayer(this.layer, beforeId);
    this.effectRef = effect(() => this.update(), { injector: this.injector });
  }

  detach(): void {
    this.effectRef?.destroy();
    this.effectRef = null;
    this.token++;
    if (this.map && this.layer && this.map.getLayer(this.layer.id)) this.map.removeLayer(this.layer.id);
    this.layer = null;
    this.map = null;
  }

  private update(): void {
    const layer = this.layer;
    const def = this.state.activeLayer();
    const manifest = this.catalog.manifest();
    const time = this.state.timeMs();
    const validTimes = this.catalog.validTimes();
    if (!layer) return;
    if (!def || !manifest || time === null || validTimes.length === 0) {
      layer.setLayer(null);
      return;
    }
    const info = manifest.vars[def.varId];
    if (!info) {
      console.warn(`[forecast] variable ${def.varId} missing from run ${manifest.run}`);
      layer.setLayer(null);
      return;
    }

    const my = ++this.token;
    const { a, b, mix } = bracketSteps(validTimes, time);
    const hA = manifest.steps[a].h;
    const hB = manifest.steps[b].h;
    const run = manifest.run;

    void Promise.all([this.loader.get(def.varId, hA), this.loader.get(def.varId, hB)])
      .then(([bmpA, bmpB]) => {
        if (my !== this.token || !this.layer) return; // a newer selection replaced this one
        layer.setGrid(manifest.grid);
        layer.setLayer(def, [info.min, info.max]);
        layer.setFrames(
          { key: `${run}/${def.varId}/${hA}`, bitmap: bmpA },
          { key: `${run}/${def.varId}/${hB}`, bitmap: bmpB },
          mix
        );
        // Warm the neighbours so scrubbing and playback stay smooth.
        const ahead = manifest.steps.slice(Math.max(a - 1, 0), b + 3).map(s => s.h);
        this.loader.prefetch(def.varId, ahead);
      })
      .catch(err => console.warn('[forecast] field load failed', err));
  }
}
