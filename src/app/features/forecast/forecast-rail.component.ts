import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MapLayerService } from '../../core/services/map-layer.service';
import { ForecastCatalogService } from '../../core/forecast/forecast-catalog.service';
import { FORECAST_MODELS } from '../../core/forecast/forecast-models';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';
import { legendPosition, paletteGradientCss } from '../../core/forecast/forecast-layers';

/** Right-hand layer buttons plus the colour legend of the active forecast layer. */
@Component({
  selector: 'app-forecast-rail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="rail glass-panel" aria-label="Map layers">
      @if (models.length > 1) {
        <select class="model" aria-label="Forecast model" [value]="catalog.activeModelId()" (change)="onModel($event)">
          @for (m of models; track m.id) {
            <option [value]="m.id">{{ m.label }} · {{ m.resolution }}</option>
          }
        </select>
      }

      <button
        type="button" class="rail-btn" [class.active]="radarActive()" [attr.aria-pressed]="radarActive()"
        aria-label="Radar" title="IMD Doppler radar" (click)="toggleRadar()"
      >
        <span class="rail-icon" aria-hidden="true">📡</span>
        <span class="rail-label">Radar (IMD)</span>
      </button>
      <hr class="sep" />

      @for (layer of state.layers; track layer.id) {
        <button
          type="button"
          class="rail-btn"
          [class.active]="state.activeLayerId() === layer.id"
          [attr.aria-pressed]="state.activeLayerId() === layer.id"
          [attr.aria-label]="layer.label"
          [title]="layer.label"
          (click)="state.toggleLayer(layer.id)"
        >
          <span class="rail-icon" aria-hidden="true">{{ layer.icon }}</span>
          <span class="rail-label">{{ layer.label }}</span>
        </button>
      }
      <hr class="sep" />

      <button
        type="button" class="rail-btn" [class.active]="state.windParticles()" [attr.aria-pressed]="state.windParticles()"
        aria-label="Wind animation" title="Animated wind streaks (any layer)" (click)="state.toggleWindParticles()"
      >
        <span class="rail-icon" aria-hidden="true">〰</span>
        <span class="rail-label">Wind animation</span>
      </button>
    </nav>

    @if (state.activeLayer(); as layer) {
      <div class="legend glass-panel" role="img" [attr.aria-label]="layer.label + ' legend in ' + layer.unit">
        <div class="legend-title">{{ layer.label }} <span class="legend-unit">{{ layer.unit }}</span></div>
        <div class="legend-bar" [style.background]="gradient()"></div>
        <div class="legend-ticks">
          @for (tick of layer.ticks; track tick) {
            <span class="legend-tick" [style.left.%]="tickLeft(layer, tick)">{{ tick }}</span>
          }
        </div>
        @if (catalog.status() === 'loading') {
          <div class="legend-note">Loading forecast…</div>
        } @else if (catalog.status() === 'error') {
          <div class="legend-note error">Forecast unavailable. Retrying every 10 min.</div>
        } @else {
          <div class="legend-note">{{ catalog.model().label }} {{ catalog.model().resolution }} · run {{ runLabel() }}</div>
        }
      </div>
    }
  `,
  styles: [`
    :host { display: contents; }
    .rail {
      position: fixed; right: 12px; top: 50%; transform: translateY(-50%);
      z-index: 900; display: flex; flex-direction: column; gap: 4px; padding: 6px;
      max-height: calc(100vh - 220px); overflow-y: auto;
    }
    .rail-btn {
      display: flex; align-items: center; gap: 8px; min-width: 44px; min-height: 44px; padding: 6px 10px;
      border: 1px solid transparent; border-radius: 12px; background: transparent;
      color: var(--text-secondary); font: 500 12px var(--font-body); cursor: pointer; white-space: nowrap;
      transition: background var(--transition-fast), color var(--transition-fast);
    }
    .rail-btn:hover { background: rgba(255,255,255,0.07); color: var(--text-primary); }
    .rail-btn:focus-visible { outline: 2px solid var(--neon-cyan); outline-offset: 1px; }
    .rail-btn.active { background: rgba(0,229,255,0.15); border-color: rgba(0,229,255,0.45); color: var(--neon-cyan); }
    .rail-icon { font-size: 18px; width: 24px; text-align: center; }
    .sep { width: 100%; height: 1px; margin: 3px 0; border: 0; background: rgba(255,255,255,0.1); }
    .model { margin: 2px 0 4px; padding: 6px 8px; border-radius: 10px; border: 1px solid var(--glass-border); background: rgba(255,255,255,0.06); color: var(--text-primary); font: 12px var(--font-body); }
    .rail-label { display: none; }
    @media (min-width: 900px) { .rail-label { display: inline; } }
    .legend {
      position: fixed; left: 12px; bottom: 92px; z-index: 900; width: min(280px, calc(100vw - 100px)); padding: 10px 12px 8px;
    }
    .legend-title { font: 600 12px var(--font-body); color: var(--text-primary); margin-bottom: 6px; }
    .legend-unit { color: var(--text-muted); font-weight: 400; margin-left: 4px; }
    .legend-bar { height: 10px; border-radius: 5px; }
    .legend-ticks { position: relative; height: 16px; margin-top: 3px; }
    .legend-tick { position: absolute; transform: translateX(-50%); font: 11px var(--font-body); color: var(--text-secondary); }
    .legend-note { font: 10px var(--font-body); color: var(--text-muted); margin-top: 2px; }
    .legend-note.error { color: var(--neon-orange); }
  `]
})
export class ForecastRailComponent {
  protected readonly state = inject(ForecastStateService);
  protected readonly catalog = inject(ForecastCatalogService);
  private readonly mapLayers = inject(MapLayerService);
  protected readonly models = FORECAST_MODELS;

  protected readonly radarActive = computed(() => this.mapLayers.layers().some(l => l.id === 'radar' && l.active));

  protected toggleRadar(): void {
    if (this.radarActive()) this.mapLayers.deactivateAll();
    else this.state.selectRadar();
  }

  protected onModel(event: Event): void {
    void this.catalog.setModel((event.target as HTMLSelectElement).value).then(() => this.state.reclampTime());
  }

  protected readonly runLabel = computed(() => {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})Z$/.exec(this.catalog.runLabel());
    return m ? `${m[3]}/${m[2]} ${m[4]}Z` : this.catalog.runLabel();
  });
  protected readonly gradient = computed(() => {
    const layer = this.state.activeLayer();
    return layer ? paletteGradientCss(layer.stops) : '';
  });

  protected tickLeft(layer: NonNullable<ReturnType<ForecastStateService['activeLayer']>>, tick: number): number {
    return legendPosition(layer, tick) * 100;
  }
}
