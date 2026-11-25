import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { IconComponent } from '../../shared/icon.component';
import { LightningKeyComponent } from '../map/lightning-key.component';
import { MapLayerService } from '../../core/services/map-layer.service';
import { SatelliteService } from '../../core/satellite/satellite.service';
import { cloudTopGradient, greyScaleTempFromMeasured } from '../../core/satellite/satellite-image';
import { OwnKind } from '../../core/satellite/own-products';

const IST_OFFSET_MS = 5.5 * 3_600_000;

/** "14:45 IST" for a time in epoch ms. */
function istClock(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} IST`;
}

/** Where the labels of the cloud-top colour bar sit along it: the bar runs from +20 °C on the left to -85 °C on the right. */
/** The same bar for our infrared, labelled with measured temperatures (the colours sit where greyScaleTempFromMeasured puts them). */
const MEASURED_MARKS = [0, -20, -40, -60].map(t => ({ label: `${t}°`, left: ((20 - greyScaleTempFromMeasured(t)) / 105) * 100 }));

/** Controls for the live satellite picture (Meteosat-9): the frame loop, the Cloud-Top hover readout, and opacity. */
@Component({
  selector: 'app-satellite-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, LightningKeyComponent],
  template: `
    @if (active()) {
      <section class="panel glass-panel" [class.compact]="!expanded()" aria-label="Satellite settings">
        <header>
          <span class="live" [class.off]="failed()" aria-hidden="true"></span>
          <div class="heading">
            <div class="title-row">
              <strong>Global Satellite</strong>
            </div>
            <span class="sub">Observed, {{ productLabel() }}</span>
          </div>
          <div class="playback" role="group" aria-label="Playback controls">
            <button type="button" class="btn-step" (click)="sat.step(-1)" [disabled]="noLoop()" aria-label="Previous frame" title="Previous frame">
              <app-icon name="prev" [size]="11" />
            </button>
            <button type="button" class="play" (click)="sat.togglePlay()" [disabled]="noLoop()" [attr.aria-label]="sat.playing() ? 'Pause loop' : 'Play loop'" [title]="sat.playing() ? 'Pause loop' : 'Play loop'">
              <app-icon [name]="sat.playing() ? 'pause' : 'play'" [size]="13" />
            </button>
            <button type="button" class="btn-step" (click)="sat.step(1)" [disabled]="noLoop()" aria-label="Next frame" title="Next frame">
              <app-icon name="next" [size]="11" />
            </button>
            <button type="button" class="btn-step more" (click)="expanded.set(!expanded())" [attr.aria-expanded]="expanded()" [attr.aria-label]="expanded() ? 'Show less' : 'Show more'" [title]="expanded() ? 'Show less' : 'Show more'">
              <app-icon name="chevron" [size]="12" [style.transform]="expanded() ? 'rotate(180deg)' : ''" />
            </button>
          </div>
        </header>

        @if (failed()) {
          <p class="msg">The satellite service did not answer. It will try again in a few minutes.</p>
        } @else {
            <div class="channel view3d" role="group" aria-label="Picture">
              <button type="button" [class.on]="sat.source() === 'rgb'" [attr.aria-pressed]="sat.source() === 'rgb'" (click)="pick('rgb')" title="Global True Colour (day) &amp; IR clouds (night) from best satellite view angles">RGB</button>
              <button type="button" [class.on]="sat.source() === 'infrared'" [attr.aria-pressed]="sat.source() === 'infrared'" (click)="pick('infrared')" title="Global cloud-top brightness temperature in Windy colours, day and night">Infrared</button>
            </div>
            <p class="hint3d full-only">{{ ownNote }}</p>
          <div class="scan">
            <span>{{ timeLabel() }}</span>
            <span class="age">@if (sat.updatedAgoMinutes() !== null) { Updated {{ sat.updatedAgoMinutes()! < 1 ? 'just now' : sat.updatedAgoMinutes() + ' min ago' }} } @else if (sat.ageMinutes() !== null) { {{ sat.ageMinutes() }} min old } @else { Loading… }</span>
          </div>
          <input type="range" class="frames" min="0" [max]="Math.max(count() - 1, 0)" step="0.01" [value]="sat.position()" [disabled]="noLoop()" (input)="onFrame($event)" aria-label="Satellite time" />
          <div class="ends full-only"><span>{{ firstLabel() }}</span><span>{{ lastLabel() }}</span></div>
          @if (sat.loading()) { <div class="loading">Loading pictures…</div> }
          @else if (historyHint()) { <div class="loading">Press play to load the last 4 hours.</div> }
        }

        @if (nightLegend()) {
          <div class="cloud-legend full-only" role="img" aria-label="Cloud-top temperature (°C): the colder the top, the brighter the colour">
            <div class="label">Cloud-top temperature (°C)</div>
            <div class="cloud-bar" [style.background]="gradient"></div>
            <div class="cloud-scale">
              @for (m of legendMarks; track m.label) { <span [style.left.%]="m.left">{{ m.label }}</span> }
            </div>
          </div>
        }

        <!-- always there, at a fixed height, so the panel does not jump as the pointer moves on and off the cloud -->
        <div class="hover-readout" aria-live="polite" [title]="readoutTitle()">
          @if (sat.hoverReading(); as h) {
            <span class="hover-dot" [style.background]="h.color"></span>
            <span class="hover-type">{{ h.label }}</span>
            @if (h.measured; as m) {
              <span class="hover-vals">{{ h.tempC > 0 ? '+' : '' }}{{ h.tempC }}°C · {{ m.ir.toFixed(1) }} K</span>
            } @else {
              <span class="hover-vals">≈ {{ h.tempC > 0 ? '+' : '' }}{{ h.tempC }}°C · {{ h.heightKm }} km</span>
            }
          } @else {
            <span class="hover-type idle">Hover the map to read cloud tops</span>
          }
        </div>

        <label class="opacity full-only">
          <span class="label">Opacity <span class="value">{{ opacityPercent() }}%</span></span>
          <input type="range" min="0.2" max="1" step="0.05" [value]="sat.opacity()" (input)="onOpacity($event)" aria-label="Satellite opacity" />
        </label>
        <app-lightning-key class="full-only" />
        <p class="note full-only">{{ ownNote }}</p>
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
    .channel { display: flex; gap: 2px; margin-top: 10px; padding: 2px; border-radius: 9px; background: var(--surface-3); }
    .channel button { flex: 1; padding: 5px 8px; border: 0; border-radius: 7px; background: transparent; color: var(--text-secondary); font: inherit; font-weight: 600; cursor: pointer; }
    .channel.off button { opacity: 0.5; cursor: default; }
    .channel button.on { background: var(--accent); color: #fff; }
    .view3d { margin-top: 6px; }
    .kinds { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .kind { padding: 4px 8px; border: 0; border-radius: 12px; background: var(--surface-3); color: var(--text-secondary); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
    .kind.on { background: var(--accent); color: #fff; }
    .custom { display: grid; gap: 4px; margin-top: 6px; font-size: 12px; }
    .crow { display: grid; grid-template-columns: 16px 1fr 52px 52px 44px; gap: 4px; align-items: center; }
    .crow select, .crow input { min-width: 0; padding: 3px 4px; border: 1px solid var(--surface-4); border-radius: 6px; background: var(--surface-2); color: var(--text-primary); font: inherit; font-size: 12px; }
    .cname { font-weight: 700; text-align: center; }
    .cname.c0 { color: #ef4444; }
    .cname.c1 { color: #22c55e; }
    .cname.c2 { color: #3b82f6; }
    .reset { justify-self: end; padding: 3px 8px; border: 0; border-radius: 6px; background: var(--surface-3); color: var(--text-secondary); font: inherit; font-size: 11px; cursor: pointer; }
    .hint3d { margin: 6px 0 0; font-size: 11px; line-height: 1.4; color: var(--text-secondary); }
    .scan { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin: 10px 0 6px; color: var(--text-secondary); }
    .age { font-weight: 600; color: var(--text-primary); }
    .ends { display: flex; justify-content: space-between; font-size: var(--fs-xs); color: var(--text-muted); margin-top: 2px; }
    .loading, .msg { margin: 6px 0 0; color: var(--text-secondary); font-size: 11px; }
    .label { display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 4px; }
    .value { color: var(--text-primary); float: right; font-weight: 600; }
    .cloud-legend { margin-top: 8px; }
    .cloud-bar { height: 8px; border-radius: 4px; box-shadow: inset 0 0 0 1px var(--line-strong); }
    .cloud-scale { position: relative; height: 14px; margin-top: 2px; font-size: var(--fs-xs); color: var(--text-secondary); font-variant-numeric: tabular-nums; }
    .cloud-scale span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
    .hover-readout { display: flex; align-items: center; gap: 6px; margin-top: 8px; padding: 0 8px; height: 28px; box-sizing: border-box; border-radius: 8px; background: var(--surface-3); font-size: 11px; }
    .hover-type.idle { color: var(--text-muted); }
    .hover-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .hover-type { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-secondary); }
    .hover-vals { font-weight: 600; color: var(--text-primary); font-variant-numeric: tabular-nums; }
    .opacity { display: block; margin-top: 10px; }
    input[type=range] { width: 100%; margin: 0; accent-color: var(--neon-cyan); cursor: pointer; }
    .note { margin: 10px 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .presets { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    /* compact (phones by default): the satellite, the pictures in one row that scrolls, the time and the slider */
    .panel.compact .full-only { display: none; }
    .panel.compact .kinds { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
    .panel.compact .kinds::-webkit-scrollbar { display: none; }
    .panel.compact .kind { flex: none; }
    .panel.compact .hover-readout { display: none; }
    /* a touch screen has no pointer to hover with */
    @media (pointer: coarse) { .hover-readout { display: none; } }
    /* phones: keep it to a small card (time, slider) so the picture stays visible */
    @media (max-width: 700px) {
      .panel { bottom: 84px; width: min(280px, calc(100vw - 24px)); padding: 8px 10px; }
      .heading strong { font-size: 13px; }
      .playback { gap: 3px; }
      .play { width: 30px; height: 28px; }
      .btn-step { width: 24px; height: 28px; }
      .scan { margin: 6px 0 4px; }
      .ends, .note, .opacity { display: none; }
    }
  `]
})
export class SatellitePanelComponent {
  /** Phones start with the compact panel (the full one covered most of the screen); larger screens start expanded. */
  protected readonly expanded = signal(typeof window === 'undefined' || window.innerWidth > 700);
  protected readonly sat = inject(SatelliteService);
  private readonly layers = inject(MapLayerService);
  protected readonly Math = Math;
  protected readonly gradient = cloudTopGradient();
  protected readonly legendMarks = MEASURED_MARKS;

  protected readonly active = computed(() => this.layers.layers().some(l => l.id === 'satellite' && l.active));
  protected readonly count = computed(() => this.sat.frames().length);
  protected readonly failed = this.sat.failed;
  protected readonly opacityPercent = computed(() => Math.round(this.sat.opacity() * 100));
  /** The picture on the map is the infrared: the colour bar explains its colours. */
  protected readonly nightLegend = computed(() => this.sat.source() === 'infrared');
  protected readonly noLoop = computed(() => this.count() < 2 && this.sat.historyRequested());
  protected readonly historyHint = computed(() => this.count() > 0 && !this.sat.historyRequested());
  protected readonly productLabel = computed(() => (this.sat.source() === 'rgb' ? 'Cloud RGB' : 'Infrared'));
  protected readonly readoutTitle = computed(() => {
    const m = this.sat.hoverReading()?.measured;
    if (m) {
      const c = (k: number) => (Number.isNaN(k) ? '–' : `${(k - 273.15).toFixed(1)} °C (${k.toFixed(1)} K)`);
      return `Measured cloud-top IR temperature: ${c(m.ir)}`;
    }
    return 'Hover the map anywhere to read cloud-top temperature and height';
  });
  protected readonly ownNote = 'Best-view-angle global mosaic: GOES-West, GOES-East, Meteosat-0°, Meteosat-9 & Himawari-9.';
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

  protected pick(kind: OwnKind): void {
    this.sat.pickKind(kind);
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
