import { ChangeDetectionStrategy, Component, computed, effect, inject, untracked } from '@angular/core';
import { MapLayerService } from '../../core/services/map-layer.service';
import { SatelliteService } from '../../core/satellite/satellite.service';

const IST_OFFSET_MS = 5.5 * 3_600_000;

/** "14:45 IST" for a time in epoch ms. */
function istClock(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} IST`;
}

/** Controls for the Meteosat picture: which frame, play as a loop, opacity. Shown only while the satellite layer is on. */
@Component({
  selector: 'app-satellite-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (active()) {
      <section class="panel glass-panel" aria-label="Satellite settings">
        <header>
          <span class="live" [class.off]="failed()" aria-hidden="true"></span>
          <div class="heading">
            <strong>Meteosat-9</strong>
            <span class="sub">Observed, {{ productLabel() }}</span>
          </div>
          <button type="button" class="play" (click)="sat.togglePlay()" [disabled]="count() < 2" [attr.aria-label]="sat.playing() ? 'Pause loop' : 'Play loop'">
            {{ sat.playing() ? '❚❚' : '▶' }}
          </button>
        </header>

        @if (failed()) {
          <p class="msg">The satellite service did not answer. It will try again in a few minutes.</p>
        } @else {
          <div class="scan">
            <span>{{ timeLabel() }}</span>
            <span class="age">@if (sat.ageMinutes() !== null) { {{ sat.ageMinutes() }} min old } @else { Loading… }</span>
          </div>
          <input type="range" class="frames" min="0" [max]="Math.max(count() - 1, 0)" step="0.01" [value]="sat.position()" [disabled]="count() < 2" (input)="onFrame($event)" aria-label="Satellite time" />
          <div class="ends"><span>{{ firstLabel() }}</span><span>{{ lastLabel() }}</span></div>
          @if (sat.loading()) { <div class="loading">Loading pictures…</div> }
        }

        <div class="views" role="group" aria-label="What to show">
          <button type="button" class="view" [class.active]="sat.view() === 'clouds'" [attr.aria-pressed]="sat.view() === 'clouds'" (click)="sat.setView('clouds')" title="Only the clouds, bright over the map">Clouds only</button>
          <button type="button" class="view" [class.active]="sat.view() === 'picture'" [attr.aria-pressed]="sat.view() === 'picture'" (click)="sat.setView('picture')" title="The whole satellite picture, land and sea included">Full picture</button>
        </div>

        <label class="opacity">
          <span class="label">Opacity <span class="value">{{ opacityPercent() }}%</span></span>
          <input type="range" min="0.2" max="1" step="0.05" [value]="sat.opacity()" (input)="onOpacity($event)" aria-label="Satellite opacity" />
        </label>
        <p class="note">Last hour, every 15 minutes. HRV by day, infrared at night. © EUMETSAT</p>
      </section>
    }
  `,
  styles: [`
    :host { display: contents; }
    .panel { position: fixed; left: 12px; bottom: 12px; z-index: 900; width: min(300px, calc(100vw - 24px)); padding: 12px 14px; color: var(--text-primary); font-family: var(--font-body); font-size: 12px; }
    header { display: flex; align-items: center; gap: 10px; }
    .live { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 8px #22c55e; flex: none; }
    .live.off { background: #ef4444; box-shadow: 0 0 8px #ef4444; }
    .heading { flex: 1; min-width: 0; }
    .heading strong { display: block; font-size: 14px; }
    .sub { color: var(--text-muted); font-size: 11px; }
    .play { width: 36px; height: 36px; border-radius: 10px; border: 1px solid var(--glass-border); background: rgba(255,255,255,0.06); color: var(--text-primary); font-size: 14px; cursor: pointer; }
    .play:hover:not(:disabled) { background: rgba(255,255,255,0.14); }
    .play:disabled { opacity: 0.4; cursor: default; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--neon-cyan); outline-offset: 2px; }
    .scan { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin: 10px 0 6px; color: var(--text-secondary); }
    .age { font-weight: 600; color: var(--text-primary); }
    .ends { display: flex; justify-content: space-between; font-size: 10px; color: var(--text-muted); margin-top: 2px; }
    .loading, .msg { margin: 6px 0 0; color: var(--text-secondary); font-size: 11px; }
    .label { display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 4px; }
    .value { color: var(--text-primary); float: right; font-weight: 600; }
    .views { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 10px; }
    .view { min-height: 36px; border-radius: 10px; border: 1px solid transparent; background: rgba(255,255,255,0.05); color: var(--text-secondary); font: 600 12px var(--font-body); cursor: pointer; }
    .view:hover { background: rgba(255,255,255,0.1); color: var(--text-primary); }
    .view.active { background: rgba(0,229,255,0.16); border-color: rgba(0,229,255,0.5); color: var(--neon-cyan); }
    .opacity { display: block; margin-top: 10px; }
    input[type=range] { width: 100%; margin: 0; accent-color: var(--neon-cyan); cursor: pointer; }
    .note { margin: 10px 0 0; font-size: 10px; color: var(--text-muted); }
    @media (max-width: 700px) { .panel { bottom: 84px; } }
  `]
})
export class SatellitePanelComponent {
  protected readonly sat = inject(SatelliteService);
  private readonly layers = inject(MapLayerService);
  protected readonly Math = Math;

  protected readonly active = computed(() => this.layers.layers().some(l => l.id === 'satellite' && l.active));
  protected readonly count = computed(() => this.sat.frames().length);
  protected readonly failed = this.sat.failed;
  protected readonly opacityPercent = computed(() => Math.round(this.sat.opacity() * 100));
  protected readonly productLabel = computed(() => {
    const p = this.sat.current()?.product;
    return p ? (p.id === 'hrv' ? 'daylight, HRV' : 'night, infrared') : 'loading';
  });
  protected readonly timeLabel = computed(() => {
    const f = this.sat.current();
    return f ? istClock(f.timeMs) : '';
  });
  protected readonly firstLabel = computed(() => (this.sat.frames()[0] ? istClock(this.sat.frames()[0].timeMs) : ''));
  protected readonly lastLabel = computed(() => {
    const f = this.sat.frames().at(-1);
    return f ? istClock(f.timeMs) : '';
  });

  constructor() {
    // fetch while the layer is on; stop refreshing and looping when it is off
    effect(() => {
      const on = this.active();
      untracked(() => (on ? this.sat.activate() : this.sat.deactivate()));
    });
  }

  protected onFrame(event: Event): void {
    this.sat.pause();
    this.sat.setFrame(parseFloat((event.target as HTMLInputElement).value));
  }

  protected onOpacity(event: Event): void {
    const value = parseFloat((event.target as HTMLInputElement).value);
    this.sat.opacity.set(value);
    this.layers.setLayerOpacity('satellite', value);
  }
}
