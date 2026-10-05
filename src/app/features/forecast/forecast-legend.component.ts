import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ForecastCatalogService } from '../../core/forecast/forecast-catalog.service';
import { ForecastLayerDef, legendPosition, paletteGradientCss } from '../../core/forecast/forecast-layers';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';

/** Colour legend of the layer on screen, with the model and run it comes from. */
@Component({
  selector: 'app-forecast-legend',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (state.activeLayer(); as layer) {
      <div class="legend glass-panel" role="img" [attr.aria-label]="layer.label + ' legend in ' + layer.unit">
        <div class="title">{{ layer.label }} <span class="unit">{{ layer.unit }}</span></div>
        <div class="bar" [style.background]="gradient()"></div>
        <div class="ticks">
          @for (tick of layer.ticks; track tick) {
            <span class="tick" [style.left.%]="tickLeft(layer, tick)">{{ tick }}</span>
          }
        </div>
        @if (catalog.status() === 'loading') {
          <div class="note">Loading forecast…</div>
        } @else if (catalog.status() === 'error') {
          <div class="note error">Forecast unavailable. Retrying every 10 min.</div>
        } @else {
          <div class="note">{{ catalog.model().label }} {{ catalog.model().resolution }} · run {{ runLabel() }}</div>
        }
      </div>
    }
  `,
  styles: [`
    :host { display: contents; }
    .legend { position: fixed; left: 12px; bottom: 92px; z-index: 900; width: min(280px, calc(100vw - 100px)); padding: 10px 12px 8px; font-family: var(--font-body); color: var(--text-primary); }
    .title { font-size: 12px; font-weight: 600; margin-bottom: 6px; }
    .unit { color: var(--text-muted); font-weight: 400; margin-left: 4px; }
    .bar { height: 10px; border-radius: 5px; }
    .ticks { position: relative; height: 16px; margin-top: 3px; }
    .tick { position: absolute; transform: translateX(-50%); font-size: 11px; color: var(--text-secondary); }
    .note { font-size: 10px; color: var(--text-muted); margin-top: 2px; }
    .note.error { color: var(--neon-orange); }
    @media (max-width: 700px) { .legend { bottom: 88px; } }
  `]
})
export class ForecastLegendComponent {
  protected readonly state = inject(ForecastStateService);
  protected readonly catalog = inject(ForecastCatalogService);

  protected readonly runLabel = computed(() => {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})Z$/.exec(this.catalog.runLabel());
    return m ? `${m[3]}/${m[2]} ${m[4]}Z` : this.catalog.runLabel();
  });
  protected readonly gradient = computed(() => {
    const layer = this.state.activeLayer();
    return layer ? paletteGradientCss(layer.stops) : '';
  });

  protected tickLeft(layer: ForecastLayerDef, tick: number): number {
    return legendPosition(layer, tick) * 100;
  }
}
