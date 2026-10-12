import { ChangeDetectionStrategy, Component, HostListener, computed, inject, signal } from '@angular/core';
import { ForecastCatalogService } from '../../core/forecast/forecast-catalog.service';
import { ForecastLayerDef, forecastLayerById, legendPosition, paletteGradientCss } from '../../core/forecast/forecast-layers';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';
import { layerFacts } from '../../core/forecast/layer-notes';
import { istStamp, istValid, leadHours, leadLabel, runHourLabel, runIdToMs } from '../../core/forecast/model-runs';
import { UnitsService } from '../../core/units/units.service';
import { METRIC, Quantity, Units, legendConversion, niceTicks, quantityOf, unitChoices } from '../../core/units/units';
import { IconComponent } from '../../shared/icon.component';

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
 * unit to change it (temperature, wind, rain and pressure layers): the values on the bar are then round numbers of the new unit. The button at
 * the right opens what the colours mean: the quantity, the scale, how it relates to the time on the bar, where it is left out, how it is moved to
 * the 90 m ground, and which run of which model it is.
 */
@Component({
  selector: 'app-forecast-legend',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
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
          <button type="button" class="about" [class.on]="infoOpen()" [attr.aria-expanded]="infoOpen()" aria-haspopup="dialog" aria-controls="layer-info" aria-label="About this layer: what it shows, its scale, its time and what is left out" title="About this layer" (click)="infoOpen.set(!infoOpen())" data-layer-info-toggle>
            <app-icon name="info" [size]="14" />
          </button>
        </div>
      </div>
      @if (infoOpen()) {
        <section id="layer-info" class="pop" role="dialog" aria-label="About this layer">
          <header class="pop-head">
            <strong>{{ facts().title }}</strong>
            <button type="button" class="btn-icon" (click)="infoOpen.set(false)" aria-label="Close" title="Close (Esc)"><app-icon name="close" [size]="16" /></button>
          </header>
          <dl>
            <div><dt>What it shows</dt><dd>{{ facts().what }}</dd></div>
            <div><dt>Colour scale</dt><dd>{{ facts().scale }}</dd></div>
            <div><dt>Time</dt><dd>{{ facts().time }}</dd></div>
            <div><dt>Left out</dt><dd>{{ facts().gaps }}</dd></div>
            <div><dt>At the ground</dt><dd>{{ facts().ground }}</dd></div>
            <div><dt>Forecast</dt><dd>{{ forecastLine() }}</dd></div>
          </dl>
        </section>
      }
    }
  `,
  styles: [`
    :host { display: contents; --tick-bg: rgba(0, 0, 0, 0.58); }
    .legend { position: fixed; left: 0; right: 0; bottom: 0; height: var(--legend-h); z-index: 910; background: var(--surface-0); }
    .bar { position: relative; height: 100%; box-shadow: 0 -1px 0 var(--line); }
    .unit {
      position: absolute; left: 0; top: 0; bottom: 0; z-index: 1; min-width: var(--hit); padding: 0 12px 0 10px; border: 0; background: rgba(0, 0, 0, 0.62); color: #fff;
      font-size: var(--fs-xs); font-weight: var(--fw-strong); letter-spacing: 0.02em; cursor: pointer; white-space: nowrap; max-width: 40vw; overflow: hidden; text-overflow: ellipsis;
    }
    .unit:not(:disabled):hover { background: rgba(0, 0, 0, 0.78); }
    .unit:disabled { cursor: default; }
    .tick {
      position: absolute; top: 50%; left: clamp(64px, calc(var(--p) * 1%), calc(100% - 52px)); transform: translate(-50%, -50%); padding: 1px 6px; border-radius: 9px;
      background: var(--tick-bg); color: #fff; font-size: var(--fs-s); font-weight: var(--fw-strong); font-variant-numeric: tabular-nums; white-space: nowrap; pointer-events: none;
    }
    .about { position: absolute; right: 0; top: 0; bottom: 0; z-index: 1; display: grid; place-items: center; width: max(34px, var(--hit)); padding: 0; border: 0; background: rgba(0, 0, 0, 0.62); color: #fff; cursor: pointer; }
    .about:hover, .about.on { background: rgba(0, 0, 0, 0.82); }
    .about.on { color: var(--accent-strong); }
    .about:focus-visible { outline-offset: -3px; }

    .pop {
      position: fixed; right: var(--gutter); bottom: calc(var(--bars-h) + 12px); z-index: var(--z-panel); width: min(440px, calc(100vw - 2 * var(--gutter))); max-height: calc(100dvh - var(--bars-h) - 90px); overflow-y: auto;
      padding: var(--sp-3) var(--sp-4); background: var(--surface-solid); border-radius: var(--radius-l); box-shadow: var(--shadow-2); color: var(--text-primary); animation: sheet-in var(--t-med) both; overscroll-behavior: contain;
    }
    .pop-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); margin-bottom: var(--sp-2); }
    .pop-head strong { font-size: var(--fs-xl); font-weight: var(--fw-strong); }
    dl { margin: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    dt { font-size: var(--fs-xs); font-weight: var(--fw-medium); color: var(--text-muted); text-transform: uppercase; letter-spacing: var(--ls-caps); }
    dd { margin: 1px 0 0; font-size: var(--fs-m); line-height: var(--lh-normal); color: var(--text-secondary); }
  `]
})
export class ForecastLegendComponent {
  protected readonly state = inject(ForecastStateService);
  private readonly catalog = inject(ForecastCatalogService);
  private readonly unitsService = inject(UnitsService);

  protected readonly infoOpen = signal(false);

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

  /** What the colours of the layer on the map mean (the layer as drawn at the chosen altitude). */
  protected readonly facts = computed(() => {
    const shown = this.state.activeLayer()!;
    const base = forecastLayerById(this.state.activeLayerId()) ?? shown;
    return layerFacts(base, shown, this.state.level());
  });

  /** "ECMWF IFS 9 km · run 18Z (11 Oct, 23:30 IST) · valid Mon, 12 Oct, 11:30 IST (+12 h)". */
  protected readonly forecastLine = computed(() => {
    const manifest = this.catalog.manifest();
    const model = this.catalog.model();
    const parts = [`${model.label} ${model.gridKm} km`];
    const init = manifest ? runIdToMs(manifest.run) : null;
    if (init !== null) parts.push(`run ${runHourLabel(init)} (${istStamp(init)})`);
    const t = this.state.timeMs();
    if (t !== null) parts.push(`valid ${istValid(t)}${init !== null ? ` (${leadLabel(leadHours(init, t))})` : ''}`);
    return parts.join(' · ');
  });

  protected cycle(): void {
    const q = this.choices();
    if (q) this.unitsService.cycle(q);
  }

  @HostListener('window:keydown.escape', ['$event'])
  protected onEscape(event: Event): void {
    if (!this.infoOpen()) return;
    this.infoOpen.set(false);
    event.preventDefault();
  }

  /** A click outside the box closes it (the button that opens it is marked and does not count as outside). */
  @HostListener('document:click', ['$event'])
  protected onDocumentClick(event: MouseEvent): void {
    if (this.infoOpen() && !(event.target as HTMLElement | null)?.closest?.('#layer-info, [data-layer-info-toggle]')) this.infoOpen.set(false);
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
