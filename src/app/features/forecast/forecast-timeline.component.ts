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

/** Hour of the day in IST, shown on the time bar as "12 AM", "6 AM", "12 PM", "6 PM". */
export function istHourLabel(ms: number): string {
  const h = new Date(ms + IST_OFFSET_MS).getUTCHours();
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Whether an IST day (given by its midnight) is a Saturday or a Sunday: weekends are written in amber on the bar, as on windy.com. */
export function isWeekendIst(dayStartMs: number): boolean {
  const d = new Date(dayStartMs + IST_OFFSET_MS + 12 * HOUR_MS).getUTCDay();
  return d === 0 || d === 6;
}

/** The names of an IST day in three lengths, for the widths a block can have: "Monday 12", "Mon 12", "M 12". */
export function dayNames(ms: number): { long: string; mid: string; short: string } {
  const at = (opt: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-IN', { timeZone: IST, ...opt }).format(ms);
  const date = at({ day: 'numeric' });
  return { long: `${at({ weekday: 'long' })} ${date}`, mid: `${at({ weekday: 'short' })} ${date}`, short: `${at({ weekday: 'narrow' })} ${date}` };
}

/**
 * The bar along the bottom, after windy.com and meteoblue: a play button, then the days as blocks (their names as long as they fit, weekends
 * in amber), the time already passed dimmed, and an amber tooltip with the time on the playhead. A dot on a day means its steps are further
 * apart (every 6 h, not every 3 h). With the rain accumulation layer the bar carries the chosen period instead: a white stretch with a handle
 * at each end.
 */
@Component({
  selector: 'app-forecast-timeline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    @if (state.forecastActive() && range(); as r) {
      <section class="bar" aria-label="Forecast timeline">
        <button type="button" class="play" (click)="state.togglePlay()" [attr.aria-label]="state.playing() ? 'Pause' : 'Play'" [attr.aria-pressed]="state.playing()" [title]="state.playing() ? 'Pause (Space)' : 'Play (Space)'">
          <app-icon [name]="state.playing() ? 'pause' : 'play'" [size]="26" />
        </button>

        <div class="track" #track>
          <div class="blocks" aria-hidden="true">
            @for (d of dayBlocks(); track d.ms; let odd = $odd) {
              <div class="block" [class.odd]="odd" [class.weekend]="d.weekend" [style.left.%]="d.pct" [style.width.%]="d.width">
                <span class="day"><span class="long">{{ d.names.long }}</span><span class="mid">{{ d.names.mid }}</span><span class="short">{{ d.names.short }}</span></span>
                @if (d.coarse) { <span class="dot" title="Steps every 6 hours on this day"></span> }
                @for (t of d.ticks; track t) { <span class="tick" [style.left.%]="t"></span> }
              </div>
            }
            <div class="past" [style.width.%]="nowPct()"></div>
          </div>

          @if (period(); as p) {
            <!-- rain accumulation: the white stretch is the period; drag its ends, or the stretch itself -->
            <div class="selection" [style.left.%]="p.fromPct" [style.width.%]="p.toPct - p.fromPct" (pointerdown)="beginDrag($event, 'move', track)" title="Drag to move the period"></div>
            <div class="handle start" [style.left.%]="p.fromPct" (pointerdown)="beginDrag($event, 'start', track)" role="slider" aria-label="Start of the period" [attr.aria-valuetext]="p.fromLabel">
              <span class="tip">{{ p.fromLabel }}</span>
            </div>
            <div class="handle end" [style.left.%]="p.toPct" (pointerdown)="beginDrag($event, 'end', track)" role="slider" aria-label="End of the period" [attr.aria-valuetext]="p.toLabel">
              <span class="tip">{{ p.toLabel }} ({{ p.hours }}h)</span>
            </div>
          } @else {
            @if (thumbPct() >= 0) {
              <div class="playhead" aria-hidden="true" [style.--pct]="thumbPct()">
                <span class="tip" [title]="lead() ?? ''">{{ shortLabel() }}</span>
              </div>
            }
            <input
              type="range" aria-label="Forecast time" [attr.aria-valuetext]="timeLabel() + ', ' + (lead() ?? '')"
              [min]="r.start" [max]="r.end" step="600000"
              [value]="state.timeMs() ?? r.start"
              (input)="onScrub($event)"
            />
          }
        </div>

        <div class="tail">
          <button type="button" class="step" (click)="state.stepHours(-1)" aria-label="Back one hour" title="Back 1 h (←)"><app-icon name="chevron" [size]="16" class="left" /></button>
          <button type="button" class="step" (click)="state.stepHours(1)" aria-label="Forward one hour" title="Forward 1 h (→)"><app-icon name="chevron" [size]="16" class="right" /></button>
          <button type="button" class="speed" (click)="cycleSpeed()" [attr.aria-label]="'Playback speed: ' + state.speed() + ' hours per second. Change speed'" title="Playback speed">{{ state.speed() }}×</button>
        </div>
      </section>
    }
  `,
  styles: [`
    :host { display: contents; }
    .bar {
      position: fixed; left: 0; right: 0; bottom: var(--legend-h); height: var(--timeline-h); z-index: 900; display: flex; align-items: stretch;
      background: var(--surface-1); box-shadow: 0 -1px 0 var(--line);
    }
    .play { flex: none; width: 54px; border: 0; background: transparent; color: var(--accent-strong); cursor: pointer; display: grid; place-items: center; transition: transform var(--t-fast), color var(--t-fast); }
    .play:hover { color: var(--text-primary); transform: scale(1.08); }
    .track { position: relative; flex: 1; min-width: 0; }
    .blocks { position: absolute; inset: 0; overflow: hidden; }
    .block { position: absolute; top: 0; bottom: 0; container-type: inline-size; background: rgba(255, 255, 255, 0.06); border-left: 1px solid var(--line-strong); display: grid; place-items: center; }
    .block.odd { background: rgba(255, 255, 255, 0.12); }
    :host-context(:root[data-theme='light']) .block { background: rgba(20, 40, 70, 0.04); }
    :host-context(:root[data-theme='light']) .block.odd { background: rgba(20, 40, 70, 0.09); }
    .day { font-size: 14px; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; max-width: 100%; padding: 0 4px; text-shadow: var(--text-halo); }
    .block.weekend .day { color: var(--text-secondary); }
    .day .long, .day .mid { display: none; }
    @container (max-width: 26px) { .day { display: none; } }          /* a sliver of a day (the run starts late in it): no label */
    @container (min-width: 64px) { .day .short { display: none; } .day .mid { display: inline; } }
    @container (min-width: 124px) { .day .mid { display: none; } .day .long { display: inline; } }
    .dot { position: absolute; top: 4px; right: 4px; width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35); }
    .tick { position: absolute; bottom: 0; width: 1px; height: 6px; background: var(--line-strong); }
    .past { position: absolute; inset: 0 auto 0 0; background: rgba(0, 0, 0, 0.28); pointer-events: none; }

    /* the playhead: an accent line and the tooltip with the time, rising out of the bar */
    .playhead { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; left: calc(var(--pct) * 1%); background: var(--accent); pointer-events: none; }
    .playhead .tip {
      position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); padding: 4px 12px 3px; border-radius: 9px 9px 0 0; background: var(--accent); color: var(--on-accent);
      font-size: 15px; font-weight: 650; white-space: nowrap; font-variant-numeric: tabular-nums; box-shadow: 0 0 4px rgba(0, 0, 0, 0.6);
    }
    input[type=range] { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; touch-action: none; }
    .track:has(input:focus-visible) { outline: 2px solid var(--accent-strong); outline-offset: -2px; }

    /* rain accumulation: the chosen period on the bar (white, with a handle at each end and the times above them) */
    .selection { position: absolute; top: 0; height: 10px; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5); cursor: grab; touch-action: none; }   /* a white strip along the top of the bar, so the day names stay readable */
    .handle { position: absolute; top: 0; bottom: 0; width: 24px; margin-left: -12px; cursor: ew-resize; touch-action: none; }
    .handle::before { content: ''; position: absolute; left: 11px; top: 0; bottom: 0; width: 3px; background: var(--accent); }
    .handle .tip {
      position: absolute; bottom: 100%; padding: 4px 10px 3px; background: var(--accent); color: var(--on-accent); font-size: 14px; font-weight: 650; white-space: nowrap;
      box-shadow: 0 0 4px rgba(0, 0, 0, 0.6); pointer-events: none;
    }
    .handle.start .tip { right: 12px; border-radius: 9px 0 0 0; }          /* the start time sits left of its handle, the end time right of its own */
    .handle.end .tip { left: 12px; border-radius: 0 9px 0 0; }

    .tail { flex: none; display: flex; align-items: center; gap: 2px; padding: 0 8px 0 6px; }
    .step { width: 30px; height: 30px; display: grid; place-items: center; border: 0; border-radius: 50%; background: transparent; color: var(--text-secondary); cursor: pointer; }
    .step:hover { background: var(--surface-3); color: var(--text-primary); }
    .step .left { transform: rotate(90deg); }
    .step .right { transform: rotate(-90deg); }
    .speed { min-width: max(36px, var(--hit)); height: max(26px, calc(var(--hit) - 8px)); padding: 0 6px; border: 1px solid var(--line); border-radius: 13px; background: transparent; color: var(--text-secondary); font-size: 12px; font-weight: 650; cursor: pointer; font-variant-numeric: tabular-nums; }
    .speed:hover { background: var(--surface-3); color: var(--text-primary); }

    @media (max-width: 700px) {
      .play { width: 44px; }
      .day { font-size: 12px; }
      .playhead .tip { font-size: 13px; padding: 3px 9px 2px; }
      .tail .step { display: none; }
      .tail { padding: 0 6px 0 2px; }
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

  /** The playhead tooltip: day, number and hour ("Thu 15 · 11 AM"). */
  protected readonly shortLabel = computed(() => {
    const t = this.state.timeMs();
    if (t === null) return '';
    const day = new Intl.DateTimeFormat('en-IN', { timeZone: IST, weekday: 'short', day: 'numeric' }).format(t);
    return `${day} · ${istHourLabel(t)}`;
  });

  /** Lead time of the model run ("T+06 h"), when the run id is known. */
  protected readonly lead = computed(() => {
    const t = this.state.timeMs();
    const run = runStartMs(this.catalog.runLabel());
    return t === null || run === null ? null : leadTimeLabel(t, run);
  });

  /** Where "now" is on the track, in percent (clamped to the run). */
  protected readonly nowPct = computed(() => {
    const r = this.range();
    this.state.timeMs(); // re-evaluated as the time moves, so the dimmed part follows the clock
    return r ? Math.min(Math.max(((Date.now() - r.start) / (r.end - r.start)) * 100, 0), 100) : 0;
  });

  /** Where the playhead is, in percent of the run (-1 when there is no time yet). */
  protected readonly thumbPct = computed(() => {
    const r = this.range();
    const t = this.state.timeMs();
    return r && t !== null ? Math.min(Math.max(((t - r.start) / (r.end - r.start)) * 100, 0), 100) : -1;
  });

  /** One block per IST day inside the run, with a tick every 6 hours; a day whose steps are 6 h apart or more is marked. */
  protected readonly dayBlocks = computed(() => {
    const r = this.range();
    if (!r) return [];
    const span = r.end - r.start;
    const valid = this.catalog.validTimes();
    const blocks: { ms: number; pct: number; width: number; names: ReturnType<typeof dayNames>; weekend: boolean; coarse: boolean; ticks: number[] }[] = [];
    let ms = Math.floor((r.start + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS; // the IST midnight at or before the run's start
    for (; ms < r.end; ms += DAY_MS) {
      const from = Math.max(ms, r.start);
      const to = Math.min(ms + DAY_MS, r.end);
      // ticks inside the block, as a percent of the block's own width
      const ticks: number[] = [];
      for (let k = 1; k < 4; k++) {
        const t = ms + k * 6 * HOUR_MS;
        if (t > from && t < to) ticks.push(((t - from) / (to - from)) * 100);
      }
      const inDay = valid.filter(t => t >= ms && t < ms + DAY_MS);
      const gap = inDay.length > 1 ? Math.max(...inDay.slice(1).map((t, i) => t - inDay[i])) : 0;
      blocks.push({
        ms,
        pct: ((from - r.start) / span) * 100,
        width: ((to - from) / span) * 100,
        names: dayNames(ms + 12 * HOUR_MS),
        weekend: isWeekendIst(ms),
        coarse: gap >= 6 * HOUR_MS,
        ticks,
      });
    }
    return blocks;
  });

  /** The chosen rain accumulation period on the track, or null when that layer is not on. */
  protected readonly period = computed(() => {
    const r = this.range();
    const from = this.state.rangeStartMs();
    const to = this.state.rangeEndMs();
    if (!r || from === null || to === null || this.state.activeLayerId() !== 'raintot') return null;
    const span = r.end - r.start;
    const fmt = new Intl.DateTimeFormat('en-IN', { timeZone: IST, weekday: 'short', day: 'numeric' });
    const label = (ms: number) => `${fmt.format(ms)} · ${istHourLabel(ms)}`;
    return {
      fromPct: ((from - r.start) / span) * 100,
      toPct: ((to - r.start) / span) * 100,
      fromLabel: label(from),
      toLabel: label(to),
      hours: Math.round((to - from) / HOUR_MS),
    };
  });

  /** Drags the start, the end, or the whole period along the track (the times snap to whole hours). */
  protected beginDrag(event: PointerEvent, part: 'start' | 'end' | 'move', track: HTMLElement): void {
    const r = this.range();
    const origin = { from: this.state.rangeStartMs(), to: this.state.rangeEndMs() };
    if (!r || origin.from === null || origin.to === null) return;
    event.preventDefault();
    const rect = track.getBoundingClientRect();
    const msAt = (clientX: number) => r.start + ((clientX - rect.left) / rect.width) * (r.end - r.start);
    const snap = (ms: number) => Math.round(ms / HOUR_MS) * HOUR_MS;
    const grabbed = msAt(event.clientX);
    const move = (e: PointerEvent) => {
      const ms = msAt(e.clientX);
      if (part === 'start') this.state.setRangeStart(snap(ms));
      else if (part === 'end') this.state.setRangeEnd(snap(ms));
      else {
        this.state.rangeStartMs.set(origin.from!);
        this.state.rangeEndMs.set(origin.to!);
        this.state.shiftRange(snap(ms - grabbed));
      }
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }

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
