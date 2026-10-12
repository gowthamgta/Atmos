import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ForecastLayerDef, legendPosition, paletteGradientCss } from '../../core/forecast/forecast-layers';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';
import { UnitsService } from '../../core/units/units.service';
import { METRIC, Quantity, Units, legendConversion, niceTicks, quantityOf, unitChoices } from '../../core/units/units';

export interface LegendTick {
  label: string;
  /** 0 to 1 along the bar. */
  pos: number;
}

/** The unit text of a layer without its long explanation ("IMD 24 h rain: ..." and "mm in the chosen period" are explained in the menu). */
export function shortUnit(unit: string): string {
  return unit.startsWith('mm') ? 'mm' : unit.startsWith('IMD') ? 'IMD' : unit;
}

/**
 * The colour bar along the bottom, as on windy.com: the layer's palette with its values written on it, and the unit at the left. Click the
 * unit to change it (temperature, wind, rain and pressure layers): the values on the bar are then round numbers of the new unit.
 */
@Component({
  selector: 'app-forecast-legend',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (state.activeLayer(); as layer) {
      <div class="legend" role="group" [attr.aria-label]="layer.label + ' colour scale in ' + unitLabel() + (state.level() === 'surface' ? '' : ' at ' + state.level() + ' hPa')">
        <div class="bar" [style.background]="gradient()">
          <button type="button" class="unit" [disabled]="!choices()" (click)="cycle()" [attr.aria-label]="choices() ? 'Unit: ' + unitLabel() + '. Change unit' : 'Unit: ' + unitLabel()" [title]="choices() ? 'Click to change the unit' : layer.unit">
            {{ unitLabel() }}
          </button>
          @for (t of ticks(); track t.label) {
            <span class="tick" [style.--p]="t.pos * 100" aria-hidden="true">{{ t.label }}</span>
          }
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: contents; }
    .legend { position: fixed; left: 0; right: 0; bottom: 0; height: var(--legend-h); z-index: 910; background: var(--surface-0); }
    .bar { position: relative; height: 100%; box-shadow: 0 -1px 0 var(--line); }
    .unit {
      position: absolute; left: 0; top: 0; bottom: 0; z-index: 1; padding: 0 12px 0 10px; border: 0; background: rgba(0, 0, 0, 0.32); color: #fff;
      font-size: 11px; font-weight: 700; letter-spacing: 0.02em; text-shadow: var(--text-halo); cursor: pointer; white-space: nowrap; max-width: 40vw; overflow: hidden; text-overflow: ellipsis;
    }
    .unit:not(:disabled):hover { background: rgba(0, 0, 0, 0.5); }
    .unit:disabled { cursor: default; }
    .tick {
      position: absolute; top: 50%; left: clamp(64px, calc(var(--p) * 1%), calc(100% - 18px)); transform: translate(-50%, -50%); color: #fff; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.75), 0 0 3px rgba(0, 0, 0, 0.6); white-space: nowrap; pointer-events: none;
    }
    @media (max-width: 700px) { .tick { font-size: 11px; } }
  `]
})
export class ForecastLegendComponent {
  protected readonly state = inject(ForecastStateService);
  private readonly unitsService = inject(UnitsService);

  private readonly quantity = computed(() => {
    const layer = this.state.activeLayer();
    return layer ? quantityOf(layer.id, layer.unit) : null;
  });
  /** The quantity whose unit can be changed on this layer, or null. */
  protected readonly choices = computed(() => {
    const q = this.quantity();
    return q && unitChoices(q).length > 1 ? q : null;
  });
  protected readonly unitLabel = computed(() => {
    const layer = this.state.activeLayer();
    const q = this.quantity();
    return q ? legendConversion(q, this.unitsService.units()).label : layer ? shortUnit(layer.unit) : '';
  });
  protected readonly gradient = computed(() => {
    const layer = this.state.activeLayer();
    return layer ? paletteGradientCss(layer.stops) : '';
  });
  protected readonly ticks = computed(() => {
    const layer = this.state.activeLayer();
    return layer ? legendTicks(layer, this.quantity(), this.unitsService.units()) : [];
  });

  protected cycle(): void {
    const q = this.choices();
    if (q) this.unitsService.cycle(q);
  }
}

/** The values written on the bar: the layer's own ticks in its own unit, or round numbers of the unit chosen instead. */
export function legendTicks(layer: ForecastLayerDef, quantity: Quantity | null, units: Units): LegendTick[] {
  const own = layer.ticks.map(t => ({ label: String(t), pos: legendPosition(layer, t) }));
  if (!quantity) return own;
  const conv = legendConversion(quantity, units);
  if (conv.label === legendConversion(quantity, METRIC).label) return own;
  const scale = layer.displayScale ?? 1;
  const a = conv.from(layer.min * scale);
  const b = conv.from(layer.max * scale);
  return niceTicks(Math.min(a, b), Math.max(a, b), 6, conv.integer).map(x => ({ label: String(x), pos: legendPosition(layer, conv.to(x)) }));
}
