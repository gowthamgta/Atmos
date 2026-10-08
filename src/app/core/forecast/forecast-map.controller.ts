import { EffectRef, Injectable, Injector, effect, inject } from '@angular/core';
import { Marker } from 'maplibre-gl';
import type { Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl';
import { ScalarFieldLayer } from '../rendering/scalar-field.layer';
import { WindParticlesLayer } from '../rendering/wind-particles.layer';
import { isobarGeoJson } from './contours';
import { cycloneGeoJson, loadCyclones } from './cyclone-tracks';
import { decodeFieldBitmap } from './field-decode';
import { FieldLoaderService } from './field-loader.service';
import { ForecastCatalogService } from './forecast-catalog.service';
import { ForecastInspectorService } from './forecast-inspector.service';
import { ForecastStateService } from './forecast-state.service';
import { TerrainService } from './terrain.service';
import { ForecastGrid, bracketSteps } from './forecast.model';
import { isPhone } from '../ui/device-profile';

/** How strongly the 90 m relief is shaded into the forecast colours when it is on. */
const RELIEF_STRENGTH = 0.55;

/** Whether two grids are the same cells (the terrain can only be sampled where its grid lines up with the field's). */
function sameGrid(a: ForecastGrid, b: ForecastGrid): boolean {
  return a.nx === b.nx && a.ny === b.ny && a.lonMin === b.lonMin && a.latMax === b.latMax && a.step === b.step;
}

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
  private isobarToken = 0;
  private isobarTimer: ReturnType<typeof setTimeout> | null = null;
  private lastIsobarUpdate = 0;

  private cycloneLoadedAt = 0;

  private static readonly CYCLONE_SOURCE = 'forecast-cyclones';
  private static readonly CYCLONE_LAYERS = ['forecast-cyclone-labels', 'forecast-cyclone-points', 'forecast-cyclone-track', 'forecast-cyclone-members'];
  private static readonly ISOBAR_SOURCE = 'forecast-isobars';
  private static readonly ISOBAR_MIN_INTERVAL_MS = 150;

  /** Mount the layers below `beforeId` (so boundaries and labels stay on top). */
  attach(map: MapLibreMap, beforeId?: string): void {
    this.detach();
    this.map = map;
    this.layer = new ScalarFieldLayer();
    map.addLayer(this.layer, beforeId);
    this.windLayer = new WindParticlesLayer(window.innerWidth < 700 ? 1800 : 11000);
    map.addLayer(this.windLayer, beforeId); // added second, so the streaks draw over the colour field
    this.addIsobarLayers(map, beforeId);
    this.addCycloneLayers(map);
    this.cycloneLoadedAt = 0;
    map.on('click', this.onMapClick);
    this.effects = [
      effect(() => this.update(), { injector: this.injector }),
      effect(() => this.updateWind(), { injector: this.injector }),
      effect(() => this.updateIsobars(), { injector: this.injector }),
      effect(() => this.updateCyclones(), { injector: this.injector }),
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
    this.isobarToken++;
    if (this.isobarTimer) clearTimeout(this.isobarTimer);
    this.isobarTimer = null;
    if (this.map) {
      this.removeIsobarLayers(this.map);
      this.removeCycloneLayers(this.map);
    }
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
    // 90 m terrain (loaded once): downscaling, relief shading, and the underground mask of pressure levels
    // the terrain covers the South India box only: a field on another grid (the world model) is drawn without it
    const terrainData = this.terrain.data();
    const onTerrain = !!terrainData && sameGrid(manifest.grid, terrainData.meta.grid);
    const modelGround = onTerrain ? this.terrain.modelGround(terrainData!, this.catalog.model().gridKm).bitmap : null;
    layer.setTerrain(onTerrain ? terrainData : null, modelGround);
    layer.setRelief(this.state.relief() ? RELIEF_STRENGTH : 0);
    layer.setLite(isPhone()); // phones take the cheaper relief slope; larger screens take the full one
    if (!terrainData) {
      this.terrain.ensureLoaded().catch(err => console.warn('[forecast] terrain unavailable; showing model resolution', err));
    }

    const info = manifest.vars[def.varId];
    const info2 = def.varId2 ? manifest.vars[def.varId2] : undefined;
    if (!info || (def.varId2 && !info2)) {
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
        layer.setLayer(def, [info.min, info.max], info2 ? [info2.min, info2.max] : undefined);
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

  private addIsobarLayers(map: MapLibreMap, beforeId?: string): void {
    map.addSource(ForecastMapController.ISOBAR_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'forecast-isobar-lines',
      type: 'line',
      source: ForecastMapController.ISOBAR_SOURCE,
      layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' },
      paint: {
        'line-color': 'rgba(255, 255, 255, 0.62)',
        'line-width': ['case', ['get', 'major'], 1.7, 0.9],
      },
    }, beforeId);
    map.addLayer({
      id: 'forecast-isobar-labels',
      type: 'symbol',
      source: ForecastMapController.ISOBAR_SOURCE,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 320,
        'text-field': ['get', 'label'],
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-size': 11,
        'text-keep-upright': true,
        visibility: 'none',
      },
      paint: {
        'text-color': 'rgba(255, 255, 255, 0.92)',
        'text-halo-color': 'rgba(8, 12, 22, 0.85)',
        'text-halo-width': 1.4,
      },
    }, beforeId);
  }

  /** Forecast tracks of tropical cyclones, drawn on top: the ensemble spread, the main track and a point per time. */
  private addCycloneLayers(map: MapLibreMap): void {
    const source = ForecastMapController.CYCLONE_SOURCE;
    map.addSource(source, { type: 'geojson', data: cycloneGeoJson(null) });
    const hidden = { visibility: 'none' as const };
    map.addLayer({ id: 'forecast-cyclone-members', type: 'line', source, filter: ['==', ['get', 'kind'], 'member'],
      layout: { 'line-join': 'round', 'line-cap': 'round', ...hidden }, paint: { 'line-color': '#ffd1dc', 'line-width': 1, 'line-opacity': 0.28 } });
    map.addLayer({ id: 'forecast-cyclone-track', type: 'line', source, filter: ['==', ['get', 'kind'], 'track'],
      layout: { 'line-join': 'round', 'line-cap': 'round', ...hidden }, paint: { 'line-color': '#ffffff', 'line-width': 2.4, 'line-opacity': 0.92 } });
    map.addLayer({ id: 'forecast-cyclone-points', type: 'circle', source, filter: ['==', ['get', 'kind'], 'point'], layout: hidden,
      paint: { 'circle-color': ['get', 'color'], 'circle-radius': ['case', ['get', 'big'], 6.5, 3.8], 'circle-stroke-color': '#0b0f1a', 'circle-stroke-width': 1.4 } });
    map.addLayer({ id: 'forecast-cyclone-labels', type: 'symbol', source, filter: ['all', ['==', ['get', 'kind'], 'point'], ['!=', ['get', 'label'], '']],
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-allow-overlap': true, ...hidden },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(8, 12, 22, 0.9)', 'text-halo-width': 1.5 } });
  }

  private removeCycloneLayers(map: MapLibreMap): void {
    for (const id of ForecastMapController.CYCLONE_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(ForecastMapController.CYCLONE_SOURCE)) map.removeSource(ForecastMapController.CYCLONE_SOURCE);
  }

  /** Shows the tracks while the overlay is on; the file is fetched when first needed and again once it is 30 minutes old. */
  private updateCyclones(): void {
    const map = this.map;
    if (!map) return;
    const on = this.state.cyclones();
    for (const id of ForecastMapController.CYCLONE_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    if (!on || Date.now() - this.cycloneLoadedAt < 30 * 60_000) return;
    this.cycloneLoadedAt = Date.now();
    void loadCyclones().then(data => {
      if (!this.map || !data) return;
      (this.map.getSource(ForecastMapController.CYCLONE_SOURCE) as { setData?: (d: unknown) => void } | undefined)?.setData?.(cycloneGeoJson(data));
    });
  }

  private removeIsobarLayers(map: MapLibreMap): void {
    for (const id of ['forecast-isobar-labels', 'forecast-isobar-lines']) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(ForecastMapController.ISOBAR_SOURCE)) map.removeSource(ForecastMapController.ISOBAR_SOURCE);
  }

  /** Contours the blended pressure (or height) field and pushes it to the map (at most ~7 times a second). */
  private updateIsobars(): void {
    const map = this.map;
    if (!map) return;
    const manifest = this.catalog.manifest();
    const time = this.state.timeMs();
    const validTimes = this.catalog.validTimes();
    const on = this.state.isobars();
    const visibility = on ? 'visible' : 'none';
    for (const id of ['forecast-isobar-lines', 'forecast-isobar-labels']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
    }
    // sea-level pressure at the ground; the height of the pressure surface at altitude
    const spec = this.state.contour();
    const info = manifest?.vars[spec.varId];
    if (!on || !manifest || !info || time === null || validTimes.length === 0) return;

    const my = ++this.isobarToken;
    const { a, b, mix } = bracketSteps(validTimes, time);
    void Promise.all([this.loader.get(spec.varId, manifest.steps[a].h), this.loader.get(spec.varId, manifest.steps[b].h)])
      .then(([bmpA, bmpB]) => {
        if (my !== this.isobarToken || !this.map) return;
        const fa = decodeFieldBitmap(bmpA, info.min, info.max);
        const fb = decodeFieldBitmap(bmpB, info.min, info.max);
        const blended = new Float32Array(fa.length);
        for (let i = 0; i < fa.length; i++) blended[i] = fa[i] * (1 - mix) + fb[i] * mix;
        const geojson = isobarGeoJson(blended, manifest.grid, spec.step);
        this.pushIsobars(geojson);
      })
      .catch(err => console.warn('[forecast] isobars failed', err));
  }

  private pushIsobars(geojson: ReturnType<typeof isobarGeoJson>): void {
    const apply = () => {
      this.isobarTimer = null;
      this.lastIsobarUpdate = performance.now();
      const source = this.map?.getSource(ForecastMapController.ISOBAR_SOURCE) as { setData?: (d: unknown) => void } | undefined;
      source?.setData?.(geojson);
    };
    if (this.isobarTimer) clearTimeout(this.isobarTimer); // only the newest data matters
    const wait = ForecastMapController.ISOBAR_MIN_INTERVAL_MS - (performance.now() - this.lastIsobarUpdate);
    if (wait <= 0) apply();
    else this.isobarTimer = setTimeout(apply, wait);
  }

  /** Feeds the particle layer the two wind steps around the selected time, at the active wind layer's level. */
  private updateWind(): void {
    const wind = this.windLayer;
    if (!wind) return;
    const manifest = this.catalog.manifest();
    const time = this.state.timeMs();
    const validTimes = this.catalog.validTimes();
    const on = this.state.windParticles();
    // the animation follows the selected altitude: the 10 m wind at the ground, otherwise that pressure level
    const [uVar, vVar] = this.state.windVars();
    if (!on || !manifest || time === null || validTimes.length === 0 || !manifest.vars[uVar] || !manifest.vars[vVar]) {
      wind.setVisible(false);
      wind.setWind(null);
      return;
    }

    const my = ++this.windToken;
    const { a, b, mix } = bracketSteps(validTimes, time);
    const hA = manifest.steps[a].h;
    const hB = manifest.steps[b].h;
    const u = manifest.vars[uVar];
    const v = manifest.vars[vVar];

    void Promise.all([this.loader.get(uVar, hA), this.loader.get(uVar, hB), this.loader.get(vVar, hA), this.loader.get(vVar, hB)])
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
        this.loader.prefetch(uVar, ahead);
        this.loader.prefetch(vVar, ahead);
      })
      .catch(err => console.warn('[forecast] wind load failed', err));
  }
}
