import { ChangeDetectionStrategy, Component, HostListener, computed, inject } from '@angular/core';
import { MapLayerService } from '../../core/services/map-layer.service';
import { RADAR_COLOR_STOPS } from '../../core/services/radar-field';
import { RadarNowcastService } from '../../core/services/radar-nowcast.service';
import { RadarService } from '../../core/services/radar.service';
import { IconComponent } from '../../shared/icon.component';
import { followDrag, fractionAlong } from '../../shared/pointer-drag';

/** "14:45" (IST) for a time in epoch ms. */
export function istClock(ms: number): string {
  const d = new Date(ms + 5.5 * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** How far ahead of or behind the live picture a time is, as "+30 min" or "−20 min" (empty for the live picture). */
export function offsetLabel(ms: number, liveMs: number): string {
  const min = Math.round((ms - liveMs) / 60_000);
  return min === 0 ? '' : `${min > 0 ? '+' : '−'}${Math.abs(min)} min`;
}

/** The radar's colour scale as a gradient along the bar (the stops of RADAR_COLOR_STOPS, spread over their range). */
function radarGradient(): string {
  const top = RADAR_COLOR_STOPS[RADAR_COLOR_STOPS.length - 1].val;
  const stops = RADAR_COLOR_STOPS.slice(1).map(s => `rgb(${s.r}, ${s.g}, ${s.b}) ${((s.val / top) * 100).toFixed(1)}%`);
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
/** Where the colour bar is labelled: reflectivity in dBZ, each at its place on the scale (dBZ = 12 + 9.6 x intensity). */
const TICKS = [20, 30, 40, 50, 60].map(dbz => ({ label: String(dbz), pos: (((dbz - 12) / 9.6) / RADAR_COLOR_STOPS[RADAR_COLOR_STOPS.length - 1].val) * 100 }));

/**
 * The bar along the bottom while the radar is on, as the forecast layers have: a play button, then the time as a strip of pictures, the last hour
 * of radar to the left of "Now" and the nowcast (the radar slid ahead along the motion of the rain) to the right, in stripes so a guess is never
 * mistaken for what the radar saw; and under it the colour bar. Drag the amber line or its time badge, click the strip or use the arrow keys.
 */
@Component({
  selector: 'app-radar-bars',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    @if (active()) {
      <section class="bar" aria-label="Radar time">
        <button type="button" class="play" (click)="radar.togglePlay()" [disabled]="loading() && notches().length < 2" [attr.aria-label]="radar.playing() ? 'Pause' : 'Play the last hour and the nowcast'" [attr.aria-pressed]="radar.playing()" [title]="radar.playing() ? 'Pause (Space)' : 'Play the last hour and the nowcast (Space)'">
          <app-icon [name]="radar.playing() ? 'pause' : 'play'" [size]="26" />
        </button>

        <div class="track">
          <div class="inner" #inner>
            <div class="zone observed" [style.width.%]="nowPct()" aria-hidden="true"><span>{{ notches().length < 2 ? '' : 'Observed' }}</span></div>
            @if (ahead() > 0) {
              <div class="zone guess" [style.left.%]="nowPct()" [style.width.%]="100 - nowPct()" aria-hidden="true"><span>Nowcast</span></div>
            }
            @for (n of notches(); track n.i) {
              <span class="notch" [class.now]="n.now" [class.guess]="n.guess" [class.odd]="n.odd" [class.third]="n.third" [style.left.%]="n.pct" aria-hidden="true"><span class="lbl">{{ n.label }}</span></span>
            }
            <div class="playhead" [class.guess]="isGuess()" [style.left.%]="headPct()" aria-hidden="true">
              <span class="tip" (pointerdown)="beginPlayheadDrag($event, inner)">{{ tip() }}</span>
            </div>
            @if (notches().length > 1) {
              <input type="range" aria-label="Radar time" [attr.aria-valuetext]="tipFull()" min="0" [max]="radar.cursorMax()" step="1" [value]="radar.cursor()" (input)="onScrub($event)" />
            }
          </div>
          @if (loading()) {
            <div class="note" role="status">Building the last hour… {{ percent() }}%</div>
          } @else if (notches().length < 2 && radar.historyAvailable()) {
            <div class="note">Press play to load the last hour</div>
          }
        </div>

        <div class="tail">
          <button type="button" class="step" (click)="stepBy(-1)" [disabled]="radar.cursor() <= 0" aria-label="Back one picture" title="Back 10 minutes (←)"><app-icon name="chevron" [size]="16" class="left" /></button>
          <button type="button" class="step" (click)="stepBy(1)" [disabled]="radar.cursor() >= radar.cursorMax()" aria-label="Forward one picture" title="Forward 10 minutes (→)"><app-icon name="chevron" [size]="16" class="right" /></button>
        </div>
      </section>

      <div class="legend" role="img" aria-label="Radar reflectivity colour scale in dBZ">
        <div class="scale" [style.background]="gradient">
          <span class="unit">dBZ</span>
          @for (t of ticks; track t.label) { <span class="tick" [style.--p]="t.pos" aria-hidden="true">{{ t.label }}</span> }
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: contents; }
    .bar { position: fixed; left: 0; right: 0; bottom: var(--legend-h); height: var(--timeline-h); z-index: 900; display: flex; align-items: stretch; background: var(--surface-1); box-shadow: 0 -1px 0 var(--line); }
    .play { flex: none; width: 54px; border: 0; background: transparent; color: var(--accent-strong); cursor: pointer; display: grid; place-items: center; transition: transform var(--t-fast), color var(--t-fast); }
    .play:hover:not(:disabled) { color: var(--text-primary); transform: scale(1.08); }
    .play:disabled { opacity: 0.5; cursor: progress; }
    .track { position: relative; flex: 1; min-width: 0; container-type: inline-size; }
    .inner { position: absolute; inset: 0 22px; }
    .zone { position: absolute; top: 0; bottom: 0; display: flex; align-items: flex-start; padding: 3px 6px 0; font-size: var(--fs-xs); font-weight: var(--fw-strong); letter-spacing: var(--ls-caps); text-transform: uppercase; color: var(--text-muted); pointer-events: none; overflow: hidden; }
    .zone.observed { left: 0; background: rgba(255, 255, 255, 0.07); }
    .zone.guess { background: repeating-linear-gradient(135deg, rgba(255, 255, 255, 0.16) 0 6px, rgba(255, 255, 255, 0.04) 6px 12px); justify-content: flex-end; }
    :host-context(:root[data-theme='light']) .zone.observed { background: rgba(20, 40, 70, 0.05); }
    :host-context(:root[data-theme='light']) .zone.guess { background: repeating-linear-gradient(135deg, rgba(20, 40, 70, 0.14) 0 6px, rgba(20, 40, 70, 0.04) 6px 12px); }
    .notch { position: absolute; bottom: 0; width: 1px; height: 8px; margin-left: -0.5px; background: var(--line-strong); pointer-events: none; }
    .notch.now { height: 100%; width: 2px; margin-left: -1px; background: var(--text-secondary); opacity: 0.55; }
    .notch .lbl { position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); font-size: var(--fs-s); font-weight: var(--fw-medium); color: var(--text-secondary); white-space: nowrap; font-variant-numeric: tabular-nums; text-shadow: var(--text-halo); }
    .notch.now .lbl { bottom: auto; top: 4px; left: 6px; transform: none; font-weight: var(--fw-strong); color: var(--text-primary); }
    .notch.guess .lbl { font-style: italic; opacity: 0.85; }
    @container (max-width: 560px) { .notch.odd:not(.now) .lbl { display: none; } }
    @container (max-width: 330px) { .notch.third:not(.now) .lbl { display: none; } }
    .playhead { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--accent); pointer-events: none; z-index: 2; }
    .playhead .tip { position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); padding: 4px 12px 3px; border-radius: 9px 9px 0 0; background: var(--accent); color: var(--on-accent); font-size: 15px; font-weight: 650; white-space: nowrap; font-variant-numeric: tabular-nums; box-shadow: 0 0 4px rgba(0, 0, 0, 0.6); pointer-events: auto; cursor: grab; touch-action: none; user-select: none; }
    .playhead .tip:active { cursor: grabbing; }
    .playhead.guess .tip { background: repeating-linear-gradient(135deg, var(--accent) 0 8px, color-mix(in srgb, var(--accent) 80%, white) 8px 16px); }
    input[type=range] { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; touch-action: none; z-index: 3; }
    .track:has(input:focus-visible) { outline: 2px solid var(--accent-strong); outline-offset: -2px; }
    .note { position: absolute; inset: auto 22px 3px 22px; text-align: center; font-size: var(--fs-s); color: var(--text-secondary); pointer-events: none; }

    .tail { flex: none; display: flex; align-items: center; gap: 2px; padding: 0 8px 0 6px; }
    .step { width: 30px; height: 30px; display: grid; place-items: center; border: 0; border-radius: 50%; background: transparent; color: var(--text-secondary); cursor: pointer; }
    .step:hover:not(:disabled) { background: var(--surface-3); color: var(--text-primary); }
    .step:disabled { opacity: 0.35; cursor: default; }
    .step .left { transform: rotate(90deg); }
    .step .right { transform: rotate(-90deg); }

    .legend { position: fixed; left: 0; right: 0; bottom: 0; height: var(--legend-h); z-index: 910; background: var(--surface-0); }
    .scale { position: relative; height: 100%; box-shadow: 0 -1px 0 var(--line); }
    .unit { position: absolute; left: 0; top: 0; bottom: 0; display: grid; place-items: center; min-width: var(--hit); padding: 0 12px 0 10px; background: rgba(0, 0, 0, 0.62); color: #fff; font-size: var(--fs-xs); font-weight: var(--fw-strong); letter-spacing: 0.02em; }
    .tick { position: absolute; top: 50%; left: clamp(64px, calc(var(--p) * 1%), calc(100% - 30px)); transform: translate(-50%, -50%); padding: 1px 6px; border-radius: 9px; background: rgba(0, 0, 0, 0.58); color: #fff; font-size: var(--fs-s); font-weight: var(--fw-strong); font-variant-numeric: tabular-nums; pointer-events: none; }

    @media (max-width: 700px) {
      .play { width: 44px; }
      .playhead .tip { font-size: 13px; padding: 3px 9px 2px; }
      .tail .step { display: none; }
      .tail { padding: 0 6px 0 2px; }
      .inner { inset: 0 16px; }
    }
  `]
})
export class RadarBarsComponent {
  protected readonly radar = inject(RadarService);
  private readonly layers = inject(MapLayerService);
  /** Instantiated here so the nowcast is worked out whenever the bar is on. */
  protected readonly nowcast = inject(RadarNowcastService);

  protected readonly gradient = radarGradient();
  protected readonly ticks = TICKS;
  protected readonly active = computed(() => this.layers.layers().some(l => l.id === 'radar' && l.active));
  protected readonly loading = this.radar.historyLoading;
  protected readonly percent = computed(() => Math.round(this.radar.historyProgress() * 100));

  /** The loop's pictures, the live picture and the nowcast steps in a row: one notch each. */
  protected readonly notches = computed(() => {
    const h = this.radar.history();
    const a = this.radar.nowcast();
    const live = this.radar.compositeMosaic()?.timing?.epochMs ?? null;
    const times = [...h.map(f => f.timeMs), live, ...a.map(f => f.timeMs)];
    const last = times.length - 1;
    return times.flatMap((t, i) => {
      if (t === null) return [];
      const rel = i - h.length;
      const now = rel === 0;
      return [{
        i,
        pct: last === 0 ? 100 : (i / last) * 100,
        now,
        guess: rel > 0,
        odd: rel % 2 !== 0,
        third: rel % 3 !== 0,
        label: now ? 'Now' : istClock(t),
      }];
    });
  });
  /** How many nowcast steps there are. */
  protected readonly ahead = computed(() => this.radar.nowcast().length);
  /** Where "now" is along the strip, in percent. */
  protected readonly nowPct = computed(() => {
    const total = this.radar.cursorMax();
    return total === 0 ? 100 : (this.radar.history().length / total) * 100;
  });
  protected readonly headPct = computed(() => {
    const total = this.radar.cursorMax();
    return total === 0 ? 100 : (this.radar.cursor() / total) * 100;
  });
  protected readonly isGuess = computed(() => this.radar.leadIndex() !== null);

  /** The time of the picture on the map, ms. */
  private readonly shownMs = computed<number | null>(() => {
    const li = this.radar.leadIndex();
    if (li !== null) return this.radar.nowcast()[li]?.timeMs ?? null;
    const pi = this.radar.playIndex();
    return pi !== null ? (this.radar.history()[pi]?.timeMs ?? null) : (this.radar.compositeMosaic()?.timing?.epochMs ?? null);
  });
  protected readonly offset = computed(() => {
    const t = this.shownMs();
    const live = this.radar.compositeMosaic()?.timing?.epochMs;
    return t === null || !live ? '' : offsetLabel(t, live);
  });
  /** The tooltip on the amber line: the time, and how far from live. */
  protected readonly tip = computed(() => {
    const t = this.shownMs();
    if (t === null) return 'Live';
    if (this.radar.playIndex() === null && this.radar.leadIndex() === null) return `Live ${istClock(t)}`;
    return `${istClock(t)} · ${this.offset()}`;
  });
  protected readonly tipFull = computed(() => (this.isGuess() ? `Nowcast, ${this.tip()}` : this.tip()));

  protected onScrub(event: Event): void {
    this.radar.pause();
    this.radar.setCursor(Number((event.target as HTMLInputElement).value));
  }

  /** Drags the time badge on the amber line along the strip, as on the forecast bar: it snaps to the pictures, as the strip does. */
  protected beginPlayheadDrag(event: PointerEvent, inner: HTMLElement): void {
    const max = this.radar.cursorMax();
    if (max < 1) return;
    this.radar.pause();
    followDrag(event, e => {
      const cursor = Math.round(fractionAlong(inner, e.clientX) * this.radar.cursorMax());
      if (cursor !== this.radar.cursor()) this.radar.setCursor(cursor);
    });
  }

  protected stepBy(delta: number): void {
    this.radar.pause();
    this.radar.setCursor(this.radar.cursor() + delta);
  }

  @HostListener('window:keydown', ['$event'])
  protected onKey(e: KeyboardEvent): void {
    if (!this.active() || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (e.key === ' ' && !(target instanceof HTMLButtonElement)) {
      e.preventDefault();
      void this.radar.togglePlay();
    } else if (e.key === 'ArrowRight') {
      this.stepBy(1);
    } else if (e.key === 'ArrowLeft') {
      this.stepBy(-1);
    }
  }
}
