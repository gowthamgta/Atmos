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

/**
 * Bottom time bar, after windy.com: step back / play / step forward, speed, and a track in day blocks (each IST day labelled,
 * with its 6-hourly ticks). The time already passed is dimmed, "now" is marked, and a tooltip shows the day and hour under the playhead.
 */
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
            @if (period(); as p) {
              <strong class="when">{{ p.fromLabel }} → {{ p.toLabel }}</strong>
              <span class="chips"><span class="chip lead" title="Length of the period of rain accumulation">{{ p.hours }} h of rain</span></span>
            } @else {
              <strong class="when">{{ timeLabel() }}</strong>
              <span class="chips">
                @if (lead(); as l) { <span class="chip lead" title="Hours since the model run began">{{ l }}</span> }
                <span class="chip phase" [class.past]="phase() === 'past'" [class.now]="phase() === 'now'">{{ phaseLabel() }}</span>
              </span>
            }
          </div>

          <button type="button" class="speed" (click)="cycleSpeed()" [attr.aria-label]="'Playback speed: ' + state.speed() + ' hours per second. Change speed'" title="Playback speed">
            {{ state.speed() }}<small> h/s</small>
          </button>
        </div>

        <div class="track" #track>
          <div class="blocks" aria-hidden="true">
            @for (d of dayBlocks(); track d.ms) {
              <div class="block" [style.left.%]="d.pct" [style.width.%]="d.width">
                <span class="day">{{ d.label }}</span>
                @for (t of d.ticks; track t.pct) {
                  <span class="tick" [style.left.%]="t.pct" [class.major]="t.major">
                    @if (t.major) { <span class="tick-label">{{ t.label }}</span> }
                  </span>
                }
              </div>
            }
          </div>
          <div class="rail" aria-hidden="true">
            <div class="past" [style.width.%]="nowPct()"></div>
            @if (nowPct() > 0 && nowPct() < 100) { <div class="now" [style.left.%]="nowPct()"></div> }
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
              <div class="playhead" aria-hidden="true" [style.left.%]="thumbPct()">
                <span class="tip">{{ shortLabel() }}</span>
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

    /* the track: day blocks above, the rail and the playhead in the middle, the scrub input on top of all */
    .track { position: relative; margin-top: 6px; height: 52px; }
    .blocks { position: absolute; left: 0; right: 0; top: 0; height: 20px; }
    .block { position: absolute; top: 0; height: 100%; border-left: 1px solid var(--line-strong); }
    .day { position: absolute; left: 6px; top: 1px; font-size: 11px; font-weight: 650; color: var(--text-secondary); white-space: nowrap; }
    .tick { position: absolute; top: 31px; width: 1px; height: 5px; background: var(--text-muted); }
    .tick.major { top: 30px; height: 7px; background: var(--text-secondary); }
    .tick-label { position: absolute; top: 37px; left: 3px; font-size: 9px; color: var(--text-muted); white-space: nowrap; }
    .rail { position: absolute; left: 0; right: 0; top: 26px; height: 6px; border-radius: 3px; background: var(--surface-4); }
    .rail .past { position: absolute; inset: 0 auto 0 0; border-radius: 3px 0 0 3px; background: var(--line-strong); }
    .rail .now { position: absolute; top: -5px; bottom: -5px; width: 2px; margin-left: -1px; background: var(--ok); }
    .playhead { position: absolute; top: 14px; bottom: 6px; width: 2px; margin-left: -1px; background: var(--accent); pointer-events: none; }
    .playhead .tip {
      position: absolute; bottom: calc(100% + 2px); left: 50%; transform: translateX(-50%); padding: 2px 7px; border-radius: var(--radius-s);
      background: var(--accent); color: var(--on-accent); font-size: 11px; font-weight: 650; white-space: nowrap; box-shadow: var(--shadow-1);
    }
    /* rain accumulation: the chosen period on the track (white, with a handle at each end and the times beside them) */
    .selection { position: absolute; top: 24px; height: 10px; border-radius: 2px; background: #fff; box-shadow: 0 0 0 1px var(--line-strong); cursor: grab; touch-action: none; }
    .handle { position: absolute; top: 14px; bottom: 4px; width: 22px; margin-left: -11px; cursor: ew-resize; touch-action: none; }
    .handle::before { content: ''; position: absolute; left: 10px; top: 0; bottom: 0; width: 2px; background: #fff; }
    .handle .tip {
      position: absolute; bottom: calc(100% + 2px); padding: 2px 7px; border-radius: var(--radius-s); background: var(--accent); color: var(--on-accent);
      font-size: 11px; font-weight: 650; white-space: nowrap; box-shadow: var(--shadow-1); pointer-events: none;
    }
    .handle.start .tip { right: 11px; }          /* the start time sits to the left of its handle, the end time to the right of its own */
    .handle.end .tip { left: 11px; }
    input[type=range] { position: absolute; inset: 22px 0 auto 0; width: 100%; height: 22px; margin: 0; background: transparent; appearance: none; -webkit-appearance: none; cursor: pointer; touch-action: none; opacity: 0; }
    input[type=range]:focus-visible { opacity: 0; }
    input[type=range]::-webkit-slider-runnable-track { height: 6px; }
    input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; margin-top: -6px; border-radius: 50%; background: var(--accent); }
    input[type=range]::-moz-range-thumb { width: 16px; height: 16px; border-radius: 50%; background: var(--accent); border: 0; }

    @media (max-width: 700px) {
      .dock { right: var(--gutter); padding: 6px 10px 4px; }
      .row { gap: 8px; }
      .when { font-size: 13px; }
      .transport .btn-icon { width: 32px; height: 32px; }
      .play { width: 40px; height: 40px; }
      .speed { min-width: 44px; }
      .track { height: 50px; }
      .tick-label { display: none; }
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

  /** The playhead tooltip: day, number and hour, as on windy.com ("Thu 15 · 11 AM"). */
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

  /** Where the playhead is, in percent of the run (-1 when there is no time yet). */
  protected readonly thumbPct = computed(() => {
    const r = this.range();
    const t = this.state.timeMs();
    return r && t !== null ? Math.min(Math.max(((t - r.start) / (r.end - r.start)) * 100, 0), 100) : -1;
  });

  /** One block per IST day inside the run, with a tick every 6 hours (the midnight, 6 AM, noon and 6 PM ticks are labelled). */
  protected readonly dayBlocks = computed(() => {
    const r = this.range();
    if (!r) return [];
    const span = r.end - r.start;
    const pct = (ms: number) => ((ms - r.start) / span) * 100;
    const dayFmt = new Intl.DateTimeFormat('en-IN', { timeZone: IST, weekday: 'short', day: 'numeric' });
    const blocks: { ms: number; pct: number; width: number; label: string; ticks: { pct: number; major: boolean; label: string }[] }[] = [];
    let ms = Math.floor((r.start + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS; // the IST midnight at or before the run's start
    for (; ms < r.end; ms += DAY_MS) {
      const from = Math.max(ms, r.start);
      const to = Math.min(ms + DAY_MS, r.end);
      const ticks: { pct: number; major: boolean; label: string }[] = [];
      for (let k = 0; k < 4; k++) {
        const t = ms + k * 6 * HOUR_MS;
        if (t >= from && t < to) ticks.push({ pct: pct(t), major: true, label: istHourLabel(t) });
      }
      blocks.push({ ms, pct: pct(from), width: ((to - from) / span) * 100, label: dayFmt.format(from), ticks });
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
