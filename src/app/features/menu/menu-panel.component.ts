import { ChangeDetectionStrategy, Component, HostListener, computed, inject, signal } from '@angular/core';
import { MapLayerService } from '../../core/services/map-layer.service';
import { ForecastCatalogService } from '../../core/forecast/forecast-catalog.service';
import { ForecastLayerDef, LAYER_GROUPS, layerAvailableAt, paletteGradientCss, supportsLevels } from '../../core/forecast/forecast-layers';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';
import { MapHostService } from '../../core/ui/map-host.service';
import { PerfMeterService } from '../../core/ui/perf-meter.service';
import { FrameStats, Grade, gradeOf, slowShare } from '../../core/ui/perf-stats';
import { MenuTab, PanelService } from '../../core/ui/panel.service';
import { UnitsService } from '../../core/units/units.service';
import { PRESSURE_LABEL, PRESSURE_UNITS, RAIN_LABEL, RAIN_UNITS, TEMP_LABEL, TEMP_UNITS, WIND_LABEL, WIND_UNITS } from '../../core/units/units';
import { IconComponent } from '../../shared/icon.component';
import { RovingTabsDirective } from '../../shared/roving-tabs.directive';
import { layerIcon } from '../../shared/icons';
import { ThemeService } from '../../shared/theme.service';
import { AltitudePickerComponent } from '../altitude/altitude-picker.component';
import { ModelListComponent } from '../models/model-list.component';

const TABS: readonly { id: MenuTab; label: string }[] = [
  { id: 'layers', label: 'Layers' },
  { id: 'models', label: 'Models' },
  { id: 'settings', label: 'Settings' },
];

/**
 * The one panel for everything that is not on the rail, opened by the button at the top right (on a phone it is a sheet from the bottom).
 * Layers: a search, the observed pictures, every layer with its palette, the altitude, and the overlays as switches. Models: the forecast
 * models and how current each is. Settings: units, look, the map's home view and full screen, share and credits.
 */
@Component({
  selector: 'app-menu-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AltitudePickerComponent, IconComponent, ModelListComponent, RovingTabsDirective],
  template: `
    @if (open()) {
      <div class="scrim" (click)="panels.close('menu')" aria-hidden="true"></div>
      <section id="menu-panel" class="panel" role="dialog" aria-label="Menu: layers, models and settings">
        <header class="head">
          <div class="seg tabs" role="tablist" aria-label="Menu" appRovingTabs>
            @for (t of tabs; track t.id) {
              <button type="button" role="tab" [id]="'tab-' + t.id" [class.on]="tab() === t.id" [attr.aria-selected]="tab() === t.id" [attr.tabindex]="tab() === t.id ? 0 : -1" aria-controls="menu-body" (click)="panels.menuTab.set(t.id)">{{ t.label }}</button>
            }
          </div>
          <button type="button" class="btn-icon" (click)="panels.close('menu')" aria-label="Close the menu" title="Close (Esc)"><app-icon name="close" [size]="16" /></button>
        </header>

        <div class="scroll" id="menu-body" role="tabpanel" [attr.aria-labelledby]="'tab-' + tab()">
          @switch (tab()) {
            @case ('layers') {
              <label class="find">
                <app-icon name="search" [size]="16" />
                <input type="search" placeholder="Search for a layer" aria-label="Search for a layer" [value]="filter()" (input)="onFilter($event)" autocomplete="off" />
              </label>

              @if (!filter()) {
                <section aria-labelledby="h-obs">
                  <h3 id="h-obs">Observed</h3>
                  <div class="obs">
                    <button type="button" class="tile" [class.active]="radarActive()" [attr.aria-pressed]="radarActive()" (click)="toggleRadar()" title="IMD radar: what is falling now (observed, not a forecast)">
                      <app-icon name="radar" [size]="20" /><span class="tile-name">Radar</span><span class="tile-sub">IMD · live</span>
                    </button>
                    <button type="button" class="tile" [class.active]="satelliteActive()" [attr.aria-pressed]="satelliteActive()" (click)="toggleSatellite()" title="Live satellite: Meteosat-9 over India, HRV by day, infrared at night">
                      <app-icon name="satellite" [size]="20" /><span class="tile-name">Satellite</span><span class="tile-sub">15 min</span>
                    </button>
                    <button type="button" class="tile" [class.active]="gibsActive()" [attr.aria-pressed]="gibsActive()" (click)="toggleGibs()" title="High-detail true-colour picture at 250 m, one per day (NASA GIBS)">
                      <app-icon name="globe" [size]="20" /><span class="tile-name">HD satellite</span><span class="tile-sub">250 m · daily</span>
                    </button>
                  </div>
                </section>
              }

              <section aria-labelledby="h-layers">
                <h3 id="h-layers">Forecast layers</h3>
                @for (group of groups(); track group.name) {
                  <h4>{{ group.name }}</h4>
                  <div class="list">
                    @for (layer of group.layers; track layer.id) {
                      <button
                        type="button" class="layer" [class.active]="state.activeLayerId() === layer.id" [class.ground-only]="groundOnly(layer)"
                        [attr.aria-pressed]="state.activeLayerId() === layer.id" [disabled]="!available(layer)"
                        [title]="layerTitle(layer)" (click)="state.toggleLayer(layer.id)"
                      >
                        <app-icon class="l-icon" [name]="icon(layer.id)" [size]="18" />
                        <span class="l-name">{{ layer.label }}</span>
                        <span class="l-palette" [style.background]="palette(layer)" aria-hidden="true"></span>
                        @if (state.activeLayerId() === layer.id) { <app-icon class="tick" name="check" [size]="15" /> }
                      </button>
                    }
                  </div>
                } @empty {
                  <p class="none">No layer matches “{{ filter() }}”.</p>
                }
              </section>

              @if (!filter()) {
                <section aria-labelledby="h-alt">
                  <h3 id="h-alt">Altitude</h3>
                  <app-altitude-picker inline />
                  <p class="hint alt-hint">Heights and flight levels are for the standard atmosphere; on the day, a level can sit a few hundred metres higher or lower.</p>
                </section>

                <section aria-labelledby="h-over">
                  <h3 id="h-over">Overlays</h3>
                  <div class="overlays">
                    <button type="button" class="toggle" [attr.aria-pressed]="state.windParticles()" (click)="state.toggleWindParticles()" title="Animated wind streaks at the selected altitude">
                      <app-icon name="wind" [size]="16" />Wind streaks
                    </button>
                    <button type="button" class="toggle" [attr.aria-pressed]="state.isobars()" [disabled]="!contourAvailable()" (click)="state.toggleIsobars()" [title]="state.level() === 'surface' ? 'Lines of equal sea-level pressure' : 'Lines of equal height of the ' + state.level() + ' hPa surface'">
                      <app-icon name="isobars" [size]="16" />{{ state.level() === 'surface' ? 'Pressure lines' : 'Height lines' }}
                    </button>
                    <button type="button" class="toggle" [attr.aria-pressed]="state.stationMarkers()" (click)="state.toggleStationMarkers()" title="Weather stations of Tamil Nadu (observed, last 24 h). Click a station for its readings">
                      <app-icon name="pin" [size]="16" />Weather stations
                    </button>
                    <button type="button" class="toggle" [attr.aria-pressed]="state.cyclones()" (click)="state.toggleCyclones()" title="ECMWF forecast tracks of tropical cyclones near India (drawn when there are any)">
                      <app-icon name="cyclone" [size]="16" />Cyclone tracks
                    </button>
                    <button type="button" class="toggle" [attr.aria-pressed]="state.districtLines()" (click)="state.toggleDistrictLines()" title="Show or hide the district boundaries (state and country outlines stay)">
                      <app-icon name="districts" [size]="16" />Districts
                    </button>
                    <button type="button" class="toggle" [attr.aria-pressed]="state.relief()" (click)="state.toggleRelief()" title="Shade the 90 m terrain into the colour layer">
                      <app-icon name="mountain" [size]="16" />Terrain relief
                    </button>
                  </div>
                </section>
              }
            }

            @case ('models') {
              <app-model-list />
            }

            @case ('settings') {
              <section aria-labelledby="h-units">
                <h3 id="h-units">Units</h3>
                <div class="units">
                  <div class="urow"><span>Temperature</span><div class="seg" role="group" aria-label="Temperature unit">
                    @for (u of tempUnits; track u) { <button type="button" [class.on]="units().temp === u" [attr.aria-pressed]="units().temp === u" (click)="setUnit('temp', u)">{{ tempLabel[u] }}</button> }
                  </div></div>
                  <div class="urow"><span>Wind</span><div class="seg" role="group" aria-label="Wind unit">
                    @for (u of windUnits; track u) { <button type="button" [class.on]="units().wind === u" [attr.aria-pressed]="units().wind === u" (click)="setUnit('wind', u)">{{ windLabel[u] }}</button> }
                  </div></div>
                  <div class="urow"><span>Rain</span><div class="seg" role="group" aria-label="Rain unit">
                    @for (u of rainUnits; track u) { <button type="button" [class.on]="units().rain === u" [attr.aria-pressed]="units().rain === u" (click)="setUnit('rain', u)">{{ rainLabel[u] }}</button> }
                  </div></div>
                  <div class="urow"><span>Pressure</span><div class="seg" role="group" aria-label="Pressure unit">
                    @for (u of pressureUnits; track u) { <button type="button" [class.on]="units().pressure === u" [attr.aria-pressed]="units().pressure === u" (click)="setUnit('pressure', u)">{{ pressureLabel[u] }}</button> }
                  </div></div>
                  <p class="hint">The unit at the left of the colour bar changes these too.</p>
                </div>
              </section>

              <section aria-labelledby="h-look">
                <h3 id="h-look">Look</h3>
                <div class="seg wide" role="group" aria-label="Theme">
                  <button type="button" [class.on]="theme.theme() === 'dark'" [attr.aria-pressed]="theme.theme() === 'dark'" (click)="theme.theme.set('dark')">Dark</button>
                  <button type="button" [class.on]="theme.theme() === 'light'" [attr.aria-pressed]="theme.theme() === 'light'" (click)="theme.theme.set('light')">Light</button>
                </div>
              </section>

              <section aria-labelledby="h-map">
                <h3 id="h-map">Map</h3>
                <div class="actions">
                  <button type="button" (click)="mapHost.home(); panels.close('menu')"><app-icon name="home" [size]="16" />Home view</button>
                  @if (fullscreenAvailable) {
                    <button type="button" (click)="toggleFullscreen()" [attr.aria-pressed]="fullscreen()"><app-icon [name]="fullscreen() ? 'shrink' : 'expand'" [size]="16" />{{ fullscreen() ? 'Leave full screen' : 'Full screen' }}</button>
                  }
                  <button type="button" (click)="share()"><app-icon name="share" [size]="16" />{{ copied() ? 'Link copied' : 'Share this view' }}</button>
                  <button type="button" (click)="about()"><app-icon name="help" [size]="16" />Help &amp; credits</button>
                </div>
              </section>

              <section aria-labelledby="h-speed">
                <h3 id="h-speed">Speed</h3>
                <div class="actions">
                  <button type="button" (click)="perf.toggle()" [attr.aria-pressed]="perf.enabled()" title="A line over the map with the frame rate, the worst frames, long tasks and memory"><app-icon name="gauge" [size]="16" />Performance meter</button>
                  <button type="button" (click)="runTest()" [disabled]="perf.testing()" title="Pans and zooms the map for ten seconds and reports how smoothly it drew"><app-icon name="clock" [size]="16" />{{ perf.testing() ? 'Testing…' : 'Test map speed' }}</button>
                </div>
                @if (perf.testing()) {
                  <p class="hint" role="status">Resting, then panning and zooming, for ten seconds. Keep this page in front.</p>
                }
                @if (report(); as r) {
                  <div class="report" role="group" aria-label="Map speed test result">
                    <p class="verdict" [class.good]="r.grade === 'good'" [class.fair]="r.grade === 'fair'" [class.poor]="r.grade === 'poor'">{{ r.verdict }}</p>
                    <table>
                      <thead><tr><th></th><th>frames/s</th><th>95% under</th><th>stutters</th></tr></thead>
                      <tbody>
                        @for (row of r.rows; track row.name) { <tr><th scope="row">{{ row.name }}</th><td>{{ row.fps }}</td><td>{{ row.p95 }}</td><td>{{ row.slow }}</td></tr> }
                      </tbody>
                    </table>
                    <p class="hint">{{ r.device }}</p>
                  </div>
                }
              </section>
            }
          }
        </div>
      </section>
    }
  `,
  styles: [`
    :host { display: contents; }
    .scrim { display: none; }
    .panel {
      position: fixed; z-index: var(--z-panel); top: calc(var(--gutter) + var(--hit) + 8px); right: var(--gutter); width: min(400px, calc(100vw - 2 * var(--gutter)));
      max-height: calc(100dvh - var(--gutter) - var(--hit) - 8px - var(--stack-h) - 10px); display: flex; flex-direction: column;
      background: var(--surface-solid); border-radius: var(--radius-l); box-shadow: var(--shadow-2); color: var(--text-primary); animation: sheet-in var(--t-med) both;
    }
    .head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); padding: var(--sp-2) var(--sp-2) var(--sp-1) var(--sp-3); }
    .tabs { flex: 1; }
    .tabs button { flex: 1; }
    .scroll { overflow-y: auto; padding: var(--sp-1) var(--sp-3) var(--sp-3); overscroll-behavior: contain; }
    section + section { margin-top: var(--sp-4); }
    h3 { margin: var(--sp-2) 0 var(--sp-2); font-size: var(--fs-xs); font-weight: var(--fw-strong); text-transform: uppercase; letter-spacing: var(--ls-caps); color: var(--text-muted); }
    h4 { margin: var(--sp-3) 0 var(--sp-1); font-size: var(--fs-s); font-weight: var(--fw-medium); color: var(--text-secondary); }
    .none { padding: var(--sp-3) 0; font-size: var(--fs-m); color: var(--text-muted); }

    .find { display: flex; align-items: center; gap: var(--sp-2); height: var(--hit); padding: 0 var(--sp-3); margin-bottom: var(--sp-2); border-radius: calc(var(--hit) / 2); background: var(--surface-3); color: var(--text-secondary); }
    .find input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text-primary); font-size: var(--fs-l); }
    .find input::placeholder { color: var(--text-muted); }
    .find:focus-within { box-shadow: 0 0 0 2px var(--accent-strong); }

    .obs { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--sp-2); }
    .tile { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: var(--sp-2) var(--sp-3); min-height: var(--tap); border-radius: var(--radius-m); border: 0; background: var(--surface-3); color: var(--text-secondary); cursor: pointer; text-align: left; transition: background var(--t-fast); }
    .tile:hover:not(.active) { background: var(--surface-4); color: var(--text-primary); }
    .tile.active { background: var(--accent); color: var(--on-accent); }
    .tile.active:hover { background: var(--accent-strong); color: var(--on-accent); }
    .tile-name { font-weight: var(--fw-strong); font-size: var(--fs-m); color: var(--text-primary); }
    .tile.active .tile-name { color: inherit; }
    .tile-sub { font-size: var(--fs-xs); color: var(--text-muted); }
    .tile.active .tile-sub { color: inherit; opacity: 0.8; }

    .list { display: flex; flex-direction: column; }
    .layer { display: flex; align-items: center; gap: var(--sp-3); min-height: var(--hit); padding: var(--sp-1) var(--sp-2); border: 0; border-radius: var(--radius-m); background: transparent; color: var(--text-primary); font-size: var(--fs-l); cursor: pointer; text-align: left; transition: background var(--t-fast); }
    .layer:hover:not(:disabled):not(.active) { background: var(--surface-3); }
    .layer.active, .layer.active:hover:not(:disabled) { background: var(--accent); color: var(--on-accent); font-weight: var(--fw-strong); }
    .layer:disabled { opacity: 0.4; cursor: not-allowed; }
    .layer.ground-only:not(.active) { opacity: 0.65; }
    .l-icon { color: var(--text-secondary); }
    .layer.active .l-icon { color: var(--on-accent); }
    .l-name { flex: 1; min-width: 0; line-height: var(--lh-tight); }
    /* the layer's own palette, small: this is where its colours are shown, so the buttons themselves can stay plain */
    .l-palette { flex: none; width: 44px; height: 6px; border-radius: 3px; opacity: 0.9; }
    .layer.active .l-palette { opacity: 1; box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.32); }
    .tick { color: var(--on-accent); }

    .alt-hint { margin: var(--sp-2) var(--sp-1) 0; }

    .overlays { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-1); }
    .toggle { display: flex; align-items: center; gap: var(--sp-2); min-height: var(--hit); padding: 0 var(--sp-3); border: 0; border-radius: var(--radius-m); background: var(--surface-3); color: var(--text-secondary); font-size: var(--fs-m); font-weight: var(--fw-medium); cursor: pointer; text-align: left; transition: background var(--t-fast); }
    .toggle:hover:not(:disabled):not([aria-pressed='true']) { background: var(--surface-4); color: var(--text-primary); }
    .toggle[aria-pressed='true'], .toggle[aria-pressed='true']:hover:not(:disabled) { background: var(--accent); color: var(--on-accent); }
    .toggle:disabled { opacity: 0.4; cursor: not-allowed; }

    .units { display: flex; flex-direction: column; gap: var(--sp-2); }
    .urow { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); font-size: var(--fs-l); }
    .hint { font-size: var(--fs-xs); color: var(--text-muted); }

    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-1); }
    .actions button { display: flex; align-items: center; gap: var(--sp-2); min-height: var(--hit); padding: 0 var(--sp-3); border: 0; border-radius: var(--radius-m); background: var(--surface-3); color: var(--text-primary); font-size: var(--fs-m); font-weight: var(--fw-medium); cursor: pointer; text-align: left; }
    .actions button:hover:not(:disabled):not([aria-pressed='true']) { background: var(--surface-4); }
    .actions button[aria-pressed='true'], .actions button[aria-pressed='true']:hover:not(:disabled) { background: var(--accent); color: var(--on-accent); }
    .actions button:disabled { opacity: 0.6; cursor: progress; }
    .report { margin-top: var(--sp-3); padding: var(--sp-3); border-radius: var(--radius-m); background: var(--surface-3); }
    .verdict { margin: 0 0 var(--sp-2); font-size: var(--fs-l); font-weight: var(--fw-strong); }
    .verdict.good { color: var(--ok); }
    .verdict.fair { color: var(--warn); }
    .verdict.poor { color: var(--danger); }
    .report table { width: 100%; border-collapse: collapse; font-size: var(--fs-m); font-variant-numeric: tabular-nums; }
    .report th, .report td { padding: 3px 0; text-align: right; font-weight: var(--fw-normal); }
    .report thead th { font-size: var(--fs-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: var(--ls-caps); }
    .report tbody th { text-align: left; color: var(--text-secondary); }
    .report td { color: var(--text-primary); font-weight: var(--fw-medium); }

    @media (max-width: 700px) {
      .scrim { display: block; position: fixed; inset: 0; z-index: calc(var(--z-panel) - 1); background: var(--scrim); animation: sheet-in var(--t-med) both; }
      .panel { top: auto; right: 0; left: 0; bottom: 0; width: auto; max-height: 86dvh; border-radius: var(--radius-l) var(--radius-l) 0 0; padding-bottom: env(safe-area-inset-bottom); }
    }
  `]
})
export class MenuPanelComponent {
  protected readonly state = inject(ForecastStateService);
  protected readonly catalog = inject(ForecastCatalogService);
  protected readonly panels = inject(PanelService);
  protected readonly theme = inject(ThemeService);
  protected readonly mapHost = inject(MapHostService);
  protected readonly perf = inject(PerfMeterService);
  private readonly mapLayers = inject(MapLayerService);
  private readonly unitsService = inject(UnitsService);

  protected readonly units = this.unitsService.units;
  protected readonly tabs = TABS;
  protected readonly tempUnits = TEMP_UNITS;
  protected readonly windUnits = WIND_UNITS;
  protected readonly rainUnits = RAIN_UNITS;
  protected readonly pressureUnits = PRESSURE_UNITS;
  protected readonly tempLabel = TEMP_LABEL;
  protected readonly windLabel = WIND_LABEL;
  protected readonly rainLabel = RAIN_LABEL;
  protected readonly pressureLabel = PRESSURE_LABEL;

  protected readonly filter = signal('');
  protected readonly copied = signal(false);
  protected readonly fullscreen = signal(false);
  protected readonly fullscreenAvailable = typeof document !== 'undefined' && document.fullscreenEnabled === true;
  protected readonly open = computed(() => this.panels.open() === 'menu');
  protected readonly tab = this.panels.menuTab;
  protected readonly radarActive = computed(() => this.mapLayers.layers().some(l => l.id === 'radar' && l.active));
  protected readonly satelliteActive = computed(() => this.mapLayers.layers().some(l => l.id === 'satellite' && l.active));
  protected readonly gibsActive = computed(() => this.mapLayers.layers().some(l => l.id === 'gibs' && l.active));

  /** Layers grouped for display, narrowed by the search box. */
  protected readonly groups = computed(() => {
    const q = this.filter().trim().toLowerCase();
    return LAYER_GROUPS.map(name => ({
      name,
      layers: this.state.layers.filter(l => l.group === name && (!q || l.label.toLowerCase().includes(q) || name.toLowerCase().includes(q))),
    })).filter(g => g.layers.length > 0);
  });

  protected icon = layerIcon;

  /** A layer's palette as a thin bar. */
  protected palette(layer: ForecastLayerDef): string {
    return paletteGradientCss(layer.stops);
  }

  protected onFilter(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  protected setUnit(key: 'temp' | 'wind' | 'rain' | 'pressure', value: string): void {
    this.unitsService.set(key, value as never);
  }

  /** A layer that only exists at the ground, while an altitude is selected: dimmed, and choosing it returns to the ground. */
  protected groundOnly(layer: ForecastLayerDef): boolean {
    return this.state.level() !== 'surface' && !supportsLevels(layer);
  }

  protected available(layer: ForecastLayerDef): boolean {
    // a layer that only exists at the ground is judged at the ground (choosing it returns you there)
    const level = supportsLevels(layer) ? this.state.level() : 'surface';
    if (layer.levelOnly && level === 'surface') {            // judged at any altitude the model has (choosing it goes up)
      return this.state.levels().some(l => l !== 'surface' && layerAvailableAt(layer, l, this.catalog.manifest()?.vars));
    }
    return layerAvailableAt(layer, level, this.catalog.manifest()?.vars);
  }

  protected layerTitle(layer: ForecastLayerDef): string {
    if (!this.available(layer)) {
      const where = this.state.level() === 'surface' ? '' : ` at ${this.state.level()} hPa`;
      return `${layer.label}${where} is not provided by ${this.catalog.model().label}`;
    }
    return this.groundOnly(layer) ? `${layer.label}: ground only (choosing it returns to the ground)` : layer.label;
  }

  protected contourAvailable(): boolean {
    const vars = this.catalog.manifest()?.vars;
    return !vars || this.state.contour().varId in vars;
  }

  protected runTest(): void {
    const view = this.mapHost.view();
    if (view) void this.perf.runTest(view);
  }

  /** The result of the map speed test in words and figures (null before one has run). */
  protected readonly report = computed(() => {
    const t = this.perf.test();
    if (!t) return null;
    const row = (name: string, s: FrameStats | null) => ({
      name,
      fps: s ? String(Math.round(s.fps)) : '–',
      p95: s ? `${Math.round(s.p95Ms)} ms` : '–',
      slow: s ? `${Math.round(slowShare(s))}%` : '–',
    });
    const main = t.moving ?? t.still;
    const grade: Grade | 'none' = main ? gradeOf(main) : 'none';
    const verdict = !main
      ? 'No frames were drawn: the page was not on screen. Run it again with this page in front.'
      : grade === 'good'
        ? 'Smooth: close to 60 frames a second, and no stutter you would notice.'
        : grade === 'fair'
          ? 'Mostly smooth, with some stutter. Switching off Wind streaks or Terrain relief in Layers will help.'
          : 'Rough. Switch off Wind streaks and Terrain relief in Layers, and close other tabs.';
    return { grade, verdict, rows: [row('Animation only', t.still), row('Panning and zooming', t.moving)], device: t.device };
  });

  protected toggleRadar(): void {
    if (this.radarActive()) this.mapLayers.deactivateAll();
    else this.state.selectRadar();
  }

  protected toggleGibs(): void {
    if (this.gibsActive()) this.mapLayers.deactivateAll();
    else this.state.selectGibs();
  }

  protected toggleSatellite(): void {
    if (this.satelliteActive()) this.mapLayers.deactivateAll();
    else this.state.selectSatellite();
  }

  protected toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  }

  @HostListener('document:fullscreenchange')
  protected onFullscreenChange(): void {
    this.fullscreen.set(!!document.fullscreenElement);
  }

  /** Copies the address of this view (it holds the layer, model, altitude and place) so it can be sent to someone. */
  protected share(): void {
    const done = () => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    };
    try {
      void navigator.clipboard.writeText(window.location.href).then(done, () => window.prompt('Copy this link', window.location.href));
    } catch {
      window.prompt('Copy this link', window.location.href);
    }
  }

  protected about(): void {
    this.panels.close('menu');
    this.panels.toggle('about');
  }

  @HostListener('window:keydown.escape', ['$event'])
  protected onEscape(event: Event): void {
    if (!this.open()) return;
    this.panels.close('menu');
    event.preventDefault();
  }

  /** Clicking anywhere outside the menu (the map, say) closes it; the button that opens it is marked and does not count as outside. */
  @HostListener('document:click', ['$event'])
  protected onDocumentClick(event: MouseEvent): void {
    if (this.open() && !(event.target as HTMLElement | null)?.closest?.('app-menu-panel, [data-menu-toggle]')) this.panels.close('menu');
  }
}
