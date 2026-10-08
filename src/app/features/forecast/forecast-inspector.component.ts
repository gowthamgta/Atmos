import { ChangeDetectionStrategy, Component, HostListener, computed, inject } from '@angular/core';
import { ForecastCatalogService } from '../../core/forecast/forecast-catalog.service';
import { ForecastInspectorService } from '../../core/forecast/forecast-inspector.service';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';
import { rowsForLayer } from '../../core/forecast/point-forecast';

const IST = 'Asia/Kolkata';

/** Card with the value of the selected layer at the clicked point, for the selected time. */
@Component({
  selector: 'app-forecast-inspector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (inspector.selected(); as sel) {
      <aside class="card glass-panel-solid" role="dialog" aria-label="Forecast at selected point">
        <header>
          <div class="place">
            <strong>{{ placeTitle() }}</strong>
            @if (inspector.point(); as p) {
              <span class="sub">{{ p.state && p.district ? p.state : '' }}</span>
            }
          </div>
          <button type="button" class="close" aria-label="Close" title="Close (Esc)" (click)="inspector.close()">×</button>
        </header>

        @if (inspector.point(); as p) {
          <div class="meta">
            {{ sel.lat.toFixed(3) }}°N, {{ sel.lon.toFixed(3) }}°E
            @if (p.elevationM !== null) { · {{ p.elevationM.toFixed(0) }} m }
            · {{ timeLabel() }}
          </div>
          <dl>
            @for (row of rows(); track row.id) {
              @if (row.heading) {
                <div class="heading">{{ row.label }}</div>
              } @else {
                <div class="row">
                  <dt>{{ row.label }}</dt>
                  <dd>{{ row.text }}@if (row.terrainAdjusted) { <span class="adj" title="Adjusted to 90 m terrain">▲</span> }</dd>
                </div>
              }
            }
            @if (rows().length === 0) {
              <div class="row"><dt>{{ layerLabel() }}</dt><dd>–</dd></div>
            }
          </dl>
          <footer>
            @if (adjusted()) { ▲ adjusted to 90 m terrain. }
            Model: {{ catalog.model().label }}, {{ catalog.model().resolution }}.
          </footer>
        } @else if (inspector.busy()) {
          <div class="meta">Loading…</div>
        } @else {
          <div class="meta">Outside the forecast area (4–22°N, 68–90°E).</div>
        }
      </aside>
    }
  `,
  styles: [`
    :host { display: contents; }
    .card { position: fixed; top: 76px; left: 12px; z-index: 950; width: min(300px, calc(100vw - 24px)); max-height: calc(100vh - 160px); overflow-y: auto; padding: 12px 14px 10px; color: var(--text-primary); font-family: var(--font-body); }
    header { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
    .place strong { display: block; font-size: 15px; }
    .sub { font-size: 12px; color: var(--text-secondary); }
    .close { flex: none; width: 32px; height: 32px; margin: -6px -8px 0 0; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); font-size: 22px; cursor: pointer; }
    .close:hover { background: rgba(255,255,255,0.1); color: var(--text-primary); }
    .close:focus-visible { outline: 2px solid var(--neon-cyan); }
    .meta { margin: 4px 0 8px; font-size: 11px; color: var(--text-muted); }
    dl { margin: 0; }
    .heading { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(0,229,255,0.35); font-size: 12px; font-weight: 700; color: var(--neon-cyan); }
    .row { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; border-top: 1px solid rgba(255,255,255,0.07); font-size: 13px; }
    dt { color: var(--text-secondary); }
    dd { margin: 0; font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
    .adj { margin-left: 4px; font-size: 8px; color: var(--neon-cyan); vertical-align: middle; }
    footer { margin-top: 6px; font-size: 10px; color: var(--text-muted); }
    @media (max-width: 700px) {
      /* bottom sheet above the timeline so the top bar stays visible */
      .card { top: auto; bottom: 84px; left: 12px; right: 12px; width: auto; max-height: 52vh; overflow-y: auto; }
    }
  `]
})
export class ForecastInspectorComponent {
  protected readonly inspector = inject(ForecastInspectorService);
  protected readonly catalog = inject(ForecastCatalogService);
  private readonly state = inject(ForecastStateService);

  /** Only the selected layer's value (every row when no layer is on, e.g. only the wind animation). */
  protected readonly rows = computed(() => {
    const p = this.inspector.point();
    return p ? rowsForLayer(p.rows, this.state.activeLayerId(), this.state.level()) : [];
  });
  protected readonly adjusted = computed(() => this.rows().some(r => r.terrainAdjusted));
  protected readonly layerLabel = computed(() => this.state.activeLayer()?.label ?? 'Value');

  protected readonly placeTitle = computed(() => {
    const p = this.inspector.point();
    if (!p) return 'Selected point';
    return p.district ?? p.state ?? 'Open sea / outside districts';
  });

  protected readonly timeLabel = computed(() => {
    const p = this.inspector.point();
    if (!p) return '';
    const day = new Intl.DateTimeFormat('en-IN', { timeZone: IST, weekday: 'short', day: 'numeric', month: 'short' }).format(p.timeMs);
    const time = new Intl.DateTimeFormat('en-IN', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: false }).format(p.timeMs);
    return `${day} ${time} IST`;
  });

  @HostListener('window:keydown.escape')
  protected onEscape(): void {
    this.inspector.close();
  }
}
