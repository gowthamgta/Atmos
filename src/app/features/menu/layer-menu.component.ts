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
import { SATELLITE_SOURCES } from '../../core/satellite/satellite.config';
import { SatelliteService } from '../../core/satellite/satellite.service';

/** Height in km of an altitude, for the ladder ("10 m" at the ground). */
function ladderKm(level: Level): string {
  if (level === 'surface') return 'ground';
  const km = LEVEL_KM[level];
  return km < 10 ? `${km} km` : `${Math.round(km)} km`;
}

/**
 * One menu for everything you can look at: the radar, the model, the altitude, the weather layers (grouped), and the
 * overlays (wind animation, pressure lines). It opens from a button in the header that always shows what is on.
 */
@Component({
  selector: 'app-layer-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" class="trigger" [class.open]="open()" (click)="panels.toggle('layers')" [attr.aria-expanded]="open()" aria-haspopup="dialog" aria-label="Layers and altitude">
      <span class="t-icon" aria-hidden="true">{{ triggerIcon() }}</span>
      <span class="t-text">
        <span class="t-main">{{ triggerMain() }}</span>
        @if (triggerSub()) { <span class="t-sub">{{ triggerSub() }}</span> }
      </span>
      <svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    </button>

    @if (open()) {
      <section class="panel glass-panel-solid" role="dialog" aria-label="Layers and altitude">
        <div class="top-row">
          <button type="button" class="radar" [class.active]="radarActive()" [attr.aria-pressed]="radarActive()" (click)="toggleRadar()">
            <span aria-hidden="true">📡</span> Radar <span class="radar-sub">IMD · observed</span>
          </button>
          <button type="button" class="radar" [class.active]="satelliteActive()" [attr.aria-pressed]="satelliteActive()" (click)="toggleSatellite()" title="Live satellite: Meteosat-9 or FY-4B, true colour by day, infrared at night">
            <span aria-hidden="true">🛰</span> Satellite <span class="radar-sub">live · observed</span>
          </button>
          <button type="button" class="radar" [class.active]="gibsActive()" [attr.aria-pressed]="gibsActive()" (click)="toggleGibs()" title="High-detail true-colour picture at 250 m, one per day (NASA GIBS)">
            <span aria-hidden="true">🌍</span> HD satellite <span class="radar-sub">250 m · daily</span>
          </button>
          <button type="button" class="radar" [class.active]="imergActive()" [attr.aria-pressed]="imergActive()" (click)="toggleImerg()" title="Rain that has actually fallen, estimated from satellites (NASA IMERG)">
            <span aria-hidden="true">☔</span> Observed rain <span class="radar-sub">IMERG · 30 min</span>
          </button>
          <label class="model">
            <span class="sr">Forecast model</span>
            <select (change)="onModel($event)" aria-label="Forecast model">
              @for (m of models; track m.id) {
                <option [value]="m.id" [selected]="m.id === catalog.activeModelId()">{{ m.label }} · {{ m.resolution }}</option>
              }
            </select>
          </label>
        </div>

        <div class="body">
          <nav class="ladder" aria-label="Altitude">
            <div class="ladder-title">Altitude</div>
            @for (lvl of allLevels(); track lvl) {
              <button
                type="button" class="rung" [class.active]="state.level() === lvl" [attr.aria-pressed]="state.level() === lvl"
                [disabled]="!hasLevel(lvl)" [title]="levelTitle(lvl)" (click)="state.setLevel(lvl)"
              >
                <span class="rung-main">{{ levelName(lvl) }}</span>
                <span class="rung-sub">{{ rungSub(lvl) }}</span>
              </button>
            }
          </nav>

          <div class="layers">
            @for (group of groups(); track group.name) {
              <h2>{{ group.name }}</h2>
              <div class="grid">
                @for (layer of group.layers; track layer.id) {
                  <button
                    type="button" class="layer" [class.active]="state.activeLayerId() === layer.id" [class.ground-only]="groundOnly(layer)"
                    [attr.aria-pressed]="state.activeLayerId() === layer.id" [disabled]="!available(layer)"
                    [title]="layerTitle(layer)" (click)="state.toggleLayer(layer.id)"
                  >
                    <span class="l-icon" aria-hidden="true">{{ layer.icon }}</span>
                    <span class="l-name">{{ layer.label }}</span>
                  </button>
                }
              </div>
            }

            <h2>Overlays</h2>
            <div class="grid">
              <button type="button" class="layer" [class.active]="state.windParticles()" [attr.aria-pressed]="state.windParticles()" (click)="state.toggleWindParticles()" title="Animated wind streaks at the selected altitude">
                <span class="l-icon" aria-hidden="true">〰</span><span class="l-name">Wind animation</span>
              </button>
              <button type="button" class="layer" [class.active]="state.isobars()" [attr.aria-pressed]="state.isobars()" [disabled]="!contourAvailable()" (click)="state.toggleIsobars()" [title]="state.level() === 'surface' ? 'Lines of equal sea-level pressure' : 'Lines of equal height of the ' + state.level() + ' hPa surface'">
                <span class="l-icon" aria-hidden="true">≋</span><span class="l-name">{{ state.level() === 'surface' ? 'Isobars' : 'Height lines' }}</span>
              </button>
              <button type="button" class="layer" [class.active]="state.cyclones()" [attr.aria-pressed]="state.cyclones()" (click)="state.toggleCyclones()" title="ECMWF forecast tracks of tropical cyclones near India (drawn when there are any)">
                <span class="l-icon" aria-hidden="true">🌀</span><span class="l-name">Cyclone tracks</span>
              </button>
              <button type="button" class="layer" [class.active]="state.districtLines()" [attr.aria-pressed]="state.districtLines()" (click)="state.toggleDistrictLines()" title="Show or hide the district boundaries (state and country outlines stay)">
                <span class="l-icon" aria-hidden="true">▦</span><span class="l-name">District boundaries</span>
              </button>
              <button type="button" class="layer" [class.active]="state.relief()" [attr.aria-pressed]="state.relief()" (click)="state.toggleRelief()" title="Shade the 1 km terrain into the colour layer">
                <span class="l-icon" aria-hidden="true">⛰</span><span class="l-name">Terrain relief</span>
              </button>
              <button type="button" class="layer" [class.active]="state.detail()" [attr.aria-pressed]="state.detail()" (click)="state.toggleDetail()" title="Full 1 km detail: smoother fields, rain over hills and sunshine on slopes. Turn off if the map lags.">
                <span class="l-icon" aria-hidden="true">✦</span><span class="l-name">1 km detail</span>
              </button>
            </div>
          </div>
        </div>
      </section>
    }
  `,
  styles: [`
    :host { display: contents; }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    .trigger {
      display: flex; align-items: center; gap: 10px; min-height: 44px; max-width: min(300px, calc(100vw - 150px)); padding: 6px 12px;
      border-radius: 12px; border: 1px solid rgba(255,255,255,0.12); background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(16px);
      color: var(--text-primary); font-family: var(--font-body); cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,0.3); text-align: left;
    }
    .trigger:hover, .trigger.open { border-color: rgba(0,229,255,0.45); }
    .trigger:focus-visible, button:focus-visible, select:focus-visible { outline: 2px solid var(--neon-cyan); outline-offset: 2px; }
    .t-icon { font-size: 18px; }
    .t-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.15; }
    .t-main { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .t-sub { font-size: 11px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chev { flex: none; color: var(--text-secondary); transition: transform 0.2s; }
    .trigger.open .chev { transform: rotate(180deg); }

    .panel {
      position: fixed; z-index: 1100; top: 66px; right: 14px; width: min(400px, calc(100vw - 20px));
      max-height: calc(100vh - 90px); max-height: calc(100dvh - 90px); overflow-y: auto; padding: 12px; color: var(--text-primary); font-family: var(--font-body);
    }
    .top-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
    .radar {
      flex: none; display: flex; flex-direction: column; align-items: flex-start; min-height: 44px; padding: 6px 12px; border-radius: 12px;
      border: 1px solid transparent; background: rgba(255,255,255,0.06); color: var(--text-primary); font: 600 13px var(--font-body); cursor: pointer;
    }
    .radar-sub { font-weight: 400; font-size: 10px; color: var(--text-secondary); }
    .radar:hover { background: rgba(255,255,255,0.12); }
    .radar.active { background: rgba(0,229,255,0.16); border-color: rgba(0,229,255,0.5); color: var(--neon-cyan); }
    .model { flex: 1 1 100%; min-width: 0; }
    .radar { flex: 1 1 0; }
    select {
      width: 100%; height: 100%; min-height: 44px; padding: 6px 10px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.06); color: var(--text-primary); font: 12px var(--font-body);
    }
    option { background: #0f172a; color: #e8eaf6; }

    .body { display: flex; gap: 10px; }
    .ladder { flex: none; width: 82px; display: flex; flex-direction: column; gap: 4px; }
    .ladder-title, h2 { margin: 0 0 2px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-muted); }
    .rung {
      display: flex; flex-direction: column; align-items: flex-start; min-height: 44px; padding: 5px 8px; border-radius: 10px; border: 1px solid transparent;
      background: rgba(255,255,255,0.05); color: var(--text-secondary); cursor: pointer; text-align: left;
    }
    .rung:hover:not(:disabled) { background: rgba(255,255,255,0.11); color: var(--text-primary); }
    .rung.active { background: rgba(0,229,255,0.16); border-color: rgba(0,229,255,0.5); color: var(--neon-cyan); }
    .rung:disabled { opacity: 0.3; cursor: not-allowed; }
    .rung-main { font-size: 12px; font-weight: 700; }
    .rung-sub { font-size: 10px; opacity: 0.8; }

    .layers { flex: 1; min-width: 0; }
    h2 { margin-top: 10px; }
    h2:first-child { margin-top: 0; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
    .layer {
      display: flex; align-items: center; gap: 6px; min-height: 40px; padding: 5px 8px; border-radius: 10px; border: 1px solid transparent;
      background: rgba(255,255,255,0.05); color: var(--text-secondary); font: 500 12px var(--font-body); cursor: pointer; text-align: left; position: relative;
    }
    .layer:hover:not(:disabled) { background: rgba(255,255,255,0.11); color: var(--text-primary); }
    .layer.active { background: rgba(0,229,255,0.16); border-color: rgba(0,229,255,0.5); color: var(--neon-cyan); }
    .layer:disabled { opacity: 0.32; cursor: not-allowed; }
    .l-icon { flex: none; width: 20px; text-align: center; font-size: 15px; }
    .l-name { min-width: 0; line-height: 1.15; }
    .layer.ground-only:not(.active) { opacity: 0.6; }

    @media (max-width: 700px) {
      .panel { top: 60px; right: 10px; }
      .ladder { width: 74px; }
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
  protected readonly imergActive = computed(() => this.mapLayers.layers().some(l => l.id === 'imerg' && l.active));

  /** Layers grouped for display. */
  protected readonly groups = computed(() =>
    LAYER_GROUPS.map(name => ({ name, layers: this.state.layers.filter(l => l.group === name) })).filter(g => g.layers.length > 0)
  );

  protected readonly triggerIcon = computed(() => (this.radarActive() ? '📡' : this.satelliteActive() ? '🛰' : this.gibsActive() ? '🌍' : this.imergActive() ? '☔' : this.state.activeLayer()?.icon ?? '☰'));
  protected readonly triggerMain = computed(() => {
    if (this.radarActive()) return 'IMD radar';
    if (this.satelliteActive()) return 'Satellite';
    if (this.gibsActive()) return 'HD satellite';
    if (this.imergActive()) return 'Observed rain';
    const base = this.state.layers.find(l => l.id === this.state.activeLayerId());
    if (base) return base.label;
    return this.state.windParticles() || this.state.isobars() ? 'Overlays' : 'Layers';
  });
  protected readonly triggerSub = computed(() => {
    if (this.radarActive()) return 'Observed now';
    if (this.satelliteActive()) return SATELLITE_SOURCES[this.satellite.source()].label;
    if (this.gibsActive()) return '250 m · daily';
    if (this.imergActive()) return 'IMERG · every 30 min';
    if (!this.state.forecastActive()) return 'Tap to choose';
    const level = this.state.level();
    return `${this.catalog.model().label} · ${level === 'surface' ? 'ground' : level + ' hPa'}`;
  });

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

  protected toggleImerg(): void {
    if (this.imergActive()) this.mapLayers.deactivateAll();
    else this.state.selectImerg();
  }

  protected toggleSatellite(): void {
    if (this.satelliteActive()) this.mapLayers.deactivateAll();
    else this.state.selectSatellite();
  }

  protected onModel(event: Event): void {
    void this.catalog.setModel((event.target as HTMLSelectElement).value).then(() => this.state.reclampTime());
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
