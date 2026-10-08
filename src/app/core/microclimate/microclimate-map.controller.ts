import { EffectRef, Injectable, Injector, effect, inject } from '@angular/core';
import type { Map as MapLibreMap, MapLayerMouseEvent } from 'maplibre-gl';
import { ForecastStateService } from '../forecast/forecast-state.service';
import { PanelService } from '../ui/panel.service';
import { MicroclimateService } from './microclimate.service';
import { metricById, metricColour, stepIndex, valuesAt } from './microclimate.model';

/** A district outline as read from the boundaries file (only what the map uses). */
interface Outline {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: unknown;
}

const SOURCE = 'tn-microclimate';
const FILL = 'tn-microclimate-fill';
const LINE = 'tn-microclimate-line';
const DATA_URL = '/data/south-india-districts.geojson';

/**
 * Colours the Tamil Nadu districts on the map by the chosen microclimate value at the timeline's time. Clicking a district
 * selects it and opens its card. The district outlines come from the same file as the district boundaries.
 */
@Injectable({ providedIn: 'root' })
export class MicroclimateMapController {
  private readonly injector = inject(Injector);
  private readonly service = inject(MicroclimateService);
  private readonly forecast = inject(ForecastStateService);
  private readonly panels = inject(PanelService);

  private map: MapLibreMap | null = null;
  private effects: EffectRef[] = [];
  private outlines: Outline[] | null = null;
  private loading: Promise<Outline[]> | null = null;

  attach(map: MapLibreMap, beforeId?: string): void {
    this.detach();
    this.map = map;
    map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: FILL, type: 'fill', source: SOURCE, layout: { visibility: 'none' },
      paint: {
        'fill-color': ['coalesce', ['get', 'colour'], 'rgba(0,0,0,0)'],
        'fill-opacity': ['case', ['==', ['get', 'colour'], null], 0, 0.62],
      },
    }, beforeId);
    map.addLayer({
      id: LINE, type: 'line', source: SOURCE, layout: { visibility: 'none' },
      paint: { 'line-color': 'rgba(255,255,255,0.7)', 'line-width': 1 },
    }, beforeId);
    map.on('click', FILL, this.onClick);
    map.on('mouseenter', FILL, this.onEnter);
    map.on('mouseleave', FILL, this.onLeave);
    this.effects = [effect(() => this.sync(), { injector: this.injector })];
  }

  detach(): void {
    this.effects.forEach(e => e.destroy());
    this.effects = [];
    const map = this.map;
    if (!map) return;
    map.off('click', FILL, this.onClick);
    map.off('mouseenter', FILL, this.onEnter);
    map.off('mouseleave', FILL, this.onLeave);
    for (const id of [LINE, FILL]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SOURCE)) map.removeSource(SOURCE);
    this.map = null;
  }

  private readonly onClick = (e: MapLayerMouseEvent): void => {
    const name = e.features?.[0]?.properties?.['name'];
    if (typeof name !== 'string') return;
    this.service.selected.set(name);
    this.panels.open.set('microclimate');
  };

  private readonly onEnter = (): void => {
    if (this.map) this.map.getCanvas().style.cursor = 'pointer';
  };

  private readonly onLeave = (): void => {
    if (this.map) this.map.getCanvas().style.cursor = '';
  };

  /** Runs whenever the switch, metric, data or time changes. */
  private sync(): void {
    const map = this.map;
    if (!map || !map.getSource(SOURCE)) return;
    const on = this.service.onMap();
    for (const id of [FILL, LINE]) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    if (!on) return;
    this.service.load();
    const data = this.service.data();
    if (!data) return;
    const def = metricById(this.service.metric());
    const idx = stepIndex(data.times, this.forecast.timeMs() ?? Date.now());
    const values = new Map(data.districts.map(d => [d.name, valuesAt(d, idx)]));
    void this.outlinesOf().then(features => {
      if (!this.map || !this.service.onMap()) return;
      const out = features.map(f => {
        const name = String(f.properties?.['name']);
        const v = values.get(name);
        const colour = v ? metricColour(def, def.value(v)) : null;
        return { ...f, properties: { name, colour } };
      });
      (this.map.getSource(SOURCE) as { setData?: (d: unknown) => void } | undefined)?.setData?.({ type: 'FeatureCollection', features: out });
    });
  }

  /** Tamil Nadu's district outlines, read once. */
  private outlinesOf(): Promise<Outline[]> {
    if (this.outlines) return Promise.resolve(this.outlines);
    if (this.loading) return this.loading;
    const load = fetch(DATA_URL)
      .then(res => {
        if (!res.ok) throw new Error(`${res.status} ${res.url}`);
        return res.json() as Promise<{ features: Outline[] }>;
      })
      .then(fc => {
        this.outlines = fc.features.filter(f => f.properties?.['kind'] === 'district' && f.properties?.['state'] === 'Tamil Nadu');
        return this.outlines;
      })
      .finally(() => (this.loading = null));
    this.loading = load;
    return load;
  }
}
