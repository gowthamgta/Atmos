import {
  Component,
  computed,
  OnInit,
  OnDestroy,
  inject,
  effect,
  signal,
  untracked,
  isDevMode
} from '@angular/core';
import type * as maplibregl from 'maplibre-gl';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { loadMapLibre } from '../../core/map/maplibre-lazy';
import { MapLayerService, LayerConfig } from '../../core/services/map-layer.service';
import { RadarDisplayFrame, RadarService } from '../../core/services/radar.service';
import { StormTracksService } from '../../core/services/storm-tracks.service';
import { SatelliteFrame, SatelliteService } from '../../core/satellite/satellite.service';
import { isPhone, maxPixelRatio } from '../../core/ui/device-profile';
import { RadarFieldLayer } from '../../core/rendering/radar-field.layer';
import { SatelliteImageLayer } from '../../core/rendering/satellite-image.layer';
import { CloudVolumeLayer } from '../../core/rendering/cloud-volume.layer';
import { SatelliteDataLayer } from '../../core/rendering/satellite-data.layer';
import { isShaderKind } from '../../core/satellite/own-products';
import { GibsHdService } from '../../core/satellite/gibs-hd.service';
import { GIBS_MAX_ZOOM, GIBS_TILE_SIZE } from '../../core/satellite/gibs-hd';
import { registerGibsProtocol } from '../../core/satellite/gibs-hd-protocol';
import { MAP_MAX_ZOOM, SATELLITE_BOUNDS, SATELLITE_MAX_ZOOM, SatelliteChannel } from '../../core/satellite/satellite.config';
import { SatelliteDetailService, ShownWindow } from '../../core/satellite/satellite-detail.service';
import type { MapView } from '../../core/satellite/satellite-window';
import { RadarCoverageService } from '../../core/services/radar-coverage.service';
import { TerrainService } from '../../core/forecast/terrain.service';
import { syncCoverageLayer } from './radar-coverage-overlay';

/** Where the map opens and where "recenter" goes: Kallakurichi, at the zoom that shows the forecast area (about 16 degrees across). */
const KALLAKURICHI = { lng: 78.96, lat: 11.74 } as const;
const HOME_ZOOM = 6.2;
/** How far the map can be panned and zoomed out: wide enough to roam freely beyond the forecast area. */

// State and district outlines for South India and Sri Lanka (built by scripts/build-boundaries.py).
// The lines are drawn above every raster overlay (radar, forecast) so boundaries stay readable on top of them.
const BOUNDARY_SOURCE_ID = 'boundaries';
const BOUNDARY_FIRST_LAYER_ID = 'district-casing';
const BORDER_TOP_LAYER_ID = 'border-top';
const DARK_LAND = '#2b2e35';
const DARK_SEA = '#171b22';
const PLAIN_LAND = '#585b64';
const PLAIN_SEA = '#3d424d';
const STORM_SOURCE_ID = 'storm-tracks';
const STORM_FIRST_LAYER_ID = 'storm-cone-fill';
const STORM_LAYER_IDS = [STORM_FIRST_LAYER_ID, 'storm-cone-line', 'storm-track-line', 'storm-ticks', 'storm-tick-labels', 'storm-cells', 'storm-cell-labels'];
import { ForecastMapController } from '../../core/forecast/forecast-map.controller';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';
import { ForecastInspectorService } from '../../core/forecast/forecast-inspector.service';
import { MapHostService } from '../../core/ui/map-host.service';
import { UrlStateService } from '../../core/ui/url-state.service';
import { RadarHoverTooltipComponent } from './radar-hover-tooltip.component';

@Component({
  selector: 'app-map',
  standalone: true,
  imports: [RadarHoverTooltipComponent],
  template: `
    <div id="map-container">
      <app-radar-hover-tooltip />
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
    /* ── Live Radar Hover dBZ Tooltip ── */
  `]
})
export class MapComponent implements OnInit, OnDestroy {
  private layerService = inject(MapLayerService);
  private radarService = inject(RadarService);
  private forecastMap = inject(ForecastMapController);
  private satellite = inject(SatelliteService);
  private satelliteDetail = inject(SatelliteDetailService);
  private gibs = inject(GibsHdService);
  private storms = inject(StormTracksService);
  private coverage = inject(RadarCoverageService);
  private terrain = inject(TerrainService);
  private forecastState = inject(ForecastStateService);
  private forecastInspector = inject(ForecastInspectorService);

  private map: MapLibreMap | null = null;
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

  // Reactive Effect: the 90 m relief shaded into the radar echoes (the same terrain, light and strength as the forecast colours; the Terrain relief switch)
  private radarReliefEffect = effect(() => {
    const data = this.terrain.data();
    const strength = 0; // no shading on the radar echoes: the terrain is shown on the map itself (see reliefEffect)
    this.radarService.displayed(); // the layer exists once there is a picture to show
    const layer = this.radarLayer;
    if (!layer) return;
    layer.setTerrain(data);
    layer.setRelief(strength);
    layer.setLite(isPhone());
  });

  // Reactive Effect: the haze that marks where the radars see little (far away, behind mountains), under the echoes
  private coverageEffect = effect(() => {
    const overlay = this.coverage.overlay();
    const visible = this.coverage.visible();
    if (!this.map || !this.isMapLoaded()) return;
    syncCoverageLayer(this.map, overlay, visible, this.map.getLayer('radar-field-layer') ? 'radar-field-layer' : this.observationAnchorId());
  });

  // Reactive Effect: Meteosat satellite pictures (which are loaded, where the loop is, whether the layer is on, opacity)
  private satelliteEffect = effect(() => {
    const on = this.layerService.layers().some(l => l.id === 'satellite' && l.active);
    const frames = this.satellite.frames();
    const position = this.satellite.position();
    const opacity = this.satellite.opacity();
    const kind = this.satellite.current()?.product.id;
    const threeD = this.satellite.threeD();
    const heightScale = this.satellite.heightScale();
    this.satellite.irColour3D();   // redraw the 3D clouds when their colouring changes
    const custom = this.satellite.custom();
    if (!this.map || !this.isMapLoaded()) return;
    // our own pictures (own-products.ts): the 3D clouds are built from EUMETView's frames only
    const own = frames[0]?.own;
    const shader = !!own && isShaderKind(own.kind);
    const show3D = threeD && (!own || own.kind === 'rgb');   // our RGB frames carry the 3D field (with measured tops)
    this.updateSatelliteOverlay(on && !shader, frames, position, show3D ? 0 : opacity);
    this.updateSatelliteData(on && shader, frames, position, opacity, custom);
    this.updateCloudVolume(on && show3D, frames, position, opacity, heightScale);
    this.map.setMaxZoom(on ? SATELLITE_MAX_ZOOM : MAP_MAX_ZOOM); // closer than this the picture is only blur
  });

  // Reactive Effect: the closer window of the satellite picture at HRV's finer pixel (see satellite-detail.service.ts)
  private satelliteDetailEffect = effect(() => {
    const shown = this.satelliteDetail.shown();
    const position = this.satellite.position();
    const opacity = this.satellite.opacity();
    const kind = this.satellite.current()?.product.id;
    const threeD = this.satellite.threeD();
    const own = this.satellite.source() !== 'eumetview';
    if (!this.map || !this.isMapLoaded()) return;
    this.updateSatelliteDetailLayer(threeD || own ? null : shown, position, opacity, kind);
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

  /** Radar and satellite pictures sit on a plain, light basemap (roads, rivers and borders stay), like Windy's. */
  private plainBasemap = computed(() => this.layerService.layers().some(l => (l.id === 'radar' || l.id === 'satellite') && l.active));
  /** The satellite picture covers the ground, so the map's terrain is left out under it; the radar shows the terrain of the map (the Terrain relief toggle). */
  private satelliteOn = computed(() => this.layerService.layers().some(l => l.id === 'satellite' && l.active));

  // Show or hide the basemap terrain hillshade (tied to the Terrain relief toggle; off under the satellite picture)
  private reliefEffect = effect(() => {
    const visible = this.forecastState.relief() && !this.satelliteOn();
    if (!this.map || !this.isMapLoaded()) return;
    this.setHillshadeVisible(visible);
    this.showPlainLines(this.plainBasemap());
  });

  /**
   * Under a radar or satellite picture the roads and rivers of the basemap would be covered by it: draw them again above it, thin and
   * faint (like Windy), only while one of those layers is on.
   */
  private showPlainLines(on: boolean): void {
    const map = this.map;
    if (!map) return;
    const before = this.observationAnchorId();
    if (on && before && !map.getLayer('plain-waterway')) {
      map.addLayer({
        id: 'plain-waterway', type: 'line', source: 'base-vector', 'source-layer': 'waterway',
        filter: ['match', ['get', 'class'], ['river', 'canal'], true, false],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': 'rgba(150, 185, 235, 0.55)', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 9, 1.2, 12, 2.4] }
      }, before);
      map.addLayer({
        id: 'plain-roads', type: 'line', source: 'base-vector', 'source-layer': 'transportation', minzoom: 6,
        filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'], true, false],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': 'rgba(255, 255, 255, 0.4)', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 9, 0.9, 13, 1.8] }
      }, before);
    }
    for (const id of ['plain-waterway', 'plain-roads']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    // Windy's flat, mid-grey land and slightly darker sea under radar and satellite
    if (map.getLayer('map-background-layer')) map.setPaintProperty('map-background-layer', 'background-color', on ? PLAIN_LAND : DARK_LAND);
    if (map.getLayer('base-water')) map.setPaintProperty('base-water', 'fill-color', on ? PLAIN_SEA : DARK_SEA);
  }

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
  private readonly mapHost = inject(MapHostService);
  private readonly urlState = inject(UrlStateService);

  ngOnInit(): void {
    this.mapHost.register({
      zoomIn: () => this.zoomIn(),
      zoomOut: () => this.zoomOut(),
      home: () => this.flyToMosaicCenter(),
      flyTo: (lat, lon, zoom) => this.flyTo(lat, lon, zoom),
      tour: (legs, ms) => this.tour(legs, ms),
      view: () => (this.map ? { lat: this.map.getCenter().lat, lon: this.map.getCenter().lng, zoom: this.map.getZoom() } : null),
      renderer: () => this.renderer(),
      ensureVisible: (lat, lon, clear) => this.ensureVisible(lat, lon, clear),
    });
    void this.initMap();
  }

  private destroyed = false;

  ngOnDestroy(): void {
    this.destroyed = true;
    this.mapHost.register(null);

    this.removeRadarLayer();

    this.removeSatelliteLayers();
    this.removeGibsLayer();
    this.forecastMap.detach();
    this.map?.remove();
    this.map = null;
  }

  private async initMap(): Promise<void> {
    // the map library comes in its own file, after the page has drawn
    const ml = await loadMapLibre();
    if (this.destroyed) return;
    if (typeof ml.setWorkerUrl === 'function') {
      ml.setWorkerUrl('/maplibre-gl-worker.mjs');
    }

    const isMobile = typeof window !== 'undefined' && (window.innerWidth < 700 || ('ontouchstart' in window && window.innerWidth < 900));
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    const pixelRatio = maxPixelRatio(isMobile, dpr);

    registerGibsProtocol(ml);
    const map = new ml.Map({
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
          // Rivers and canals (streams only once zoomed in)
          {
            id: 'base-waterway',
            type: 'line',
            source: 'base-vector',
            'source-layer': 'waterway',
            filter: ['match', ['get', 'class'], ['river', 'canal'], true, ['==', ['zoom'], 99]],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': 'rgba(120, 150, 190, 0.55)',
              'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 9, 1.2, 12, 2.4]
            }
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
      // Open centred on Kallakurichi; users can zoom out freely beyond the forecast area
      // the position of a shared link, else Kallakurichi
      center: this.urlState.camera() ? [this.urlState.camera()!.lon, this.urlState.camera()!.lat] : [KALLAKURICHI.lng, KALLAKURICHI.lat],
      zoom: this.urlState.camera()?.zoom ?? HOME_ZOOM,
      minZoom: 3.2,
      maxZoom: MAP_MAX_ZOOM,
      attributionControl: false
    });
    this.map = map;
    if (isDevMode()) (window as unknown as Record<string, unknown>)['__atmosMap'] = map; // debugging handle, dev builds only

    // every move goes into the address, so a link opens at the same place
    map.on('moveend', () => {
      const c = map.getCenter();
      this.urlState.setCamera({ lat: c.lat, lon: c.lng, zoom: map.getZoom() });
    });

    map.on('load', () => {
      this.isMapLoaded.set(true);

      // 1. Set initial basemap visibility (Dark Terrain)
      this.syncBasemap('dark');

      // 1b. Tamil Nadu boundary lines (must exist before any overlay layer is mounted)
      this.initBoundaries();
      this.initPlaceLabels();

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
      if (this.layerService.layers().some(l => l.id === 'satellite' && l.active)) {
        this.satellite.inspectAt(e.lngLat.lat, e.lngLat.lng);
      }
    });

    // Real-time IMD Radar dBZ and Satellite Cloud-Top hover inspector
    map.on('mousemove', (e) => {
      if (this.layerService.layers().some(l => l.id === 'satellite' && l.active)) {
        this.satellite.inspectAt(e.lngLat.lat, e.lngLat.lng);
      } else {
        this.satellite.clearHover();
      }
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
      this.satellite.clearHover();
    });

    // The satellite detail window follows the map's position and size
    const sendView = () => this.satelliteDetail.setView(this.mapView());
    map.on('moveend', sendView);
    map.on('resize', sendView);
    map.on('load', sendView); // a map that opens where it is looking (a shared link, the last visit) gets its closer picture without a first move
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
      void this.terrain.ensureLoaded().catch(() => undefined); // the relief shading needs the terrain (loaded once, shared with the forecast layers)
      // above the boundary lines (the echoes stay readable) but under the storm cones and place names
      this.map.addLayer(this.radarLayer, this.observationAnchorId());
    }
    this.radarLayer.setFrame(mosaic);
  }

  // --- Meteosat satellite pictures: one GPU layer with smooth (bicubic) magnification and a cross-fade between pictures ---

  private satelliteLayer: SatelliteImageLayer | null = null;
  private satelliteDetailLayer: SatelliteImageLayer | null = null;
  private satelliteKeys = '';
  private satelliteDetailKeys = '';

  /** The map's current view as the detail service needs it. */
  private mapView(): MapView {
    const map = this.map!;
    const c = map.getCenter();
    const el = map.getContainer();
    return { lat: c.lat, lon: c.lng, zoom: map.getZoom(), width: el.clientWidth, height: el.clientHeight };
  }

  private removeSatelliteLayers(): void {
    if (this.map && this.satelliteData && this.map.getLayer(this.satelliteData.id)) this.map.removeLayer(this.satelliteData.id);
    this.satelliteData = null;
    if (this.map && this.cloudVolume && this.map.getLayer(this.cloudVolume.id)) this.map.removeLayer(this.cloudVolume.id);
    this.cloudVolume = null;
    this.removeFlatLayers();
  }

  /** The flat picture and its closer window (the 3D clouds and the browser-drawn products have their own layers). */
  private removeFlatLayers(): void {
    if (this.map && this.satelliteDetailLayer && this.map.getLayer(this.satelliteDetailLayer.id)) this.map.removeLayer(this.satelliteDetailLayer.id);
    this.satelliteDetailLayer = null;
    this.satelliteDetailKeys = '';
    if (this.map && this.satelliteLayer) {
      this.satelliteLayer.setWindow(null);
      if (this.map.getLayer(this.satelliteLayer.id)) this.map.removeLayer(this.satelliteLayer.id);
    }
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
      this.removeFlatLayers();
      return;
    }
    if (!this.satelliteLayer) {
      this.satelliteLayer = new SatelliteImageLayer();
      // above the boundary lines, under the place names
      this.map.addLayer(this.satelliteLayer, this.observationAnchorId());
    }
    this.satelliteLayer.setBounds(frames[0]?.own?.bounds ?? SATELLITE_BOUNDS); // ours cover their own box
    const keys = frames.map(f => f.url).join('|');
    if (keys !== this.satelliteKeys) {
      this.satelliteKeys = keys;
      this.satelliteLayer.setFrames(frames.map(f => ({ key: f.url, url: f.url })));
    }
    this.satelliteLayer.setFlows(this.satellite.flows());
    this.satelliteLayer.setSoften(!frames[0]?.own);   // our own frames are lossless: no softening
    this.satelliteLayer.setPosition(position, opacity);
  }

  // --- Our own products drawn in the browser from the data pack (satellite-data.layer.ts): IR enhanced, WV difference, custom RGB ---

  private satelliteData: SatelliteDataLayer | null = null;

  private updateSatelliteData(on: boolean, frames: readonly SatelliteFrame[], position: number, opacity: number, custom: SatelliteService['custom'] extends () => infer C ? C : never): void {
    const map = this.map;
    if (!map) return;
    const own = frames[0]?.own;
    if (!on || !own) {
      if (this.satelliteData && map.getLayer(this.satelliteData.id)) map.removeLayer(this.satelliteData.id);
      this.satelliteData = null;
      return;
    }
    if (!this.satelliteData) {
      this.satelliteData = new SatelliteDataLayer();
      map.addLayer(this.satelliteData, this.observationAnchorId());
    }
    this.satelliteData.setFrames(frames.map(f => ({ key: f.url, url: f.url })), own.bounds, own.minK, own.spanK);
    this.satelliteData.setStyle({ mode: own.kind === 'infrared' ? 0 : own.kind === 'wvdiff' ? 1 : 2, custom });
    this.satelliteData.setPosition(position, opacity);
  }

  // --- The live clouds in 3D (cloud-volume.layer.ts): the flat picture steps aside and the map tilts to show their heights ---

  private cloudVolume: CloudVolumeLayer | null = null;
  private tiltedFor3D = false;

  private updateCloudVolume(on: boolean, frames: readonly SatelliteFrame[], position: number, opacity: number, heightScale: number): void {
    const map = this.map;
    if (!map) return;
    if (!on) {
      if (this.cloudVolume && map.getLayer(this.cloudVolume.id)) map.removeLayer(this.cloudVolume.id);
      this.cloudVolume = null;
      if (this.tiltedFor3D) {
        this.tiltedFor3D = false;
        map.easeTo({ pitch: 0, duration: 900 });
      }
      return;
    }
    if (!this.cloudVolume) {
      this.cloudVolume = new CloudVolumeLayer();
      map.addLayer(this.cloudVolume, this.observationAnchorId());
    }
    if (!this.tiltedFor3D) {
      this.tiltedFor3D = true;
      if (map.getPitch() < 30) map.easeTo({ pitch: 55, duration: 1200 });
    }
    this.cloudVolume.setFrames(frames.map(f => ({
      key: f.url, field: f.cloudField ?? null, timeMs: f.timeMs, picture: f.url,
      ir: f.own ? { url: f.own.dataUrl, bounds: f.own.dataBounds ?? f.own.bounds } : undefined,
    })));
    this.cloudVolume.setIrColour(this.satellite.irColour3D());
    this.cloudVolume.setFlows(this.satellite.flows());
    this.cloudVolume.setHeightScale(heightScale);
    this.cloudVolume.setPosition(position, opacity);
  }

  /**
   * The closer window of the satellite picture at HRV's finer pixel, drawn over the whole-India picture. It has its own
   * GPU layer that fades in at its edge; the main layer makes a hole of the same size (see `setWindow`), so the two blend
   * seamlessly and the window shows no frame.
   */
  private updateSatelliteDetailLayer(shown: ShownWindow | null, position: number, opacity: number, kind: SatelliteChannel | undefined): void {
    if (!this.map || !this.satelliteLayer) return;
    if (!shown || shown.frames.every(f => f === null)) {
      if (this.satelliteDetailLayer) {
        if (this.map.getLayer(this.satelliteDetailLayer.id)) this.map.removeLayer(this.satelliteDetailLayer.id);
        this.satelliteDetailLayer = null;
        this.satelliteDetailKeys = '';
        this.satelliteLayer.setWindow(null);
      }
      return;
    }
    if (!this.satelliteDetailLayer) {
      this.satelliteDetailLayer = new SatelliteImageLayer({ id: 'satellite-detail-layer', featherFraction: 0.06 });
      // right above the main satellite layer
      this.map.addLayer(this.satelliteDetailLayer, this.observationAnchorId());
      this.satelliteLayer.setWindow(this.satelliteDetailLayer);
    }
    this.satelliteDetailLayer.setBounds(shown.window.bounds);
    // Build the frame list aligned to the main loop's times: null where the window has no picture yet
    const mainFrames = this.satellite.frames();
    const detailFrames = mainFrames.map(mf => {
      const idx = shown.times.indexOf(mf.timeMs);
      const df = idx >= 0 ? shown.frames[idx] : null;
      return df ? { key: df.url, url: df.url } : null;
    });
    const keys = detailFrames.map(f => f?.key ?? '').join('|');
    if (keys !== this.satelliteDetailKeys) {
      this.satelliteDetailKeys = keys;
      this.satelliteDetailLayer.setFrames(detailFrames);
    }
    this.satelliteDetailLayer.setFlows(this.satellite.flows()); // the main loop's motion, read by map position
    this.satelliteDetailLayer.setPosition(position, opacity);
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
      this.map.addLayer({ id: 'gibs-hd', type: 'raster', source: 'gibs-hd', paint: {
        'raster-opacity': opacity,
        'raster-fade-duration': 200,
        'raster-resampling': 'linear',
      } }, this.observationAnchorId());
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
    // the district lines are drawn for Tamil Nadu only; the other states show their outlines
    const isDistrict: maplibregl.ExpressionSpecification = ['all', ['==', ['get', 'kind'], 'district'], ['==', ['get', 'state'], 'Tamil Nadu']];
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


  /** Place names above the weather colours, with a dark halo so they stay readable on every palette (the base map has no labels of its own). */
  private initPlaceLabels(): void {
    if (!this.map || this.map.getLayer('label-city')) return;
    const font = ['Open Sans Regular', 'Arial Unicode MS Regular'];
    const name: maplibregl.ExpressionSpecification = ['coalesce', ['get', 'name_en'], ['get', 'name']];
    const halo = { 'text-halo-color': 'rgba(6, 11, 22, 0.92)', 'text-halo-width': 1.5, 'text-halo-blur': 0.4 };
    const symbol = (
      id: string, sourceLayer: string, filter: maplibregl.ExpressionSpecification, minzoom: number, maxzoom: number,
      size: maplibregl.ExpressionSpecification | number, color: string, extra: Record<string, unknown> = {}
    ) => this.map!.addLayer({
      id, type: 'symbol', source: 'base-vector', 'source-layer': sourceLayer, filter, minzoom, maxzoom,
      layout: { 'text-field': name, 'text-font': font, 'text-size': size, 'text-max-width': 7, ...extra } as maplibregl.SymbolLayerSpecification['layout'],
      paint: { 'text-color': color, ...halo }
    });
    symbol('label-sea', 'water_name', ['match', ['get', 'class'], ['sea', 'ocean'], true, false], 3, 8, 11, 'rgba(150, 200, 240, 0.9)', { 'text-letter-spacing': 0.15, 'text-transform': 'uppercase' });
    symbol('label-country', 'place', ['==', ['get', 'class'], 'country'], 3, 7, ['interpolate', ['linear'], ['zoom'], 3, 10, 6, 14], 'rgba(235, 240, 250, 0.85)', { 'text-transform': 'uppercase', 'text-letter-spacing': 0.12 });
    symbol('label-state', 'place', ['==', ['get', 'class'], 'state'], 4.5, 8.5, ['interpolate', ['linear'], ['zoom'], 5, 10, 8, 12.5], 'rgba(214, 224, 242, 0.8)', { 'text-transform': 'uppercase', 'text-letter-spacing': 0.08 });
    symbol('label-city', 'place', ['==', ['get', 'class'], 'city'], 4.5, 24, ['interpolate', ['linear'], ['zoom'], 5, 11, 10, 15], '#ffffff');
    symbol('label-town', 'place', ['==', ['get', 'class'], 'town'], 7, 24, ['interpolate', ['linear'], ['zoom'], 7, 10.5, 12, 13.5], 'rgba(244, 247, 252, 0.95)');
    symbol('label-village', 'place', ['match', ['get', 'class'], ['village', 'suburb', 'hamlet'], true, false], 9.5, 24, 11, 'rgba(226, 233, 245, 0.88)');
  }
  private syncBasemap(type: string = 'dark'): void {
    if (!this.map || !this.isMapLoaded()) return;
    for (const id of ['base-water', 'base-waterway', 'base-border', 'base-road-motorway', 'base-road-primary', 'base-road-secondary', 'base-road-minor']) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', 'visible');
    }
    this.setHillshadeVisible(this.forecastState.relief() && !this.satelliteOn());
  }

  public flyToMosaicCenter(): void {
    if (!this.map) return;
    this.map.easeTo({ center: [KALLAKURICHI.lng, KALLAKURICHI.lat], zoom: HOME_ZOOM, essential: true });
  }

  /** Move the view to a place (a search result), at street-and-town level unless a zoom is given. */
  public flyTo(lat: number, lon: number, zoom = 9): void {
    this.map?.flyTo({ center: [lon, lat], zoom, essential: true });
  }

  /** Moves the camera through the views in turn (the map speed test); each leg ends when the camera stops, or a little after it should have. */
  public async tour(legs: readonly { lat: number; lon: number; zoom: number }[], msPerLeg: number): Promise<void> {
    const map = this.map;
    if (!map) return;
    for (const leg of legs) {
      await new Promise<void>(resolve => {
        const done = setTimeout(resolve, msPerLeg + 1500);
        map.once('moveend', () => {
          clearTimeout(done);
          resolve();
        });
        map.easeTo({ center: [leg.lon, leg.lat], zoom: leg.zoom, duration: msPerLeg, essential: true });
      });
    }
  }

  /** Pans the map by the least that brings a point into the clear part of the screen (the part the meteogram, the card and the bars leave free). */
  public ensureVisible(lat: number, lon: number, clear: { top: number; right: number; bottom: number; left: number }): void {
    const map = this.map;
    if (!map) return;
    const canvas = map.getCanvas();
    const p = map.project([lon, lat]);
    const minX = clear.left;
    const maxX = Math.max(minX, canvas.clientWidth - clear.right);
    const minY = clear.top;
    const maxY = Math.max(minY, canvas.clientHeight - clear.bottom);
    const dx = p.x - Math.min(Math.max(p.x, minX), maxX);
    const dy = p.y - Math.min(Math.max(p.y, minY), maxY);
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) map.panBy([dx, dy], { duration: 350, essential: true });
  }

  /** The graphics chip the page is drawn with, as the browser reports it ("ANGLE (Qualcomm, Adreno (TM) 619...)"). */
  public renderer(): string {
    try {
      const canvas = this.map?.getCanvas();
      const gl = (canvas?.getContext('webgl2') ?? canvas?.getContext('webgl')) as WebGLRenderingContext | null | undefined;
      if (!gl) return '';
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)).replace(/\s+/g, ' ').slice(0, 80);
    } catch {
      return '';
    }
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

    // Refresh live sweeps only when radar is switched back on. The service already
    // auto-refreshes every minute, so re-fetching on every layer/opacity change
    // would re-download and re-decode every station GIF on each slider tick.
    if (this.isRadarActive && !wasRadarActive) {
      untracked(() => this.radarService.fetchAllRadarSweeps());
    }

  }
}
