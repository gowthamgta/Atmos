import { ChangeDetectionStrategy, Component, HostListener, computed, inject } from '@angular/core';
import { ForecastCatalogService } from '../../core/forecast/forecast-catalog.service';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';
import { IconComponent } from '../../shared/icon.component';

const IST = 'Asia/Kolkata';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const IST_OFFSET_MS = 5.5 * HOUR_MS;

/** Epoch ms of a run id like 20261010T00Z (null when it does not parse). */
export function runStartMs(run: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})?Z$/.exec(run);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], m[5] ? +m[5] : 0) : null;
}

/** "T+06 h" for the hours since the model run began. */
export function leadTimeLabel(timeMs: number, runMs: number): string {
  const h = Math.round((timeMs - runMs) / HOUR_MS);
  return `T${h < 0 ? '−' : '+'}${String(Math.abs(h)).padStart(2, '0')} h`;
}

/** Bottom timeline: step back / play / step forward, speed, a draggable track over the whole run with "now" and day marks (IST). */
@Component({
  selector: 'app-forecast-timeline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    @if (state.forecastActive() && range(); as r) {
      <section class="dock" aria-label="Forecast timeline">
        <div class="row">
          <div class="transport" role="group" aria-label="Playback">
            <button type="button" class="btn-icon" (click)="state.stepHours(-1)" aria-label="Back one hour" title="Back 1 h (←)"><app-icon name="prev" [size]="16" /></button>
            <button type="button" class="play" (click)="state.togglePlay()" [attr.aria-label]="state.playing() ? 'Pause' : 'Play'" [attr.aria-pressed]="state.playing()" [title]="state.playing() ? 'Pause (Space)' : 'Play (Space)'">
              <app-icon [name]="state.playing() ? 'pause' : 'play'" [size]="18" />
            </button>
            <button type="button" class="btn-icon" (click)="state.stepHours(1)" aria-label="Forward one hour" title="Forward 1 h (→)"><app-icon name="next" [size]="16" /></button>
          </div>

          <div class="readout" aria-live="off">
            <strong class="when">{{ timeLabel() }}</strong>
            <span class="chips">
              @if (lead(); as l) { <span class="chip lead" title="Hours since the model run began">{{ l }}</span> }
              <span class="chip phase" [class.past]="phase() === 'past'" [class.now]="phase() === 'now'">{{ phaseLabel() }}</span>
            </span>
          </div>

          <button type="button" class="speed" (click)="cycleSpeed()" [attr.aria-label]="'Playback speed: ' + state.speed() + ' hours per second. Change speed'" title="Playback speed">
            {{ state.speed() }}<small> h/s</small>
          </button>
        </div>

        <div class="track">
          <div class="rail" aria-hidden="true">
            <div class="past" [style.width.%]="nowPct()"></div>
            @if (nowPct() > 0 && nowPct() < 100) { <div class="now" [style.left.%]="nowPct()"><span>now</span></div> }
          </div>
          <input
            type="range" aria-label="Forecast time" [attr.aria-valuetext]="timeLabel() + ', ' + (lead() ?? '')"
            [min]="r.start" [max]="r.end" step="600000"
            [value]="state.timeMs() ?? r.start"
            [style.--pct]="thumbPct() + '%'"
            (input)="onScrub($event)"
          />
          <div class="days" aria-hidden="true">
            @for (d of dayMarks(); track d.ms) {
              <span class="day" [style.left.%]="d.pct">{{ d.label }}</span>
            }
          </div>
        </div>
      </section>
    }
  `,
  styles: [`
    :host { display: contents; }
    .dock {
      position: fixed; left: var(--gutter); right: 68px; bottom: var(--gutter); z-index: 900;
      padding: 8px 14px 6px; background: var(--surface-1); border: 1px solid var(--line); border-radius: var(--radius-l); box-shadow: var(--shadow-2);
      animation: sheet-in var(--t-med) both;
    }
    .row { display: flex; align-items: center; gap: 12px; }
    .transport { display: flex; align-items: center; gap: 6px; flex: none; }
    .play {
      width: 44px; height: 44px; border-radius: 50%; border: 1px solid var(--accent-line); background: var(--accent); color: var(--on-accent);
      display: grid; place-items: center; cursor: pointer; transition: transform var(--t-fast), filter var(--t-fast);
    }
    .play:hover { filter: brightness(1.1); }
    .play:active { transform: scale(0.94); }
    .readout { flex: 1; min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; }
    .when { font-size: 15px; font-weight: 650; letter-spacing: 0.005em; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .chips { display: inline-flex; gap: 6px; align-items: center; }
    .chip { font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface-3); color: var(--text-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .chip.lead { color: var(--model); border-color: color-mix(in srgb, var(--model) 45%, transparent); }
    .chip.phase.now { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 50%, transparent); }
    .chip.phase.past { color: var(--text-muted); }
    .speed { flex: none; min-width: 52px; height: 32px; padding: 0 8px; border-radius: var(--radius-m); border: 1px solid var(--line); background: var(--surface-3); color: var(--text-primary); font-weight: 650; font-size: 13px; cursor: pointer; font-variant-numeric: tabular-nums; }
    .speed small { font-weight: 500; color: var(--text-muted); font-size: 10px; }
    .speed:hover { background: var(--surface-4); }

    .track { position: relative; margin-top: 4px; height: 44px; }
    .rail { position: absolute; left: 0; right: 0; top: 14px; height: 6px; border-radius: 3px; background: var(--surface-4); }
    .rail .past { position: absolute; inset: 0 auto 0 0; border-radius: 3px 0 0 3px; background: var(--line-strong); }
    .rail .now { position: absolute; top: -5px; bottom: -5px; width: 2px; margin-left: -1px; background: var(--ok); }
    .rail .now span { position: absolute; top: 26px; left: 50%; transform: translateX(-50%); font-size: 9px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ok); }
    input[type=range] { position: absolute; inset: 4px 0 auto 0; width: 100%; height: 26px; margin: 0; background: transparent; appearance: none; -webkit-appearance: none; cursor: pointer; touch-action: none; }
    input[type=range]::-webkit-slider-runnable-track { height: 6px; border-radius: 3px; background: linear-gradient(90deg, var(--accent) var(--pct), transparent var(--pct)); }
    input[type=range]::-moz-range-track { height: 6px; border-radius: 3px; background: transparent; }
    input[type=range]::-moz-range-progress { height: 6px; border-radius: 3px; background: var(--accent); }
    input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 20px; height: 20px; margin-top: -7px; border-radius: 50%; background: var(--surface-1); border: 3px solid var(--accent); box-shadow: var(--shadow-1); }
    input[type=range]::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: var(--surface-1); border: 3px solid var(--accent); }
    input[type=range]:focus-visible { outline-offset: 4px; border-radius: 4px; }
    .days { position: absolute; left: 0; right: 0; bottom: 0; height: 14px; pointer-events: none; }
    .day { position: absolute; transform: translateX(-50%); font-size: 10px; color: var(--text-secondary); white-space: nowrap; }
    .day::before { content: ''; position: absolute; left: 50%; top: -6px; width: 1px; height: 5px; background: var(--text-muted); }

    @media (max-width: 700px) {
      .dock { right: var(--gutter); padding: 6px 10px 4px; }
      .row { gap: 8px; }
      .when { font-size: 13px; }
      .transport .btn-icon { width: 32px; height: 32px; }
      .play { width: 40px; height: 40px; }
      .speed { min-width: 44px; }
      .track { height: 40px; }
    }
  `]
})
export class ForecastTimelineComponent {
  protected readonly state = inject(ForecastStateService);
  private readonly catalog = inject(ForecastCatalogService);

  protected readonly range = computed(() => {
    const start = this.state.startMs();
    const end = this.state.endMs();
    return start !== null && end !== null && end > start ? { start, end } : null;
  });

  protected readonly timeLabel = computed(() => {
    const t = this.state.timeMs();
    if (t === null) return '';
    const day = new Intl.DateTimeFormat('en-IN', { timeZone: IST, weekday: 'short', day: 'numeric', month: 'short' }).format(t);
    const time = new Intl.DateTimeFormat('en-IN', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: false }).format(t);
    return `${day} · ${time} IST`;
  });

  /** Lead time of the model run ("T+06 h"), when the run id is known. */
  protected readonly lead = computed(() => {
    const t = this.state.timeMs();
    const run = runStartMs(this.catalog.runLabel());
    return t === null || run === null ? null : leadTimeLabel(t, run);
  });

  protected readonly phase = computed<'past' | 'now' | 'forecast'>(() => {
    const t = this.state.timeMs();
    if (t === null) return 'forecast';
    const d = t - Date.now();
    return Math.abs(d) < 0.5 * HOUR_MS ? 'now' : d < 0 ? 'past' : 'forecast';
  });

  protected readonly phaseLabel = computed(() => {
    const t = this.state.timeMs();
    if (t === null) return '';
    const hours = Math.round((t - Date.now()) / HOUR_MS);
    if (this.phase() === 'now') return 'Now';
    return hours > 0 ? `In ${hours} h` : `${-hours} h ago`;
  });

  /** Where "now" is on the track, in percent (clamped to the run). */
  protected readonly nowPct = computed(() => {
    const r = this.range();
    this.state.timeMs(); // re-evaluated as the time moves, so the marker follows the clock
    return r ? Math.min(Math.max(((Date.now() - r.start) / (r.end - r.start)) * 100, 0), 100) : 0;
  });

  protected readonly thumbPct = computed(() => {
    const r = this.range();
    const t = this.state.timeMs();
    return r && t !== null ? Math.min(Math.max(((t - r.start) / (r.end - r.start)) * 100, 0), 100) : 0;
  });

  /** One tick per IST midnight inside the run. */
  protected readonly dayMarks = computed(() => {
    const r = this.range();
    if (!r) return [];
    const fmt = new Intl.DateTimeFormat('en-IN', { timeZone: IST, weekday: 'short', day: 'numeric' });
    const marks: { ms: number; pct: number; label: string }[] = [];
    let ms = Math.ceil((r.start + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS; // first IST midnight
    for (; ms < r.end; ms += DAY_MS) marks.push({ ms, pct: ((ms - r.start) / (r.end - r.start)) * 100, label: fmt.format(ms) });
    return marks;
  });

  protected onScrub(event: Event): void {
    this.state.pause();
    this.state.setTime(Number((event.target as HTMLInputElement).value));
  }

  protected cycleSpeed(): void {
    const speeds = ForecastStateService.SPEEDS;
    const i = speeds.indexOf(this.state.speed() as (typeof speeds)[number]);
    this.state.setSpeed(speeds[(i + 1) % speeds.length]);
  }

  @HostListener('window:keydown', ['$event'])
  protected onKey(e: KeyboardEvent): void {
    if (!this.state.forecastActive() || this.catalog.status() !== 'ready') return;
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return; // inputs handle their own keys
    if (e.key === ' ' && !(target instanceof HTMLButtonElement)) {
      e.preventDefault();
      this.state.togglePlay();
    } else if (e.key === 'ArrowRight') {
      this.state.stepHours(e.shiftKey ? 24 : 1);
    } else if (e.key === 'ArrowLeft') {
      this.state.stepHours(e.shiftKey ? -24 : -1);
    }
  }
}
