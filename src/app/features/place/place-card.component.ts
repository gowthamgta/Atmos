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
import { MapHostService } from '../../core/ui/map-host.service';
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
 * bar: the temperature in big figures with a picture of the sky, wind and humidity, and the next days as a strip. "All values" opens the full list
 * of values at that place and the observations nearby (rain gauge, weather station, airport). Click anywhere on the map to choose another place.
 */
@Component({
  selector: 'app-place-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <div class="wrap">
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

            <button type="button" class="expand" (click)="expanded.set(!expanded())" [attr.aria-expanded]="expanded()">
              All values and observations <app-icon name="chevron" [size]="14" [style.transform]="expanded() ? 'rotate(180deg)' : ''" />
            </button>

            @if (expanded()) {
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
              <footer>
                @if (adjusted()) { ▲ adjusted to 90 m terrain. }
                Model: {{ catalog.model().label }}, {{ catalog.model().resolution }}.
              </footer>
            }
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
    .wrap { position: fixed; top: var(--gutter); left: var(--gutter); z-index: 950; width: min(410px, calc(100vw - 2 * var(--gutter))); display: flex; flex-direction: column; gap: 8px; max-height: calc(100dvh - var(--stack-h) - 24px); }

    .searchbox { position: relative; flex: none; }
    .search { display: flex; align-items: center; gap: 8px; height: 46px; padding: 0 6px 0 14px; border-radius: 23px; background: var(--surface-1); box-shadow: var(--shadow-2); color: var(--text-secondary); flex: none; }
    .search.open { border-radius: 23px 23px 0 0; }
    .input { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; color: var(--text-primary); font-size: 19px; font-weight: 450; text-overflow: ellipsis; }
    .input::placeholder { color: var(--text-muted); font-weight: 400; }
    .search:focus-within { box-shadow: 0 0 0 2px var(--accent-strong), var(--shadow-2); }
    .home { display: grid; place-items: center; width: 36px; height: 36px; border: 0; border-radius: 50%; background: transparent; color: var(--text-secondary); cursor: pointer; flex: none; }
    .home:hover { background: var(--surface-3); color: var(--text-primary); }

    .results { position: absolute; top: 100%; left: 0; right: 0; z-index: 5; list-style: none; margin: 0; padding: 4px 0 6px; border-radius: 0 0 14px 14px; background: var(--surface-solid); box-shadow: var(--shadow-2); max-height: 55dvh; overflow-y: auto; }
    .results li { display: flex; flex-direction: column; gap: 0; padding: 7px 16px; cursor: pointer; }
    .results li strong { font-size: 15px; font-weight: 600; }
    .results li span { font-size: 12px; color: var(--text-muted); }
    .results li:hover, .results li.active { background: var(--surface-3); }
    .results li.empty { color: var(--text-muted); cursor: default; font-size: 13px; }

    .card { padding: 10px 14px 8px; border-radius: 14px; background: var(--surface-1); box-shadow: var(--shadow-2); overflow-y: auto; min-height: 0; animation: sheet-in var(--t-med) both; }
    header { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
    .where strong { display: block; font-size: 16px; line-height: 1.2; }
    .sub { font-size: 12px; color: var(--text-secondary); }
    .x { flex: none; display: grid; place-items: center; width: 30px; height: 30px; margin: -4px -6px 0 0; border: 0; border-radius: 50%; background: transparent; color: var(--text-secondary); cursor: pointer; }
    .x:hover { background: var(--surface-3); color: var(--text-primary); }

    .now { display: flex; align-items: center; gap: 10px; margin-top: 2px; }
    .temp { font-size: 52px; font-weight: 300; line-height: 1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
    .sky { color: var(--accent-strong); }
    .facts { display: flex; flex-direction: column; gap: 1px; margin-left: 4px; font-size: 12.5px; color: var(--text-secondary); min-width: 0; }
    .facts span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .when { margin: 2px 0 8px; font-size: 11px; color: var(--text-muted); }

    .days { list-style: none; display: grid; grid-template-columns: repeat(5, 1fr); margin: 0; padding: 6px 0 4px; border-top: 1px solid var(--line); }
    .day { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 0 2px; font-size: 12px; font-variant-numeric: tabular-nums; }
    .day + .day { border-left: 1px solid var(--line); }
    .wd { font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; color: var(--text-muted); }
    .day app-icon { color: var(--text-primary); }
    .range { white-space: nowrap; }
    .range strong { font-weight: 650; }
    .slash { margin: 0 2px; color: var(--text-muted); }
    .bar { width: calc(100% - 6px); height: 4px; border-radius: 2px; }
    .rain { font-size: 11px; font-weight: 600; color: #8fcaff; min-height: 14px; }
    .rain.dry { color: var(--text-muted); font-weight: 400; }
    :host-context(:root[data-theme='light']) .rain { color: #1d6fb8; }

    .expand { display: flex; align-items: center; gap: 4px; width: 100%; margin-top: 2px; padding: 6px 0 2px; border: 0; border-top: 1px solid var(--line); background: transparent; color: var(--accent-strong); font-size: 12.5px; font-weight: 600; cursor: pointer; }
    .expand app-icon { transition: transform var(--t-fast); }
    .values { margin: 4px 0 0; }
    .heading { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--accent-line); font-size: 12px; font-weight: 700; color: var(--accent-strong); }
    .row { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; border-top: 1px solid var(--line); font-size: 13px; }
    .row.on { background: var(--accent-soft); margin: 0 -14px; padding: 5px 14px; }
    dt { color: var(--text-secondary); }
    dd { margin: 0; font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
    .adj { margin-left: 4px; font-size: 8px; color: var(--accent-strong); vertical-align: middle; }
    .obs-heading { display: flex; align-items: baseline; justify-content: space-between; }
    .obs-note { font-size: 10px; font-weight: 500; color: var(--text-muted); }
    .obs { padding: 5px 0; border-top: 1px solid var(--line); }
    .obs-main { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; color: var(--text-secondary); }
    .obs-main strong { color: var(--text-primary); text-align: right; font-variant-numeric: tabular-nums; }
    .obs-sub { margin-top: 1px; font-size: 10.5px; color: var(--text-muted); }
    footer { margin-top: 6px; font-size: 10px; color: var(--text-muted); }
    .note { padding: 8px 0; font-size: 12px; color: var(--text-muted); }
    .busy { display: flex; align-items: center; gap: 8px; }
    .spinner { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--line-strong); border-top-color: var(--accent-strong); animation: spin 0.8s linear infinite; }

    @media (max-width: 700px) {
      /* the right-hand column (menu button and layer buttons) stays clear of the card */
      .card { margin-right: 52px; }
      .input { font-size: 17px; }
      .temp { font-size: 44px; }
      .days { grid-template-columns: repeat(4, 1fr); }
      .day:nth-child(5) { display: none; }
      .wrap { max-height: calc(100dvh - var(--stack-h) - 20px); }
    }
  `]
})
export class PlaceCardComponent {
  protected readonly inspector = inject(ForecastInspectorService);
  protected readonly catalog = inject(ForecastCatalogService);
  protected readonly outlook = inject(OutlookService);
  private readonly state = inject(ForecastStateService);
  private readonly search = inject(PlaceSearchService);
  private readonly mapHost = inject(MapHostService);
  private readonly observations = inject(ObservationsService);
  private readonly unitsService = inject(UnitsService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly expanded = signal(false);

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

  @HostListener('window:keydown.escape')
  protected onEscape(): void {
    if (!this.editing()) this.inspector.close();
  }
}

