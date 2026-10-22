import { rowsForLayer } from './point-forecast';
import { ConsensusService } from './consensus.service';
import { INDIA_GRID, blendFields, differenceField, encodeFieldBitmap } from './derived-fields';
import { EffectRef, Injectable, Injector, effect, inject } from '@angular/core';
import type { Map as MapLibreMap, MapMouseEvent, Marker } from 'maplibre-gl';
import { maplibre } from '../map/maplibre-lazy';
import { ScalarFieldLayer } from '../rendering/scalar-field.layer';
import { WindParticlesLayer } from '../rendering/wind-particles.layer';
import { isobarGeoJson } from './contours';
import { CycloneData, cycloneGeoJson, loadCyclones } from './cyclone-tracks';
import { ageStrokes, lightningGeoJson, lightningShown, loadLightning } from './lightning';
import { MapLayerService } from '../services/map-layer.service';
import type { Stroke } from './lightning';
import { decodeFieldBitmap } from './field-decode';
import { FieldLoaderService } from './field-loader.service';
import { ForecastCatalogService } from './forecast-catalog.service';
import { ForecastInspectorService } from './forecast-inspector.service';
import { ForecastStateService } from './forecast-state.service';
import { TerrainService } from './terrain.service';
import { ForecastManifest, bracketSteps } from './forecast.model';
import type { ForecastLayerDef } from './forecast-layers';
import { isPhone } from '../ui/device-profile';
import { MeteogramService } from '../meteogram/meteogram.service';
import { PerfMeterService } from '../ui/perf-meter.service';

/** How strongly the 90 m relief is shaded into the forecast colours when it is on. */
export const RELIEF_STRENGTH = 0.55;

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
  private readonly mapLayers = inject(MapLayerService);
  private readonly terrain = inject(TerrainService);
  private readonly inspector = inject(ForecastInspectorService);
  private readonly consensus = inject(ConsensusService);
  private readonly meteogram = inject(MeteogramService);
  private readonly perf = inject(PerfMeterService);

  private map: MapLibreMap | null = null;
  private layer: ScalarFieldLayer | null = null;
  private windLayer: WindParticlesLayer | null = null;
  private effects: EffectRef[] = [];
  private marker: Marker | null = null;
  private pinLabel: HTMLSpanElement | null = null;
  /** Bumped on every update so slow downloads for an old selection are dropped. */
  private token = 0;
  private windToken = 0;
  private isobarToken = 0;
  private isobarTimer: ReturnType<typeof setTimeout> | null = null;
  private lastIsobarUpdate = 0;

  private cycloneLoadedAt = 0;
  private cycloneLoading = false;
  /** The tracks last loaded, drawn again for each time on the bar (the cone starts and the storm marker sits at that time). */
  private cycloneData: CycloneData | null = null;
  private cycloneDrawnFor = '';
  private lightningTimer: ReturnType<typeof setInterval> | null = null;
  private lightningTick: ReturnType<typeof setInterval> | null = null;
  private lightningStrokes: Stroke[] = [];
  private lightningFetchedAt = 0;
  private lightningLoading = false;

  private static readonly CYCLONE_SOURCE = 'forecast-cyclones';
  private static readonly CYCLONE_LAYERS = [
    'forecast-cyclone-now-label', 'forecast-cyclone-now-icon', 'forecast-cyclone-now', 'forecast-cyclone-labels', 'forecast-cyclone-points',
    'forecast-cyclone-track', 'forecast-cyclone-casing', 'forecast-cyclone-cone-line', 'forecast-cyclone-cone',
  ];
  private static readonly CYCLONE_IMAGE = 'cyclone-symbol';
  private static readonly LIGHTNING_SOURCE = 'forecast-lightning';
  private static readonly LIGHTNING_LAYER = 'forecast-lightning-bolts';
  private static readonly LIGHTNING_IMAGE = 'lightning-bolt';
  private static readonly LIGHTNING_FLASH = 'forecast-lightning-flash';
  private static readonly LIGHTNING_REFRESH_MS = 10_000;
  private static readonly LIGHTNING_TICK_MS = 1_000;
  private static readonly ISOBAR_SOURCE = 'forecast-isobars';
  private static readonly ISOBAR_MIN_INTERVAL_MS = 150;

  /** Mount the layers below `beforeId` (so boundaries and labels stay on top). */
  attach(map: MapLibreMap, beforeId?: string): void {
    this.detach();
    this.map = map;
    this.layer = new ScalarFieldLayer();
    map.addLayer(this.layer, beforeId);
    // the particle step needs no log, tan or cos per particle (see particle-system.ts), so these counts cost less than 1800 and 11000 did
    this.windLayer = new WindParticlesLayer(window.innerWidth < 700 ? 2600 : 16000);
    map.addLayer(this.windLayer, beforeId); // added second, so the streaks draw over the colour field
    this.perf.probe('streaks', () => String(this.windLayer?.particleCount ?? 0));
    this.addIsobarLayers(map, beforeId);
    this.addCycloneLayers(map);
    this.addLightningLayer(map);
    this.cycloneLoadedAt = 0;
    map.on('click', this.onMapClick);
    this.effects = [
      effect(() => this.update(), { injector: this.injector }),
      effect(() => this.updateWind(), { injector: this.injector }),
      effect(() => this.updateIsobars(), { injector: this.injector }),
      effect(() => this.updateCyclones(), { injector: this.injector }),
      effect(() => this.updateLightning(), { injector: this.injector }),
      effect(() => this.syncMarker(), { injector: this.injector }),
    ];
  }

  detach(): void {
    this.perf.probe('streaks', null);
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
      this.removeLightningLayer(this.map);
    }
    this.stopLightning();
    for (const l of [this.layer, this.windLayer]) {
      if (this.map && l && this.map.getLayer(l.id)) this.map.removeLayer(l.id);
    }
    this.layer = null;
    this.windLayer = null;
    this.map = null;
  }

  /** Clicking the map while a forecast overlay is shown inspects that point. */
  private readonly onMapClick = (e: MapMouseEvent): void => {
    if (this.state.forecastActive()) {
      this.inspector.select(e.lngLat.lat, e.lngLat.lng);
      this.meteogram.noteMapClick();   // the first click on the map opens the meteogram of the place (once; after that it stays as the visitor left it)
    }
  };

  private syncMarker(): void {
    const sel = this.inspector.selected();
    // read here, so the bubble follows the time, the layer, the altitude and the units
    const point = this.inspector.point();
    const stale = this.inspector.stale();
    const layerId = this.state.activeLayerId();
    const level = this.state.level();
    if (!this.map || !sel) {
      this.marker?.remove();
      this.marker = null;
      this.pinLabel = null;
      return;
    }
    if (!this.marker) {
      const el = document.createElement('div');
      el.className = 'forecast-pin';
      el.style.cssText =
        'position:relative;width:14px;height:14px;border-radius:50%;background:#0ea5e9;border:2px solid #fff;box-shadow:0 0 0 3px rgba(56,189,248,.45),0 2px 6px rgba(0,0,0,.6);pointer-events:none;';
      // the value of the layer at the pin, in a bubble to its right (windy.com's picker)
      const label = document.createElement('span');
      label.style.cssText =
        'position:absolute;left:20px;top:50%;transform:translateY(-50%);padding:2px 9px;border-radius:12px;background:rgba(26,33,46,.94);color:#fff;font:600 13px -apple-system,system-ui,"Segoe UI",Roboto,sans-serif;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.6);font-variant-numeric:tabular-nums;';
      el.appendChild(label);
      this.pinLabel = label;
      this.marker = new (maplibre().Marker)({ element: el }).setLngLat([sel.lon, sel.lat]).addTo(this.map);
    } else {
      this.marker.setLngLat([sel.lon, sel.lat]);
    }
    if (this.pinLabel) {
      const row = point ? rowsForLayer(point.rows, layerId, level)[0] : undefined;
      // an out-of-date number (the new one is slow to arrive) is not shown as if it were current
      const text = row && row.text.length <= 28 && !row.text.startsWith('–') ? (stale ? '…' : row.text) : '';
      this.pinLabel.textContent = text;
      this.pinLabel.style.display = text ? '' : 'none';
      const nearRight = this.map.project([sel.lon, sel.lat]).x > this.map.getCanvas().clientWidth - 160;
      this.pinLabel.style.left = nearRight ? 'auto' : '20px';
      this.pinLabel.style.right = nearRight ? '20px' : 'auto';
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
    // the terrain (loaded once): downscaling, relief shading, and the underground mask of pressure levels. It goes to every field whatever
    // its grid (0.1 degrees, or 0.25 for GFS, AIGFS and AIFS): the shader reads the terrain by latitude and longitude, takes the ground
    // the field stands on at the field's own nodes, and leaves the pixels outside the terrain's box alone
    const consensusLayer = def.id === 'extreme';           // drawn from every model, on the India grid of ECMWF IFS
    const rangeLayer = def.id === 'raintot';               // the rain between two chosen times
    const rangeStart = this.state.rangeStartMs();          // read here so the layer redraws when the slider moves
    const rangeEnd = this.state.rangeEndMs();
    const terrainData = this.terrain.data();
    const onTerrain = !!terrainData;
    const modelGround = onTerrain ? this.terrain.modelGround(terrainData!, consensusLayer ? 9 : this.catalog.model().groundKm).bitmap : null;
    layer.setTerrain(onTerrain ? terrainData : null, modelGround);
    layer.setRelief(this.state.relief() ? RELIEF_STRENGTH : 0);
    layer.setLite(isPhone()); // phones take the cheaper relief slope; larger screens take the full one
    if (!terrainData) {
      this.terrain.ensureLoaded().catch(err => console.warn('[forecast] terrain unavailable; showing model resolution', err));
    }

    if (consensusLayer) {
      void this.updateConsensus(layer, def, time, ++this.token);
      return;
    }
    if (rangeLayer) {
      void this.updateRainRange(layer, def, manifest, rangeStart, rangeEnd, ++this.token);
      return;
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

  /** The rain between the two chosen times: the running total at the end minus the one at the start, each blended between its two steps. */
  private async updateRainRange(layer: ScalarFieldLayer, def: ForecastLayerDef, manifest: ForecastManifest, start: number | null, end: number | null, my: number): Promise<void> {
    const info = manifest.vars['raintot'];
    if (!info || start === null || end === null) {
      layer.setLayer(null);
      return;
    }
    const validTimes = this.catalog.validTimes();
    const totalAt = async (t: number): Promise<Float32Array> => {
      const { a, b, mix } = bracketSteps(validTimes, t);
      const [bmpA, bmpB] = await Promise.all([this.loader.get('raintot', manifest.steps[a].h), this.loader.get('raintot', manifest.steps[b].h)]);
      return blendFields(decodeFieldBitmap(bmpA, info.min, info.max), decodeFieldBitmap(bmpB, info.min, info.max), mix);
    };
    try {
      const [atEnd, atStart] = await Promise.all([totalAt(end), totalAt(start)]);
      if (my !== this.token || !this.layer) return;
      const bitmap = await encodeFieldBitmap(differenceField(atEnd, atStart), manifest.grid, info.min, info.max);
      if (my !== this.token || !this.layer) return;
      const frame = { key: `${manifest.model}/${manifest.run}.${manifest.build ?? ''}/raintot-range/${start}-${end}`, bitmap };
      layer.setGrid(manifest.grid);
      layer.setLayer(def, [info.min, info.max]);
      layer.setFrames(frame, frame, 0);
    } catch (err) {
      console.warn('[forecast] rain accumulation failed', err);
    }
  }

  /** The multi-model 24 h rain probability layer (`0..100 %`, see ConsensusService). */
  private async updateConsensus(layer: ScalarFieldLayer, def: ForecastLayerDef, time: number, my: number): Promise<void> {
    try {
      const result = await this.consensus.compute(time);
      if (my !== this.token || !this.layer) return;
      if (!result) {
        layer.setLayer(null);
        return;
      }
      const bitmap = await encodeFieldBitmap(result.values, INDIA_GRID, 0, 100);
      if (my !== this.token || !this.layer) return;
      const frame = { key: `consensus/${Math.round(time / 60_000)}/${result.models.join(',')}`, bitmap };
      layer.setGrid(INDIA_GRID);
      layer.setLayer(def, [0, 100]);
      layer.setFrames(frame, frame, 0);
    } catch (err) {
      console.warn('[forecast] consensus failed', err);
    }
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

  /**
   * Forecast tracks of tropical cyclones, drawn on top: the cone of the typical track error from the time on the bar, the track coloured by the
   * storm's IMD class on a dark casing, a point every 12 h with a label each day, and the storm where it is at the time on the bar.
   */
  private addCycloneLayers(map: MapLibreMap): void {
    const source = ForecastMapController.CYCLONE_SOURCE;
    if (!map.hasImage(ForecastMapController.CYCLONE_IMAGE)) map.addImage(ForecastMapController.CYCLONE_IMAGE, this.cycloneImage());
    map.addSource(source, { type: 'geojson', data: cycloneGeoJson(null) });
    const hidden = { visibility: 'none' as const };
    const kind = (k: string) => ['==', ['get', 'kind'], k] as ['==', ['get', string], string];
    map.addLayer({ id: 'forecast-cyclone-cone', type: 'fill', source, filter: kind('cone'), layout: hidden,
      paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.1 } });
    map.addLayer({ id: 'forecast-cyclone-cone-line', type: 'line', source, filter: kind('cone'), layout: { 'line-join': 'round', ...hidden },
      paint: { 'line-color': '#ffffff', 'line-opacity': 0.6, 'line-width': 1.2, 'line-dasharray': [3, 2] } });
    map.addLayer({ id: 'forecast-cyclone-casing', type: 'line', source, filter: kind('segment'), layout: { 'line-join': 'round', 'line-cap': 'round', ...hidden },
      paint: { 'line-color': 'rgba(8, 12, 22, 0.8)', 'line-width': 6.5 } });
    map.addLayer({ id: 'forecast-cyclone-track', type: 'line', source, filter: kind('segment'), layout: { 'line-join': 'round', 'line-cap': 'round', ...hidden },
      paint: { 'line-color': ['get', 'color'], 'line-width': 3.5, 'line-opacity': ['case', ['get', 'past'], 0.4, 1] } });
    map.addLayer({ id: 'forecast-cyclone-points', type: 'circle', source, filter: kind('point'), layout: hidden,
      paint: { 'circle-color': ['get', 'color'], 'circle-radius': ['case', ['get', 'day'], 5.5, 3.5], 'circle-stroke-color': 'rgba(8, 12, 22, 0.9)', 'circle-stroke-width': 1.5,
        'circle-opacity': ['case', ['get', 'past'], 0.4, 1], 'circle-stroke-opacity': ['case', ['get', 'past'], 0.4, 1] } });
    map.addLayer({ id: 'forecast-cyclone-labels', type: 'symbol', source, filter: ['all', kind('point'), ['!=', ['get', 'label'], '']],
      layout: {
        'text-field': ['get', 'label'], 'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'], 'text-size': 11.5, 'text-line-height': 1.15,
        // beside the point on whichever side is free, the strongest first where they crowd
        'text-variable-anchor': ['left', 'right', 'top', 'bottom'], 'text-radial-offset': 0.9, 'text-justify': 'auto',
        'symbol-sort-key': ['-', 10, ['get', 'rank']], ...hidden,
      },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(8, 12, 22, 0.92)', 'text-halo-width': 1.6 } });
    map.addLayer({ id: 'forecast-cyclone-now', type: 'circle', source, filter: kind('now'), layout: hidden,
      paint: { 'circle-color': ['get', 'color'], 'circle-radius': 13, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5, 'circle-opacity': 0.95 } });
    map.addLayer({ id: 'forecast-cyclone-now-icon', type: 'symbol', source, filter: kind('now'),
      layout: { 'icon-image': ForecastMapController.CYCLONE_IMAGE, 'icon-size': 0.5, 'icon-allow-overlap': true, 'icon-ignore-placement': true, ...hidden } });
    map.addLayer({ id: 'forecast-cyclone-now-label', type: 'symbol', source, filter: kind('now'),
      layout: {
        'text-field': ['get', 'label'], 'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'], 'text-size': 12.5,
        'text-line-height': 1.2, 'text-max-width': 24, 'text-justify': 'auto', ...hidden,
        // above or below the storm first (the track mostly runs sideways), on whichever side is free; placed before the daily labels, which move aside
        'text-variable-anchor': ['bottom', 'top', 'left', 'right'], 'text-radial-offset': 1.7,
      },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(8, 12, 22, 0.95)', 'text-halo-width': 1.8 } });
  }

  /** A cyclone's symbol (two curved arms around an eye, white with a dark edge), drawn once for the marker of the storm. */
  private cycloneImage(): ImageData {
    const size = 48;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const c = size / 2;
    ctx.translate(c, c);
    const arm = () => {
      ctx.beginPath();
      ctx.moveTo(4, -6);
      ctx.bezierCurveTo(10, -14, 4, -21, -6, -20);
      ctx.bezierCurveTo(4, -17, 6, -11, 0, -7);
      ctx.closePath();
    };
    for (const pass of [0, 1]) {
      for (const turn of [0, Math.PI]) {
        ctx.save();
        ctx.rotate(turn);
        arm();
        if (pass === 0) {
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(8, 12, 22, 0.85)';
          ctx.stroke();
        } else {
          ctx.fillStyle = '#ffffff';
          ctx.fill();
        }
        ctx.restore();
      }
    }
    ctx.beginPath();
    ctx.arc(0, 0, 7, 0, Math.PI * 2);
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(8, 12, 22, 0.85)';
    ctx.stroke();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    return ctx.getImageData(0, 0, size, size);
  }

  /** A pink bolt with a dark edge, drawn once for the symbol layer. */
  private boltImage(): ImageData {
    const size = 48;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.beginPath();
    ctx.moveTo(29, 4);
    ctx.lineTo(11, 27);
    ctx.lineTo(23, 27);
    ctx.lineTo(18, 44);
    ctx.lineTo(37, 20);
    ctx.lineTo(25, 20);
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(40, 8, 40, 0.9)';
    ctx.stroke();
    ctx.fillStyle = '#ff7ad9';
    ctx.fill();
    return ctx.getImageData(0, 0, size, size);
  }

  /** Lightning strokes as bolts, fading with age over the five minutes they are shown. */
  private addLightningLayer(map: MapLibreMap): void {
    const source = ForecastMapController.LIGHTNING_SOURCE;
    if (!map.hasImage(ForecastMapController.LIGHTNING_IMAGE)) map.addImage(ForecastMapController.LIGHTNING_IMAGE, this.boltImage());
    map.addSource(source, { type: 'geojson', data: lightningGeoJson([]) });
    // a new strike flashes: a ring that grows and fades over its first ten seconds
    map.addLayer({
      id: ForecastMapController.LIGHTNING_FLASH, type: 'circle', source, filter: ['<', ['get', 'age'], 10],
      layout: { visibility: 'none' },
      paint: {
        'circle-color': 'rgba(255, 255, 255, 0)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
        'circle-radius': ['interpolate', ['linear'], ['get', 'age'], 0, 6, 10, 28],
        'circle-stroke-opacity': ['interpolate', ['linear'], ['get', 'age'], 0, 0.95, 10, 0],
      },
    });
    map.addLayer({
      id: ForecastMapController.LIGHTNING_LAYER, type: 'symbol', source,
      layout: {
        'icon-image': ForecastMapController.LIGHTNING_IMAGE, 'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 4, 0.3, 8, 0.5, 11, 0.75], 'symbol-sort-key': ['-', ['get', 'age']], visibility: 'none',
      },
      paint: { 'icon-opacity': ['interpolate', ['linear'], ['get', 'age'], 0, 1, 300, 0.35] },
    });
  }

  private removeLightningLayer(map: MapLibreMap): void {
    for (const id of [ForecastMapController.LIGHTNING_LAYER, ForecastMapController.LIGHTNING_FLASH]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(ForecastMapController.LIGHTNING_SOURCE)) map.removeSource(ForecastMapController.LIGHTNING_SOURCE);
  }

  /** Draws the strokes as they are now: aged by the time since they were fetched, so the bolts fade and the flashes run between polls. */
  private drawLightning(): void {
    const source = this.map?.getSource(ForecastMapController.LIGHTNING_SOURCE) as { setData?: (d: unknown) => void } | undefined;
    if (!source?.setData) return;
    source.setData(lightningGeoJson(ageStrokes(this.lightningStrokes, (Date.now() - this.lightningFetchedAt) / 1000)));
  }

  private pullLightning(): void {
    if (this.lightningLoading) return;
    this.lightningLoading = true;
    void loadLightning().then(strokes => {
      if (!this.map || !strokes) return;
      this.lightningStrokes = strokes;
      this.lightningFetchedAt = Date.now();
      this.drawLightning();
    }).finally(() => (this.lightningLoading = false));
  }

  private stopLightning(): void {
    if (this.lightningTimer) clearInterval(this.lightningTimer);
    if (this.lightningTick) clearInterval(this.lightningTick);
    this.lightningTimer = this.lightningTick = null;
  }

  /** Shows the bolts while the radar or the satellite is on: fetched now and every ten seconds, redrawn every second (nothing runs while it is off). */
  private updateLightning(): void {
    const map = this.map;
    if (!map) return;
    const on = lightningShown(this.mapLayers.layers());
    for (const id of [ForecastMapController.LIGHTNING_LAYER, ForecastMapController.LIGHTNING_FLASH]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
    if (on && !this.lightningTimer) {
      this.pullLightning();
      this.lightningTimer = setInterval(() => this.pullLightning(), ForecastMapController.LIGHTNING_REFRESH_MS);
      this.lightningTick = setInterval(() => this.drawLightning(), ForecastMapController.LIGHTNING_TICK_MS);
    } else if (!on && this.lightningTimer) {
      this.stopLightning();
    }
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
    const time = this.state.timeMs();
    for (const id of ForecastMapController.CYCLONE_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    if (!on) return;
    this.drawCyclones(time);
    if (this.cycloneLoading || Date.now() - this.cycloneLoadedAt < 30 * 60_000) return;
    this.cycloneLoading = true;
    void loadCyclones().then(data => {
      // the 30 minutes count from a load that worked: a failed one is tried again the next time the overlay is looked at
      if (data) this.cycloneLoadedAt = Date.now();
      if (!data) return;
      this.cycloneData = data;
      this.cycloneDrawnFor = '';
      this.drawCyclones(this.state.timeMs());
    }).finally(() => (this.cycloneLoading = false));
  }

  /** The tracks for a time on the bar (each hour once: the cone and the storm's place are worked out for it). */
  private drawCyclones(timeMs: number | null): void {
    const key = `${this.cycloneData?.run ?? ''}|${timeMs === null ? '' : Math.round(timeMs / 3_600_000)}`;
    if (!this.map || !this.cycloneData || key === this.cycloneDrawnFor) return;
    this.cycloneDrawnFor = key;
    (this.map.getSource(ForecastMapController.CYCLONE_SOURCE) as { setData?: (d: unknown) => void } | undefined)?.setData?.(cycloneGeoJson(this.cycloneData, timeMs));
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
