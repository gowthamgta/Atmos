import { ChangeDetectionStrategy, Component, DOCUMENT, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { ForecastCatalogService } from '../../core/forecast/forecast-catalog.service';
import { ForecastInspectorService } from '../../core/forecast/forecast-inspector.service';
import { FORECAST_MODELS, forecastModelById, modelColor } from '../../core/forecast/forecast-models';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';
import { istStamp, istValid, leadHours, leadLabel, runHourLabel, utcStamp } from '../../core/forecast/model-runs';
import { ModelRunsService } from '../../core/forecast/model-runs.service';
import { degToCompass } from '../../core/domain/models/compass';
import { istDayStart } from '../../core/meteogram/chart-math';
import { compareAt } from '../../core/meteogram/compare';
import { CompareVar, MeteogramService, RANGE_DAYS } from '../../core/meteogram/meteogram.service';
import { PointSeriesService } from '../../core/meteogram/point-series.service';
import { Series, indexAt, sumFrom } from '../../core/meteogram/point-series';
import { UnitsService } from '../../core/units/units.service';
import { formatPressure, formatRain, formatTemp, formatWind } from '../../core/units/units';
import { MapHostService } from '../../core/ui/map-host.service';
import { observeSize } from '../../shared/observe-size';
import { IconComponent } from '../../shared/icon.component';
import { RovingTabsDirective } from '../../shared/roving-tabs.directive';
import { CompareTableComponent } from './compare-table.component';
import { MeteogramChartComponent } from './meteogram-chart.component';

const DAY_MS = 86_400_000;
const COMPARE_TABS: readonly { id: CompareVar; label: string }[] = [
  { id: 'temp', label: 'Temperature' },
  { id: 'rain', label: 'Rain' },
  { id: 'wind', label: 'Wind' },
  { id: 'pressure', label: 'Pressure' },
];

/**
 * The meteogram: a sheet over the time bar with the hourly forecast of the place on the card, after meteoblue's diagrams. "Forecast" shows the
 * model on the map in three rows (temperature, rain with the cloud cover, wind with its gusts); "Compare models" draws one quantity for every
 * model and sets them side by side in a table at the chosen time, with each model's run and the forecast hour of that time. Pointing at the chart
 * reads the hour under the pointer; clicking or dragging on it moves the time on the bar, and the map with it.
 */
@Component({
  selector: 'app-meteogram',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, MeteogramChartComponent, CompareTableComponent, RovingTabsDirective],
  template: `
    @if (m.visible()) {
      <section #sheet class="sheet" role="region" [attr.aria-label]="'Meteogram, hourly forecast for ' + place().name" [class.compare]="m.view() === 'compare'">
        <header class="head">
          <div class="where">
            <strong class="place">{{ place().name }}</strong>
            <span class="meta">{{ place().meta }}</span>
          </div>
          <div class="controls">
            <div class="seg" role="tablist" aria-label="Kind of chart" appRovingTabs>
              <button type="button" role="tab" [class.on]="m.view() === 'model'" [attr.aria-selected]="m.view() === 'model'" [attr.tabindex]="m.view() === 'model' ? 0 : -1" (click)="m.view.set('model')">Forecast</button>
              <button type="button" role="tab" [class.on]="m.view() === 'compare'" [attr.aria-selected]="m.view() === 'compare'" [attr.tabindex]="m.view() === 'compare' ? 0 : -1" (click)="m.view.set('compare')">Compare<span class="long"> models</span></button>
            </div>
            <div class="seg" role="group" aria-label="Days shown">
              @for (d of rangeDays; track d) {
                <button type="button" [class.on]="m.days() === d" [attr.aria-pressed]="m.days() === d" [attr.aria-label]="d + ' days'" (click)="m.days.set(d)">{{ d }}<span class="long"> days</span><span class="short">d</span></button>
              }
            </div>
          </div>
          <div class="tools">
            <button type="button" class="btn-icon info" [class.on]="noteOpen()" [attr.aria-expanded]="noteOpen()" aria-controls="meteogram-note" aria-label="Where this comes from" title="Where this comes from" (click)="noteOpen.set(!noteOpen())"><app-icon name="info" [size]="16" /></button>
            <button type="button" class="btn-icon" (click)="m.close()" aria-label="Hide the meteogram" title="Hide the meteogram (M)"><app-icon name="chevron" [size]="16" /></button>
          </div>
        </header>

        @switch (series.status()) {
          @case ('error') {
            <div class="state error" role="alert">
              <span>{{ series.error() }}</span>
              <button type="button" class="again" (click)="m.retry()">Try again</button>
            </div>
          }
          @case ('ready') {
            @if (series.data(); as data) {
              @if (m.view() === 'model') {
                <div class="readout" role="group" aria-label="Forecast at the time chosen">
                  @if (readout(); as r) {
                    <div class="cell when" [title]="r.leadTitle">
                      <span class="label"><span class="model-dot" [class.ai]="activeModel().ai" [style.--model-color]="activeColor()"></span>{{ activeModel().short }} {{ activeModel().gridKm }} km{{ r.lead }}</span>
                      <span class="value time">{{ r.when }}</span>
                    </div>
                    @for (c of r.cells; track c.key) {
                      <div class="cell" [title]="c.value + ' ' + c.sub">
                        <span class="label"><span class="swatch" [style.background]="c.color"></span>{{ c.label }}</span>
                        <span class="line"><span class="value">{{ c.value }}</span><span class="sub">{{ c.sub }}</span></span>
                      </div>
                    }
                  }
                </div>
                <div class="chart model" tabindex="0" aria-describedby="meteogram-help">
                  <app-meteogram-chart
                    mode="model" [series]="data" [modelId]="catalog.activeModelId()" [startMs]="window().startMs" [endMs]="window().endMs"
                    [timeMs]="state.timeMs()" [nowMs]="runs.nowMs()" [units]="units()" [hover]="m.hoverMs()"
                    (hoverChange)="m.hoverMs.set($event)" (pick)="pick($event)" />
                </div>
              } @else {
                <div class="toolbar">
                  <div class="seg" role="tablist" aria-label="Quantity compared" appRovingTabs>
                    @for (t of compareTabs; track t.id) {
                      <button type="button" role="tab" [class.on]="m.compareVar() === t.id" [attr.aria-selected]="m.compareVar() === t.id" [attr.tabindex]="m.compareVar() === t.id ? 0 : -1" (click)="m.compareVar.set(t.id)">{{ t.label }}</button>
                    }
                  </div>
                  <div class="legend" role="group" aria-label="Models drawn">
                    @for (def of models; track def.id) {
                      <button type="button" class="key" [class.off]="m.hidden().has(def.id)" [attr.aria-pressed]="!m.hidden().has(def.id)" (click)="m.toggleModel(def.id)" [title]="(m.hidden().has(def.id) ? 'Show ' : 'Hide ') + def.label">
                        <span class="model-dot" [class.ai]="def.ai" [style.--model-color]="color(def.id)"></span>{{ def.short }}@if (def.ai) { <span class="ai-tag">AI</span> }
                      </button>
                    }
                  </div>
                </div>
                <div class="compare-body">
                  <div class="chart" tabindex="0" aria-describedby="meteogram-help">
                    <app-meteogram-chart
                      mode="compare" [series]="data" [modelId]="catalog.activeModelId()" [compareVar]="m.compareVar()" [modelIds]="shownModels()"
                      [startMs]="window().startMs" [endMs]="window().endMs" [timeMs]="state.timeMs()" [nowMs]="runs.nowMs()" [units]="units()" [hover]="m.hoverMs()"
                      (hoverChange)="m.hoverMs.set($event)" (pick)="pick($event)" />
                  </div>
                  <div class="table">
                    <div class="table-when">{{ tableWhen() }}</div>
                    <app-compare-table [table]="table()" [units]="units()" [mapModelId]="catalog.activeModelId()" [hiddenIds]="m.hidden()" (chooseModel)="state.selectModel($event)" />
                  </div>
                </div>
              }
              <p id="meteogram-help" class="sr-only">Use the left and right arrow keys to move through the forecast. Click or drag on the chart to set the time on the map.</p>
              <!-- said when the time on the map settles (not at every step of a drag or a play, and never for the pointer passing over the chart) -->
              <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ announcement() }}</p>
              <footer id="meteogram-note" class="foot" [class.open]="noteOpen()">{{ footnote() }}</footer>
            }
          }
          @default {
            <div class="state" role="status"><span class="spinner" aria-hidden="true"></span>Loading the hourly forecast…</div>
          }
        }
      </section>
    }
  `,
  styles: [`
    :host { display: contents; --sheet-gap: 30px; }
    .sheet {
      position: fixed; left: var(--gutter); bottom: calc(var(--bars-h) + var(--sheet-gap)); z-index: var(--z-sheet);
      /* it stops short of the right-hand column (menu, layers, zoom, model), which keeps its place and its height */
      width: min(calc(100vw - 2 * var(--gutter) - 240px), 1040px);
      max-height: min(70dvh, 600px); overflow-y: auto; overscroll-behavior: contain; padding: var(--sp-2) var(--sp-4) var(--sp-2);
      background: var(--surface-solid); border-radius: var(--radius-l); box-shadow: var(--shadow-2); color: var(--text-primary); animation: sheet-in var(--t-med) both;
    }
    /* name | the two choices | tools, in one row when there is room; the choices drop under the name when there is not */
    .head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); margin-bottom: var(--sp-2); }
    .where { display: flex; align-items: baseline; gap: var(--sp-2); min-width: 0; flex: 1 1 220px; flex-wrap: wrap; }
    .tools { display: flex; gap: var(--sp-1); margin-left: auto; }
    .short { display: none; }
    .place { font-size: var(--fs-xl); font-weight: var(--fw-strong); line-height: var(--lh-tight); }
    .meta { font-size: var(--fs-s); color: var(--text-muted); }
    .controls { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; flex: 0 1 auto; }

    .readout { display: grid; grid-template-columns: minmax(170px, 1.5fr) repeat(4, minmax(0, 1fr)); gap: var(--sp-2) var(--sp-4); padding: 0 0 var(--sp-2); }
    .cell { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .line { display: flex; align-items: baseline; gap: var(--sp-2); min-width: 0; }
    .label { display: flex; align-items: center; gap: 6px; font-size: var(--fs-xs); font-weight: var(--fw-medium); color: var(--text-muted); text-transform: uppercase; letter-spacing: var(--ls-caps); white-space: nowrap; }
    .swatch { width: 8px; height: 8px; border-radius: 2px; flex: none; }
    .value { flex: none; font-size: 19px; font-weight: var(--fw-strong); line-height: 1.15; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .value.time { font-size: var(--fs-xl); }
    .sub { min-width: 0; font-size: var(--fs-s); color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    /* the chart takes the height the screen can spare: more of it on a tall screen, less on a short one */
    .chart { --chart-h: clamp(150px, 26dvh, 215px); min-width: 0; border-radius: var(--radius-m); outline-offset: 2px; }
    .chart.model { --chart-h: clamp(176px, 32dvh, 250px); }
    .toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; padding-bottom: var(--sp-2); }
    .legend { display: flex; gap: var(--sp-1); flex-wrap: wrap; }
    .key { display: inline-flex; align-items: center; gap: 6px; min-height: calc(var(--hit) - 8px); padding: 0 var(--sp-3); border: 1px solid var(--line); border-radius: calc(var(--hit) / 2); background: transparent; color: var(--text-primary); font-size: var(--fs-m); font-weight: var(--fw-medium); cursor: pointer; }
    .key:hover { background: var(--surface-3); }
    .key.off { color: var(--text-muted); text-decoration: line-through; }
    .key.off .model-dot { opacity: 0.35; }
    .ai-tag { padding: 0 5px; border-radius: 6px; background: var(--surface-4); font-size: var(--fs-xs); color: var(--text-secondary); }

    .compare-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-3); }
    .table { min-width: 0; }
    .table-when { padding: 0 0 var(--sp-1); font-size: var(--fs-s); font-weight: var(--fw-medium); color: var(--text-secondary); }

    .foot { margin-top: var(--sp-2); padding-top: var(--sp-2); border-top: 1px solid var(--line); font-size: var(--fs-xs); color: var(--text-muted); line-height: var(--lh-normal); }
    .state { display: flex; align-items: center; gap: var(--sp-3); justify-content: center; min-height: 150px; font-size: var(--fs-m); color: var(--text-secondary); }
    .state.error { color: var(--warn); flex-wrap: wrap; text-align: center; }
    .again { min-height: calc(var(--hit) - 8px); padding: 0 var(--sp-4); border: 0; border-radius: calc(var(--hit) / 2); background: var(--accent); color: var(--on-accent); font-weight: var(--fw-strong); cursor: pointer; }
    .spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--line-strong); border-top-color: var(--accent-strong); animation: spin 0.8s linear infinite; }

    @media (min-width: 1260px) {
      .compare-body { grid-template-columns: minmax(300px, 1fr) minmax(520px, 600px); align-items: start; }
    }
    /* the source line is behind the info button, except on a tall screen that has the room for it */
    .foot { display: none; }
    .foot.open { display: block; }
    .info.on { background: var(--accent); color: var(--on-accent); }
    @media (min-height: 801px) and (min-width: 761px) {
      .foot { display: block; }
      .info { display: none; }
    }
    @media (max-width: 760px) {
      :host { --sheet-gap: 0px; }
      .sheet { left: 0; right: 0; bottom: var(--bars-h); width: auto; max-height: 60dvh; border-radius: var(--radius-l) var(--radius-l) 0 0; padding: var(--sp-2) var(--sp-3); }
      .head { flex-wrap: wrap; gap: var(--sp-1) var(--sp-2); }
      .where { order: 1; }
      .tools { order: 2; }
      .controls { order: 3; width: 100%; justify-content: space-between; }
      .controls .seg button { padding: 0 var(--sp-3); }
      .long { display: none; }
      .short { display: inline; }
      /* the time on one row, the four values in four columns: a phone's chart needs the height */
      .readout { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--sp-1) var(--sp-2); }
      .readout .when { grid-column: 1 / -1; flex-direction: row; align-items: baseline; justify-content: space-between; gap: var(--sp-2); }
      .readout .when .label { order: 2; }
      .value { font-size: var(--fs-xl); }
      .readout .sub { display: none; }
      .label { font-size: var(--fs-xs); letter-spacing: 0.04em; }
      .chart, .chart.model { --chart-h: 186px; }
    }
    @media (max-width: 760px) and (max-height: 700px) {
      .chart, .chart.model { --chart-h: 150px; }
    }
  `]
})
export class MeteogramComponent implements OnDestroy {
  protected readonly m = inject(MeteogramService);
  protected readonly series = inject(PointSeriesService);
  protected readonly state = inject(ForecastStateService);
  protected readonly catalog = inject(ForecastCatalogService);
  protected readonly runs = inject(ModelRunsService);
  private readonly inspector = inject(ForecastInspectorService);
  private readonly unitsService = inject(UnitsService);
  private readonly document = inject(DOCUMENT);
  private readonly mapHost = inject(MapHostService);

  protected readonly units = this.unitsService.units;
  protected readonly rangeDays = RANGE_DAYS;
  protected readonly compareTabs = COMPARE_TABS;
  protected readonly models = FORECAST_MODELS;

  private readonly sheet = viewChild<ElementRef<HTMLElement>>('sheet');
  private stopWatching: (() => void) | null = null;

  constructor() {
    // the chart compares every model, so every model's run is looked up as soon as the sheet is open
    effect(() => {
      if (this.m.visible()) untracked(() => void this.runs.watch(FORECAST_MODELS.map(def => def.id)));
    });
    // the sheet's height is given to the rest of the screen (--sheet-h), so the card, the rail and the model button make room for it
    effect(() => {
      const el = this.sheet()?.nativeElement;
      untracked(() => {
        this.stopWatching?.();
        this.stopWatching = null;
        if (!el) {
          this.setSheetHeight(0);
          return;
        }
        this.stopWatching = observeSize(el, (_w, h) => this.setSheetHeight(h + this.gap()));
      });
    });
    // a screen reader hears the readout when the time on the map has settled for a moment (not at every step of a drag or a play)
    effect(() => {
      const t = this.state.timeMs();
      this.series.data();
      this.units();
      this.catalog.activeModelId();
      if (!this.m.visible() || t === null) return;
      untracked(() => {
        if (this.announceTimer) clearTimeout(this.announceTimer);
        this.announceTimer = setTimeout(() => {
          const r = this.readoutAt(this.state.timeMs() ?? t);
          this.announcement.set(r ? `${r.when}. ${r.cells.map(c => `${c.label} ${c.value}${c.sub ? `, ${c.sub}` : ''}`).join('. ')}.` : '');
        }, 800);
      });
    });
    // the place stays in view above the sheet: a click near the bottom of the map would otherwise end up under it
    effect(() => {
      const sel = this.inspector.selected();
      if (!this.m.visible() || !this.sheet() || !sel) return;
      untracked(() => setTimeout(() => this.keepPlaceInView(sel.lat, sel.lon), 60));   // after the sheet has been measured
    });
  }

  ngOnDestroy(): void {
    if (this.announceTimer) clearTimeout(this.announceTimer);
    this.stopWatching?.();
    this.setSheetHeight(0);
  }

  /** Pans the map, if need be, so the place is above the sheet and below the search box (and, on a phone, clear of the card). */
  private keepPlaceInView(lat: number, lon: number): void {
    const el = this.sheet()?.nativeElement;
    const view = this.document.defaultView;
    if (!el || !view) return;
    const top = view.innerWidth <= 700 ? 118 : 70;
    const bottom = view.innerHeight - el.getBoundingClientRect().top + 28;
    this.mapHost.ensureVisible(lat, lon, { top, right: 60, bottom, left: 24 });
  }

  /** The space the sheet leaves above the bars: room for the playhead's tooltip (none on a phone, where the sheet sits on the bars). */
  private gap(): number {
    return (this.document.defaultView?.innerWidth ?? 1024) > 760 ? 30 : 0;
  }

  private setSheetHeight(px: number): void {
    const root = this.document.documentElement;
    root.style.setProperty('--sheet-h', `${Math.round(px)}px`);
    if (px > 0) root.setAttribute('data-sheet', 'open');
    else root.removeAttribute('data-sheet');
  }

  // ---- what is shown -------------------------------------------------------------------------------------------------
  protected readonly place = computed(() => {
    const point = this.inspector.point();
    const sel = this.inspector.selected();
    const name = this.inspector.label() ?? point?.district ?? point?.state ?? 'Selected point';
    const meta: string[] = [];
    if (sel) meta.push(`${sel.lat.toFixed(2)}°N ${sel.lon.toFixed(2)}°E`);
    const elevation = this.series.data()?.elevationM ?? point?.elevationM ?? null;
    if (elevation !== null) meta.push(`${Math.round(elevation)} m`);
    meta.push('times in IST');
    return { name, meta: meta.join(' · ') };
  });

  /** From the start of today (IST) for the chosen number of days. */
  protected readonly window = computed(() => {
    const startMs = istDayStart(this.runs.nowMs());
    return { startMs, endMs: startMs + this.m.days() * DAY_MS };
  });

  protected readonly activeModel = computed(() => forecastModelById(this.catalog.activeModelId()));
  protected readonly activeColor = computed(() => modelColor(this.catalog.activeModelId()));
  protected color = modelColor;
  /** The source line under the chart is open (behind the info button, where the screen is too short to show it). */
  protected readonly noteOpen = signal(false);
  protected readonly shownModels = computed(() => FORECAST_MODELS.map(def => def.id).filter(id => !this.m.hidden().has(id)));

  /** The time the readout and the table are for: the hour under the pointer, else the time on the map's bar. */
  private readonly focusMs = computed(() => this.m.hoverMs() ?? this.state.timeMs() ?? this.runs.nowMs());

  protected readonly table = computed(() => compareAt(this.series.data()!, FORECAST_MODELS.map(def => def.id), this.focusMs()));
  protected readonly tableWhen = computed(() => `At ${istValid(this.table().timeMs)}${this.m.hoverMs() === null ? ', the time on the map' : ''}`);

  protected readonly readout = computed(() => this.readoutAt(this.focusMs()));

  /** What the readout says for a time (the hour of the series nearest it). */
  private readoutAt(ms: number) {
    const data = this.series.data();
    const model = data?.models[this.catalog.activeModelId()];
    if (!data || !model) return null;
    const i = indexAt(data.times, ms);
    const u = this.units();
    const at = (s: Series): number | null => s[i] ?? null;
    const [temp, feels, rain, wind, dir, gust, pressure, cloud, humidity] = [model.temp, model.feels, model.rain, model.wind, model.windDir, model.gust, model.pressure, model.cloud, model.humidity].map(at);
    const rain24 = sumFrom(model.rain, i, 24, true);
    const init = this.runs.infos().find(info => info.model.id === this.catalog.activeModelId())?.upstream?.latestInitMs ?? null;
    const dash = (s: string | null | undefined) => s ?? '';
    return {
      when: istValid(data.times[i]),
      lead: init !== null ? ` · ${leadLabel(leadHours(init, data.times[i]))}` : '',
      leadTitle: init !== null ? `Forecast hour ${leadLabel(leadHours(init, data.times[i]))} of the ${runHourLabel(init)} run of ${this.activeModel().label}` : '',
      cells: [
        { key: 'temp', label: 'Temp.', color: 'var(--s-temp)', value: formatTemp(temp, u, 0), sub: feels !== null ? `feels ${formatTemp(feels, u, 0)}` : '' },
        { key: 'rain', label: 'Rain', color: 'var(--s-rain)', value: formatRain(rain, u), sub: rain24 !== null ? `${formatRain(rain24, u)} in 24 h` : 'hour before' },
        { key: 'wind', label: 'Wind', color: 'var(--s-wind)', value: formatWind(wind, u), sub: dash(dir !== null ? `${degToCompass(dir)}${gust !== null ? ` · gusts ${formatWind(gust, u)}` : ''}` : '') },
        { key: 'pressure', label: 'Pressure', color: 'var(--s-pressure)', value: formatPressure(pressure, u), sub: [humidity !== null ? `RH ${Math.round(humidity)}%` : '', cloud !== null ? `cloud ${Math.round(cloud)}%` : ''].filter(Boolean).join(' · ') },
      ],
    };
  }

  /** The sentence a screen reader gets when the time on the map settles. */
  protected readonly announcement = signal('');
  private announceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Where the data comes from and how current it is: the run the chart is made of, and whether the map shows another one. */
  protected readonly footnote = computed(() => {
    const id = this.catalog.activeModelId();
    const def = forecastModelById(id);
    const info = this.runs.infos().find(i => i.model.id === id);
    const init = info?.upstream?.latestInitMs ?? null;
    const published = info?.published?.initMs ?? null;
    if (this.m.view() === 'compare') {
      return 'Hourly values from Open-Meteo, the newest run of each model (the Run column). A dash means the model does not provide the value, or its run ends before then. Spread is the largest difference between models. Values at the point can differ a little from the map, which is interpolated and corrected to the 90 m terrain.';
    }
    const parts = [`${def.label}, ${def.resolution}`];
    if (init !== null) parts.push(`run ${runHourLabel(init)} · ${istStamp(init)} (${utcStamp(init)})`);
    parts.push('hourly values from Open-Meteo');
    let text = `${parts.join(' · ')}. Each rain bar is the hour before its time. Values at the point can differ a little from the map, which is interpolated and corrected to the 90 m terrain.`;
    if (init !== null && published !== null && published < init) text += ` The map still shows the ${runHourLabel(published)} run; ${info?.badge?.toLowerCase() ?? 'an update is coming'}.`;
    return text;
  });

  protected pick(ms: number): void {
    this.state.pause();
    this.state.setTime(ms);
  }

  @HostListener('window:keydown', ['$event'])
  protected onKey(e: KeyboardEvent): void {
    if ((e.key !== 'm' && e.key !== 'M') || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (this.inspector.selected()) this.m.toggle();
  }
}
