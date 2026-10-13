import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, untracked } from '@angular/core';
import { IconComponent } from '../../shared/icon.component';
import { MapLayerService } from '../../core/services/map-layer.service';
import { SATELLITE_CREDIT, SATELLITE_NAME, isTwilightTime } from '../../core/satellite/satellite.config';
import { SatelliteService } from '../../core/satellite/satellite.service';
import { SatelliteDetailService } from '../../core/satellite/satellite-detail.service';

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
            <div class="title-row">
              <strong>{{ sourceLabel }}</strong>
              @if (detailActive()) {
                <span class="hd-badge" [class.loading]="detailLoading()" title="High-resolution 0.8 km HRV window active on viewport">
                  {{ detailLoading() ? 'HD loading…' : 'HD 0.8 km' }}
                </span>
              }
            </div>
            <span class="sub">Observed, {{ productLabel() }}</span>
          </div>
          <div class="playback" role="group" aria-label="Playback controls">
            <button type="button" class="btn-step" (click)="sat.step(-1)" [disabled]="count() < 2" aria-label="Previous frame" title="Previous frame (15 min)">
              <app-icon name="prev" [size]="11" />
            </button>
            <button type="button" class="play" (click)="sat.togglePlay()" [disabled]="count() < 2" [attr.aria-label]="sat.playing() ? 'Pause loop' : 'Play loop'" [title]="sat.playing() ? 'Pause loop' : 'Play loop'">
              <app-icon [name]="sat.playing() ? 'pause' : 'play'" [size]="13" />
            </button>
            <button type="button" class="btn-step" (click)="sat.step(1)" [disabled]="count() < 2" aria-label="Next frame" title="Next frame (15 min)">
              <app-icon name="next" [size]="11" />
            </button>
          </div>
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
    .panel { position: fixed; left: 12px; bottom: 12px; z-index: 900; width: min(316px, calc(100vw - 24px)); padding: 12px 14px; color: var(--text-primary); font-family: var(--font-body); font-size: 12px; }
    header { display: flex; align-items: center; gap: 10px; }
    .live { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); box-shadow: none; flex: none; }
    .live.off { background: var(--danger); box-shadow: none; }
    .heading { flex: 1; min-width: 0; }
    .title-row { display: flex; align-items: center; gap: 6px; }
    .heading strong { display: block; font-size: 14px; white-space: nowrap; }
    .hd-badge { display: inline-flex; align-items: center; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 4px; background: rgba(6, 182, 212, 0.16); border: 1px solid rgba(6, 182, 212, 0.45); color: var(--neon-cyan); letter-spacing: 0.02em; white-space: nowrap; line-height: 1.3; }
    .hd-badge.loading { animation: pulse-glow 1.4s ease-in-out infinite alternate; opacity: 0.85; }
    @keyframes pulse-glow { from { opacity: 0.55; } to { opacity: 1; } }
    .sub { color: var(--text-muted); font-size: 11px; }
    .playback { display: flex; align-items: center; gap: 4px; flex: none; }
    .btn-step { width: 26px; height: 32px; border-radius: 8px; border: 1px solid var(--glass-border); background: var(--surface-3); color: var(--text-secondary); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; transition: background 0.15s, color 0.15s; }
    .btn-step:hover:not(:disabled) { background: var(--surface-4); color: var(--text-primary); }
    .btn-step:disabled { opacity: 0.35; cursor: default; }
    .play { width: 34px; height: 32px; border-radius: 8px; border: 1px solid var(--glass-border); background: var(--surface-3); color: var(--text-primary); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; }
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
      .panel { bottom: 84px; width: min(280px, calc(100vw - 24px)); padding: 8px 10px; }
      .heading strong { font-size: 13px; }
      .playback { gap: 3px; }
      .play { width: 30px; height: 28px; }
      .btn-step { width: 24px; height: 28px; }
      .scan { margin: 6px 0 4px; }
      .ends, .note, .opacity { display: none; }
      .channels, .views { margin-top: 6px; gap: 4px; }
      .view { min-height: 28px; font-size: 11px; }
    }
  `]
})
export class SatellitePanelComponent {
  protected readonly sat = inject(SatelliteService);
  private readonly detail = inject(SatelliteDetailService);
  private readonly layers = inject(MapLayerService);
  protected readonly Math = Math;

  protected readonly active = computed(() => this.layers.layers().some(l => l.id === 'satellite' && l.active));
  protected readonly count = computed(() => this.sat.frames().length);
  protected readonly failed = this.sat.failed;
  protected readonly detailActive = computed(() => this.detail.shown() !== null);
  protected readonly detailLoading = this.detail.loading;
  protected readonly opacityPercent = computed(() => Math.round(this.sat.opacity() * 100));
  protected readonly productLabel = computed(() => {
    const f = this.sat.current();
    if (!f) return 'loading';
    if (f.product.id === 'wv') return 'water vapour 6.2 µm';
    if (f.product.id === 'ir') return 'infrared 10.8 µm';
    return isTwilightTime(f.timeMs) ? 'twilight HRV + IR' : 'daylight, HRV';
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

  @HostListener('keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this.sat.step(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      this.sat.step(1);
    } else if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      this.sat.togglePlay();
    }
  }

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
