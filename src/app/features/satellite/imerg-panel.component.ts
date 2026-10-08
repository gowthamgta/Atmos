import { ChangeDetectionStrategy, Component, computed, effect, inject, untracked } from '@angular/core';
import { MapLayerService } from '../../core/services/map-layer.service';
import { ImergService } from '../../core/satellite/imerg.service';

/** Controls for the observed-rain layer (NASA IMERG): which half hour, opacity. Shown only while the layer is on. */
@Component({
  selector: 'app-imerg-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (active()) {
      <section class="panel glass-panel" aria-label="Observed rain settings">
        <header>
          <span class="live" aria-hidden="true"></span>
          <div class="heading">
            <strong>Observed rain</strong>
            <span class="sub">NASA IMERG · every 30 min · about 10 km</span>
          </div>
        </header>

        @if (imerg.checking()) {
          <p class="msg">Looking for the newest picture…</p>
        } @else if (imerg.failed()) {
          <p class="msg">No recent picture found. NASA publishes them a few hours late; try again shortly.</p>
        } @else {
          <div class="stepper" role="group" aria-label="Time">
            <button type="button" class="chip" [disabled]="!imerg.canGoBack()" (click)="imerg.step(-2)" aria-label="One hour earlier">◀ 1 h</button>
            <button type="button" class="chip" [disabled]="!imerg.canGoBack()" (click)="imerg.step(-1)" aria-label="Half an hour earlier">◀ 30 min</button>
            <span class="time">{{ imerg.label() }} IST</span>
            <button type="button" class="chip" [disabled]="!imerg.canGoForward()" (click)="imerg.step(1)" aria-label="Half an hour later">30 min ▶</button>
            <button type="button" class="chip" [disabled]="!imerg.canGoForward()" (click)="imerg.step(2)" aria-label="One hour later">1 h ▶</button>
          </div>
        }

        <label class="opacity">
          <span class="label">Opacity <span class="value">{{ opacityPercent() }}%</span></span>
          <input type="range" min="0.2" max="1" step="0.05" [value]="imerg.opacity()" (input)="onOpacity($event)" aria-label="Observed rain opacity" />
        </label>
        <div class="legend" aria-label="Rain rate, millimetres per hour">
          <span class="bar"></span>
          <span class="ticks"><span>0.1</span><span>1</span><span>5</span><span>10</span><span>25+ mm/h</span></span>
        </div>
        <p class="note">Rain rate estimated from satellites; the newest picture is a few hours old. © NASA GPM / GIBS</p>
      </section>
    }
  `,
  styles: [`
    :host { display: contents; }
    .panel { position: fixed; left: 12px; bottom: 12px; z-index: 900; width: min(320px, calc(100vw - 24px)); padding: 12px 14px; color: var(--text-primary); font-family: var(--font-body); font-size: 12px; }
    header { display: flex; align-items: center; gap: 10px; }
    .live { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 8px #22c55e; flex: none; }
    .heading { flex: 1; min-width: 0; }
    .heading strong { display: block; font-size: 14px; }
    .sub { color: var(--text-muted); font-size: 11px; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--neon-cyan); outline-offset: 2px; }
    .stepper { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 10px; align-items: center; }
    .time { grid-column: 1 / -1; order: -1; text-align: center; font-weight: 600; font-size: 13px; }
    .chip { min-height: 34px; border-radius: 10px; border: 1px solid transparent; background: rgba(255,255,255,0.05); color: var(--text-secondary); font: 600 12px var(--font-body); cursor: pointer; padding: 0 8px; }
    .chip:hover:not(:disabled) { background: rgba(255,255,255,0.1); color: var(--text-primary); }
    .chip:disabled { opacity: 0.4; cursor: default; }
    .msg { margin: 8px 0 0; color: var(--text-secondary); font-size: 11px; }
    .label { display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 4px; }
    .value { color: var(--text-primary); float: right; font-weight: 600; }
    .opacity { display: block; margin-top: 10px; }
    input[type=range] { width: 100%; margin: 0; accent-color: var(--neon-cyan); cursor: pointer; }
    .legend { margin-top: 10px; }
    .bar { display: block; height: 8px; border-radius: 4px; background: linear-gradient(90deg, #a6d6f5, #3a87d6, #2ea84a, #f2d23a, #e8742a, #d4232b, #a31a8f); }
    .ticks { display: flex; justify-content: space-between; margin-top: 3px; color: var(--text-muted); font-size: 10px; }
    .note { margin: 10px 0 0; font-size: 10px; color: var(--text-muted); }
    @media (max-width: 700px) {
      .panel { bottom: 84px; width: min(300px, calc(100vw - 24px)); padding: 8px 10px; }
      .heading strong { font-size: 13px; }
      .opacity, .note, .legend { display: none; }
    }
  `]
})
export class ImergPanelComponent {
  protected readonly imerg = inject(ImergService);
  private readonly layers = inject(MapLayerService);

  protected readonly active = computed(() => this.layers.layers().some(l => l.id === 'imerg' && l.active));
  protected readonly opacityPercent = computed(() => Math.round(this.imerg.opacity() * 100));

  constructor() {
    // each time the layer is switched on, find the newest picture
    effect(() => {
      if (this.active()) untracked(() => void this.imerg.pickNewest());
    });
  }

  protected onOpacity(event: Event): void {
    const value = parseFloat((event.target as HTMLInputElement).value);
    this.imerg.opacity.set(value);
    this.layers.setLayerOpacity('imerg', value);
  }
}
