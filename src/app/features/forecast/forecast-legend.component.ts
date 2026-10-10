import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ForecastCatalogService } from '../../core/forecast/forecast-catalog.service';
import { ForecastLayerDef, legendPosition, paletteGradientCss } from '../../core/forecast/forecast-layers';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';
import { IconComponent } from '../../shared/icon.component';
import { layerIcon } from '../../shared/icons';

/** Colour legend of the layer on screen, with the model and run it comes from. */
@Component({
  selector: 'app-forecast-legend',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    @if (state.activeLayer(); as layer) {
      <div class="legend" role="img" [attr.aria-label]="layer.label + ' legend in ' + layer.unit + (state.level() === 'surface' ? '' : ' at ' + state.level() + ' hPa')">
        <div class="title">
          <app-icon [name]="icon(layer.id)" [size]="15" />
          <span class="name">{{ layer.label }}</span>
          <span class="unit">{{ layer.unit }}</span>
        </div>
        <div class="bar" [style.background]="gradient()"></div>
        <div class="ticks" aria-hidden="true">
          @for (tick of layer.ticks; track tick) {
            <span class="tick" [style.left.%]="tickLeft(layer, tick)">{{ tick }}</span>
          }
        </div>
        <div class="meta">
          @if (catalog.status() === 'loading') {
            <span class="state"><span class="spinner"></span>Loading forecast…</span>
          } @else if (catalog.status() === 'error') {
            <span class="state error">Forecast unavailable. Retrying every 10 min.</span>
          } @else {
            <span class="model">{{ catalog.model().label }}</span>
            <span class="dot">·</span>
            <span>{{ catalog.model().resolution }}</span>
            <span class="dot">·</span>
            <span>run {{ runLabel() }}</span>
            @if (state.level() !== 'surface') { <span class="dot">·</span><span>{{ state.level() }} hPa</span> }
          }
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: contents; }
    .legend {
      position: fixed; left: var(--gutter); bottom: 132px; z-index: 900; width: min(300px, calc(100vw - 92px));
      padding: 9px 12px 8px; color: var(--text-primary); background: var(--surface-1); border: 1px solid var(--line);
      border-radius: var(--radius-l); box-shadow: var(--shadow-2);
    }
    .title { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 650; margin-bottom: 7px; color: var(--text-primary); }
    .title app-icon { color: var(--accent); }
    .unit { margin-left: auto; color: var(--text-secondary); font-weight: 500; font-variant-numeric: tabular-nums; }
    .bar { height: 10px; border-radius: 5px; box-shadow: 0 0 0 1px var(--line) inset; }
    .ticks { position: relative; height: 16px; margin-top: 3px; }
    .tick { position: absolute; transform: translateX(-50%); font-size: 11px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
    .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0 5px; font-size: 10.5px; color: var(--text-muted); }
    .model { color: var(--model); font-weight: 650; }
    .dot { opacity: 0.6; }
    .state { display: inline-flex; align-items: center; gap: 6px; }
    .state.error { color: var(--warn); }
    .spinner { width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--line-strong); border-top-color: var(--accent); animation: spin 0.8s linear infinite; }
    @media (max-width: 700px) { .legend { bottom: 118px; width: min(280px, calc(100vw - 24px)); } }
  `]
})
export class ForecastLegendComponent {
  protected readonly state = inject(ForecastStateService);
  protected readonly catalog = inject(ForecastCatalogService);

  protected readonly runLabel = computed(() => {
    // a model run is YYYYMMDDTHHZ; the blend's run is when it was assembled, YYYYMMDDTHHMMZ
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})?Z$/.exec(this.catalog.runLabel());
    return m ? `${m[3]}/${m[2]} ${m[4]}${m[5] ? ':' + m[5] : ''}Z` : this.catalog.runLabel();
  });
  protected readonly gradient = computed(() => {
    const layer = this.state.activeLayer();
    return layer ? paletteGradientCss(layer.stops) : '';
  });

  protected icon = layerIcon;

  protected tickLeft(layer: ForecastLayerDef, tick: number): number {
    return legendPosition(layer, tick) * 100;
  }
}
