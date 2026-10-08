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
import { isPhone, maxPixelRatio } from '../../core/ui/device-profile';
import { RadarFieldLayer } from '../../core/rendering/radar-field.layer';
import { SatelliteImageLayer } from '../../core/rendering/satellite-image.layer';
import { GibsHdService } from '../../core/satellite/gibs-hd.service';
import { GIBS_MAX_ZOOM, GIBS_TILE_SIZE } from '../../core/satellite/gibs-hd';
import { registerGibsProtocol } from '../../core/satellite/gibs-hd-protocol';
import { SATELLITE_BOUNDS } from '../../core/satellite/satellite.config';
import { RadarProductKey } from '../../core/domain/models/radar.model';

/** [[west, south], [east, north]]: Tamil Nadu focus view by default. */
const TAMIL_NADU_VIEW: [[number, number], [number, number]] = [[76.0, 8.0], [80.6, 13.8]];
/** [[west, south], [east, north]]: the whole forecast area (South India, Sri Lanka and the seas around them). */
const SOUTH_INDIA_VIEW: [[number, number], [number, number]] = [[67.5, 3.5], [90.5, 22.5]];
/** How far the map can be panned and zoomed out: wide enough to roam freely beyond the forecast area. */
const MAP_MAX_BOUNDS: [[number, number], [number, number]] = [[52, -10], [108, 34]];

// State and district outlines for South India and Sri Lanka (built by scripts/build-south-india-data.py).
// The lines are drawn above every raster overlay (radar, forecast) so boundaries stay readable on top of them.
const BOUNDARY_SOURCE_ID = 'boundaries';
const BOUNDARY_FIRST_LAYER_ID = 'district-casing';
const BORDER_TOP_LAYER_ID = 'border-top';
const STORM_SOURCE_ID = 'storm-tracks';
const STORM_FIRST_LAYER_ID = 'storm-cone-fill';
const STORM_LAYER_IDS = [STORM_FIRST_LAYER_ID, 'storm-cone-line', 'storm-track-line', 'storm-ticks', 'storm-tick-labels', 'storm-cells', 'storm-cell-labels'];
import { ForecastMapController } from '../../core/forecast/forecast-map.controller';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';

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
  private gibs = inject(GibsHdService);
  private storms = inject(StormTracksService);
  private forecastState = inject(ForecastStateService);

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
    const view = this.satellite.view();
    if (!this.map || !this.isMapLoaded()) return;
    this.updateSatelliteOverlay(on, frames, position, opacity);
    this.satelliteLayer?.setLook(view);
  });

  // Reactive Effect: high-detail (250 m) true-colour satellite tiles from NASA GIBS
  private gibsEffect = effect(() => {
    const on = this.layerService.layers().some(l => l.id === 'gibs' && l.active);
    const template = this.gibs.template();
    const opacity = this.gibs.opacity();
    if (!this.map || !this.isMapLoaded()) return;
    this.updateGibsLayer(on, template, opacity);
  });

  // Reactive Effect: Basemap Switcher (Terrain vs Dark)
  private basemapEffect = effect(() => {
    const basemap = this.layerService.activeBasemap();
    if (!this.map || !this.isMapLoaded()) return;
    this.syncBasemap(basemap);
  });

  // Show or hide the district lines (the state and country outlines stay either way)
  private districtLinesEffect = effect(() => {
    const visible = this.forecastState.districtLines();
    if (!this.map || !this.isMapLoaded()) return;
    this.setDistrictLinesVisible(visible);
  });

  private setDistrictLinesVisible(visible: boolean): void {
    if (!this.map) return;
    for (const id of [BOUNDARY_FIRST_LAYER_ID, 'district-lines']) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  }

  // Show or hide the basemap terrain hillshade (tied to the Terrain relief toggle)
  private reliefEffect = effect(() => {
    const visible = this.forecastState.relief();
    if (!this.map || !this.isMapLoaded()) return;
    this.setHillshadeVisible(visible);
  });

  private setHillshadeVisible(visible: boolean): void {
    if (!this.map) return;
    if (this.map.getLayer('dark-hillshade-layer')) {
      this.map.setLayoutProperty('dark-hillshade-layer', 'visibility', visible ? 'visible' : 'none');
    }
  }

  // Reactive Effect: Radar Opacity Slider
  private radarOpacityEffect = effect(() => {
    const opacity = this.radarService.radarOpacity();
    if (!this.map || !this.isMapLoaded()) return;
    this.radarLayer?.setOpacity(opacity);
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

    this.removeRadarLayer();

    this.removeSatelliteLayers();
    this.removeGibsLayer();
    this.forecastMap.detach();
    this.map?.remove();
    this.map = null;
  }

  private initMap(): void {
    if (typeof maplibregl.setWorkerUrl === 'function') {
      maplibregl.setWorkerUrl('/maplibre-gl-worker.mjs');
    }

    const isMobile = typeof window !== 'undefined' && (window.innerWidth < 700 || ('ontouchstart' in window && window.innerWidth < 900));
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    const pixelRatio = maxPixelRatio(isMobile, dpr);

    registerGibsProtocol();
    const map = new maplibregl.Map({
      container: 'map-container',
      pixelRatio,
      fadeDuration: 50,
      maxTileCacheSize: 100,
      style: {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
          // Land, sea, borders, and roads drawn from OpenFreeMap's vector tiles (free, no key).
          'base-vector': {
            type: 'vector',
            url: 'https://tiles.openfreemap.org/planet',
            attribution: '&copy; OpenFreeMap, OpenMapTiles data &copy; OpenStreetMap contributors'
          },
          'esri-dark-hillshade': {
            type: 'raster',
            tiles: [
              'https://services.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade_Dark/MapServer/tile/{z}/{y}/{x}'
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
            id: 'dark-hillshade-layer',
            type: 'raster',
            source: 'esri-dark-hillshade',
            minzoom: 0,
            maxzoom: 19,
            layout: {
              visibility: 'none'
            },
            paint: {
              'raster-opacity': 0.65,
              'raster-brightness-min': 0.14
            }
          },
          {
            id: 'base-water',
            type: 'fill',
            source: 'base-vector',
            'source-layer': 'water',
            paint: { 'fill-color': '#171b22' }
          },
          // Roads: motorways, trunks, primary, secondary, and minor streets from OpenFreeMap
          {
            id: 'base-road-minor',
            type: 'line',
            source: 'base-vector',
            'source-layer': 'transportation',
            minzoom: 11,
            filter: ['match', ['get', 'class'], ['minor', 'service'], true, false],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': 'rgba(148, 163, 184, 0.14)',
              'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.4, 14, 0.9]
            }
          },
          {
            id: 'base-road-secondary',
            type: 'line',
            source: 'base-vector',
            'source-layer': 'transportation',
            minzoom: 8,
            filter: ['match', ['get', 'class'], ['secondary', 'tertiary'], true, false],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': 'rgba(203, 213, 225, 0.18)',
              'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 11, 0.9, 14, 1.6]
            }
          },
          {
            id: 'base-road-primary',
            type: 'line',
            source: 'base-vector',
            'source-layer': 'transportation',
            minzoom: 6,
            filter: ['match', ['get', 'class'], ['primary'], true, false],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': 'rgba(226, 232, 240, 0.25)',
              'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 9, 1.0, 13, 2.2]
            }
          },
          {
            id: 'base-road-motorway',
            type: 'line',
            source: 'base-vector',
            'source-layer': 'transportation',
            minzoom: 4.5,
            filter: ['match', ['get', 'class'], ['motorway', 'trunk'], true, false],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': 'rgba(241, 245, 249, 0.35)',
              'line-width': ['interpolate', ['linear'], ['zoom'], 4.5, 0.6, 8, 1.2, 12, 2.4, 15, 3.5]
            }
          },
          {
            id: 'base-border',
            type: 'line',
            source: 'base-vector',
            'source-layer': 'boundary',
            filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
            paint: { 'line-color': 'rgba(255, 255, 255, 0.28)', 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 8, 1.1] }
          }
        ]
      },
      // Open centered on Tamil Nadu by default; users can zoom out freely beyond it
      bounds: TAMIL_NADU_VIEW,
      fitBoundsOptions: { padding: 16 },
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

  private radarLayer: RadarFieldLayer | null = null;

  private removeRadarLayer(): void {
    if (this.map && this.radarLayer && this.map.getLayer(this.radarLayer.id)) this.map.removeLayer(this.radarLayer.id);
    this.radarLayer = null;
  }

  /**
   * The radar is drawn on the GPU from the mosaic's intensity (see RadarFieldLayer), so the layer is added when there is
   * a picture to show and the radar is on, and removed otherwise.
   */
  private updateRadarMosaicOverlay(mosaic: RadarDisplayFrame | null): void {
    if (!this.map || !this.isMapLoaded()) return;
    if (!mosaic || !this.isRadarActive) {
      this.removeRadarLayer();
      return;
    }
    if (!this.radarLayer) {
      this.radarLayer = new RadarFieldLayer();
      this.radarLayer.setOpacity(this.radarService.radarOpacity());
      // above the boundary lines (the echoes stay readable) but under the storm cones and place names
      this.map.addLayer(this.radarLayer, this.observationAnchorId());
    }
    this.radarLayer.setFrame(mosaic);
  }

  // --- Meteosat satellite pictures: one GPU layer with smooth (bicubic) magnification and a cross-fade between pictures ---

  private satelliteLayer: SatelliteImageLayer | null = null;
  private satelliteKeys = '';

  private removeSatelliteLayers(): void {
    if (this.map && this.satelliteLayer && this.map.getLayer(this.satelliteLayer.id)) this.map.removeLayer(this.satelliteLayer.id);
    this.satelliteLayer = null;
    this.satelliteKeys = '';
  }

  /**
   * Shows frame `floor(position)` and fades the next one in by the fractional part, so playback moves smoothly instead
   * of jumping between pictures.
   */
  private updateSatelliteOverlay(on: boolean, frames: readonly SatelliteFrame[], position: number, opacity: number): void {
    if (!this.map) return;
    if (!on || frames.length === 0) {
      this.removeSatelliteLayers();
      return;
    }
    if (!this.satelliteLayer) {
      this.satelliteLayer = new SatelliteImageLayer();
      // above the boundary lines, under the place names
      this.map.addLayer(this.satelliteLayer, this.observationAnchorId());
      this.satelliteLayer.setLite(isPhone());
    }
    const keys = frames.map(f => f.url).join('|');
    if (keys !== this.satelliteKeys) {
      this.satelliteKeys = keys;
      this.satelliteLayer.setFrames(frames.map(f => ({ key: f.url, url: f.url })));
    }
    this.satelliteLayer.setPosition(position, opacity);
  }

  // --- High-detail satellite: raster tiles of the day's true-colour picture (the protocol clears the no-data black) ---

  private gibsTemplate = '';

  private removeGibsLayer(): void {
    if (!this.map) return;
    if (this.map.getLayer('gibs-hd')) this.map.removeLayer('gibs-hd');
    if (this.map.getSource('gibs-hd')) this.map.removeSource('gibs-hd');
    this.gibsTemplate = '';
  }

  private updateGibsLayer(on: boolean, template: string, opacity: number): void {
    if (!this.map) return;
    if (!on) {
      this.removeGibsLayer();
      return;
    }
    if (template !== this.gibsTemplate || !this.map.getLayer('gibs-hd')) {
      this.removeGibsLayer();
      const b = SATELLITE_BOUNDS;
      this.map.addSource('gibs-hd', {
        type: 'raster',
        tiles: [template],
        tileSize: GIBS_TILE_SIZE,
        maxzoom: GIBS_MAX_ZOOM,
        bounds: [b.west, b.south, b.east, b.north],
        attribution: 'NASA GIBS / EOSDIS',
      });
      this.map.addLayer({ id: 'gibs-hd', type: 'raster', source: 'gibs-hd', paint: { 'raster-opacity': opacity, 'raster-fade-duration': 200 } }, this.observationAnchorId());
      this.gibsTemplate = template;
    }
    this.map.setPaintProperty('gibs-hd', 'raster-opacity', opacity);
  }

  // --- Storm cells and cones ---

  private initStormLayers(): void {
    if (!this.map || this.map.getSource(STORM_SOURCE_ID)) return;
    this.map.addSource(STORM_SOURCE_ID, { type: 'geojson', data: this.storms.geojson() as unknown as maplibregl.GeoJSONSourceSpecification["data"] });
    const before = undefined; // above everything, including the top outline
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

  /**
   * Observed imagery (radar, satellite) goes above the boundary lines but under the thin top outline (and so under the storm
   * cones, which are added after it). There are no place names on the map, so nothing else has to stay above the imagery.
   */
  private observationAnchorId(): string | undefined {
    if (!this.map) return undefined;
    return this.map.getLayer(BORDER_TOP_LAYER_ID) ? BORDER_TOP_LAYER_ID : undefined;
  }

  // --- Tamil Nadu boundary lines (state + 38 districts) ---

  /** Layer id that the forecast layers are inserted before, so the boundary lines stay on top of them. */
  private overlayAnchorId(): string | undefined {
    if (!this.map) return undefined;
    return this.map.getLayer(BOUNDARY_FIRST_LAYER_ID) ? BOUNDARY_FIRST_LAYER_ID : undefined;
  }

  private initBoundaries(): void {
    if (!this.map || this.map.getSource(BOUNDARY_SOURCE_ID)) return;

    this.map.addSource(BOUNDARY_SOURCE_ID, {
      type: 'geojson',
      data: '/data/south-india-districts.geojson',
      tolerance: 0.5
    });

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
    });

    // A dark casing under a light core keeps every line readable on both the pale humidity palette
    // and the dark teal / navy ends of the other palettes.
    line(BOUNDARY_FIRST_LAYER_ID, isDistrict, 'rgba(8, 12, 22, 0.5)', widths(1.8, 3.2));
    line('district-lines', isDistrict, 'rgba(255, 255, 255, 0.66)', widths(0.6, 1.2));
    line('state-casing', isState, 'rgba(8, 12, 22, 0.72)', widths(3.4, 6.0));
    line('state-line', isState, 'rgba(255, 255, 255, 0.96)', widths(1.5, 2.6));
    // A thin copy of the country and state outlines above the radar and satellite pictures, so the borders (Sri Lanka's
    // included) stay visible whatever imagery is on. The imagery is inserted just below this layer.
    line(BORDER_TOP_LAYER_ID, isState, 'rgba(255, 255, 255, 0.85)', widths(0.9, 1.6));
    this.setDistrictLinesVisible(this.forecastState.districtLines()); // the effect may have run before the layers existed
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
    for (const id of ['base-water', 'base-border', 'base-road-motorway', 'base-road-primary', 'base-road-secondary', 'base-road-minor']) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', 'visible');
    }
    this.setHillshadeVisible(this.forecastState.relief());
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
    this.map.fitBounds(TAMIL_NADU_VIEW, { padding: 16, essential: true });
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

    // Show or hide the radar mosaic (its opacity is owned by radarOpacityEffect)
    untracked(() => this.updateRadarMosaicOverlay(this.radarService.displayed()));

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
