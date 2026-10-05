import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  effect,
  signal,
  untracked,
  isDevMode
} from '@angular/core';
import * as maplibregl from 'maplibre-gl';
import { Map as MapLibreMap, Marker } from 'maplibre-gl';
import { MapLayerService, LayerConfig } from '../../core/services/map-layer.service';
import { RadarDisplayFrame, RadarService } from '../../core/services/radar.service';
import { StormTracksService } from '../../core/services/storm-tracks.service';
import { SatelliteFrame, SatelliteService } from '../../core/satellite/satellite.service';
import { satelliteCoordinates } from '../../core/satellite/satellite-image';
import { RadarProductKey } from '../../core/domain/models/radar.model';

/** [[west, south], [east, north]]: the whole forecast area (South India, Sri Lanka and the seas around them). */
const SOUTH_INDIA_VIEW: [[number, number], [number, number]] = [[67.5, 3.5], [90.5, 22.5]];
/** How far the map can be panned and zoomed out: wide enough to roam freely beyond the forecast area. */
const MAP_MAX_BOUNDS: [[number, number], [number, number]] = [[52, -10], [108, 34]];

// State and district outlines for South India and Sri Lanka (built by scripts/build-south-india-data.py).
// The lines are drawn above every raster overlay (radar, forecast) so boundaries stay readable on top of them.
const BOUNDARY_SOURCE_ID = 'boundaries';
const BOUNDARY_FIRST_LAYER_ID = 'district-casing';
const STORM_SOURCE_ID = 'storm-tracks';
const STORM_FIRST_LAYER_ID = 'storm-cone-fill';
const STORM_LAYER_IDS = [STORM_FIRST_LAYER_ID, 'storm-cone-line', 'storm-track-line', 'storm-ticks', 'storm-tick-labels', 'storm-cells', 'storm-cell-labels'];
import { ForecastMapController } from '../../core/forecast/forecast-map.controller';

@Component({
  selector: 'app-map',
  standalone: true,
  template: `
    <div id="map-container">
      <!-- 📡 Real-time IMD Radar dBZ Hover Inspector Tooltip -->
      @if (hoverInfo()) {
        <div
          class="radar-hover-tooltip"
          [style.left.px]="hoverInfo()!.x"
          [style.top.px]="hoverInfo()!.y"
        >
          <div class="tooltip-top-row">
            <span
              class="tooltip-badge-dot"
              [style.background-color]="hoverInfo()!.color"
              [style.box-shadow]="'0 0 10px ' + hoverInfo()!.color"
            ></span>
            <span class="tooltip-dbz-val" [style.color]="hoverInfo()!.color">
              {{ hoverInfo()!.dbz }} dBZ
            </span>
            <span class="tooltip-rate-lbl">{{ hoverInfo()!.rate }}</span>
          </div>
          <div class="tooltip-desc-row">
            <strong style="color: #f8fafc">{{ hoverInfo()!.label }}</strong>
            <span class="tooltip-sep">•</span>
            <span class="tooltip-coords">
              {{ hoverInfo()!.lat.toFixed(3) }}°N, {{ hoverInfo()!.lng.toFixed(3) }}°E
            </span>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      position: absolute;
      inset: 0;
    }
    #map-container {
      width: 100%;
      height: 100%;
      position: relative;
      z-index: 1;
      background: #2b2e35;
    }
    ::ng-deep .custom-marker {
      width: 24px;
      height: 24px;
      position: relative;
      pointer-events: none;
    }
    /* ── Live Radar Hover dBZ Tooltip ── */
    .radar-hover-tooltip {
      position: absolute;
      transform: translate(14px, -110%);
      pointer-events: none;
      z-index: 1000;
      background: rgba(15, 23, 42, 0.94);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(56, 189, 248, 0.35);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5), 0 0 15px rgba(56, 189, 248, 0.15);
      border-radius: 10px;
      padding: 0.55rem 0.85rem;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      white-space: nowrap;
      animation: tooltipFadeIn 0.15s ease-out;
    }
    @keyframes tooltipFadeIn {
      from { opacity: 0; transform: translate(14px, -95%) scale(0.95); }
      to { opacity: 1; transform: translate(14px, -110%) scale(1); }
    }
    .tooltip-top-row {
      display: flex;
      align-items: center;
      gap: 0.45rem;
    }
    .tooltip-badge-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .tooltip-dbz-val {
      font-size: 0.95rem;
      font-weight: 800;
      font-family: monospace;
      letter-spacing: -0.02em;
    }
    .tooltip-rate-lbl {
      font-size: 0.75rem;
      color: #cbd5e1;
      background: rgba(255, 255, 255, 0.08);
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: 500;
    }
    .tooltip-desc-row {
      font-size: 0.75rem;
      color: #94a3b8;
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }
    .tooltip-sep {
      color: #475569;
    }
    .tooltip-coords {
      font-family: monospace;
      font-size: 0.72rem;
      color: #64748b;
    }
    .mc-tooltip-close-btn {
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 0.8rem;
      cursor: pointer;
      padding: 0 4px;
      margin-left: 6px;
      border-radius: 3px;
      line-height: 1;
      transition: all 0.15s ease;
    }
    .mc-tooltip-close-btn:hover {
      color: #ef4444;
      background: rgba(239, 68, 68, 0.2);
    }
    /* ── Radar Station Pins & Range Rings ── */
    ::ng-deep .radar-station-marker {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      user-select: none;
      transform: translate(-50%, -50%);
      z-index: 35;
      transition: transform 0.18s ease-out, filter 0.18s ease-out;
    }
    ::ng-deep .radar-station-marker:hover {
      z-index: 60;
      transform: translate(-50%, -50%) scale(1.18);
    }
    ::ng-deep .radar-station-marker .station-dot-container {
      position: relative;
      width: 14px;
      height: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    ::ng-deep .radar-station-marker .station-center-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #0ea5e9;
      box-shadow: 0 0 6px #0ea5e9;
      border: 1px solid #ffffff;
      transition: all 0.2s ease;
    }
    ::ng-deep .radar-station-marker.active-station {
      z-index: 55;
    }
    ::ng-deep .radar-station-marker.active-station .station-center-dot {
      width: 9px;
      height: 9px;
      background: #22c55e;
      box-shadow: 0 0 10px #22c55e, 0 0 20px rgba(34, 197, 94, 0.5);
      border: 1.5px solid #ffffff;
    }
    ::ng-deep .radar-station-marker.active-station .station-pulse-ring {
      position: absolute;
      top: -4px;
      left: -4px;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: 1.5px solid rgba(34, 197, 94, 0.85);
      animation: radarStationPulse 2s cubic-bezier(0.215, 0.61, 0.355, 1) infinite;
      pointer-events: none;
    }
    ::ng-deep .station-badge-label {
      background: rgba(15, 23, 42, 0.92);
      border: 1px solid rgba(56, 189, 248, 0.35);
      color: #93c5fd;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 10px;
      font-weight: 700;
      padding: 1.5px 6px;
      border-radius: 4px;
      box-shadow: 0 3px 10px rgba(0, 0, 0, 0.6);
      white-space: nowrap;
      backdrop-filter: blur(6px);
      display: none;
    }
    ::ng-deep .radar-station-marker.active-station .station-badge-label {
      border-color: rgba(34, 197, 94, 0.6);
      color: #4ade80;
      display: block;
    }
    ::ng-deep .radar-station-marker:hover .station-badge-label,
    ::ng-deep .radar-station-marker.show-label .station-badge-label {
      display: block;
    }
    ::ng-deep .dwr-ring-label-marker {
      pointer-events: none;
      user-select: none;
    }
    ::ng-deep .dwr-ring-badge {
      background: rgba(15, 23, 42, 0.9);
      color: #38bdf8;
      font-family: monospace;
      font-size: 10px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 4px;
      border: 1px solid rgba(56, 189, 248, 0.4);
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.6);
      white-space: nowrap;
    }
    ::ng-deep .dwr-ring-badge.outer {
      color: #ef4444;
      border-color: rgba(239, 68, 68, 0.5);
    }
  `]
})
export class MapComponent implements OnInit, OnDestroy {
  private layerService = inject(MapLayerService);
  private radarService = inject(RadarService);
  private forecastMap = inject(ForecastMapController);
  private satellite = inject(SatelliteService);
  private storms = inject(StormTracksService);

  readonly hoverInfo = this.radarService.hoverInfo;
  private map: MapLibreMap | null = null;
  private ringLabelMarkers: Marker[] = [];
  readonly isMapLoaded = signal<boolean>(false);
  private isRadarActive = true;

  // Reactive Effect: Layers Visibility and Opacity
  private layerEffect = effect(() => {
    const layers = this.layerService.layers();
    if (!this.map || !this.isMapLoaded()) return;
    this.syncOverlays(layers);
  });

  // Reactive Effect: Unified Merged Radar Mosaic across all active stations
  private radarMosaicEffect = effect(() => {
    const mosaic = this.radarService.displayed(); // the live composite, or a frame of the one-hour loop
    if (!this.map || !this.isMapLoaded()) return;
    this.updateRadarMosaicOverlay(mosaic);
  });

  // Reactive Effect: Meteosat satellite pictures (which are loaded, where the loop is, whether the layer is on, opacity)
  private satelliteEffect = effect(() => {
    const on = this.layerService.layers().some(l => l.id === 'satellite' && l.active);
    const frames = this.satellite.frames();
    const position = this.satellite.position();
    const opacity = this.satellite.opacity();
    if (!this.map || !this.isMapLoaded()) return;
    this.updateSatelliteOverlay(on, frames, position, opacity);
  });

  // Reactive Effect: Basemap Switcher (Terrain vs Dark)
  private basemapEffect = effect(() => {
    const basemap = this.layerService.activeBasemap();
    if (!this.map || !this.isMapLoaded()) return;
    this.syncBasemap(basemap);
  });

  // Reactive Effect: Radar Opacity Slider
  private radarOpacityEffect = effect(() => {
    const opacity = this.radarService.radarOpacity();
    if (!this.map || !this.isMapLoaded()) return;
    if (this.map.getLayer('radar-layer-mosaic')) {
      this.map.setPaintProperty('radar-layer-mosaic', 'raster-opacity', opacity);
    }
  });

  // Reactive Effect: Recenter Mosaic Request
  private centerStationEffect = effect(() => {
    const req = this.radarService.centerStationRequest();
    if (req > 0 && this.map) {
      this.flyToMosaicCenter();
    }
  });

  // Reactive Effect: Active Station Focus & Range Rings sync (camera stays locked over South India)
  private activeStationEffect = effect(() => {
    this.radarService.activeStationId();
    if (!this.map || !this.isMapLoaded()) return;
    const product = this.radarService.activeProduct();
    const ringsSource = this.map.getSource('radar-rings-source') as maplibregl.GeoJSONSource;
    if (ringsSource) {
      ringsSource.setData(this.buildRingsGeoJson(product));
    }
    this.createRingLabelMarkers(product);
  });

  ngOnInit(): void {
    this.initMap();
  }

  ngOnDestroy(): void {
    this.ringLabelMarkers.forEach(m => m.remove());
    this.ringLabelMarkers = [];

    if (this.map?.getLayer('radar-layer-mosaic')) {
      this.map.removeLayer('radar-layer-mosaic');
    }
    if (this.map?.getSource('radar-source-mosaic')) {
      this.map.removeSource('radar-source-mosaic');
    }

    this.removeSatelliteLayers();
    this.forecastMap.detach();
    this.map?.remove();
    this.map = null;
  }

  private initMap(): void {
    if (typeof maplibregl.setWorkerUrl === 'function') {
      maplibregl.setWorkerUrl('/maplibre-gl-worker.mjs');
    }

    const map = new maplibregl.Map({
      container: 'map-container',
      pixelRatio: typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1,
      style: {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
          'esri-dark-base': {
            type: 'raster',
            tiles: [
              'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
            ],
            tileSize: 256,
            maxzoom: 16,
            attribution: '&copy; Esri'
          },
          'esri-dark-hillshade': {
            type: 'raster',
            tiles: [
              'https://services.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade_Dark/MapServer/tile/{z}/{y}/{x}'
            ],
            tileSize: 256,
            maxzoom: 16
          },
          'esri-dark-ref': {
            type: 'raster',
            tiles: [
              'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}'
            ],
            tileSize: 256,
            maxzoom: 16
          }
        },
        layers: [
          {
            id: 'map-background-layer',
            type: 'background',
            paint: {
              'background-color': '#2b2e35'
            }
          },
          {
            id: 'dark-base-layer',
            type: 'raster',
            source: 'esri-dark-base',
            minzoom: 0,
            maxzoom: 19,
            paint: {
              'raster-brightness-min': 0.18,
              'raster-contrast': -0.05
            }
          },
          {
            id: 'dark-hillshade-layer',
            type: 'raster',
            source: 'esri-dark-hillshade',
            minzoom: 0,
            maxzoom: 19,
            paint: {
              'raster-opacity': 0.65,
              'raster-brightness-min': 0.14
            }
          },
          {
            id: 'dark-ref-layer',
            type: 'raster',
            source: 'esri-dark-ref',
            minzoom: 0,
            maxzoom: 19,
            paint: {
              'raster-opacity': 0.95
            }
          }
        ]
      },
      // Open on the whole forecast area; the map can be panned and zoomed out freely beyond it
      bounds: SOUTH_INDIA_VIEW,
      fitBoundsOptions: { padding: 12 },
      minZoom: 3.2,
      maxZoom: 15,
      maxBounds: MAP_MAX_BOUNDS,
      attributionControl: false
    });
    this.map = map;
    if (isDevMode()) (window as unknown as Record<string, unknown>)['__atmosMap'] = map; // debugging handle, dev builds only

    map.on('load', () => {
      this.isMapLoaded.set(true);

      // 1. Set initial basemap visibility (Dark Terrain)
      this.syncBasemap('dark');

      // 1b. Tamil Nadu boundary lines (must exist before any overlay layer is mounted)
      this.initBoundaries();

      // 2. Add Radar Range Rings GeoJSON Source & Layer
      this.initRangeRings();

      // 4. Initial Radar Mosaic Mount
      this.updateRadarMosaicOverlay(this.radarService.displayed());

      // 4b. Storm cells and their one-hour cones, above the radar
      this.initStormLayers();

      // 6. Initial overlay sync & trigger concurrent fetch of all radar sweeps
      this.syncOverlays(this.layerService.layers());

      // 7. ECMWF forecast layer (GPU), mounted below the boundary lines
      this.forecastMap.attach(map, this.overlayAnchorId());
    });

    // Clicking the radar shows the dBZ and rain rate at that point (forecast layers have their own inspector)
    map.on('click', (e) => {
      if (this.isRadarActive) {
        this.radarService.inspectLocation(e.lngLat.lat, e.lngLat.lng, {
          x: e.point.x,
          y: e.point.y
        });
      }
    });

    // Real-time IMD Radar dBZ hover inspector
    map.on('mousemove', (e) => {
      if (!this.isRadarActive) {
        this.radarService.clearHover();
        return;
      }
      this.radarService.inspectLocation(e.lngLat.lat, e.lngLat.lng, {
        x: e.point.x,
        y: e.point.y
      });
    });

    map.on('mouseout', () => {
      this.radarService.clearHover();
    });

    // Adaptive zoom detail scaling
    map.on('zoom', () => {
      this.syncZoomVisuals();
    });
  }

  // --- 1. IMD Doppler Weather Radar Unified Merged Composite Mosaic ---

  private updateRadarMosaicOverlay(mosaic: RadarDisplayFrame | null): void {
    if (!this.map || !this.isMapLoaded()) return;

    const sourceId = 'radar-source-mosaic';
    const layerId = 'radar-layer-mosaic';

    if (!mosaic) {
      if (this.map.getLayer(layerId)) {
        this.map.removeLayer(layerId);
      }
      if (this.map.getSource(sourceId)) {
        this.map.removeSource(sourceId);
      }
      return;
    }

    const existingSource = this.map.getSource(sourceId) as maplibregl.ImageSource;
    if (existingSource && typeof existingSource.updateImage === 'function') {
      existingSource.updateImage({
        url: mosaic.url,
        coordinates: mosaic.coordinates
      });
    } else if (!existingSource) {
      this.map.addSource(sourceId, {
        type: 'image',
        url: mosaic.url,
        coordinates: mosaic.coordinates
      });

      // above the boundary lines (the echoes stay readable) but under the storm cones and place names
      const targetBefore = this.map.getLayer(STORM_FIRST_LAYER_ID) ? STORM_FIRST_LAYER_ID : this.observationAnchorId();

      this.map.addLayer(
        {
          id: layerId,
          type: 'raster',
          source: sourceId,
          paint: {
            'raster-opacity': this.radarService.radarOpacity(),
            'raster-fade-duration': 0,
            'raster-resampling': 'linear'
          },
          layout: {
            visibility: this.isRadarActive ? 'visible' : 'none'
          }
        },
        targetBefore
      );
    }

    if (this.map.getLayer(layerId)) {
      this.map.setLayoutProperty(
        layerId,
        'visibility',
        this.isRadarActive ? 'visible' : 'none'
      );
      this.map.setPaintProperty(
        layerId,
        'raster-opacity',
        this.radarService.radarOpacity()
      );
    }
  }

  // --- Meteosat satellite pictures: one layer per picture, cross-faded by the loop position ---

  /** Picture URL on the map for each frame time, so changed or dropped pictures can be told apart from unchanged ones. */
  private satelliteMounted = new Map<number, string>();

  private removeSatelliteLayers(): void {
    if (!this.map) return;
    for (const t of this.satelliteMounted.keys()) {
      if (this.map.getLayer(`satellite-layer-${t}`)) this.map.removeLayer(`satellite-layer-${t}`);
      if (this.map.getSource(`satellite-source-${t}`)) this.map.removeSource(`satellite-source-${t}`);
    }
    this.satelliteMounted.clear();
  }

  /**
   * Shows frame `floor(position)` fully and fades the next one in by the fractional part, so playback moves smoothly
   * instead of jumping between pictures. Pictures are stacked oldest to newest, so the fading one is always on top.
   */
  private updateSatelliteOverlay(on: boolean, frames: readonly SatelliteFrame[], position: number, opacity: number): void {
    if (!this.map) return;
    if (!on || frames.length === 0) {
      this.removeSatelliteLayers();
      return;
    }
    const unchanged =
      frames.length === this.satelliteMounted.size && frames.every(f => this.satelliteMounted.get(f.timeMs) === f.url);
    if (!unchanged) {
      // rebuild in time order so the stacking order stays oldest at the bottom
      this.removeSatelliteLayers();
      const coordinates = satelliteCoordinates();
      const before = this.observationAnchorId(); // above the boundary lines, under the place names
      for (const f of frames) {
        this.map.addSource(`satellite-source-${f.timeMs}`, { type: 'image', url: f.url, coordinates });
        this.map.addLayer(
          {
            id: `satellite-layer-${f.timeMs}`,
            type: 'raster',
            source: `satellite-source-${f.timeMs}`,
            layout: { visibility: 'none' },
            paint: { 'raster-opacity': 0, 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
          },
          before
        );
        this.satelliteMounted.set(f.timeMs, f.url);
      }
    }
    const base = Math.min(Math.max(Math.floor(position), 0), frames.length - 1);
    const frac = Math.min(Math.max(position - base, 0), 1); // the frame list can change under a playing loop
    frames.forEach((f, k) => {
      const id = `satellite-layer-${f.timeMs}`;
      if (!this.map!.getLayer(id)) return;
      const o = k === base ? opacity : k === base + 1 ? opacity * frac : 0;
      this.map!.setLayoutProperty(id, 'visibility', o > 0.001 ? 'visible' : 'none');
      this.map!.setPaintProperty(id, 'raster-opacity', o);
    });
  }

  // --- Storm cells and cones ---

  private initStormLayers(): void {
    if (!this.map || this.map.getSource(STORM_SOURCE_ID)) return;
    this.map.addSource(STORM_SOURCE_ID, { type: 'geojson', data: this.storms.geojson() as unknown as maplibregl.GeoJSONSourceSpecification["data"] });
    const before = this.observationAnchorId();
    const color: maplibregl.ExpressionSpecification = ['case', ['get', 'severe'], '#f87171', '#fbbf24'];
    const kind = (k: string): maplibregl.ExpressionSpecification => ['==', ['get', 'kind'], k];
    const visibility = this.storms.visible() ? 'visible' : 'none';
    this.map.addLayer({ id: STORM_FIRST_LAYER_ID, type: 'fill', source: STORM_SOURCE_ID, filter: kind('cone'), layout: { visibility },
      paint: { 'fill-color': color, 'fill-opacity': 0.16 } }, before);
    this.map.addLayer({ id: 'storm-cone-line', type: 'line', source: STORM_SOURCE_ID, filter: kind('cone'), layout: { visibility, 'line-join': 'round' },
      paint: { 'line-color': color, 'line-opacity': 0.85, 'line-width': 1.3 } }, before);
    this.map.addLayer({ id: 'storm-track-line', type: 'line', source: STORM_SOURCE_ID, filter: kind('track'), layout: { visibility, 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-opacity': 0.8, 'line-width': 1.2, 'line-dasharray': [2, 2] } }, before);
    this.map.addLayer({ id: 'storm-ticks', type: 'circle', source: STORM_SOURCE_ID, filter: kind('tick'), layout: { visibility },
      paint: { 'circle-radius': 2.6, 'circle-color': '#ffffff', 'circle-stroke-color': color, 'circle-stroke-width': 1.2 } }, before);
    this.map.addLayer({ id: 'storm-tick-labels', type: 'symbol', source: STORM_SOURCE_ID, filter: kind('tick'), minzoom: 7,
      layout: { visibility, 'text-field': ['get', 'label'], 'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'], 'text-size': 10, 'text-offset': [0, 0.9] },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(8,12,22,0.9)', 'text-halo-width': 1.2 } }, before);
    this.map.addLayer({ id: 'storm-cells', type: 'circle', source: STORM_SOURCE_ID, filter: kind('cell'), layout: { visibility },
      paint: { 'circle-radius': 4, 'circle-color': color, 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1.5 } }, before);
    this.map.addLayer({ id: 'storm-cell-labels', type: 'symbol', source: STORM_SOURCE_ID, filter: kind('cell'), minzoom: 6,
      layout: { visibility, 'text-field': ['get', 'label'], 'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'], 'text-size': 11,
        'text-offset': [0, -1.2], 'text-allow-overlap': true },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(8,12,22,0.92)', 'text-halo-width': 1.4 } }, before);
  }

  private stormEffect = effect(() => {
    const data = this.storms.geojson();
    const visible = this.storms.visible();
    if (!this.map || !this.isMapLoaded()) return;
    (this.map.getSource(STORM_SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(data as unknown as maplibregl.GeoJSONSourceSpecification["data"]);
    for (const id of STORM_LAYER_IDS) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  });

  /** Observed imagery (radar, satellite) and storm cones go above the boundary lines but under the place names. */
  private observationAnchorId(): string | undefined {
    if (!this.map) return undefined;
    if (this.map.getLayer('district-labels-1')) return 'district-labels-1';
    return this.overlayAnchorId();
  }

  // --- Tamil Nadu boundary lines (state + 38 districts) ---

  /** Layer id that the forecast layers are inserted before, so boundaries and labels stay on top. */
  private overlayAnchorId(): string | undefined {
    if (!this.map) return undefined;
    if (this.map.getLayer(BOUNDARY_FIRST_LAYER_ID)) return BOUNDARY_FIRST_LAYER_ID;
    return this.map.getLayer('dark-ref-layer') ? 'dark-ref-layer' : undefined;
  }

  private initBoundaries(): void {
    if (!this.map || this.map.getSource(BOUNDARY_SOURCE_ID)) return;

    this.map.addSource(BOUNDARY_SOURCE_ID, {
      type: 'geojson',
      data: '/data/south-india-districts.geojson'
    });

    const before = this.map.getLayer('dark-ref-layer') ? 'dark-ref-layer' : undefined;
    const widths = (z5: number, z10: number): maplibregl.ExpressionSpecification =>
      ['interpolate', ['linear'], ['zoom'], 5, z5, 10, z10];
    const isDistrict: maplibregl.ExpressionSpecification = ['==', ['get', 'kind'], 'district'];
    const isState: maplibregl.ExpressionSpecification = ['==', ['get', 'kind'], 'state'];
    const line = (
      id: string,
      filter: maplibregl.ExpressionSpecification,
      color: string,
      width: maplibregl.ExpressionSpecification
    ) => this.map!.addLayer({
      id,
      type: 'line',
      source: BOUNDARY_SOURCE_ID,
      filter,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': color, 'line-width': width }
    }, before);

    // A dark casing under a light core keeps every line readable on both the pale humidity palette
    // and the dark teal / navy ends of the other palettes.
    line(BOUNDARY_FIRST_LAYER_ID, isDistrict, 'rgba(8, 12, 22, 0.5)', widths(1.8, 3.2));
    line('district-lines', isDistrict, 'rgba(255, 255, 255, 0.66)', widths(0.6, 1.2));
    line('state-casing', isState, 'rgba(8, 12, 22, 0.72)', widths(3.4, 6.0));
    line('state-line', isState, 'rgba(255, 255, 255, 0.96)', widths(1.5, 2.6));

    // District names. Bigger districts appear first as you zoom in, so low zoom stays readable.
    const labelMinZoom: Record<number, number> = { 1: 6.2, 2: 7.2, 3: 8.2 };
    for (const rank of [1, 2, 3]) {
      this.map.addLayer({
        id: `district-labels-${rank}`,
        type: 'symbol',
        source: BOUNDARY_SOURCE_ID,
        minzoom: labelMinZoom[rank],
        filter: ['all',
          ['==', ['get', 'kind'], 'label'],
          ['==', ['get', 'rank'], rank]
        ],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10, 10, 13],
          'text-max-width': 8
        },
        paint: {
          'text-color': 'rgba(255, 255, 255, 0.9)',
          'text-halo-color': 'rgba(8, 12, 22, 0.92)',
          'text-halo-width': 1.4
        }
      }, before);
    }
  }

  // --- 2. Concentric Radar Range Rings & Station Pins ---

  private initRangeRings(): void {
    if (!this.map) return;

    const product = this.radarService.activeProduct();
    this.map.addSource('radar-rings-source', {
      type: 'geojson',
      data: this.buildRingsGeoJson(product)
    });

    this.map.addLayer(
      {
        id: 'radar-rings-lines',
        type: 'line',
        source: 'radar-rings-source',
        paint: {
          'line-color': ['case', ['get', 'isOuter'], 'rgba(239, 68, 68, 0.65)', 'rgba(56, 189, 248, 0.4)'],
          'line-width': 1.0,
          'line-dasharray': [4, 4]
        },
        layout: {
          visibility: 'none'
        }
      },
      this.overlayAnchorId()
    );

    this.createRingLabelMarkers(product);
  }

  private buildRingsGeoJson(productKey: RadarProductKey): any {
    const center = this.radarService.activeStation();
    const prod = center.products[productKey] || center.products.caz;
    const rings = prod.rings;
    const maxKm = rings[rings.length - 1];

    const features = rings.map(km => {
      const coords = this.createCircleCoordinates(center.lng, center.lat, km);
      return {
        type: 'Feature',
        properties: {
          km,
          isOuter: km === maxKm
        },
        geometry: {
          type: 'LineString',
          coordinates: coords
        }
      };
    });

    return {
      type: 'FeatureCollection',
      features
    };
  }

  private createCircleCoordinates(centerLng: number, centerLat: number, radiusKm: number, steps = 72): [number, number][] {
    const coords: [number, number][] = [];
    const latRadius = radiusKm / 111.32;
    const lonRadius = radiusKm / (111.32 * Math.cos((centerLat * Math.PI) / 180));

    for (let i = 0; i <= steps; i++) {
      const angle = (i * 2 * Math.PI) / steps;
      const lon = centerLng + Math.sin(angle) * lonRadius;
      const lat = centerLat + Math.cos(angle) * latRadius;
      coords.push([lon, lat]);
    }
    return coords;
  }

  private createRingLabelMarkers(productKey: RadarProductKey): void {
    if (!this.map) return;

    this.ringLabelMarkers.forEach(m => m.remove());
    this.ringLabelMarkers = [];

    const center = this.radarService.activeStation();
    const prod = center.products[productKey] || center.products.caz;
    const rings = prod.rings;
    const maxKm = rings[rings.length - 1];

    for (const km of rings) {
      const isOuter = km === maxKm;
      const labelLat = center.lat + (km / 111.32);

      const el = document.createElement('div');
      el.className = 'dwr-ring-label-marker';
      el.innerHTML = `<span class="dwr-ring-badge ${isOuter ? 'outer' : ''}">${km}km</span>`;

      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([center.lng, labelLat])
        .addTo(this.map);

      el.style.display = 'none';
      this.ringLabelMarkers.push(marker);
    }
  }

  private syncBasemap(type: string = 'dark'): void {
    if (!this.map || !this.isMapLoaded()) return;
    if (this.map.getLayer('dark-base-layer')) {
      this.map.setLayoutProperty('dark-base-layer', 'visibility', 'visible');
    }
    if (this.map.getLayer('dark-hillshade-layer')) {
      this.map.setLayoutProperty('dark-hillshade-layer', 'visibility', 'visible');
    }
    if (this.map.getLayer('dark-ref-layer')) {
      this.map.setLayoutProperty('dark-ref-layer', 'visibility', 'visible');
    }
  }

  private syncZoomVisuals(): void {
    if (!this.map) return;
    const z = this.map.getZoom();

    const showRingLabels = z >= 7.5 && this.isRadarActive && this.radarService.showRangeRings();
    this.ringLabelMarkers.forEach(m => {
      m.getElement().style.display = showRingLabels ? 'block' : 'none';
    });
  }

  public flyToMosaicCenter(): void {
    if (!this.map) return;
    this.map.fitBounds(SOUTH_INDIA_VIEW, { padding: 12, essential: true });
  }

  public zoomIn(): void {
    this.map?.zoomIn();
  }

  public zoomOut(): void {
    this.map?.zoomOut();
  }

  private syncOverlays(layers: LayerConfig[]): void {
    if (!this.map || !this.isMapLoaded()) return;

    const radarLayer = layers.find(l => l.id === 'radar');
    const wasRadarActive = this.isRadarActive;
    this.isRadarActive = radarLayer?.active ?? true;

    // Toggle Unified Radar Mosaic Layer (opacity is owned by radarOpacityEffect)
    if (this.map.getLayer('radar-layer-mosaic')) {
      this.map.setLayoutProperty(
        'radar-layer-mosaic',
        'visibility',
        this.isRadarActive ? 'visible' : 'none'
      );
    }

    // Toggle Concentric Range Rings
    if (this.map.getLayer('radar-rings-lines')) {
      const showRings = this.radarService.showRangeRings();
      this.map.setLayoutProperty(
        'radar-rings-lines',
        'visibility',
        (this.isRadarActive && showRings) ? 'visible' : 'none'
      );
    }

    // Refresh live sweeps only when radar is switched back on. The service already
    // auto-refreshes every minute, so re-fetching on every layer/opacity change
    // would re-download and re-decode every station GIF on each slider tick.
    if (this.isRadarActive && !wasRadarActive) {
      untracked(() => this.radarService.fetchAllRadarSweeps());
    }

    this.syncZoomVisuals();
  }
}
