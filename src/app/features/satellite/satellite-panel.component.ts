import { ChangeDetectionStrategy, Component, computed, effect, inject, untracked } from '@angular/core';
import { IconComponent } from '../../shared/icon.component';
import { MapLayerService } from '../../core/services/map-layer.service';
import { SATELLITE_CREDIT, SATELLITE_NAME, isTwilightTime } from '../../core/satellite/satellite.config';
import { SatelliteService } from '../../core/satellite/satellite.service';

const IST_OFFSET_MS = 5.5 * 3_600_000;

/** "14:45 IST" for a time in epoch ms. */
function istClock(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} IST`;
}

/** Controls for the live satellite picture (Meteosat-9): channel, view mode, frame loop, Cloud-Top hover readout, and opacity. */
@Component({
  selector: 'app-satellite-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    @if (active()) {
      <section class="panel glass-panel" aria-label="Satellite settings">
        <header>
          <span class="live" [class.off]="failed()" aria-hidden="true"></span>
          <div class="heading">
            <strong>{{ sourceLabel }}</strong>
            <span class="sub">Observed, {{ productLabel() }}</span>
          </div>
          <button type="button" class="play" (click)="sat.togglePlay()" [disabled]="count() < 2" [attr.aria-label]="sat.playing() ? 'Pause loop' : 'Play loop'">
            <app-icon [name]="sat.playing() ? 'pause' : 'play'" [size]="14" />
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

        <div class="channels" role="group" aria-label="Satellite channel">
          <button type="button" class="view" [class.active]="sat.channelMode() === 'auto'" [attr.aria-pressed]="sat.channelMode() === 'auto'" (click)="sat.setChannelMode('auto')" title="HRV by day, Infrared at night, blended across dawn and dusk">Auto</button>
          <button type="button" class="view" [class.active]="sat.channelMode() === 'ir'" [attr.aria-pressed]="sat.channelMode() === 'ir'" (click)="sat.setChannelMode('ir')" title="Thermal Infrared 10.8 µm (cloud-top temperature, 24 hours)">IR 10.8</button>
          <button type="button" class="view" [class.active]="sat.channelMode() === 'wv'" [attr.aria-pressed]="sat.channelMode() === 'wv'" (click)="sat.setChannelMode('wv')" title="Upper-level Water Vapour 6.2 µm (jet streams, dry intrusions and deep moisture)">WV 6.2</button>
        </div>

        <div class="views" role="group" aria-label="What to show">
          <button type="button" class="view" [class.active]="sat.view() === 'clouds'" [attr.aria-pressed]="sat.view() === 'clouds'" (click)="sat.setView('clouds')" title="Only the clouds, with the land and sea cleared">Clouds</button>
          <button type="button" class="view" [class.active]="sat.view() === 'thermal'" [attr.aria-pressed]="sat.view() === 'thermal'" (click)="sat.setView('thermal')" title="Colorized Cloud-Top Temperature (Dvorak scale highlighting deep convection)">Thermal IR</button>
          <button type="button" class="view" [class.active]="sat.view() === 'picture'" [attr.aria-pressed]="sat.view() === 'picture'" (click)="sat.setView('picture')" title="The whole satellite picture, land and sea included">Full</button>
        </div>

        @if (sat.view() === 'picture') {
          <button type="button" class="enhance" [class.active]="sat.enhance()" [attr.aria-pressed]="sat.enhance()" (click)="sat.setEnhance(!sat.enhance())"
            title="By day the natural colours, sharpened with the detail of the high-resolution visible channel (and no empty patches in the north and east); infrared and water vapour with their pixel steps smoothed. Off: the pictures as EUMETSAT sends them">
            <app-icon name="eye" [size]="16" />
            <span class="enhance-text">Enhance picture <span class="enhance-sub">{{ enhanceNote() }}</span></span>
          </button>
        }

        @if (sat.view() === 'thermal') {
          <div class="thermal-legend" role="img" aria-label="Cloud-Top Temperature (°C)">
            <div class="label">Cloud-top temperature (°C)</div>
            <div class="thermal-bar"></div>
            <div class="thermal-scale">
              <span>0°</span><span>-20°</span><span>-45°</span><span>-65°</span><span>-80°C</span>
            </div>
          </div>
        }

        @if (sat.hoverReading(); as h) {
          <div class="hover-readout" aria-live="polite" title="Estimated from the grey of the infrared picture, not measured: good to a few degrees and a couple of kilometres">
            <span class="hover-dot" [style.background]="h.color"></span>
            <span class="hover-type">{{ h.label }}</span>
            <span class="hover-vals">≈ {{ h.tempC > 0 ? '+' : '' }}{{ h.tempC }}°C · {{ h.heightKm }} km</span>
          </div>
        }

        <label class="opacity">
          <span class="label">Opacity <span class="value">{{ opacityPercent() }}%</span></span>
          <input type="range" min="0.2" max="1" step="0.05" [value]="sat.opacity()" (input)="onOpacity($event)" aria-label="Satellite opacity" />
        </label>
        <p class="note">{{ note }}</p>
      </section>
    }
  `,
  styles: [`
    :host { display: contents; }
    .panel { position: fixed; left: 12px; bottom: 12px; z-index: 900; width: min(310px, calc(100vw - 24px)); padding: 12px 14px; color: var(--text-primary); font-family: var(--font-body); font-size: 12px; }
    header { display: flex; align-items: center; gap: 10px; }
    .live { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); box-shadow: none; flex: none; }
    .live.off { background: var(--danger); box-shadow: none; }
    .heading { flex: 1; min-width: 0; }
    .heading strong { display: block; font-size: 14px; }
    .sub { color: var(--text-muted); font-size: 11px; }
    .play { width: 36px; height: 36px; border-radius: 10px; border: 1px solid var(--glass-border); background: var(--surface-3); color: var(--text-primary); font-size: 14px; cursor: pointer; }
    .play:hover:not(:disabled) { background: var(--surface-4); }
    .play:disabled { opacity: 0.4; cursor: default; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--neon-cyan); outline-offset: 2px; }
    .scan { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin: 10px 0 6px; color: var(--text-secondary); }
    .age { font-weight: 600; color: var(--text-primary); }
    .ends { display: flex; justify-content: space-between; font-size: var(--fs-xs); color: var(--text-muted); margin-top: 2px; }
    .loading, .msg { margin: 6px 0 0; color: var(--text-secondary); font-size: 11px; }
    .label { display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 4px; }
    .value { color: var(--text-primary); float: right; font-weight: 600; }
    .channels, .views { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 8px; }
    .view { min-height: 32px; border-radius: 10px; border: 1px solid transparent; background: var(--surface-3); color: var(--text-secondary); font: 600 11.5px var(--font-body); cursor: pointer; padding: 0 4px; }
    .view:hover { background: var(--surface-4); color: var(--text-primary); }
    .view.active { background: var(--accent-soft); border-color: var(--accent-line); color: var(--neon-cyan); }
    .enhance { display: flex; align-items: center; gap: 8px; width: 100%; margin-top: 8px; padding: 6px 10px; min-height: 36px; border-radius: 10px; border: 1px solid transparent; background: var(--surface-3); color: var(--text-secondary); font: 600 11.5px var(--font-body); cursor: pointer; text-align: left; }
    .enhance:hover { background: var(--surface-4); color: var(--text-primary); }
    .enhance.active { background: var(--accent-soft); border-color: var(--accent-line); color: var(--neon-cyan); }
    .enhance-sub { display: block; font-weight: 400; font-size: var(--fs-xs); color: var(--text-muted); }
    .thermal-legend { margin-top: 8px; }
    .thermal-bar { height: 6px; border-radius: 3px; background: linear-gradient(to right, #38bdf8 0%, #06b6d4 18%, #10b981 35%, #facc15 55%, #f97316 70%, #ef4444 82%, #d946ef 92%, #ffffff 100%); }
    .thermal-scale { display: flex; justify-content: space-between; margin-top: 2px; font-size: var(--fs-xs); color: var(--text-secondary); }
    .hover-readout { display: flex; align-items: center; gap: 6px; margin-top: 8px; padding: 5px 8px; border-radius: 8px; background: var(--surface-3); font-size: 11px; }
    .hover-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .hover-type { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-secondary); }
    .hover-vals { font-weight: 600; color: var(--text-primary); font-variant-numeric: tabular-nums; }
    .opacity { display: block; margin-top: 10px; }
    input[type=range] { width: 100%; margin: 0; accent-color: var(--neon-cyan); cursor: pointer; }
    .note { margin: 10px 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
    /* phones: keep it to a small card (time, slider, view) so the picture stays visible */
    @media (max-width: 700px) {
      .panel { bottom: 84px; width: min(268px, calc(100vw - 24px)); padding: 8px 10px; }
      .heading strong { font-size: 13px; }
      .play { width: 32px; height: 32px; }
      .scan { margin: 6px 0 4px; }
      .ends, .note, .opacity { display: none; }
      .channels, .views { margin-top: 6px; gap: 4px; }
      .enhance { margin-top: 6px; min-height: 28px; padding: 3px 8px; }
      .enhance-sub { display: none; }
      .view { min-height: 28px; font-size: 11px; }
    }
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
    const f = this.sat.current();
    if (!f) return 'loading';
    if (f.product.id === 'wv') return 'water vapour 6.2 µm';
    if (f.product.id === 'ir') return 'infrared 10.8 µm';
    return isTwilightTime(f.timeMs) ? 'twilight HRV + IR' : 'daylight, HRV';
  });
  protected readonly enhanceNote = computed(() => {
    if (!this.sat.enhance()) return 'Off: as EUMETSAT sends it';
    const f = this.sat.current();
    if (!f) return '';
    return f.product.id === 'hrv' ? 'Natural colour, sharpened by the HRV' : 'Pixel steps smoothed';
  });
  protected readonly sourceLabel = SATELLITE_NAME;
  protected readonly note = `Last hour, every 15 minutes. HRV by day (blended with IR at dawn/dusk), IR 10.8 µm and WV 6.2 µm 24/7. ${SATELLITE_CREDIT}`;
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
