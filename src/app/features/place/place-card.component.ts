import { ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, inject, signal } from '@angular/core';
import { ForecastCatalogService } from '../../core/forecast/forecast-catalog.service';
import { ForecastInspectorService } from '../../core/forecast/forecast-inspector.service';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';
import { HOME } from '../../core/geo/home';
import { Place, PlaceSearchService } from '../../core/geo/place-search.service';
import { ageLabel, compassPoint } from '../../core/forecast/observations';
import { ObservationsService } from '../../core/forecast/observations.service';
import { OutlookService } from '../../core/forecast/outlook.service';
import { currentIcon, temperatureBar } from '../../core/forecast/outlook';
import { runLines } from '../../core/forecast/model-runs';
import { ModelRunsService } from '../../core/forecast/model-runs.service';
import { MeteogramService } from '../../core/meteogram/meteogram.service';
import { MapHostService } from '../../core/ui/map-host.service';
import { PanelService } from '../../core/ui/panel.service';
import { UnitsService } from '../../core/units/units.service';
import { formatRain, formatTemp, formatWind } from '../../core/units/units';
import { IconComponent } from '../../shared/icon.component';

const IST = 'Asia/Kolkata';
const KT_TO_MS = 0.514444;
const SEARCH_DELAY_MS = 250;

/** The first number in a text such as "27.2 °C" (null when there is none). */
export function firstNumber(text: string | undefined): number | null {
  const n = text === undefined ? NaN : parseFloat(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * The card at the top left, after windy.com: a search box (the name of the place is in it), and under it the place's weather at the time on the
 * bar: the temperature in big figures with a picture of the sky, wind and humidity, and the next days as a strip. "Meteogram" opens the hourly
 * chart; "All values" opens the full list of values at that place and the observations nearby (rain gauge, weather station, airport), which are
 * only read from the forecast when it is opened. The last line says which run of which model the numbers are from. Click anywhere on the map to
 * choose another place.
 */
@Component({
  selector: 'app-place-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <div class="wrap" [class.tight]="meteogram.visible()">
      <div class="searchbox">
      <div class="search" [class.open]="showResults()">
        <app-icon name="search" [size]="18" />
        <input
          #box type="search" class="input" placeholder="Search a place in India" autocomplete="off" spellcheck="false"
          aria-label="Search for a place" role="combobox" aria-autocomplete="list" [attr.aria-expanded]="showResults()" aria-controls="place-results"
          [value]="shownName()" (focus)="onFocus(box)" (input)="onInput($event)" (blur)="onBlur()" (keydown)="onKey($event)"
        />
        <button type="button" class="home" (click)="goHome()" aria-label="Go to the home place, Kallakurichi" title="Home place: Kallakurichi"><app-icon name="locate" [size]="18" /></button>
      </div>

      @if (showResults()) {
        <ul id="place-results" class="results" role="listbox" aria-label="Places">
          @for (p of suggestions(); track p.lat + ',' + p.lon; let i = $index) {
            <li role="option" [attr.aria-selected]="i === active()" [class.active]="i === active()" (mousedown)="$event.preventDefault(); choose(p)">
              <strong>{{ p.name }}</strong>@if (p.region) { <span>{{ p.region }}</span> }
            </li>
          } @empty {
            <li class="empty">No place found</li>
          }
        </ul>
      }
      </div>

      @if (inspector.selected(); as sel) {
        <section class="card" aria-label="Weather at the chosen place">
          @if (inspector.point(); as p) {
            <header>
              <div class="where"><strong>{{ title() }}</strong>@if (subtitle()) { <span class="sub">{{ subtitle() }}</span> }</div>
              <button type="button" class="x" (click)="inspector.close()" aria-label="Close the place card" title="Close (Esc)"><app-icon name="close" [size]="16" /></button>
            </header>

            <div class="now">
              <span class="temp" [title]="'Temperature at ' + timeLabel()">{{ bigTemp() }}</span>
              <app-icon class="sky" [name]="sky()" [size]="34" />
              <div class="facts">
                @if (feels(); as f) { <span>Feels like {{ f }}</span> }
                @if (wind(); as w) { <span>{{ w }}</span> }
                @if (humidity(); as h) { <span>Humidity {{ h }}</span> }
              </div>
            </div>
            <div class="when">{{ timeLabel() }} · {{ sel.lat.toFixed(2) }}°N, {{ sel.lon.toFixed(2) }}°E@if (p.elevationM !== null) { · {{ p.elevationM.toFixed(0) }} m }</div>

            @if (outlook.days().length) {
              <ul class="days" aria-label="Next days">
                @for (d of outlook.days(); track d.startMs) {
                  <li class="day">
                    <span class="wd">{{ d.weekday }}</span>
                    <app-icon [name]="d.icon" [size]="24" />
                    <span class="range"><strong>{{ temp(d.tmax) }}</strong><span class="slash">/</span>{{ temp(d.tmin) }}</span>
                    <span class="bar" [style.background]="bar(d.tmin, d.tmax)"></span>
                    <span class="rain" [class.dry]="!(d.rainMm !== null && d.rainMm >= 1)">{{ d.rainMm !== null && d.rainMm >= 1 ? rain(d.rainMm) : '·' }}</span>
                  </li>
                }
              </ul>
            } @else if (outlook.busy()) {
              <div class="note">Loading the next days…</div>
            }

            <div class="actions">
              <button type="button" class="act" (click)="meteogram.toggle()" [attr.aria-pressed]="meteogram.visible()" title="Hourly chart of temperature, rain, wind and gusts, and the models side by side (M)">
                <app-icon name="chart" [size]="16" />Meteogram
              </button>
              <button type="button" class="act" (click)="toggleValues()" [attr.aria-expanded]="expanded()" title="Every value at this place, and the observations nearby">
                All values <app-icon name="chevron" [size]="14" [style.transform]="expanded() ? 'rotate(180deg)' : ''" />
              </button>
            </div>

            @if (expanded()) {
              @if (p.detailed) {
                <dl class="values">
                  @for (row of p.rows; track row.id) {
                    @if (row.heading) {
                      <div class="heading">{{ row.label }}</div>
                    } @else {
                      <div class="row" [class.on]="row.id === layerRow()">
                        <dt>{{ row.label }}</dt>
                        <dd>{{ row.text }}@if (row.terrainAdjusted) { <span class="adj" title="Adjusted to 90 m terrain">▲</span> }</dd>
                      </div>
                    }
                  }
                </dl>
              } @else {
                <div class="note busy" role="status"><span class="spinner" aria-hidden="true"></span>Reading every value… {{ inspector.progress().done }} of {{ inspector.progress().total }}</div>
              }
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
                @if (o.station) {
                  <div class="obs">
                    <div class="obs-main"><span>Weather station</span><strong>{{ o.station.value }}</strong></div>
                    <div class="obs-sub">{{ o.station.place }} · {{ o.station.km }} km · {{ o.station.age }}@if (o.station.rain) { · {{ o.station.rain }} }</div>
                  </div>
                }
                @if (!o.gauge && !o.airport && !o.station) {
                  <div class="obs-sub">No rain gauge within 15 km, weather station within 100 km or airport within 120 km.</div>
                }
              }
              @if (adjusted()) { <p class="footer">▲ adjusted to 90 m terrain.</p> }
            }

            <button type="button" class="runline" (click)="panels.toggle('models')" [attr.aria-expanded]="panels.open() === 'models'" aria-haspopup="dialog" [title]="runTitle()">
              <span class="status-dot" [class.ok]="runTone() === 'ok'" [class.warn]="runTone() === 'warn'" [class.bad]="runTone() === 'bad'"></span>
              <span class="run-text">{{ catalog.model().short }} {{ catalog.model().gridKm }} km · {{ runText() }}</span>
              <span class="run-badge">{{ runBadge() }}</span>
            </button>
          } @else if (inspector.busy()) {
            <div class="note busy"><span class="spinner" aria-hidden="true"></span>Loading…</div>
          } @else {
            <header><div class="where"><strong>Outside the forecast area</strong></div><button type="button" class="x" (click)="inspector.close()" aria-label="Close"><app-icon name="close" [size]="16" /></button></header>
          }
        </section>
      }
    </div>
  `,
  styles: [`
    :host { display: contents; }
    .wrap { position: fixed; top: var(--gutter); left: var(--gutter); z-index: var(--z-card); width: min(410px, calc(100vw - 2 * var(--gutter))); display: flex; flex-direction: column; gap: var(--sp-2); max-height: calc(100dvh - var(--left-stack-h) - 56px); }   /* leaves room for the time tooltip that rises out of the bar */

    .searchbox { position: relative; flex: none; }
    .search { display: flex; align-items: center; gap: var(--sp-2); height: 46px; padding: 0 6px 0 14px; border-radius: 23px; background: var(--surface-1); box-shadow: var(--shadow-2); color: var(--text-secondary); flex: none; }
    .search.open { border-radius: 23px 23px 0 0; }
    .input { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; color: var(--text-primary); font-size: var(--fs-2xl); font-weight: var(--fw-normal); text-overflow: ellipsis; }
    .input::placeholder { color: var(--text-muted); }
    .search:focus-within { box-shadow: 0 0 0 2px var(--accent-strong), var(--shadow-2); }
    .home { display: grid; place-items: center; width: var(--hit); height: var(--hit); border: 0; border-radius: 50%; background: transparent; color: var(--text-secondary); cursor: pointer; flex: none; }
    .home:hover { background: var(--surface-3); color: var(--text-primary); }

    .results { position: absolute; top: 100%; left: 0; right: 0; z-index: 5; list-style: none; margin: 0; padding: var(--sp-1) 0 6px; border-radius: 0 0 14px 14px; background: var(--surface-solid); box-shadow: var(--shadow-2); max-height: 55dvh; overflow-y: auto; }
    .results li { display: flex; flex-direction: column; gap: 0; padding: 8px var(--sp-4); min-height: var(--hit); justify-content: center; cursor: pointer; }
    .results li strong { font-size: var(--fs-l); font-weight: var(--fw-strong); }
    .results li span { font-size: var(--fs-s); color: var(--text-muted); }
    .results li:hover, .results li.active { background: var(--surface-3); }
    .results li.empty { color: var(--text-muted); cursor: default; font-size: var(--fs-m); }

    .card { padding: var(--sp-3) 14px var(--sp-1); border-radius: 14px; background: var(--surface-1); box-shadow: var(--shadow-2); overflow-y: auto; min-height: 0; animation: sheet-in var(--t-med) both; }
    header { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-2); }
    .where strong { display: block; font-size: var(--fs-xl); font-weight: var(--fw-strong); line-height: var(--lh-tight); }
    .sub { font-size: var(--fs-s); color: var(--text-secondary); }
    .x { flex: none; display: grid; place-items: center; width: var(--hit); height: var(--hit); margin: -8px -10px 0 0; border: 0; border-radius: 50%; background: transparent; color: var(--text-secondary); cursor: pointer; }
    .x:hover { background: var(--surface-3); color: var(--text-primary); }

    .now { display: flex; align-items: center; gap: 10px; margin-top: 2px; }
    .temp { font-size: 52px; font-weight: 300; line-height: 1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
    .sky { color: var(--accent-strong); }
    .facts { display: flex; flex-direction: column; gap: 1px; margin-left: var(--sp-1); font-size: var(--fs-m); color: var(--text-secondary); min-width: 0; }
    .facts span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .when { margin: 2px 0 var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); }

    .days { list-style: none; display: grid; grid-template-columns: repeat(5, 1fr); margin: 0; padding: 6px 0 var(--sp-1); border-top: 1px solid var(--line); }
    .day { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 0 2px; font-size: var(--fs-s); font-variant-numeric: tabular-nums; }
    .day + .day { border-left: 1px solid var(--line); }
    .wd { font-size: var(--fs-xs); font-weight: var(--fw-strong); letter-spacing: var(--ls-caps); color: var(--text-muted); }
    .day app-icon { color: var(--text-primary); }
    .range { white-space: nowrap; }
    .range strong { font-weight: var(--fw-strong); }
    .slash { margin: 0 2px; color: var(--text-muted); }
    .bar { width: calc(100% - 6px); height: 4px; border-radius: 2px; }
    .rain { font-size: var(--fs-xs); font-weight: var(--fw-medium); color: var(--s-rain); min-height: 14px; }
    .rain.dry { color: var(--text-muted); font-weight: var(--fw-normal); }

    .actions { display: flex; gap: var(--sp-2); padding: var(--sp-2) 0; border-top: 1px solid var(--line); }
    .act { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: var(--hit); padding: 0 var(--sp-3); border: 0; border-radius: calc(var(--hit) / 2); background: var(--surface-3); color: var(--text-primary); font-size: var(--fs-m); font-weight: var(--fw-medium); cursor: pointer; transition: background var(--t-fast), color var(--t-fast); }
    .act:hover { background: var(--surface-4); }
    .act[aria-pressed='true'] { background: var(--accent); color: var(--on-accent); }
    .act app-icon { transition: transform var(--t-fast); }

    .values { margin: var(--sp-1) 0 0; }
    .heading { margin-top: var(--sp-2); padding-top: var(--sp-2); border-top: 1px solid var(--accent-line); font-size: var(--fs-s); font-weight: var(--fw-strong); color: var(--accent-strong); }
    .row { display: flex; justify-content: space-between; gap: var(--sp-3); padding: 5px 0; border-top: 1px solid var(--line); font-size: var(--fs-m); }
    .row.on { background: var(--accent-soft); margin: 0 -14px; padding: 5px 14px; }
    dt { color: var(--text-secondary); }
    dd { margin: 0; font-weight: var(--fw-strong); text-align: right; font-variant-numeric: tabular-nums; }
    .adj { margin-left: var(--sp-1); font-size: 8px; color: var(--accent-strong); vertical-align: middle; }
    .obs-heading { display: flex; align-items: baseline; justify-content: space-between; }
    .obs-note { font-size: var(--fs-xs); font-weight: var(--fw-normal); color: var(--text-muted); }
    .obs { padding: 5px 0; border-top: 1px solid var(--line); }
    .obs-main { display: flex; justify-content: space-between; gap: var(--sp-3); font-size: var(--fs-m); color: var(--text-secondary); }
    .obs-main strong { color: var(--text-primary); text-align: right; font-variant-numeric: tabular-nums; }
    .obs-sub { margin-top: 1px; font-size: var(--fs-xs); color: var(--text-muted); }
    .footer { margin: 6px 0 0; font-size: var(--fs-xs); color: var(--text-muted); }

    /* which run of which model these numbers are from, and whether it is the newest */
    .runline { display: flex; align-items: center; gap: var(--sp-2); width: calc(100% + 28px); margin: var(--sp-1) -14px 0; padding: 0 14px; min-height: 34px; border: 0; border-top: 1px solid var(--line); border-radius: 0 0 14px 14px; background: transparent; color: var(--text-secondary); font-size: var(--fs-xs); text-align: left; cursor: pointer; font-variant-numeric: tabular-nums; }
    .runline:hover { background: var(--surface-3); color: var(--text-primary); }
    .run-text { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .run-badge { flex: none; font-weight: var(--fw-medium); }

    .note { padding: var(--sp-2) 0; font-size: var(--fs-s); color: var(--text-muted); }
    .busy { display: flex; align-items: center; gap: var(--sp-2); }
    .spinner { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--line-strong); border-top-color: var(--accent-strong); animation: spin 0.8s linear infinite; }

    @media (max-width: 700px) {
      /* the right-hand column (menu button and layer buttons) stays clear of the card */
      .card { margin-right: calc(var(--hit) + 8px); }
      .input { font-size: var(--fs-xl); }
      .temp { font-size: 44px; }
      .days { grid-template-columns: repeat(4, 1fr); }
      .day:nth-child(5) { display: none; }
      /* the time is on the bar and the run is on the model button: the card keeps to the weather */
      .when, .runline { display: none; }
      .wrap { max-height: calc(100dvh - var(--left-stack-h) - 52px); }
      /* the meteogram carries the numbers: the card keeps to the headline while it is open */
      .tight .actions, .tight .now { display: none; }
    }
    /* ...and the days and the time and place line: they are on the chart */
    .tight .days, .tight .when { display: none; }
  `]
})
export class PlaceCardComponent {
  protected readonly inspector = inject(ForecastInspectorService);
  protected readonly catalog = inject(ForecastCatalogService);
  protected readonly outlook = inject(OutlookService);
  protected readonly meteogram = inject(MeteogramService);
  protected readonly panels = inject(PanelService);
  private readonly state = inject(ForecastStateService);
  private readonly runs = inject(ModelRunsService);
  private readonly search = inject(PlaceSearchService);
  private readonly mapHost = inject(MapHostService);
  private readonly observations = inject(ObservationsService);
  private readonly unitsService = inject(UnitsService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The full list of values is open: only then are all of them read from the forecast. */
  protected readonly expanded = this.inspector.detail;

  // ---- search
  protected readonly query = signal('');
  protected readonly editing = signal(false);
  protected readonly suggestions = signal<Place[]>([]);
  protected readonly searched = signal(false);
  protected readonly active = signal(-1);
  private timer: ReturnType<typeof setTimeout> | null = null;

  protected readonly showResults = computed(() => this.editing() && this.query().trim().length >= 2 && this.searched());
  protected readonly shownName = computed(() => (this.editing() ? this.query() : this.title()));

  // ---- what the card shows
  protected readonly title = computed(() => {
    const p = this.inspector.point();
    const label = this.inspector.label();
    if (label) return label;
    if (!p) return this.inspector.selected() ? 'Selected point' : '';
    return p.district ?? p.state ?? 'Open sea';
  });
  protected readonly subtitle = computed(() => {
    const p = this.inspector.point();
    return p?.state && p.state !== this.title() ? p.state : '';
  });

  private readonly rowText = (id: string) => this.inspector.point()?.rows.find(r => r.id === id)?.text;
  protected readonly bigTemp = computed(() => {
    const n = firstNumber(this.rowText('temp'));
    return n === null ? '–' : `${Math.round(n)}°`;
  });
  protected readonly feels = computed(() => {
    const n = firstNumber(this.rowText('feels'));
    return n === null ? '' : `${Math.round(n)}°`;
  });
  protected readonly wind = computed(() => this.rowText('wind')?.replace(/^–.*/, '') ?? '');
  protected readonly humidity = computed(() => {
    const t = this.rowText('humidity');
    return t && !t.startsWith('–') ? t : '';
  });
  protected readonly sky = computed(() => {
    const p = this.inspector.point();
    return currentIcon(p?.values['precip'] ?? null, p?.values['cloud'] ?? null, p?.timeMs ?? Date.now());
  });
  protected readonly timeLabel = computed(() => {
    const p = this.inspector.point();
    if (!p) return '';
    const day = new Intl.DateTimeFormat('en-IN', { timeZone: IST, weekday: 'short', day: 'numeric', month: 'short' }).format(p.timeMs);
    const time = new Intl.DateTimeFormat('en-IN', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: false }).format(p.timeMs);
    return `${day} ${time} IST`;
  });
  /** The row of the layer on the map, which is lit in the full list. */
  protected readonly layerRow = computed(() => ({ temp: 'temp', wind: 'wind', gust: 'gust', rain: 'rain', humidity: 'humidity', pressure: 'pressure', feels: 'feels', dew: 'dew', rain24: 'rain24', raintot: 'rainrange', extreme: 'extreme', clouds: 'clouds' } as Record<string, string>)[this.state.activeLayerId() ?? ''] ?? '');
  protected readonly adjusted = computed(() => this.inspector.point()?.rows.some(r => r.terrainAdjusted) ?? false);

  // ---- which run these numbers are from
  private readonly runInfo = computed(() => this.runs.active());
  protected readonly runTone = computed(() => this.runInfo()?.tone ?? 'none');
  protected readonly runBadge = computed(() => this.runInfo()?.badge ?? '');
  protected readonly runText = computed(() => {
    const info = this.runInfo();
    if (!info?.published) return 'run not known';
    const lines = runLines(info, this.state.timeMs(), this.runs.nowMs());
    return `${lines.run.split(' · ')[0]} · ${lines.hour}`;
  });
  protected readonly runTitle = computed(() => {
    const info = this.runInfo();
    if (!info?.published) return 'Forecast model';
    const lines = runLines(info, this.state.timeMs(), this.runs.nowMs());
    return `${this.catalog.model().label}. ${lines.run}. ${lines.published}. ${info.detail} Click for all the models.`;
  });

  protected toggleValues(): void {
    this.inspector.detail.update(on => !on);
  }

  protected temp(c: number | null): string {
    return formatTemp(c, this.unitsService.units(), 0, false);
  }
  protected rain(mm: number): string {
    return formatRain(mm, this.unitsService.units());
  }
  protected bar(lo: number | null, hi: number | null): string {
    return temperatureBar(lo, hi);
  }

  /** The rain gauge, weather station and airport nearest the place, in the chosen units. */
  protected readonly observed = computed(() => {
    const sel = this.inspector.selected();
    const o = sel ? this.observations.near(sel.lat, sel.lon) : null;
    if (!o) return null;
    const u = this.unitsService.units();
    const date = o.rainDate ? new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(Date.parse(o.rainDate)) : '';
    const wind = (kt: number | null, dir: number | string | null) => (kt !== null ? `${formatWind(kt * KT_TO_MS, u)} ${compassPoint(dir)}`.trim() : '');
    const temp = (c: number | null) => (c !== null ? formatTemp(c, u) : '');
    const g = o.gauge;
    const a = o.airport;
    const s = o.station;
    return {
      gauge: g && {
        value: formatRain(g.item.t, u),
        place: g.item.n,
        km: Math.round(g.km),
        window: `24 h to 08:30, ${date}`,
        peak: g.item.pt && g.item.pk !== null ? `${formatRain(g.item.pk, u)} at ${g.item.pt}` : '',
      },
      airport: a && {
        value: [temp(a.item.temp_c), a.item.rh_pct !== null ? `${a.item.rh_pct.toFixed(0)} %` : '', wind(a.item.wind_kt, a.item.wind_dir)].filter(Boolean).join(' · '),
        place: a.item.name ?? a.item.station,
        km: Math.round(a.km),
        age: ageLabel(a.item.time),
      },
      station: s && {
        value: [temp(s.item.temp_c), s.item.rh_pct !== null ? `${s.item.rh_pct.toFixed(0)} %` : '', wind(s.item.wind_kt, s.item.wind_dir)].filter(Boolean).join(' · '),
        place: s.item.name,
        km: Math.round(s.km),
        age: ageLabel(s.item.time),
        rain: s.item.rain_mm !== null && s.item.rain_mm > 0 ? `${formatRain(s.item.rain_mm, u)}${s.item.rain_hours ? ` in ${s.item.rain_hours} h` : ''}` : '',
      },
    };
  });

  // ---- search behaviour
  protected onFocus(input: HTMLInputElement): void {
    this.editing.set(true);
    this.query.set(this.title());
    this.searched.set(false);
    this.suggestions.set([]);
    queueMicrotask(() => input.select()); // typing replaces the name, as on windy.com
  }

  protected onInput(event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    this.query.set(text);
    this.active.set(-1);
    if (this.timer) clearTimeout(this.timer);
    if (text.trim().length < 2) {
      this.suggestions.set([]);
      this.searched.set(false);
      return;
    }
    this.timer = setTimeout(() => {
      void this.search.search(text).then(places => {
        if (this.query() !== text) return; // the box has changed since
        this.suggestions.set(places);
        this.searched.set(true);
      });
    }, SEARCH_DELAY_MS);
  }

  protected onBlur(): void {
    // a click on a result happens before this (mousedown), so the list can close now
    setTimeout(() => this.editing.set(false), 120);
  }

  protected onKey(event: KeyboardEvent): void {
    const n = this.suggestions().length;
    if (event.key === 'ArrowDown' && n) {
      event.preventDefault();
      this.active.set((this.active() + 1) % n);
    } else if (event.key === 'ArrowUp' && n) {
      event.preventDefault();
      this.active.set((this.active() - 1 + n) % n);
    } else if (event.key === 'Enter' && n) {
      event.preventDefault();
      this.choose(this.suggestions()[Math.max(this.active(), 0)]);
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      this.editing.set(false);
      (event.target as HTMLInputElement).blur();
    }
  }

  protected choose(place: Place): void {
    this.inspector.select(place.lat, place.lon, place.name);
    this.mapHost.flyTo(place.lat, place.lon, 9);
    this.editing.set(false);
    this.suggestions.set([]);
    (this.host.nativeElement.ownerDocument.activeElement as HTMLElement | null)?.blur();
  }

  protected goHome(): void {
    this.inspector.select(HOME.lat, HOME.lon, HOME.name);
    this.mapHost.home();
  }

  @HostListener('window:keydown.escape', ['$event'])
  protected onEscape(event: Event): void {
    // a panel over the map (the menu, the model list, the about box) takes the key first
    if (this.editing() || event.defaultPrevented || this.panels.open() !== null) return;
    this.inspector.close();
  }
}
