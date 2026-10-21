import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, afterNextRender, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { forecastModelById, modelColor, pointModelById } from '../../core/forecast/forecast-models';
import { CompareVar } from '../../core/meteogram/meteogram.service';
import {
  Pt, areaPath, bandPath, barsPath, daySpans, everyNth, hourAtX, istHour12, linePath, linear, niceScale, nightSpans,
} from '../../core/meteogram/chart-math';
import { PointSeries, Series, cumulative, extent, indexAt, sumFrom, windowIndexes } from '../../core/meteogram/point-series';
import {
  PRESSURE_LABEL, RAIN_LABEL, TEMP_LABEL, WIND_LABEL, Units, pressureFromHpa, rainFromMm, tempFromC, windFromMs, formatRain, formatTemp, formatWind,
} from '../../core/units/units';
import { observeSize } from '../../shared/observe-size';

const HOUR_MS = 3_600_000;
const IST = 'Asia/Kolkata';

interface Row {
  top: number;
  bottom: number;
}

interface Geometry {
  w: number;
  h: number;
  left: number;
  right: number;
  plotW: number;
  top: number;
  axisY: number;
  /** Temperature, with the rain bars standing on its floor. */
  a: Row;
  /** Wind, with its arrows along the top. */
  b: Row;
  /** The single panel of the model comparison. */
  main: Row;
  compact: boolean;
}

const NONE: Row = { top: 0, bottom: 0 };
const EMPTY: Geometry = { w: 0, h: 0, left: 0, right: 0, plotW: 0, top: 0, axisY: 0, a: NONE, b: NONE, main: NONE, compact: false };

/** Pixels the wind arrows take along the top of the wind panel, and the cloud strip at the foot of the temperature panel. */
const ARROW_BAND = 16;
const CLOUD_STRIP = 5;
/** The most of the temperature panel's height that the rain bars may climb. */
const RAIN_ZONE = 0.5;

const dayFmt = (opt: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-IN', { timeZone: IST, ...opt });

/** The decimals a tick label needs for a step. */
function tickText(v: number, step: number): string {
  const d = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return v.toFixed(d);
}

/** About how many tick steps fit in a height: one for about every 30 px, and at least two. */
const tickCount = (height: number): number => Math.max(2, Math.floor(height / 30));

/**
 * The chart of the meteogram, one SVG drawn at the size of its box (so the type stays a fixed size). In "model" mode it shows the model on the
 * map in two panels on one time axis, as yr.no does: temperature with its feels-like line, the hourly rain as bars standing on the same panel (its
 * own scale, at the right) and the cloud cover as a strip under them; then the wind with its gusts and direction arrows. In "compare" mode it draws
 * one variable for every model, one line each. Night is shaded, "now" is dashed, the time on the map's bar is the amber line, and the pointer
 * reads the hour under it.
 *
 * Times are placed exactly: a rain bar covers the hour BEFORE its time (that is what the models report), temperature and wind are points.
 */
@Component({
  selector: 'app-meteogram-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="frame" #frame>
      @if (win(); as w) {
        <svg #svg class="svg" [attr.width]="geo().w" [attr.height]="geo().h" [attr.viewBox]="'0 0 ' + geo().w + ' ' + geo().h" role="img" [attr.aria-label]="summary()">
          <defs>
            <clipPath id="clip-plot"><rect [attr.x]="geo().left" y="0" [attr.width]="geo().plotW" [attr.height]="geo().h" /></clipPath>
            <linearGradient id="fade-temp" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--s-temp)" stop-opacity="0.26" /><stop offset="1" stop-color="var(--s-temp)" stop-opacity="0" /></linearGradient>
          </defs>

          <!-- night, then the days -->
          <g class="nights" clip-path="url(#clip-plot)">
            @for (n of nights(); track n.x) { <rect [attr.x]="n.x" [attr.y]="geo().top" [attr.width]="n.w" [attr.height]="plotBottom() - geo().top" /> }
          </g>
          <g aria-hidden="true">
            @for (d of days(); track d.key) {
              @if (d.line) { <line [attr.x1]="d.line" [attr.x2]="d.line" [attr.y1]="geo().top - 4" [attr.y2]="plotBottom()" class="day-line" /> }
              @if (d.label) {
                <text [attr.x]="d.center" [attr.y]="geo().top - 8" class="day-label" text-anchor="middle">{{ d.label }}@if (d.rain) { <tspan class="day-rain" dx="7">{{ d.rain }}</tspan> }</text>
              }
            }
          </g>

          @if (mode() === 'model') {
            <!-- TEMPERATURE, with the RAIN standing on its floor and the CLOUD under it -->
            <g aria-hidden="true">
              @for (t of tempScale().ticks; track t) {
                <line [attr.x1]="geo().left" [attr.x2]="geo().left + geo().plotW" [attr.y1]="yTemp()(t)" [attr.y2]="yTemp()(t)" class="grid" />
                <text [attr.x]="geo().left - 6" [attr.y]="yTemp()(t) + 4" class="tick temp-tick" text-anchor="end">{{ tick(t, tempScale().step) }}</text>
              }
              <text [attr.x]="geo().left - 6" [attr.y]="geo().a.top - 1" class="unit temp-tick" text-anchor="end">{{ units().temp === 'C' ? '°C' : '°F' }}</text>
              <g clip-path="url(#clip-plot)">
                <path [attr.d]="rainBars()" class="bars" />
                <path [attr.d]="tempArea()" fill="url(#fade-temp)" />
                @for (c of cloudBuckets(); track c.opacity) { <path [attr.d]="c.d" class="cloud" [attr.fill-opacity]="c.opacity" /> }
                <path [attr.d]="feelsLine()" class="line feels" />
                <path [attr.d]="tempLine()" class="line temp" />
              </g>
              @for (e of tempExtremes(); track e.key) {
                <text [attr.x]="e.x" [attr.y]="e.y" class="extreme" text-anchor="middle">{{ e.text }}</text>
              }
              @if (!geo().compact) {
                @for (t of rainAxis(); track t.v) {
                  <text [attr.x]="geo().left + geo().plotW + 6" [attr.y]="t.y + 4" class="tick rain-tick" text-anchor="start">{{ t.text }}</text>
                }
                <text [attr.x]="geo().left + geo().plotW + 6" [attr.y]="geo().a.top - 1" class="unit rain-tick" text-anchor="start">{{ rainUnit() }}/h</text>
              }
            </g>

            <!-- WIND -->
            <g aria-hidden="true">
              @for (t of windScale().ticks; track t) {
                <line [attr.x1]="geo().left" [attr.x2]="geo().left + geo().plotW" [attr.y1]="yWind()(t)" [attr.y2]="yWind()(t)" class="grid" />
                <text [attr.x]="geo().left - 6" [attr.y]="yWind()(t) + 4" class="tick wind-tick" text-anchor="end">{{ tick(t, windScale().step) }}</text>
              }
              <text [attr.x]="geo().left - 6" [attr.y]="geo().b.top + 10" class="unit wind-tick" text-anchor="end">{{ windUnit() }}</text>
              <g clip-path="url(#clip-plot)">
                <path [attr.d]="gustBand()" class="gust-band" />
                <path [attr.d]="gustLine()" class="line gust" />
                <path [attr.d]="windLine()" class="line wind" />
                @for (a of arrows(); track a.x) {
                  <g [attr.transform]="'translate(' + a.x + ' ' + a.y + ') rotate(' + a.deg + ')'" class="arrow"><path d="M0 -5.5V5.5M-3.2 2.2 0 5.5 3.2 2.2" /></g>
                }
              </g>
            </g>
          } @else {
            <!-- COMPARE: one variable, every model -->
            <g aria-hidden="true">
              @for (t of mainScale().ticks; track t) {
                <line [attr.x1]="geo().left" [attr.x2]="geo().left + geo().plotW" [attr.y1]="yMain()(t)" [attr.y2]="yMain()(t)" class="grid" />
                <text [attr.x]="geo().left - 6" [attr.y]="yMain()(t) + 4" class="tick" text-anchor="end">{{ tick(t, mainScale().step) }}</text>
              }
              <text [attr.x]="geo().left - 6" [attr.y]="geo().main.top - 1" class="unit" text-anchor="end">{{ compareUnit() }}</text>
              <g clip-path="url(#clip-plot)">
                @for (l of modelLines(); track l.id) {
                  <path [attr.d]="l.d" class="line model" [class.ai]="l.ai" [style.stroke]="l.color" />
                }
              </g>
            </g>
          }

          <!-- hours along the bottom -->
          <g aria-hidden="true">
            @for (h of hourLabels(); track h.x) { <text [attr.x]="h.x" [attr.y]="geo().axisY" class="tick" text-anchor="middle">{{ h.text }}</text> }
          </g>

          <!-- now, and the time on the map's bar -->
          @if (nowX(); as nx) {
            <line [attr.x1]="nx" [attr.x2]="nx" [attr.y1]="geo().top - 2" [attr.y2]="plotBottom()" class="now-line" />
          }
          @if (mapX(); as mx) {
            <g aria-hidden="true">
              <line [attr.x1]="mx" [attr.x2]="mx" [attr.y1]="geo().top - 4" [attr.y2]="plotBottom()" class="map-line" />
              <path [attr.d]="'M' + (mx - 5) + ' ' + (geo().top - 6) + 'h10l-5 6z'" class="map-flag" />
            </g>
          }

          <!-- the hour under the pointer -->
          @if (cursor(); as c) {
            <g aria-hidden="true">
              <line [attr.x1]="c.x" [attr.x2]="c.x" [attr.y1]="geo().top - 4" [attr.y2]="plotBottom()" class="cursor-line" />
              @for (d of c.dots; track d.key) { <circle [attr.cx]="c.x" [attr.cy]="d.y" r="3.6" class="dot" [style.fill]="d.color" /> }
            </g>
          }

          <rect class="hit" [attr.x]="geo().left" y="0" [attr.width]="geo().plotW" [attr.height]="geo().h"
            (pointermove)="onMove($event)" (pointerdown)="onDown($event)" (pointerup)="onUp($event)" (pointercancel)="onUp($event)" (pointerleave)="onLeave($event)" />
        </svg>
        <div class="sr-only">
          <table>
            <caption>Daily summary for {{ modelName() }}</caption>
            <thead><tr><th>Day</th><th>Highest</th><th>Lowest</th><th>Rain</th><th>Strongest gust</th></tr></thead>
            <tbody>
              @for (d of dailyTable(); track d.day) { <tr><td>{{ d.day }}</td><td>{{ d.high }}</td><td>{{ d.low }}</td><td>{{ d.rain }}</td><td>{{ d.gust }}</td></tr> }
            </tbody>
          </table>
        </div>
      } @else {
        <p class="empty">No hours of this forecast fall in the chosen days.</p>
      }
    </div>
  `,
  styles: [`
    :host { display: block; height: var(--chart-h, 230px); min-width: 0; }
    .frame { position: relative; width: 100%; height: 100%; }
    .svg { display: block; overflow: visible; touch-action: pan-y; user-select: none; -webkit-user-select: none; }
    .empty { padding: var(--sp-4); color: var(--text-muted); font-size: var(--fs-m); }

    text { font-family: var(--font-body); fill: var(--text-muted); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
    .unit { font-weight: var(--fw-strong); fill: var(--text-secondary); }
    .temp-tick { fill: var(--s-temp); }
    .rain-tick { fill: var(--s-rain); }
    .wind-tick { fill: var(--s-wind); }
    .day-label { fill: var(--text-secondary); font-weight: var(--fw-strong); font-size: var(--fs-s); }
    .day-rain { fill: var(--s-rain); font-weight: var(--fw-strong); }
    .extreme { fill: var(--text-primary); font-weight: var(--fw-strong); font-size: var(--fs-s); paint-order: stroke; stroke: var(--surface-solid); stroke-width: 3px; stroke-linejoin: round; }
    .nights rect { fill: var(--s-night); }
    .day-line { stroke: var(--line-strong); stroke-width: 1; }
    .grid { stroke: var(--s-grid); stroke-width: 1; shape-rendering: crispEdges; }

    .line { fill: none; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
    .line.temp { stroke: var(--s-temp); stroke-width: 2.6; }
    .line.feels { stroke: var(--s-feels); stroke-width: 1.4; stroke-dasharray: 4 3; }
    .line.wind { stroke: var(--s-wind); }
    .line.gust { stroke: var(--s-gust); stroke-width: 1.2; stroke-dasharray: 3 3; }
    .gust-band { fill: var(--s-wind); fill-opacity: 0.2; }
    .line.model { stroke-width: 2.2; }
    .line.model.ai { stroke-dasharray: 6 3.5; }
    .bars { fill: var(--s-rain); fill-opacity: 0.8; }
    .cloud { fill: var(--text-primary); }
    .arrow path { fill: none; stroke: var(--text-secondary); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }

    .now-line { stroke: var(--text-secondary); stroke-width: 1; stroke-dasharray: 2 3; opacity: 0.75; }
    .map-line { stroke: var(--accent); stroke-width: 2; }
    .map-flag { fill: var(--accent); }
    .cursor-line { stroke: var(--text-primary); stroke-width: 1; opacity: 0.55; }
    .dot { stroke: var(--surface-solid); stroke-width: 1.5; }
    .hit { fill: transparent; cursor: crosshair; }

    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  `]
})
export class MeteogramChartComponent implements OnDestroy {
  readonly series = input.required<PointSeries>();
  readonly mode = input.required<'model' | 'compare'>();
  /** The model drawn in "model" mode (the one on the map). */
  readonly modelId = input.required<string>();
  readonly compareVar = input<CompareVar>('temp');
  /** The models drawn in "compare" mode. */
  readonly modelIds = input<readonly string[]>([]);
  readonly startMs = input.required<number>();
  readonly endMs = input.required<number>();
  /** The time on the map's bar. */
  readonly timeMs = input<number | null>(null);
  readonly nowMs = input<number>(Date.now());
  readonly units = input.required<Units>();
  /** The time under the pointer (shared with the readout). */
  readonly hover = input<number | null>(null);
  readonly hoverChange = output<number | null>();
  /** The visitor chose a time on the chart: the map's bar follows. */
  readonly pick = output<number>();

  private readonly frame = viewChild<ElementRef<HTMLElement>>('frame');
  private readonly svg = viewChild<ElementRef<SVGSVGElement>>('svg');
  private readonly size = signal({ w: 0, h: 0 });
  private stop: (() => void) | null = null;
  private dragging = false;

  constructor() {
    afterNextRender(() => {
      const el = this.frame()?.nativeElement;
      if (el) this.stop = observeSize(el, (w, h) => this.size.set({ w, h }));
    });
  }

  ngOnDestroy(): void {
    this.stop?.();
  }

  // ---- geometry ----------------------------------------------------------------------------------------------------
  protected readonly geo = computed<Geometry>(() => {
    const { w, h } = this.size();
    if (w < 40 || h < 60) return EMPTY;
    const compact = w < 560;
    const left = compact ? 34 : 44;
    // the rain scale stands at the right, so the model view keeps room for it; the comparison has no second scale
    const right = this.mode() === 'model' && !compact ? 44 : 10;
    const top = 24;
    const axis = 18;
    const plotW = Math.max(w - left - right, 10);
    const axisY = h - 3;
    const bottom = h - axis;
    if (this.mode() === 'compare') return { ...EMPTY, w, h, left, right, plotW, top, axisY, main: { top: top + 4, bottom }, compact };
    const gap = 16;
    const avail = bottom - top - gap;
    const aH = Math.round(avail * 0.6);
    const a = { top, bottom: top + aH };
    const b = { top: a.bottom + gap, bottom };
    return { ...EMPTY, w, h, left, right, plotW, top, axisY, a, b, compact };
  });

  /** The bottom of the lowest panel: where the vertical lines stop. */
  protected readonly plotBottom = computed(() => (this.mode() === 'compare' ? this.geo().main.bottom : this.geo().b.bottom));

  /** First and last hour of the series inside the chosen days. */
  protected readonly win = computed(() => windowIndexes(this.series().times, this.startMs(), this.endMs()));

  private readonly t0 = computed(() => {
    const w = this.win();
    return w ? this.series().times[w.from] : 0;
  });
  private readonly t1 = computed(() => {
    const w = this.win();
    return w ? this.series().times[w.to] : 1;
  });
  private readonly pxPerHour = computed(() => this.geo().plotW / Math.max((this.t1() - this.t0()) / HOUR_MS, 1));

  /** Where a time falls along the plot. */
  private readonly xAt = computed(() => {
    const g = this.geo();
    const t0 = this.t0();
    const span = Math.max(this.t1() - t0, 1);
    return (ms: number): number => g.left + ((ms - t0) / span) * g.plotW;
  });

  // ---- units ---------------------------------------------------------------------------------------------------------
  private readonly conv = computed(() => {
    const u = this.units();
    return {
      temp: (c: number) => tempFromC(c, u.temp),
      rain: (mm: number) => rainFromMm(mm, u.rain),
      wind: (ms: number) => windFromMs(ms, u.wind),
      pressure: (hpa: number) => pressureFromHpa(hpa, u.pressure),
    };
  });
  protected readonly rainUnit = computed(() => RAIN_LABEL[this.units().rain]);
  protected readonly windUnit = computed(() => WIND_LABEL[this.units().wind]);

  protected tick(v: number, step: number): string {
    return tickText(v, step);
  }

  /** The hours of the window of one series, in display units, as chart points on `x`. */
  private points(series: Series, convert: (v: number) => number, y: (v: number) => number): Pt[] {
    const w = this.win();
    if (!w) return [];
    const times = this.series().times;
    const x = this.xAt();
    const out: Pt[] = [];
    for (let i = w.from; i <= w.to; i++) {
      const v = series[i];
      out.push({ x: x(times[i]), y: v === null ? null : y(convert(v)) });
    }
    return out;
  }

  private values(series: Series, convert: (v: number) => number): (number | null)[] {
    const w = this.win();
    if (!w) return [];
    return series.slice(w.from, w.to + 1).map(v => (v === null ? null : convert(v)));
  }

  private readonly model = computed(() => this.series().models[this.modelId()]);

  // ---- model mode: temperature ---------------------------------------------------------------------------------------
  /** The temperature line has the panel above its rain bars: the bars climb the lower half at most. */
  private readonly tempBand = computed(() => {
    const g = this.geo();
    return { top: g.a.top + 14, bottom: g.a.bottom - 8 };
  });
  protected readonly tempScale = computed(() => {
    const m = this.model();
    const c = this.conv();
    const e = extent([...this.values(m.temp, c.temp), ...this.values(m.feels, c.temp)]);
    const band = this.tempBand();
    return niceScale(e?.min ?? 20, e?.max ?? 30, { minSpan: this.units().temp === 'F' ? 9 : 5, count: tickCount(band.bottom - band.top) });
  });
  protected readonly yTemp = computed(() => {
    const band = this.tempBand();
    const s = this.tempScale();
    return linear(s.min, s.max, band.bottom, band.top);
  });
  protected readonly tempLine = computed(() => linePath(this.points(this.model().temp, this.conv().temp, this.yTemp())));
  protected readonly feelsLine = computed(() => linePath(this.points(this.model().feels, this.conv().temp, this.yTemp())));
  protected readonly tempArea = computed(() => areaPath(this.points(this.model().temp, this.conv().temp, this.yTemp()), this.tempBand().bottom));

  /** The highest and lowest temperature of each day, written beside the line where there is room. */
  protected readonly tempExtremes = computed(() => {
    const w = this.win();
    if (!w || this.mode() !== 'model') return [];
    const times = this.series().times;
    const x = this.xAt();
    const y = this.yTemp();
    const c = this.conv().temp;
    const t = this.model().temp;
    const out: { key: string; x: number; y: number; text: string }[] = [];
    for (const d of daySpans(this.startMs(), this.endMs())) {
      if (x(d.toMs) - x(d.fromMs) < 64) continue;
      let hi = -1;
      let lo = -1;
      for (let i = w.from; i <= w.to; i++) {
        if (times[i] < d.fromMs || times[i] >= d.toMs || t[i] === null) continue;
        if (hi < 0 || (t[i] as number) > (t[hi] as number)) hi = i;
        if (lo < 0 || (t[i] as number) < (t[lo] as number)) lo = i;
      }
      if (hi < 0 || lo < 0 || hi === lo) continue;
      const text = (i: number) => `${Math.round(c(t[i] as number))}°`;
      out.push({ key: `h${d.startMs}`, x: x(times[hi]), y: y(c(t[hi] as number)) - 7, text: text(hi) });
      out.push({ key: `l${d.startMs}`, x: x(times[lo]), y: y(c(t[lo] as number)) + 15, text: text(lo) });
    }
    return out;
  });

  // ---- model mode: rain and cloud ------------------------------------------------------------------------------------
  /** The rain's own scale: zero at the floor of the temperature panel, the top of the scale half way up. */
  private readonly rainBase = computed(() => this.geo().a.bottom - CLOUD_STRIP - 4);
  private readonly rainZone = computed(() => Math.min((this.geo().a.bottom - this.geo().a.top) * RAIN_ZONE, 64));
  protected readonly rainScale = computed(() => {
    const e = extent(this.values(this.model().rain, this.conv().rain));
    const inches = this.units().rain === 'in';
    return niceScale(0, e?.max ?? 0, { zeroBased: true, minSpan: inches ? 0.08 : 2, count: 2 });
  });
  protected readonly yRain = computed(() => {
    const s = this.rainScale();
    return linear(s.min, s.max, this.rainBase(), this.rainBase() - this.rainZone());
  });
  /** The labels of the rain scale, at the right of the panel. */
  protected readonly rainAxis = computed(() => {
    const s = this.rainScale();
    const y = this.yRain();
    return s.ticks.map(v => ({ v, y: y(v), text: tickText(v, s.step) }));
  });
  protected readonly rainBars = computed(() => {
    const px = this.pxPerHour();
    const w = this.win();
    if (!w) return '';
    const times = this.series().times;
    const x = this.xAt();
    const y = this.yRain();
    const c = this.conv().rain;
    const rain = this.model().rain;
    // a bar covers the hour BEFORE its time, which is what the models report
    const pts: Pt[] = [];
    for (let i = w.from; i <= w.to; i++) pts.push({ x: x(times[i]) - px / 2, y: rain[i] === null ? null : y(c(rain[i] as number)) });
    return barsPath(pts, this.rainBase(), Math.max(px - 0.8, 0.8));
  });
  /** The cloud cover as four strips of different strength (one path each, so 240 hours stay four elements). */
  protected readonly cloudBuckets = computed(() => {
    const w = this.win();
    if (!w) return [];
    const times = this.series().times;
    const x = this.xAt();
    const px = this.pxPerHour();
    const cloud = this.model().cloud;
    const g = this.geo();
    const y0 = g.a.bottom - CLOUD_STRIP;
    const y1 = g.a.bottom;
    const parts: string[][] = [[], [], [], []];
    for (let i = w.from; i <= w.to; i++) {
      const v = cloud[i];
      if (v === null || v < 8) continue;
      const bucket = Math.min(3, Math.floor(v / 25));
      const x0 = x(times[i]) - px / 2;
      parts[bucket].push(`M${x0.toFixed(1)} ${y0}h${px.toFixed(1)}V${y1}h-${px.toFixed(1)}Z`);
    }
    return parts.map((p, k) => ({ opacity: [0.2, 0.36, 0.55, 0.78][k], d: p.join('') })).filter(b => b.d);
  });

  // ---- model mode: wind ----------------------------------------------------------------------------------------------
  private readonly windBand = computed(() => {
    const g = this.geo();
    return { top: g.b.top + ARROW_BAND + 6, bottom: g.b.bottom - 3 };
  });
  protected readonly windScale = computed(() => {
    const m = this.model();
    const c = this.conv().wind;
    const e = extent([...this.values(m.wind, c), ...this.values(m.gust, c)]);
    const u = this.units().wind;
    const band = this.windBand();
    return niceScale(0, e?.max ?? 0, { zeroBased: true, minSpan: { kmh: 12, ms: 4, mph: 8, kn: 6, bft: 4 }[u], count: tickCount(band.bottom - band.top), integer: u === 'bft' });
  });
  protected readonly yWind = computed(() => {
    const band = this.windBand();
    const s = this.windScale();
    return linear(s.min, s.max, band.bottom, band.top);
  });
  protected readonly windLine = computed(() => linePath(this.points(this.model().wind, this.conv().wind, this.yWind())));
  protected readonly gustLine = computed(() => linePath(this.points(this.model().gust, this.conv().wind, this.yWind())));
  protected readonly gustBand = computed(() => bandPath(this.points(this.model().gust, this.conv().wind, this.yWind()), this.points(this.model().wind, this.conv().wind, this.yWind())));
  /** Arrows showing where the wind blows to, spaced to keep clear of each other. */
  protected readonly arrows = computed(() => {
    const w = this.win();
    if (!w) return [];
    const k = everyNth(this.pxPerHour(), 26);
    const times = this.series().times;
    const x = this.xAt();
    const dir = this.model().windDir;
    const wind = this.model().wind;
    const y = this.geo().b.top + 8;
    const out: { x: number; y: number; deg: number }[] = [];
    // anchored on the IST hour of the day, so the arrows keep their place when the window moves
    for (let i = w.from; i <= w.to; i++) {
      if (dir[i] === null || wind[i] === null) continue;
      if (new Date(times[i] + 5.5 * HOUR_MS).getUTCHours() % k !== 0) continue;
      out.push({ x: x(times[i]), y, deg: dir[i] as number });   // the arrow points the way the wind blows: down for a wind from the north
    }
    return out;
  });

  // ---- compare mode ---------------------------------------------------------------------------------------------------
  protected readonly compareUnit = computed(() => {
    const u = this.units();
    switch (this.compareVar()) {
      case 'temp': return TEMP_LABEL[u.temp];
      case 'rain': return `${RAIN_LABEL[u.rain]} in all`;
      case 'wind': return WIND_LABEL[u.wind];
      case 'pressure': return PRESSURE_LABEL[u.pressure];
    }
  });

  /** For the variable on show, each model's hours in display units. */
  private readonly compareSeries = computed(() => {
    const w = this.win();
    const s = this.series();
    const c = this.conv();
    const v = this.compareVar();
    if (!w) return [];
    return this.modelIds()
      .filter(id => s.models[id])
      .map(id => {
        const m = s.models[id];
        const raw: Series = v === 'temp' ? m.temp : v === 'wind' ? m.wind : v === 'pressure' ? m.pressure : [];
        let hours: Series;
        if (v === 'rain') {
          // the rain added up from the first hour of the window: the way to see which model is the wetter
          const run = cumulative(m.rain, w.from, w.to);
          hours = [...new Array<number | null>(w.from).fill(null), ...run];
        } else {
          hours = raw;
        }
        const convert = v === 'temp' ? c.temp : v === 'wind' ? c.wind : v === 'pressure' ? c.pressure : c.rain;
        return { id, hours, convert };
      });
  });

  protected readonly mainScale = computed(() => {
    const w = this.win();
    const all: (number | null)[] = [];
    for (const s of this.compareSeries()) all.push(...(w ? s.hours.slice(w.from, w.to + 1).map(v => (v === null ? null : s.convert(v))) : []));
    const e = extent(all);
    const v = this.compareVar();
    const u = this.units();
    const spans = { temp: u.temp === 'F' ? 9 : 5, rain: u.rain === 'in' ? 0.2 : 5, wind: { kmh: 12, ms: 4, mph: 8, kn: 6, bft: 4 }[u.wind], pressure: { hPa: 4, inHg: 0.12, mmHg: 3 }[u.pressure] };
    const g = this.geo();
    return niceScale(e?.min ?? 0, e?.max ?? 1, { zeroBased: v === 'rain' || v === 'wind', minSpan: spans[v], count: tickCount(g.main.bottom - g.main.top), integer: v === 'wind' && u.wind === 'bft' });
  });
  protected readonly yMain = computed(() => {
    const g = this.geo();
    const s = this.mainScale();
    return linear(s.min, s.max, g.main.bottom, g.main.top + 8);
  });
  protected readonly modelLines = computed(() => {
    const y = this.yMain();
    return this.compareSeries().map(s => {
      const def = pointModelById(s.id);
      return { id: s.id, ai: def.ai, color: modelColor(s.id), d: linePath(this.points(s.hours, s.convert, y)) };
    });
  });

  // ---- shared frame: days, nights, hours, now -------------------------------------------------------------------------
  /** The day names across the top; with room, each carries the rain of the day (model view). */
  protected readonly days = computed(() => {
    const x = this.xAt();
    const g = this.geo();
    const w = this.win();
    const times = this.series().times;
    const rain = this.model()?.rain;
    const showRain = this.mode() === 'model' && !!w && !!rain;
    const out: { key: number; line: number | null; center: number; label: string; rain: string }[] = [];
    for (const d of daySpans(this.startMs(), this.endMs())) {
      const from = x(Math.max(d.fromMs, this.t0()));
      const to = x(Math.min(d.toMs, this.t1()));
      const width = to - from;
      const full = dayFmt({ weekday: 'short', day: 'numeric' }).format(d.startMs + 12 * HOUR_MS);
      const narrow = dayFmt({ weekday: 'narrow', day: 'numeric' }).format(d.startMs + 12 * HOUR_MS);
      let dayRain = '';
      if (showRain && width >= 120) {
        let sum = 0;
        for (let i = w!.from; i <= w!.to; i++) if (times[i] > d.fromMs && times[i] <= d.toMs && rain![i] !== null) sum += rain![i] as number;
        if (sum >= 0.5) dayRain = formatRain(sum, this.units());
      }
      out.push({ key: d.startMs, line: d.startMs > this.t0() && d.startMs < this.t1() ? x(d.startMs) : null, center: (from + to) / 2, label: width >= 62 ? full : width >= 30 ? narrow : '', rain: dayRain });
    }
    return g.plotW > 0 ? out : [];
  });

  protected readonly nights = computed(() => {
    const x = this.xAt();
    const place = this.series();
    return nightSpans(place.lat, place.lon, this.t0(), this.t1()).map(n => ({ x: x(n.fromMs), w: x(n.toMs) - x(n.fromMs) }));
  });

  protected readonly hourLabels = computed(() => {
    const w = this.win();
    if (!w) return [];
    const x = this.xAt();
    const px = this.pxPerHour();
    const every = px * 6 >= 40 ? 6 : px * 12 >= 40 ? 12 : 0;
    if (!every) return [];
    const out: { x: number; text: string }[] = [];
    const first = Math.ceil((this.t0() + 5.5 * HOUR_MS) / (every * HOUR_MS)) * every * HOUR_MS - 5.5 * HOUR_MS;
    for (let t = first; t <= this.t1(); t += every * HOUR_MS) {
      const text = istHour12(t);
      if (text === '12 AM') continue;                       // the day line is there
      out.push({ x: x(t), text: every === 12 ? text.replace(' ', '') : text });
    }
    return out;
  });

  protected readonly nowX = computed(() => {
    const now = this.nowMs();
    return now >= this.t0() && now <= this.t1() ? this.xAt()(now) : null;
  });
  protected readonly mapX = computed(() => {
    const t = this.timeMs();
    return t !== null && t >= this.t0() && t <= this.t1() ? this.xAt()(t) : null;
  });

  // ---- the pointer -----------------------------------------------------------------------------------------------------
  /** The crosshair and a dot on every line at the hour under the pointer. */
  protected readonly cursor = computed(() => {
    const ms = this.hover();
    const w = this.win();
    if (ms === null || !w) return null;
    const times = this.series().times;
    const i = Math.min(Math.max(indexAt(times, ms), w.from), w.to);
    const x = this.xAt()(times[i]);
    const dots: { key: string; y: number; color: string }[] = [];
    const c = this.conv();
    if (this.mode() === 'model') {
      const m = this.model();
      if (m.temp[i] !== null) dots.push({ key: 'temp', y: this.yTemp()(c.temp(m.temp[i] as number)), color: 'var(--s-temp)' });
      if (m.wind[i] !== null) dots.push({ key: 'wind', y: this.yWind()(c.wind(m.wind[i] as number)), color: 'var(--s-wind)' });
    } else {
      for (const s of this.compareSeries()) {
        const v = s.hours[i];
        if (v !== null && v !== undefined) dots.push({ key: s.id, y: this.yMain()(s.convert(v)), color: modelColor(s.id) });
      }
    }
    return { x, dots };
  });

  private timeAt(event: PointerEvent): number | null {
    const el = this.svg()?.nativeElement;
    const w = this.win();
    if (!el || !w) return null;
    const rect = el.getBoundingClientRect();
    const g = this.geo();
    const i = hourAtX(event.clientX - rect.left, g.left, g.left + g.plotW, w.to - w.from + 1);
    return this.series().times[w.from + i];
  }

  protected onMove(event: PointerEvent): void {
    const t = this.timeAt(event);
    if (t === null) return;
    this.hoverChange.emit(t);
    if (this.dragging) this.pick.emit(t);
  }

  protected onDown(event: PointerEvent): void {
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    this.dragging = true;
    const t = this.timeAt(event);
    if (t === null) return;
    this.hoverChange.emit(t);
    this.pick.emit(t);
  }

  protected onUp(event: PointerEvent): void {
    this.dragging = false;
    (event.currentTarget as Element).releasePointerCapture?.(event.pointerId);
  }

  protected onLeave(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && !this.dragging) this.hoverChange.emit(null);
  }

  // ---- for people who cannot see it ----------------------------------------------------------------------------------
  protected readonly modelName = computed(() => forecastModelById(this.modelId()).label);

  protected readonly summary = computed(() => {
    const w = this.win();
    if (!w) return 'No data for the chosen days.';
    const u = this.units();
    if (this.mode() === 'compare') {
      const what = { temp: 'Temperature', rain: 'Rain added up', wind: 'Wind speed', pressure: 'Sea level pressure' }[this.compareVar()];
      return `${what}, ${this.modelIds().map(id => pointModelById(id).label).join(', ')}.`;
    }
    const m = this.model();
    const t = extent(m.temp.slice(w.from, w.to + 1));
    const g = extent(m.gust.slice(w.from, w.to + 1));
    const rain = sumFrom(m.rain, w.from, w.to - w.from + 1);
    const parts = [`Hourly forecast, ${this.modelName()}.`];
    if (t) parts.push(`Temperature ${formatTemp(t.min, u)} to ${formatTemp(t.max, u)}.`);
    if (rain !== null) parts.push(`Rain ${formatRain(rain, u)} in total.`);
    if (g) parts.push(`Strongest gust ${formatWind(g.max, u)}.`);
    return parts.join(' ');
  });

  protected readonly dailyTable = computed(() => {
    const w = this.win();
    if (!w || this.mode() !== 'model') return [];
    const times = this.series().times;
    const m = this.model();
    const u = this.units();
    return daySpans(this.startMs(), this.endMs()).map(d => {
      const idx: number[] = [];
      for (let i = w.from; i <= w.to; i++) if (times[i] >= d.fromMs && times[i] < d.toMs) idx.push(i);
      const t = extent(idx.map(i => m.temp[i]));
      const g = extent(idx.map(i => m.gust[i]));
      const rain = idx.reduce((s, i) => s + (m.rain[i] ?? 0), 0);
      return {
        day: dayFmt({ weekday: 'long', day: 'numeric', month: 'long' }).format(d.startMs + 12 * HOUR_MS),
        high: t ? formatTemp(t.max, u) : '–',
        low: t ? formatTemp(t.min, u) : '–',
        rain: formatRain(rain, u),
        gust: g ? formatWind(g.max, u) : '–',
      };
    });
  });
}
