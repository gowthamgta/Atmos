import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { ForecastCatalogService } from '../forecast/forecast-catalog.service';
import { ForecastInspectorService } from '../forecast/forecast-inspector.service';
import { FORECAST_MODELS } from '../forecast/forecast-models';
import { ForecastStateService } from '../forecast/forecast-state.service';
import { forecastLayerById, supportsLevels } from '../forecast/forecast-layers';
import { ObservationsService } from '../forecast/observations.service';
import { MapLayerService } from '../services/map-layer.service';
import { OVERLAYS, ViewState, formatViewState, parseViewState } from './view-state';

const WRITE_DELAY_MS = 400;

/**
 * Keeps the address in step with the view, and applies an address when the page opens (a shared link): the layer, model, altitude, chosen place,
 * map position and overlays. The map reads its first position from here; it reports every move back.
 */
@Injectable({ providedIn: 'root' })
export class UrlStateService {
  private readonly state = inject(ForecastStateService);
  private readonly catalog = inject(ForecastCatalogService);
  private readonly inspector = inject(ForecastInspectorService);
  private readonly mapLayers = inject(MapLayerService);
  private readonly observations = inject(ObservationsService);

  /** Where the map is (or should start), from the address first. */
  readonly camera = signal<{ lat: number; lon: number; zoom: number } | null>(null);

  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.restore(parseViewState(typeof location === 'undefined' ? '' : location.hash));
    effect(() => {
      // everything that goes into the address is read here, so a change to any of them writes it again
      const view: ViewState = {
        layer: this.observedLayer() ?? this.state.activeLayerId() ?? undefined,
        model: this.catalog.activeModelId(),
        level: String(this.state.level()),
        overlays: this.overlaysOn(),
      };
      const sel = this.inspector.selected();
      if (sel) view.place = { lat: sel.lat, lon: sel.lon, ...(this.inspector.label() ? { name: this.inspector.label()! } : {}) };
      const cam = this.camera();
      if (cam) view.camera = cam;
      untracked(() => this.scheduleWrite(view));
    });
  }

  setCamera(camera: { lat: number; lon: number; zoom: number }): void {
    this.camera.set(camera);
  }

  private observedLayer(): string | null {
    return this.mapLayers.activeLayers()[0]?.id ?? null;
  }

  private overlaysOn(): string[] {
    const on: Record<(typeof OVERLAYS)[number], boolean> = {
      particles: this.state.windParticles(),
      isobars: this.state.isobars(),
      stations: this.state.stationMarkers(),
      cyclones: this.state.cyclones(),
      districts: this.state.districtLines(),
      relief: this.state.relief(),
    };
    return OVERLAYS.filter(o => on[o]);
  }

  private scheduleWrite(view: ViewState): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try {
        history.replaceState(null, '', `${location.pathname}${location.search}#${formatViewState(view)}`);
      } catch {
        /* an address that cannot be changed (a sandboxed frame): the view just is not in it */
      }
    }, WRITE_DELAY_MS);
  }

  /** Applies a view read from the address. Anything the app does not know is left out; the rest of the app starts as usual. */
  private restore(view: ViewState): void {
    if (view.camera) this.camera.set(view.camera);
    if (view.model && FORECAST_MODELS.some(m => m.id === view.model) && view.model !== this.catalog.activeModelId()) this.state.selectModel(view.model);
    if (view.layer) {
      if (view.layer === 'radar') this.state.selectRadar();
      else if (view.layer === 'satellite') this.state.selectSatellite();
      else if (view.layer === 'gibs') this.state.selectGibs();
      else if (forecastLayerById(view.layer) && view.layer !== this.state.activeLayerId()) this.state.toggleLayer(view.layer);
    }
    const layer = forecastLayerById(this.state.activeLayerId());
    if (view.level && (!layer || supportsLevels(layer))) this.state.level.set(view.level === 'surface' ? 'surface' : (Number(view.level) as never));
    if (view.overlays) {
      const has = (o: string) => view.overlays!.includes(o);
      this.state.windParticles.set(has('particles'));
      this.state.isobars.set(has('isobars'));
      this.state.stationMarkers.set(has('stations'));
      if (has('stations')) void this.observations.refresh();
      this.state.cyclones.set(has('cyclones'));
      this.state.districtLines.set(has('districts'));
      this.state.relief.set(has('relief'));
    }
    if (view.place) {
      this.inspector.skipHome(); // the link names a place: the card does not open on the home place instead
      this.inspector.select(view.place.lat, view.place.lon, view.place.name ?? null);
    }
  }
}
