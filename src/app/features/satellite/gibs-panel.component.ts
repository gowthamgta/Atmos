import { ChangeDetectionStrategy, Component, computed, effect, inject, untracked } from '@angular/core';
import { MapLayerService } from '../../core/services/map-layer.service';
import { GIBS_SENSORS } from '../../core/satellite/gibs-hd';
import { GibsHdService } from '../../core/satellite/gibs-hd.service';

/** Controls for the high-detail (250 m) true-colour satellite layer: instrument, day, opacity. Shown only while the layer is on. */
@Component({
  selector: 'app-gibs-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (active()) {
      <section class="panel glass-panel" aria-label="High-detail satellite settings">
        <header>
          <span class="live" aria-hidden="true"></span>
          <div class="heading">
            <strong>HD satellite</strong>
            <span class="sub">True colour, 250 m · {{ gibs.sensor().pass }} IST</span>
          </div>
        </header>

        <div class="days" role="group" aria-label="Day">
          @for (d of gibs.days(); track d.daysAgo) {
            <button type="button" class="chip" [class.active]="gibs.daysAgo() === d.daysAgo" [attr.aria-pressed]="gibs.daysAgo() === d.daysAgo" (click)="gibs.setDay(d.daysAgo)">
              {{ d.daysAgo === 0 ? 'Today' : d.daysAgo === 1 ? 'Yesterday' : '2 days ago' }}
              <span class="date">{{ d.date.slice(5) }}</span>
            </button>
          }
        </div>
        @if (gibs.checking()) { <p class="msg">Looking for the newest picture…</p> }

        <div class="sensors" role="group" aria-label="Instrument">
          @for (s of sensors; track s.id) {
            <button type="button" class="chip small" [class.active]="gibs.sensorId() === s.id" [attr.aria-pressed]="gibs.sensorId() === s.id" (click)="gibs.setSensor(s.id)">{{ s.label }}</button>
          }
        </div>

        <label class="opacity">
          <span class="label">Opacity <span class="value">{{ opacityPercent() }}%</span></span>
          <input type="range" min="0.2" max="1" step="0.05" [value]="gibs.opacity()" (input)="onOpacity($event)" aria-label="HD satellite opacity" />
        </label>
        <p class="note">One picture a day: the satellite's pass over India. Blank where it has not passed yet. © NASA GIBS / EOSDIS</p>
      </section>
    }
  `,
  styles: [`
    :host { display: contents; }
    .panel { position: fixed; left: 12px; bottom: 12px; z-index: 900; width: min(300px, calc(100vw - 24px)); padding: 12px 14px; color: var(--text-primary); font-family: var(--font-body); font-size: 12px; }
    header { display: flex; align-items: center; gap: 10px; }
    .live { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); box-shadow: none; flex: none; }
    .heading { flex: 1; min-width: 0; }
    .heading strong { display: block; font-size: 14px; }
    .sub { color: var(--text-muted); font-size: 11px; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--neon-cyan); outline-offset: 2px; }
    .days { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 10px; }
    .sensors { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .chip { min-height: 36px; border-radius: 10px; border: 1px solid transparent; background: var(--surface-3); color: var(--text-secondary); font: 600 12px var(--font-body); cursor: pointer; padding: 0 8px; }
    .chip.small { min-height: 30px; font-size: 11px; flex: 1 1 auto; }
    .chip:hover { background: var(--surface-4); color: var(--text-primary); }
    .chip.active { background: var(--accent-soft); border-color: var(--accent-line); color: var(--neon-cyan); }
    .date { display: block; font-weight: 400; font-size: 10px; opacity: 0.8; }
    .msg { margin: 6px 0 0; color: var(--text-secondary); font-size: 11px; }
    .label { display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 4px; }
    .value { color: var(--text-primary); float: right; font-weight: 600; }
    .opacity { display: block; margin-top: 10px; }
    input[type=range] { width: 100%; margin: 0; accent-color: var(--neon-cyan); cursor: pointer; }
    .note { margin: 10px 0 0; font-size: 10px; color: var(--text-muted); }
    @media (max-width: 700px) {
      .panel { bottom: 84px; width: min(280px, calc(100vw - 24px)); padding: 8px 10px; }
      .heading strong { font-size: 13px; }
      .opacity, .note { display: none; }
      .chip { min-height: 32px; }
    }
  `]
})
export class GibsPanelComponent {
  protected readonly gibs = inject(GibsHdService);
  private readonly layers = inject(MapLayerService);
  protected readonly sensors = GIBS_SENSORS;

  protected readonly active = computed(() => this.layers.layers().some(l => l.id === 'gibs' && l.active));
  protected readonly opacityPercent = computed(() => Math.round(this.gibs.opacity() * 100));

  constructor() {
    // each time the layer is switched on, pick the newest day that has a picture
    effect(() => {
      if (this.active()) untracked(() => void this.gibs.pickNewestDay());
    });
  }

  protected onOpacity(event: Event): void {
    const value = parseFloat((event.target as HTMLInputElement).value);
    this.gibs.opacity.set(value);
    this.layers.setLayerOpacity('gibs', value);
  }
}
