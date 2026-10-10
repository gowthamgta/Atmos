import { ChangeDetectionStrategy, Component, HostListener, computed, inject } from '@angular/core';
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
import { SATELLITE_NAME } from '../../core/satellite/satellite.config';
import { SatelliteService } from '../../core/satellite/satellite.service';
import { IconComponent } from '../../shared/icon.component';
import { IconName, layerIcon } from '../../shared/icons';

/** Height in km of an altitude, for the altitude chips ("ground" at the surface). */
function ladderKm(level: Level): string {
  if (level === 'surface') return '10 m';
  const km = LEVEL_KM[level];
  return km < 10 ? `${km} km` : `${Math.round(km)} km`;
}

/**
 * One panel for everything you can look at, in four separate parts so it is always clear what you are changing:
 * the model, the observations (radar, satellites), the altitude, and the weather layers (grouped), then the overlays.
 * It opens from a button in the top bar that always shows what is on. On phones it is a bottom sheet.
 */
@Component({
  selector: 'app-layer-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <button type="button" class="trigger" [class.open]="open()" (click)="panels.toggle('layers')" [attr.aria-expanded]="open()" aria-haspopup="dialog" aria-controls="layer-panel">
      <app-icon [name]="triggerIcon()" [size]="18" />
      <span class="t-text">
        <span class="t-main">{{ triggerMain() }}</span>
        @if (triggerSub()) { <span class="t-sub">{{ triggerSub() }}</span> }
      </span>
      <app-icon class="chev" name="chevron" [size]="14" />
    </button>

    @if (open()) {
      <div class="scrim" (click)="panels.close('layers')" aria-hidden="true"></div>
      <section id="layer-panel" class="panel" role="dialog" aria-label="Map layers, model and altitude">
        <header class="sheet-head">
          <h2 class="sheet-title">Map</h2>
          <button type="button" class="btn-icon" (click)="panels.close('layers')" aria-label="Close layers panel" title="Close (Esc)"><app-icon name="close" [size]="16" /></button>
        </header>

        <div class="scroll">
          <section aria-labelledby="h-model">
            <h3 id="h-model">Forecast model</h3>
            <div class="models" role="radiogroup" aria-label="Forecast model">
              @for (m of models; track m.id) {
                <button type="button" class="model" role="radio" [class.active]="m.id === catalog.activeModelId()" [attr.aria-checked]="m.id === catalog.activeModelId()" (click)="setModel(m.id)">
                  <span class="m-name">{{ m.label }}</span>
                  <span class="m-res">{{ m.resolution }}</span>
                  @if (m.id === catalog.activeModelId()) {
                    <span class="m-run">{{ modelStatus() }}</span>
                  }
                </button>
              }
            </div>
          </section>

          <section aria-labelledby="h-obs">
            <h3 id="h-obs">Observations</h3>
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

          <section aria-labelledby="h-layers">
            <h3 id="h-layers">Weather layer</h3>
            @for (group of groups(); track group.name) {
              <h4>{{ group.name }}</h4>
              <div class="grid">
                @for (layer of group.layers; track layer.id) {
                  <button
                    type="button" class="layer" [class.active]="state.activeLayerId() === layer.id" [class.ground-only]="groundOnly(layer)"
                    [attr.aria-pressed]="state.activeLayerId() === layer.id" [disabled]="!available(layer)"
                    [title]="layerTitle(layer)" (click)="state.toggleLayer(layer.id)"
                  >
                    <app-icon [name]="icon(layer.id)" [size]="17" />
                    <span class="l-name">{{ layer.label }}</span>
                    @if (state.activeLayerId() === layer.id) { <app-icon class="tick" name="check" [size]="14" /> }
                  </button>
                }
              </div>
            }
          </section>

          <section aria-labelledby="h-over">
            <h3 id="h-over">Overlays</h3>
            <div class="grid">
              <button type="button" class="layer" [class.active]="state.windParticles()" [attr.aria-pressed]="state.windParticles()" (click)="state.toggleWindParticles()" title="Animated wind streaks at the selected altitude">
                <app-icon name="wind" [size]="17" /><span class="l-name">Wind animation</span>
              </button>
              <button type="button" class="layer" [class.active]="state.isobars()" [attr.aria-pressed]="state.isobars()" [disabled]="!contourAvailable()" (click)="state.toggleIsobars()" [title]="state.level() === 'surface' ? 'Lines of equal sea-level pressure' : 'Lines of equal height of the ' + state.level() + ' hPa surface'">
                <app-icon name="isobars" [size]="17" /><span class="l-name">{{ state.level() === 'surface' ? 'Isobars' : 'Height lines' }}</span>
              </button>
              <button type="button" class="layer" [class.active]="state.cyclones()" [attr.aria-pressed]="state.cyclones()" (click)="state.toggleCyclones()" title="ECMWF forecast tracks of tropical cyclones near India (drawn when there are any)">
                <app-icon name="cyclone" [size]="17" /><span class="l-name">Cyclone tracks</span>
              </button>
              <button type="button" class="layer" [class.active]="state.districtLines()" [attr.aria-pressed]="state.districtLines()" (click)="state.toggleDistrictLines()" title="Show or hide the district boundaries (state and country outlines stay)">
                <app-icon name="districts" [size]="17" /><span class="l-name">District lines</span>
              </button>
              <button type="button" class="layer" [class.active]="state.relief()" [attr.aria-pressed]="state.relief()" (click)="state.toggleRelief()" title="Shade the 90 m terrain into the colour layer">
                <app-icon name="mountain" [size]="17" /><span class="l-name">Terrain relief</span>
              </button>
            </div>
          </section>
        </div>
      </section>
    }
  `,
  styles: [`
    :host { display: contents; }
    .trigger {
      display: flex; align-items: center; gap: 9px; min-height: 36px; max-width: min(320px, calc(100vw - 150px)); padding: 3px 10px 3px 11px;
      border-radius: var(--radius-m); border: 1px solid var(--line); background: var(--surface-3); color: var(--text-primary); cursor: pointer; text-align: left;
      transition: background var(--t-fast), border-color var(--t-fast);
    }
    .trigger app-icon:first-child { color: var(--accent); }
    .trigger:hover, .trigger.open { background: var(--surface-4); border-color: var(--accent-line); }
    .t-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.15; }
    .t-main { font-size: 13px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .t-sub { font-size: 11px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chev { color: var(--text-secondary); transition: transform var(--t-med); }
    .trigger.open .chev { transform: rotate(180deg); }

    .scrim { display: none; }
    .panel {
      position: fixed; z-index: 1100; top: calc(var(--bar-h) + 8px); right: var(--gutter); width: min(420px, calc(100vw - 24px));
      max-height: calc(100dvh - var(--bar-h) - 20px); display: flex; flex-direction: column;
      background: var(--surface-1); border: 1px solid var(--line); border-radius: var(--radius-l); box-shadow: var(--shadow-2); color: var(--text-primary);
      animation: sheet-in var(--t-med) both;
    }
    .sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px 6px 16px; }
    .sheet-title { font-size: 15px; font-weight: 700; }
    .scroll { overflow-y: auto; padding: 0 16px 14px; overscroll-behavior: contain; }
    section + section { margin-top: 14px; }
    h3 { margin: 0 0 7px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); }
    h4 { margin: 10px 0 5px; font-size: 12px; font-weight: 600; color: var(--text-secondary); }

    .models { display: grid; gap: 6px; }
    .model {
      display: grid; grid-template-columns: 1fr auto; gap: 1px 10px; align-items: baseline; text-align: left; padding: 9px 12px; border-radius: var(--radius-m);
      border: 1px solid var(--line); background: var(--surface-2); cursor: pointer; transition: background var(--t-fast), border-color var(--t-fast);
    }
    .model:hover { background: var(--surface-3); }
    .model.active { border-color: var(--model); background: color-mix(in srgb, var(--model) 14%, var(--surface-2)); box-shadow: inset 3px 0 0 var(--model); }
    .m-name { font-weight: 650; font-size: 13px; }
    .m-res { font-size: 12px; color: var(--text-secondary); }
    .m-run { grid-column: 1 / -1; font-size: 11px; color: var(--model); font-variant-numeric: tabular-nums; }

    .obs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .tile {
      display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 9px 10px; min-height: var(--tap); border-radius: var(--radius-m);
      border: 1px solid var(--line); background: var(--surface-2); color: var(--text-secondary); cursor: pointer; text-align: left;
      transition: background var(--t-fast), border-color var(--t-fast), color var(--t-fast);
    }
    .tile:hover { background: var(--surface-3); color: var(--text-primary); }
    .tile.active { background: var(--accent-soft); border-color: var(--accent-line); color: var(--accent-strong); }
    .tile-name { font-weight: 650; font-size: 12.5px; color: var(--text-primary); }
    .tile.active .tile-name { color: inherit; }
    .tile-sub { font-size: 10.5px; color: var(--text-muted); }

    .alts { display: flex; flex-wrap: wrap; gap: 5px; }
    .alt {
      display: flex; flex-direction: column; align-items: flex-start; min-width: 62px; min-height: 40px; padding: 4px 10px; border-radius: var(--radius-m);
      border: 1px solid var(--line); background: var(--surface-2); color: var(--text-secondary); cursor: pointer; text-align: left;
    }
    .alt:hover:not(:disabled) { background: var(--surface-3); color: var(--text-primary); }
    .alt.active { background: var(--accent-soft); border-color: var(--accent-line); color: var(--accent-strong); }
    .alt:disabled { opacity: 0.35; cursor: not-allowed; }
    .alt-main { font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .alt-sub { font-size: 10px; opacity: 0.8; }

    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
    .layer {
      display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 5px 10px; border-radius: var(--radius-m); border: 1px solid var(--line);
      background: var(--surface-2); color: var(--text-secondary); font-size: 12.5px; font-weight: 500; cursor: pointer; text-align: left;
      transition: background var(--t-fast), border-color var(--t-fast), color var(--t-fast);
    }
    .layer:hover:not(:disabled) { background: var(--surface-3); color: var(--text-primary); }
    .layer.active { background: var(--accent-soft); border-color: var(--accent-line); color: var(--accent-strong); font-weight: 650; }
    .layer:disabled { opacity: 0.35; cursor: not-allowed; }
    .layer.ground-only:not(.active) { opacity: 0.6; }
    .l-name { flex: 1; min-width: 0; line-height: 1.15; }
    .tick { color: var(--accent); }

    @media (max-width: 700px) {
      .scrim { display: block; position: fixed; inset: 0; z-index: 1099; background: var(--scrim); animation: sheet-in var(--t-med) both; }
      .panel { top: auto; right: 0; left: 0; bottom: 0; width: auto; max-height: 82dvh; border-radius: var(--radius-l) var(--radius-l) 0 0; border-bottom: 0; padding-bottom: env(safe-area-inset-bottom); }
      .obs { grid-template-columns: 1fr 1fr 1fr; }
    }
  `]
})
export class LayerMenuComponent {
  protected readonly state = inject(ForecastStateService);
  protected readonly catalog = inject(ForecastCatalogService);
  protected readonly panels = inject(PanelService);
  private readonly mapLayers = inject(MapLayerService);
  private readonly satellite = inject(SatelliteService);

  protected readonly models = FORECAST_MODELS;
  protected readonly allLevels = computed<Level[]>(() => ['surface', 925, 850, 700, 500, 300, 250, 200]);
  protected readonly open = computed(() => this.panels.open() === 'layers');
  protected readonly radarActive = computed(() => this.mapLayers.layers().some(l => l.id === 'radar' && l.active));
  protected readonly satelliteActive = computed(() => this.mapLayers.layers().some(l => l.id === 'satellite' && l.active));
  protected readonly gibsActive = computed(() => this.mapLayers.layers().some(l => l.id === 'gibs' && l.active));

  /** Layers grouped for display. */
  protected readonly groups = computed(() =>
    LAYER_GROUPS.map(name => ({ name, layers: this.state.layers.filter(l => l.group === name) })).filter(g => g.layers.length > 0)
  );

  protected readonly triggerIcon = computed<IconName>(() =>
    this.radarActive() ? 'radar' : this.satelliteActive() ? 'satellite' : this.gibsActive() ? 'globe' : this.state.activeLayerId() ? layerIcon(this.state.activeLayerId()) : 'layers'
  );
  protected readonly triggerMain = computed(() => {
    if (this.radarActive()) return 'IMD radar';
    if (this.satelliteActive()) return 'Satellite';
    if (this.gibsActive()) return 'HD satellite';
    const base = this.state.layers.find(l => l.id === this.state.activeLayerId());
    if (base) return base.label;
    return this.state.windParticles() || this.state.isobars() ? 'Overlays' : 'Layers';
  });
  protected readonly triggerSub = computed(() => {
    if (this.radarActive()) return 'Observed now';
    if (this.satelliteActive()) return SATELLITE_NAME;
    if (this.gibsActive()) return '250 m · daily';
    if (!this.state.forecastActive()) return 'Tap to choose';
    const level = this.state.level();
    return `${this.catalog.model().label} · ${level === 'surface' ? 'ground' : level + ' hPa'}`;
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

  protected setModel(id: string): void {
    void this.catalog.setModel(id).then(() => this.state.reclampTime());
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

  @HostListener('window:keydown.escape')
  protected onEscape(): void {
    this.panels.close('layers');
  }

  /** Clicking anywhere outside the menu (the map, say) closes it, so it never sits on top of what you are looking at. */
  @HostListener('document:click', ['$event'])
  protected onDocumentClick(event: MouseEvent): void {
    if (this.open() && !(event.target as HTMLElement | null)?.closest?.('app-layer-menu')) this.panels.close('layers');
  }
}
