import { ChangeDetectionStrategy, Component, HostListener, computed, inject } from '@angular/core';
import { ForecastCatalogService } from '../../core/forecast/forecast-catalog.service';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';

const IST = 'Asia/Kolkata';
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3_600_000;

/** Bottom timeline: play/pause, a continuous scrubber over the whole run, and day markers in IST. */
@Component({
  selector: 'app-forecast-timeline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (state.forecastActive() && range(); as r) {
      <section class="timeline glass-panel" aria-label="Forecast timeline">
        <button
          type="button" class="play" (click)="state.togglePlay()"
          [attr.aria-label]="state.playing() ? 'Pause' : 'Play'" [title]="state.playing() ? 'Pause (Space)' : 'Play (Space)'"
        >
          @if (state.playing()) {
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="5" height="16" rx="1"/><rect x="14" y="4" width="5" height="16" rx="1"/></svg>
          } @else {
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6,4 20,12 6,20"/></svg>
          }
        </button>

        <div class="track">
          <div class="readout">
            <strong>{{ timeLabel() }}</strong>
            <span class="lead">{{ leadLabel() }}</span>
          </div>
          <div class="scrub">
            <input
              type="range" aria-label="Forecast time"
              [min]="r.start" [max]="r.end" step="600000"
              [value]="state.timeMs() ?? r.start"
              (input)="onScrub($event)"
            />
            <div class="days" aria-hidden="true">
              @for (d of dayMarks(); track d.ms) {
                <span class="day" [style.left.%]="d.pct">{{ d.label }}</span>
              }
            </div>
          </div>
        </div>
      </section>
    }
  `,
  styles: [`
    :host { display: contents; }
    .timeline {
      position: fixed; left: 12px; right: 72px; bottom: 12px; z-index: 900; /* clear of the map zoom buttons */
      display: flex; align-items: center; gap: 12px; padding: 10px 14px;
    }
    .play {
      flex: none; width: 44px; height: 44px; border-radius: 50%; border: 1px solid rgba(0,229,255,0.45);
      background: rgba(0,229,255,0.15); color: var(--neon-cyan); cursor: pointer; display: grid; place-items: center;
    }
    .play:hover { background: rgba(0,229,255,0.28); }
    .play:focus-visible, input:focus-visible { outline: 2px solid var(--neon-cyan); outline-offset: 2px; }
    .track { flex: 1; min-width: 0; }
    .readout { display: flex; align-items: baseline; gap: 10px; font: 13px var(--font-body); color: var(--text-primary); }
    .lead { color: var(--text-muted); font-size: 11px; }
    .scrub { position: relative; padding-bottom: 16px; }
    input[type=range] { width: 100%; height: 28px; margin: 0; background: transparent; accent-color: var(--neon-cyan); cursor: pointer; }
    .days { position: absolute; left: 0; right: 0; bottom: 0; height: 14px; pointer-events: none; }
    .day { position: absolute; transform: translateX(-50%); font: 10px var(--font-body); color: var(--text-secondary); white-space: nowrap; }
    .day::before { content: ''; position: absolute; left: 50%; top: -6px; width: 1px; height: 5px; background: var(--text-muted); }
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

  protected readonly leadLabel = computed(() => {
    const t = this.state.timeMs();
    if (t === null) return '';
    const hours = Math.round((t - Date.now()) / 3_600_000);
    if (Math.abs(hours) < 1) return 'now';
    return hours > 0 ? `in ${hours} h` : `${-hours} h ago`;
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
