import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { PerfMeterService } from '../../core/ui/perf-meter.service';
import { gradeOf, slowShare } from '../../core/ui/perf-stats';

/**
 * The performance meter: one line over the corner of the map (switched on in the menu, under Settings) with the frame rate, the mean and
 * 95th-percentile frame time, the share of frames that stutter, long tasks, pictures and wind streaks in use, and the memory of the page.
 * The first figure is coloured by how smooth it is (the status colours, which are for nothing else).
 */
@Component({
  selector: 'app-perf-meter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (perf.enabled()) {
      <div class="meter" role="status" aria-label="Performance meter">
        @if (line(); as l) {
          <b class="fps" [class.good]="l.grade === 'good'" [class.fair]="l.grade === 'fair'" [class.poor]="l.grade === 'poor'">{{ l.fps }}<small> fps</small></b>
          <span title="Mean time between frames">{{ l.mean }} ms</span>
          <span title="95% of frames took no longer than this">p95 {{ l.p95 }}</span>
          <span title="Frames that took over 33 ms (under 30 a second)">slow {{ l.slow }}%</span>
          <span title="Tasks over 50 ms on the page's main thread in the last 10 s">long {{ l.long }}</span>
          @for (p of l.probes; track p.name) { <span [title]="p.name">{{ p.name }} {{ p.value }}</span> }
          @if (l.heap !== null) { <span title="JavaScript memory in use">{{ l.heap }} MB</span> }
        } @else if (paused()) {
          <span>paused: the page is not on screen</span>
        } @else {
          <span>measuring…</span>
        }
      </div>
    }
  `,
  styles: [`
    :host { display: contents; }
    .meter {
      position: fixed; left: var(--gutter); bottom: calc(var(--left-stack-h) + 6px); z-index: var(--z-ui); display: flex; flex-wrap: wrap; gap: 4px 10px; max-width: calc(100vw - 2 * var(--gutter) - 70px);
      padding: 3px 10px; border-radius: 12px; background: var(--surface-1); box-shadow: var(--shadow-1); color: var(--text-secondary); font: var(--fw-medium) var(--fs-xs) var(--font-mono); pointer-events: none; white-space: nowrap;
    }
    .fps { font-size: var(--fs-m); }
    .fps small { font-size: var(--fs-xs); font-weight: var(--fw-normal); }
    .fps.good { color: var(--ok); }
    .fps.fair { color: var(--warn); }
    .fps.poor { color: var(--danger); }
  `]
})
export class PerfMeterComponent {
  protected readonly perf = inject(PerfMeterService);

  protected readonly paused = computed(() => this.perf.live()?.paused ?? false);

  protected readonly line = computed(() => {
    const v = this.perf.live();
    const s = v?.stats;
    if (!v || !s || v.paused) return null;
    return {
      grade: gradeOf(s),
      fps: Math.round(s.fps),
      mean: s.meanMs.toFixed(1),
      p95: Math.round(s.p95Ms),
      slow: Math.round(slowShare(s)),
      long: v.longTasks,
      heap: v.heapMB,
      probes: Object.entries(v.probes).map(([name, value]) => ({ name, value })),
    };
  });
}
