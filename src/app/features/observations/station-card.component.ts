import { ChangeDetectionStrategy, Component, HostListener, computed, inject } from '@angular/core';
import { IconComponent } from '../../shared/icon.component';
import { SynopRecord, ageLabel, compassPoint } from '../../core/forecast/observations';
import { StationSelectionService } from '../../core/forecast/station-selection.service';

const IST = 'Asia/Kolkata';

/** One row of the card: a label and its value, or nothing when the station did not report it (never a made-up number). */
interface Row {
  label: string;
  value: string;
}

function rows(r: SynopRecord): Row[] {
  const out: Row[] = [];
  const add = (label: string, value: string | null) => {
    if (value !== null) out.push({ label, value });
  };
  add('Temperature', r.temp_c === null ? null : `${r.temp_c.toFixed(1)} °C`);
  add('Max / min', r.tmax_c === null && r.tmin_c === null ? null : `${fmt(r.tmax_c, '°C')} / ${fmt(r.tmin_c, '°C')}`);
  add('Dew point', r.dewp_c === null ? null : `${r.dewp_c.toFixed(1)} °C`);
  add('Humidity', r.rh_pct === null ? null : `${r.rh_pct.toFixed(0)} %`);
  add('Wind', r.wind_kt === null ? null : `${(r.wind_kt * 1.852).toFixed(0)} km/h${r.wind_dir !== null ? ` from ${compassPoint(r.wind_dir)}` : ' (calm or variable)'}`);
  add('Pressure, sea level', r.msl_hpa === null ? null : `${r.msl_hpa.toFixed(1)} hPa`);
  add('Pressure, station', r.stn_hpa === null ? null : `${r.stn_hpa.toFixed(1)} hPa`);
  add('Rain, this report', r.rain_mm === null ? null : `${r.rain_mm.toFixed(1)} mm${r.rain_hours ? ` in ${r.rain_hours} h` : ''}`);
  add('Rain, last 24 h', r.rain24_mm === null ? null : `${r.rain24_mm.toFixed(1)} mm`);
  return out;
}

function fmt(v: number | null, unit: string): string {
  return v === null ? '–' : `${v.toFixed(1)} ${unit}`;
}

/** The readings of a weather station the map's marker points to (observed, from the SYNOP reports). */
@Component({
  selector: 'app-station-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    @if (station(); as s) {
      <aside class="card" role="dialog" aria-label="Weather station readings">
        <header>
          <div class="place">
            <strong>{{ s.name }}</strong>
            <span class="sub">Station {{ s.station }} · {{ s.lat.toFixed(3) }}°N, {{ s.lon.toFixed(3) }}°E</span>
          </div>
          <button type="button" class="close" aria-label="Close station" title="Close (Esc)" (click)="close()"><app-icon name="close" [size]="16" /></button>
        </header>
        <div class="when">Observed {{ timeLabel() }} · {{ age() }}</div>
        <dl>
          @for (row of rows(); track row.label) {
            <div class="row"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></div>
          } @empty {
            <div class="row"><dt>Readings</dt><dd>none in this report</dd></div>
          }
        </dl>
        <footer>Observed, not a forecast. Source: SYNOP report via Ogimet.</footer>
      </aside>
    }
  `,
  styles: [`
    :host { display: contents; }
    .card {
      position: fixed; z-index: 950; top: calc(var(--bar-h) + 12px); left: var(--gutter); width: min(300px, calc(100vw - 24px));
      max-height: calc(100dvh - var(--bar-h) - 150px); overflow-y: auto; padding: 12px 14px 10px; color: var(--text-primary);
      background: var(--surface-1); border: 1px solid var(--line); border-radius: var(--radius-l); box-shadow: var(--shadow-2);
      animation: sheet-in var(--t-med) both;
    }
    header { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
    .place strong { display: block; font-size: 15px; }
    .sub { font-size: 11px; color: var(--text-secondary); }
    .close { flex: none; display: grid; place-items: center; width: 32px; height: 32px; margin: -6px -8px 0 0; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); cursor: pointer; }
    .close:hover { background: var(--surface-3); color: var(--text-primary); }
    .when { margin: 4px 0 8px; font-size: 11px; color: var(--text-muted); }
    dl { margin: 0; }
    .row { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; border-top: 1px solid var(--line); font-size: 12.5px; }
    dt { color: var(--text-secondary); }
    dd { margin: 0; font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
    footer { margin-top: 6px; font-size: 10px; color: var(--text-muted); }
    @media (max-width: 700px) {
      .card { top: auto; bottom: 124px; left: var(--gutter); right: var(--gutter); width: auto; max-height: 46dvh; }
    }
  `],
})
export class StationCardComponent {
  private readonly selection = inject(StationSelectionService);
  protected readonly station = this.selection.selected;
  protected readonly rows = computed(() => (this.station() ? rows(this.station()!) : []));
  protected readonly age = computed(() => (this.station() ? ageLabel(this.station()!.time) : ''));
  protected readonly timeLabel = computed(() => {
    const s = this.station();
    if (!s) return '';
    const t = Date.parse(s.time);
    const day = new Intl.DateTimeFormat('en-IN', { timeZone: IST, day: 'numeric', month: 'short' }).format(t);
    const time = new Intl.DateTimeFormat('en-IN', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: false }).format(t);
    return `${day}, ${time} IST`;
  });

  protected close(): void {
    this.selection.close();
  }

  @HostListener('window:keydown.escape')
  protected onEscape(): void {
    this.selection.close();
  }
}
