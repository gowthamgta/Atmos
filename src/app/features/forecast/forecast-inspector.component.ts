import { ChangeDetectionStrategy, Component, HostListener, computed, inject } from '@angular/core';
import { IconComponent } from '../../shared/icon.component';
import { ForecastCatalogService } from '../../core/forecast/forecast-catalog.service';
import { ForecastInspectorService } from '../../core/forecast/forecast-inspector.service';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';
import { rowsForLayer } from '../../core/forecast/point-forecast';
import { ObservationsService } from '../../core/forecast/observations.service';
import { ageLabel, compassPoint } from '../../core/forecast/observations';

const IST = 'Asia/Kolkata';

/** Card with the value of the selected layer at the clicked point, for the selected time. */
@Component({
  selector: 'app-forecast-inspector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
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
          <button type="button" class="close" aria-label="Close" title="Close (Esc)" (click)="inspector.close()"><app-icon name="close" [size]="16" /></button>
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
          @if (observed(); as o) {
            <div class="heading obs-heading">Observed nearby <span class="obs-note">not the forecast</span></div>
            @if (o.gauge) {
              <div class="obs">
                <div class="obs-main"><span>Rain gauge</span><strong>{{ o.gauge.value }}</strong></div>
                <div class="obs-sub">{{ o.gauge.place }} · {{ o.gauge.km }} km · {{ o.gauge.window }}@if (o.gauge.peak) { · wettest hour {{ o.gauge.peak }} }</div>
              </div>
            }
            @if (o.airport) {
              <div class="obs">
                <div class="obs-main"><span>Airport weather</span><strong>{{ o.airport.value }}</strong></div>
                <div class="obs-sub">{{ o.airport.place }} · {{ o.airport.km }} km · {{ o.airport.age }}</div>
              </div>
            }
            @if (!o.gauge && !o.airport) {
              <div class="obs-sub">No rain gauge within 15 km or airport within 120 km.</div>
            }
          }
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
    .card { position: fixed; top: calc(var(--bar-h) + 12px); left: var(--gutter); z-index: 950; width: min(300px, calc(100vw - 24px)); max-height: calc(100vh - 160px); overflow-y: auto; padding: 12px 14px 10px; color: var(--text-primary); font-family: var(--font-body); }
    header { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
    .place strong { display: block; font-size: 15px; }
    .sub { font-size: 12px; color: var(--text-secondary); }
    .close { flex: none; display: grid; place-items: center; width: 32px; height: 32px; margin: -6px -8px 0 0; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); cursor: pointer; }
    .close:hover { background: var(--surface-4); color: var(--text-primary); }
    .close:focus-visible { outline: 2px solid var(--neon-cyan); }
    .meta { margin: 4px 0 8px; font-size: 11px; color: var(--text-muted); }
    dl { margin: 0; }
    .heading { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--accent-line); font-size: 12px; font-weight: 700; color: var(--neon-cyan); }
    .row { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; border-top: 1px solid var(--surface-3); font-size: 13px; }
    dt { color: var(--text-secondary); }
    dd { margin: 0; font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
    .adj { margin-left: 4px; font-size: 8px; color: var(--neon-cyan); vertical-align: middle; }
    .obs-heading { display: flex; align-items: baseline; justify-content: space-between; }
    .obs-note { font-size: 10px; font-weight: 500; color: var(--text-muted); }
    .obs { padding: 5px 0; border-top: 1px solid var(--line); }
    .obs-main { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; color: var(--text-secondary); }
    .obs-main strong { color: var(--text-primary); text-align: right; font-variant-numeric: tabular-nums; }
    .obs-sub { margin-top: 1px; font-size: 10.5px; color: var(--text-muted); }
    footer { margin-top: 6px; font-size: 10px; color: var(--text-muted); }
    @media (max-width: 700px) {
      /* bottom sheet above the timeline so the top bar stays visible */
      .card { top: auto; bottom: 124px; left: var(--gutter); right: var(--gutter); width: auto; max-height: 46vh; overflow-y: auto; }
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

  private readonly observations = inject(ObservationsService);

  /** The rain gauge and airport report closest to the clicked point, as text for the card (observations, not the forecast). */
  protected readonly observed = computed(() => {
    const sel = this.inspector.selected();
    const o = sel ? this.observations.near(sel.lat, sel.lon) : null;
    if (!o) return null;
    const date = o.rainDate ? new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(Date.parse(o.rainDate)) : '';
    const g = o.gauge;
    const a = o.airport;
    return {
      gauge: g && {
        value: `${g.item.t!.toFixed(1)} mm`,
        place: g.item.n,
        km: Math.round(g.km),
        window: `24 h to 08:30, ${date}`,
        peak: g.item.pt && g.item.pk !== null ? `${g.item.pk.toFixed(1)} mm at ${g.item.pt}` : '',
      },
      airport: a && {
        value: [
          a.item.temp_c !== null ? `${a.item.temp_c.toFixed(0)} °C` : '',
          a.item.rh_pct !== null ? `${a.item.rh_pct.toFixed(0)} %` : '',
          a.item.wind_kt !== null ? `${(a.item.wind_kt * 1.852).toFixed(0)} km/h ${compassPoint(a.item.wind_dir)}`.trim() : '',
        ].filter(Boolean).join(' · '),
        place: a.item.name ?? a.item.station,
        km: Math.round(a.km),
        age: ageLabel(a.item.time),
      },
    };
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
