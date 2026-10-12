import { ChangeDetectionStrategy, Component, HostListener, computed, inject, signal } from '@angular/core';
import { MapLayerService } from '../../core/services/map-layer.service';
import { ForecastCatalogService } from '../../core/forecast/forecast-catalog.service';
import { FORECAST_MODELS } from '../../core/forecast/forecast-models';
import {
  ForecastLayerDef,
  LAYER_GROUPS,
  LEVEL_KM,
  Level,
  layerAvailableAt,
  levelLabel,
  supportsLevels,
} from '../../core/forecast/forecast-layers';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';
import { PanelService } from '../../core/ui/panel.service';
import { UnitsService } from '../../core/units/units.service';
import { PRESSURE_LABEL, PRESSURE_UNITS, RAIN_LABEL, RAIN_UNITS, TEMP_LABEL, TEMP_UNITS, WIND_LABEL, WIND_UNITS } from '../../core/units/units';
import { IconComponent } from '../../shared/icon.component';
import { layerIcon } from '../../shared/icons';
import { ThemeService } from '../../shared/theme.service';

/** Height in km of an altitude, for the altitude buttons ("10 m" at the ground). */
function ladderKm(level: Level): string {
  if (level === 'surface') return '10 m';
  const km = LEVEL_KM[level];
  return km < 10 ? `${km} km` : `${Math.round(km)} km`;
}

/**
 * The menu, after meteoblue's map menu: a search over the layers, every layer in its group, the observed pictures, the altitude, the forecast
 * model, the overlays as switches, the units, the look, and share / help at the foot. It opens from the red button at the top right or from
 * "More layers…" on the rail. On phones it is a bottom sheet.
 */
@Component({
  selector: 'app-layer-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    @if (open()) {
      <div class="scrim" (click)="panels.close('layers')" aria-hidden="true"></div>
      <section id="layer-panel" class="panel" role="dialog" aria-label="Menu: layers, altitude, model, overlays and units">
        <header class="head">
          <label class="find">
            <app-icon name="search" [size]="16" />
            <input type="search" placeholder="Search for a layer" aria-label="Search for a layer" [value]="filter()" (input)="onFilter($event)" autocomplete="off" />
          </label>
          <button type="button" class="btn-icon" (click)="panels.close('layers')" aria-label="Close the menu" title="Close (Esc)"><app-icon name="close" [size]="16" /></button>
        </header>

        <div class="scroll">
          @if (!filter()) {
            <section aria-labelledby="h-obs">
              <h3 id="h-obs">Observed pictures</h3>
              <div class="obs">
                <button type="button" class="tile" [class.active]="radarActive()" [attr.aria-pressed]="radarActive()" (click)="toggleRadar()" title="IMD radar: what is falling now (observed, not a forecast)">
                  <app-icon name="radar" [size]="20" /><span class="tile-name">Radar</span><span class="tile-sub">IMD · observed</span>
                </button>
                <button type="button" class="tile" [class.active]="satelliteActive()" [attr.aria-pressed]="satelliteActive()" (click)="toggleSatellite()" title="Live satellite: Meteosat-9 over India, HRV by day, infrared at night">
                  <app-icon name="satellite" [size]="20" /><span class="tile-name">Satellite</span><span class="tile-sub">live · 15 min</span>
                </button>
                <button type="button" class="tile" [class.active]="gibsActive()" [attr.aria-pressed]="gibsActive()" (click)="toggleGibs()" title="High-detail true-colour picture at 250 m, one per day (NASA GIBS)">
                  <app-icon name="globe" [size]="20" /><span class="tile-name">HD satellite</span><span class="tile-sub">250 m · daily</span>
                </button>
              </div>
            </section>
          }

          <section aria-labelledby="h-layers">
            <h3 id="h-layers">Weather layers</h3>
            @for (group of groups(); track group.name) {
              <h4>{{ group.name }}</h4>
              <div class="list">
                @for (layer of group.layers; track layer.id) {
                  <button
                    type="button" class="layer" [class.active]="state.activeLayerId() === layer.id" [class.ground-only]="groundOnly(layer)"
                    [attr.aria-pressed]="state.activeLayerId() === layer.id" [disabled]="!available(layer)"
                    [title]="layerTitle(layer)" (click)="state.toggleLayer(layer.id)"
                  >
                    <span class="dot" [style.background]="swatch(layer)"><app-icon [name]="icon(layer.id)" [size]="14" /></span>
                    <span class="l-name">{{ layer.label }}</span>
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
              <div class="alts" role="group" aria-label="Altitude">
                @for (lvl of allLevels(); track lvl) {
                  <button
                    type="button" class="alt" [class.active]="state.level() === lvl" [attr.aria-pressed]="state.level() === lvl"
                    [disabled]="!hasLevel(lvl)" [title]="levelTitle(lvl)" (click)="state.setLevel(lvl)"
                  >
                    <span class="alt-main">{{ levelName(lvl) }}</span>
                    <span class="alt-sub">{{ rungSub(lvl) }}</span>
                  </button>
                }
              </div>
            </section>

            <section aria-labelledby="h-model">
              <h3 id="h-model">Forecast model</h3>
              <div class="models" role="radiogroup" aria-label="Forecast model">
                @for (m of models; track m.id) {
                  <button type="button" class="model" role="radio" [class.active]="m.id === catalog.activeModelId()" [attr.aria-checked]="m.id === catalog.activeModelId()" (click)="state.selectModel(m.id)">
                    <span class="m-name">{{ m.label }}</span>
                    <span class="m-res">{{ m.resolution }}</span>
                    @if (m.id === catalog.activeModelId()) {
                      <span class="m-run">{{ modelStatus() }}</span>
                    }
                  </button>
                }
              </div>
            </section>

            <section aria-labelledby="h-over">
              <h3 id="h-over">Overlays</h3>
              <div class="switches">
                <button type="button" class="srow" role="switch" [attr.aria-checked]="state.windParticles()" (click)="state.toggleWindParticles()" title="Animated wind streaks at the selected altitude">
                  <span>Particles animation</span><span class="switch" [class.on]="state.windParticles()"></span>
                </button>
                <button type="button" class="srow" role="switch" [attr.aria-checked]="state.isobars()" [disabled]="!contourAvailable()" (click)="state.toggleIsobars()" [title]="state.level() === 'surface' ? 'Lines of equal sea-level pressure' : 'Lines of equal height of the ' + state.level() + ' hPa surface'">
                  <span>{{ state.level() === 'surface' ? 'Sea level pressure (isobars)' : 'Height lines' }}</span><span class="switch" [class.on]="state.isobars()"></span>
                </button>
                <button type="button" class="srow" role="switch" [attr.aria-checked]="state.stationMarkers()" (click)="state.toggleStationMarkers()" title="Weather stations of Tamil Nadu (observed, last 24 h). Click a station for its readings">
                  <span>Weather stations</span><span class="switch" [class.on]="state.stationMarkers()"></span>
                </button>
                <button type="button" class="srow" role="switch" [attr.aria-checked]="state.cyclones()" (click)="state.toggleCyclones()" title="ECMWF forecast tracks of tropical cyclones near India (drawn when there are any)">
                  <span>Cyclone tracks</span><span class="switch" [class.on]="state.cyclones()"></span>
                </button>
                <button type="button" class="srow" role="switch" [attr.aria-checked]="state.districtLines()" (click)="state.toggleDistrictLines()" title="Show or hide the district boundaries (state and country outlines stay)">
                  <span>District boundaries</span><span class="switch" [class.on]="state.districtLines()"></span>
                </button>
                <button type="button" class="srow" role="switch" [attr.aria-checked]="state.relief()" (click)="state.toggleRelief()" title="Shade the 90 m terrain into the colour layer">
                  <span>Terrain relief (90 m)</span><span class="switch" [class.on]="state.relief()"></span>
                </button>
              </div>
            </section>

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
                <p class="hint">Click the unit at the left of the colour bar to change it too.</p>
              </div>
            </section>

            <section aria-labelledby="h-look">
              <h3 id="h-look">Look</h3>
              <div class="seg wide" role="group" aria-label="Theme">
                <button type="button" [class.on]="theme.theme() === 'dark'" [attr.aria-pressed]="theme.theme() === 'dark'" (click)="theme.theme.set('dark')">Dark</button>
                <button type="button" [class.on]="theme.theme() === 'light'" [attr.aria-pressed]="theme.theme() === 'light'" (click)="theme.theme.set('light')">Light</button>
              </div>
            </section>
          }
        </div>

        <footer class="foot">
          <button type="button" (click)="share()"><app-icon name="share" [size]="16" /> {{ copied() ? 'Link copied' : 'Share' }}</button>
          <button type="button" (click)="about()"><app-icon name="help" [size]="16" /> Help &amp; credits</button>
        </footer>
      </section>
    }
  `,
  styles: [`
    :host { display: contents; }
    .scrim { display: none; }
    .panel {
      position: fixed; z-index: 1100; top: 64px; right: var(--gutter); width: min(390px, calc(100vw - 2 * var(--gutter)));
      max-height: calc(100dvh - 64px - var(--stack-h) - 10px); display: flex; flex-direction: column;
      background: var(--surface-solid); border-radius: var(--radius-l); box-shadow: var(--shadow-2); color: var(--text-primary); animation: sheet-in var(--t-med) both;
    }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 10px 6px 12px; }
    .find { flex: 1; display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 12px; border-radius: 19px; background: var(--surface-3); color: var(--text-secondary); }
    .find input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text-primary); font-size: 14px; }
    .find input::placeholder { color: var(--text-muted); }
    .find:focus-within { box-shadow: 0 0 0 2px var(--accent-strong); }
    .scroll { overflow-y: auto; padding: 0 14px 10px; overscroll-behavior: contain; }
    section + section { margin-top: 14px; }
    h3 { margin: 6px 0 7px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); }
    h4 { margin: 10px 0 4px; font-size: 12px; font-weight: 650; color: var(--text-secondary); }
    .none { padding: 12px 0; font-size: 13px; color: var(--text-muted); }

    .obs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .tile { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 9px 10px; min-height: var(--tap); border-radius: var(--radius-m); border: 0; background: var(--surface-3); color: var(--text-secondary); cursor: pointer; text-align: left; transition: background var(--t-fast); }
    .tile:hover { background: var(--surface-4); color: var(--text-primary); }
    .tile.active { background: var(--accent); color: var(--on-accent); }
    .tile-name { font-weight: 650; font-size: 12.5px; color: var(--text-primary); }
    .tile.active .tile-name { color: inherit; }
    .tile-sub { font-size: 10.5px; color: var(--text-muted); }
    .tile.active .tile-sub { color: rgba(255, 255, 255, 0.85); }

    .list { display: flex; flex-direction: column; }
    .layer { display: flex; align-items: center; gap: 10px; min-height: 38px; padding: 4px 8px; border: 0; border-radius: var(--radius-m); background: transparent; color: var(--text-primary); font-size: 14px; cursor: pointer; text-align: left; transition: background var(--t-fast); }
    .layer:hover:not(:disabled) { background: var(--surface-3); }
    .layer.active { background: var(--accent-soft); color: var(--accent-strong); font-weight: 650; }
    .layer:disabled { opacity: 0.4; cursor: not-allowed; }
    .layer.ground-only:not(.active) { opacity: 0.65; }
    .dot { flex: none; width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; color: #fff; border: 1.5px solid rgba(255, 255, 255, 0.85); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }
    .dot app-icon { filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.6)); }
    .l-name { flex: 1; min-width: 0; line-height: 1.2; }
    .tick { color: var(--accent-strong); }

    .alts { display: flex; flex-wrap: wrap; gap: 5px; }
    .alt { display: flex; flex-direction: column; align-items: flex-start; min-width: 62px; min-height: 40px; padding: 4px 10px; border-radius: var(--radius-m); border: 0; background: var(--surface-3); color: var(--text-secondary); cursor: pointer; text-align: left; transition: background var(--t-fast); }
    .alt:hover:not(:disabled) { background: var(--surface-4); color: var(--text-primary); }
    .alt.active { background: var(--accent); color: var(--on-accent); }
    .alt:disabled { opacity: 0.35; cursor: not-allowed; }
    .alt-main { font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .alt-sub { font-size: 10px; opacity: 0.8; }

    .models { display: grid; gap: 6px; }
    .model { display: grid; grid-template-columns: 1fr auto; gap: 1px 10px; align-items: baseline; text-align: left; padding: 8px 12px; border-radius: var(--radius-m); border: 0; background: var(--surface-3); cursor: pointer; transition: background var(--t-fast); }
    .model:hover { background: var(--surface-4); }
    .model.active { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent-strong); }
    .m-name { font-weight: 650; font-size: 13px; }
    .m-res { font-size: 12px; color: var(--text-secondary); }
    .m-run { grid-column: 1 / -1; font-size: 11px; color: var(--accent-strong); font-variant-numeric: tabular-nums; }

    .switches { display: flex; flex-direction: column; }
    .srow { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 40px; padding: 4px 8px; border: 0; border-radius: var(--radius-m); background: transparent; color: var(--text-primary); font-size: 14px; cursor: pointer; text-align: left; }
    .srow:hover:not(:disabled) { background: var(--surface-3); }
    .srow:disabled { opacity: 0.4; cursor: not-allowed; }

    .units { display: flex; flex-direction: column; gap: 8px; }
    .urow { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 14px; }
    .seg { display: inline-flex; border-radius: 15px; background: var(--surface-3); padding: 2px; }
    .seg.wide { display: flex; }
    .seg.wide button { flex: 1; }
    .seg button { height: 28px; padding: 0 11px; border: 0; border-radius: 13px; background: transparent; color: var(--text-secondary); font-size: 12.5px; font-weight: 600; cursor: pointer; }
    .seg button:hover { color: var(--text-primary); }
    .seg button.on { background: var(--accent); color: var(--on-accent); }
    .hint { font-size: 11px; color: var(--text-muted); }

    .foot { display: flex; gap: 8px; padding: 8px 12px 10px; border-top: 1px solid var(--line); }
    .foot button { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 36px; border: 0; border-radius: 18px; background: var(--surface-3); color: var(--text-primary); font-size: 13px; font-weight: 600; cursor: pointer; }
    .foot button:hover { background: var(--surface-4); }

    @media (max-width: 700px) {
      .scrim { display: block; position: fixed; inset: 0; z-index: 1099; background: var(--scrim); animation: sheet-in var(--t-med) both; }
      .panel { top: auto; right: 0; left: 0; bottom: 0; width: auto; max-height: 84dvh; border-radius: var(--radius-l) var(--radius-l) 0 0; padding-bottom: env(safe-area-inset-bottom); }
    }
  `]
})
export class LayerMenuComponent {
  protected readonly state = inject(ForecastStateService);
  protected readonly catalog = inject(ForecastCatalogService);
  protected readonly panels = inject(PanelService);
  protected readonly theme = inject(ThemeService);
  private readonly mapLayers = inject(MapLayerService);
  private readonly unitsService = inject(UnitsService);

  protected readonly units = this.unitsService.units;

  protected readonly models = FORECAST_MODELS;
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
  protected readonly allLevels = computed<Level[]>(() => ['surface', 925, 850, 700, 500, 300, 250, 200]);
  protected readonly open = computed(() => this.panels.open() === 'layers');
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

  /** Run and forecast range of the model on screen, read from its manifest. */
  protected readonly modelStatus = computed(() => {
    const status = this.catalog.status();
    if (status === 'loading') return 'Loading…';
    if (status === 'error') return 'Unavailable, retrying';
    const m = this.catalog.manifest();
    if (!m) return '';
    const run = /^(\d{4})(\d{2})(\d{2})T(\d{2})/.exec(m.run);
    const last = m.steps.at(-1)?.h;
    return `${run ? `Run ${run[3]}/${run[2]} ${run[4]}Z` : m.run}${last !== undefined ? ` · to +${last} h` : ''}`;
  });

  protected icon = layerIcon;

  /** A small coloured round mark for a layer: its own palette. */
  protected swatch(layer: ForecastLayerDef): string {
    return `linear-gradient(135deg, ${layer.stops.join(', ')})`;
  }

  protected onFilter(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  protected setUnit(key: 'temp' | 'wind' | 'rain' | 'pressure', value: string): void {
    this.unitsService.set(key, value as never);
  }

  protected levelName(level: Level): string {
    return level === 'surface' ? 'Ground' : `${level} hPa`;
  }

  protected rungSub(level: Level): string {
    return ladderKm(level);
  }

  protected hasLevel(level: Level): boolean {
    return this.state.levels().includes(level);
  }

  protected levelTitle(level: Level): string {
    return this.hasLevel(level)
      ? `${levelLabel(level)}${level === 'surface' ? ' (10 m wind, 2 m temperature)' : `, about ${LEVEL_KM[level]} km up`}`
      : `${levelLabel(level)} is not provided by ${this.catalog.model().label}`;
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
    this.panels.close('layers');
    this.panels.toggle('about');
  }

  @HostListener('window:keydown.escape')
  protected onEscape(): void {
    this.panels.close('layers');
  }

  /** Clicking anywhere outside the menu (the map, say) closes it; the buttons that open it are marked and do not count as outside. */
  @HostListener('document:click', ['$event'])
  protected onDocumentClick(event: MouseEvent): void {
    if (this.open() && !(event.target as HTMLElement | null)?.closest?.('app-layer-menu, [data-menu-toggle]')) this.panels.close('layers');
  }
}
