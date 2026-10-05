import { EffectRef, Injectable, Injector, effect, inject } from '@angular/core';
import { Marker } from 'maplibre-gl';
import type { Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl';
import { ScalarFieldLayer } from '../rendering/scalar-field.layer';
import { WindParticlesLayer } from '../rendering/wind-particles.layer';
import { decodeFieldBitmap } from './field-decode';
import { FieldLoaderService } from './field-loader.service';
import { ForecastCatalogService } from './forecast-catalog.service';
import { ForecastInspectorService } from './forecast-inspector.service';
import { ForecastStateService } from './forecast-state.service';
import { TerrainService } from './terrain.service';
import { bracketSteps } from './forecast.model';

/**
 * Owns the forecast GL layers on the map (colour field and wind particles): mounts them, and keeps them showing
 * the right field images and blend weight for the selected layer and time. The map component only calls
 * attach()/detach().
 */
@Injectable({ providedIn: 'root' })
export class ForecastMapController {
  private readonly injector = inject(Injector);
  private readonly catalog = inject(ForecastCatalogService);
  private readonly loader = inject(FieldLoaderService);
  private readonly state = inject(ForecastStateService);
  private readonly terrain = inject(TerrainService);
  private readonly inspector = inject(ForecastInspectorService);

  private map: MapLibreMap | null = null;
  private layer: ScalarFieldLayer | null = null;
  private windLayer: WindParticlesLayer | null = null;
  private effects: EffectRef[] = [];
  private marker: Marker | null = null;
  /** Bumped on every update so slow downloads for an old selection are dropped. */
  private token = 0;
  private windToken = 0;

  /** Mount the layers below `beforeId` (so boundaries and labels stay on top). */
  attach(map: MapLibreMap, beforeId?: string): void {
    this.detach();
    this.map = map;
    this.layer = new ScalarFieldLayer();
    map.addLayer(this.layer, beforeId);
    this.windLayer = new WindParticlesLayer(window.innerWidth < 700 ? 4500 : 9000);
    map.addLayer(this.windLayer, beforeId); // added second, so the streaks draw over the colour field
    map.on('click', this.onMapClick);
    this.effects = [
      effect(() => this.update(), { injector: this.injector }),
      effect(() => this.updateWind(), { injector: this.injector }),
      effect(() => this.syncMarker(), { injector: this.injector }),
    ];
  }

  detach(): void {
    this.effects.forEach(e => e.destroy());
    this.effects = [];
    this.map?.off('click', this.onMapClick);
    this.marker?.remove();
    this.marker = null;
    this.token++;
    this.windToken++;
    for (const l of [this.layer, this.windLayer]) {
      if (this.map && l && this.map.getLayer(l.id)) this.map.removeLayer(l.id);
    }
    this.layer = null;
    this.windLayer = null;
    this.map = null;
  }

  /** Clicking the map while a forecast overlay is shown inspects that point. */
  private readonly onMapClick = (e: MapMouseEvent): void => {
    if (this.state.forecastActive()) this.inspector.select(e.lngLat.lat, e.lngLat.lng);
  };

  private syncMarker(): void {
    const sel = this.inspector.selected();
    if (!this.map || !sel) {
      this.marker?.remove();
      this.marker = null;
      return;
    }
    if (!this.marker) {
      const el = document.createElement('div');
      el.className = 'forecast-pin';
      el.style.cssText =
        'width:14px;height:14px;border-radius:50%;background:#00e5ff;border:2px solid #fff;box-shadow:0 0 0 3px rgba(0,229,255,.35),0 2px 6px rgba(0,0,0,.6);';
      this.marker = new Marker({ element: el }).setLngLat([sel.lon, sel.lat]).addTo(this.map);
    } else {
      this.marker.setLngLat([sel.lon, sel.lat]);
    }
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
    // 1 km terrain for the per-pixel height correction (loaded once, only when a layer uses it)
    const terrainData = this.terrain.data();
    layer.setTerrain(terrainData);
    if (def.terrain && !terrainData) {
      this.terrain.ensureLoaded().catch(err => console.warn('[forecast] terrain unavailable; showing model resolution', err));
    }

    const info = manifest.vars[def.varId];
    if (!info || (def.varId2 && !manifest.vars[def.varId2])) {
      console.warn(`[forecast] variable ${def.varId2 ?? def.varId} missing from run ${manifest.run}`);
      layer.setLayer(null);
      return;
    }

    const my = ++this.token;
    const { a, b, mix } = bracketSteps(validTimes, time);
    const hA = manifest.steps[a].h;
    const hB = manifest.steps[b].h;
    const prefix = `${manifest.model}/${manifest.run}`;
    const varIds = def.varId2 ? [def.varId, def.varId2] : [def.varId];

    void Promise.all(varIds.flatMap(v => [this.loader.get(v, hA), this.loader.get(v, hB)]))
      .then(bitmaps => {
        if (my !== this.token || !this.layer) return; // a newer selection replaced this one
        const frame = (v: string, h: number, bitmap: ImageBitmap) => ({ key: `${prefix}/${v}/${h}`, bitmap });
        layer.setGrid(manifest.grid);
        layer.setLayer(def, [info.min, info.max]);
        layer.setFrames(
          frame(def.varId, hA, bitmaps[0]),
          frame(def.varId, hB, bitmaps[1]),
          mix,
          def.varId2 ? frame(def.varId2, hA, bitmaps[2]) : null,
          def.varId2 ? frame(def.varId2, hB, bitmaps[3]) : null
        );
        // Warm the neighbours so scrubbing and playback stay smooth.
        const ahead = manifest.steps.slice(Math.max(a - 1, 0), b + 3).map(s => s.h);
        for (const v of varIds) this.loader.prefetch(v, ahead);
      })
      .catch(err => console.warn('[forecast] field load failed', err));
  }

  /** Feeds the particle layer the two wind steps around the selected time. */
  private updateWind(): void {
    const wind = this.windLayer;
    if (!wind) return;
    const manifest = this.catalog.manifest();
    const time = this.state.timeMs();
    const validTimes = this.catalog.validTimes();
    const on = this.state.windParticles();
    if (!on || !manifest || time === null || validTimes.length === 0 || !manifest.vars['u10'] || !manifest.vars['v10']) {
      wind.setVisible(false);
      wind.setWind(null);
      return;
    }

    const my = ++this.windToken;
    const { a, b, mix } = bracketSteps(validTimes, time);
    const hA = manifest.steps[a].h;
    const hB = manifest.steps[b].h;
    const u = manifest.vars['u10'];
    const v = manifest.vars['v10'];

    void Promise.all([this.loader.get('u10', hA), this.loader.get('u10', hB), this.loader.get('v10', hA), this.loader.get('v10', hB)])
      .then(([uA, uB, vA, vB]) => {
        if (my !== this.windToken || !this.windLayer) return;
        wind.setWind({
          grid: manifest.grid,
          uA: decodeFieldBitmap(uA, u.min, u.max),
          uB: decodeFieldBitmap(uB, u.min, u.max),
          vA: decodeFieldBitmap(vA, v.min, v.max),
          vB: decodeFieldBitmap(vB, v.min, v.max),
          mix,
        });
        wind.setVisible(true);
        const ahead = manifest.steps.slice(Math.max(a - 1, 0), b + 3).map(s => s.h);
        this.loader.prefetch('u10', ahead);
        this.loader.prefetch('v10', ahead);
      })
      .catch(err => console.warn('[forecast] wind load failed', err));
  }
}
