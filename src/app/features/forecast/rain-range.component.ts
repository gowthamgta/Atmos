import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';
import { istHourLabel } from './forecast-timeline.component';

const IST = 'Asia/Kolkata';
const HOUR_MS = 3_600_000;

/** "Mon 12 · 6 AM" for a time in epoch ms (IST). */
function label(ms: number): string {
  return `${new Intl.DateTimeFormat('en-IN', { timeZone: IST, weekday: 'short', day: 'numeric', month: 'short' }).format(ms)} · ${istHourLabel(ms)}`;
}

/** "2 days 6 h" for a period in hours. */
export function periodLabel(hours: number): string {
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return [days ? `${days} day${days > 1 ? 's' : ''}` : '', rest || !days ? `${rest} h` : ''].filter(Boolean).join(' ');
}

/** Two sliders that choose the period of the rain accumulation layer: it shows the rain between the start and the end time. */
@Component({
  selector: 'app-rain-range',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (shown(); as r) {
      <section class="range" aria-label="Rain accumulation period">
        <header>
          <strong>Rain accumulation</strong>
          <span class="total" title="Length of the chosen period">{{ total() }}</span>
        </header>
        <label class="line">
          <span class="which">From</span>
          <input type="range" aria-label="Start of the period" [min]="r.first" [max]="r.last" step="3600000" [value]="r.from" (input)="onStart($event)" />
          <span class="when">{{ fromLabel() }}</span>
        </label>
        <label class="line">
          <span class="which">To</span>
          <input type="range" aria-label="End of the period" [min]="r.first" [max]="r.last" step="3600000" [value]="r.to" (input)="onEnd($event)" />
          <span class="when">{{ toLabel() }}</span>
        </label>
      </section>
    }
  `,
  styles: [`
    :host { display: contents; }
    .range {
      position: fixed; left: var(--gutter); bottom: 226px; z-index: 900; width: min(380px, calc(100vw - 92px));
      padding: 9px 12px 8px; color: var(--text-primary); background: var(--surface-1); border: 1px solid var(--line);
      border-radius: var(--radius-l); box-shadow: var(--shadow-2); animation: sheet-in var(--t-med) both;
    }
    header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; font-size: 12px; }
    .total { padding: 1px 8px; border-radius: 999px; border: 1px solid var(--accent-line); background: var(--accent-soft); color: var(--accent-strong); font-size: 11px; font-weight: 650; font-variant-numeric: tabular-nums; }
    .line { display: grid; grid-template-columns: 34px 1fr auto; align-items: center; gap: 8px; min-height: 30px; font-size: 12px; }
    .which { color: var(--text-secondary); font-weight: 600; }
    .when { min-width: 104px; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
    input[type=range] { width: 100%; margin: 0; accent-color: var(--accent); cursor: pointer; touch-action: none; }
    @media (max-width: 700px) {
      .range { bottom: 210px; width: min(340px, calc(100vw - 24px)); }
      .when { min-width: 92px; font-size: 11px; }
    }
  `],
})
export class RainRangeComponent {
  private readonly state = inject(ForecastStateService);

  /** Only while the layer is on and the period is known. */
  protected readonly shown = computed(() => {
    const from = this.state.rangeStartMs();
    const to = this.state.rangeEndMs();
    const first = this.state.startMs();
    const last = this.state.endMs();
    return this.state.activeLayerId() === 'raintot' && from !== null && to !== null && first !== null && last !== null ? { from, to, first, last } : null;
  });
  protected readonly fromLabel = computed(() => label(this.state.rangeStartMs() ?? 0));
  protected readonly toLabel = computed(() => label(this.state.rangeEndMs() ?? 0));
  protected readonly total = computed(() => {
    const from = this.state.rangeStartMs();
    const to = this.state.rangeEndMs();
    return from === null || to === null ? '' : periodLabel(Math.round((to - from) / HOUR_MS));
  });

  protected onStart(event: Event): void {
    this.state.setRangeStart(Number((event.target as HTMLInputElement).value));
  }

  protected onEnd(event: Event): void {
    this.state.setRangeEnd(Number((event.target as HTMLInputElement).value));
  }
}
