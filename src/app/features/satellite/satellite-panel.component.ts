import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, untracked } from '@angular/core';
import { IconComponent } from '../../shared/icon.component';
import { MapLayerService } from '../../core/services/map-layer.service';
import { SATELLITE_CREDIT, SATELLITE_NAME, isTwilightTime, productForTime } from '../../core/satellite/satellite.config';
import { SatelliteService } from '../../core/satellite/satellite.service';
import { SatelliteDetailService } from '../../core/satellite/satellite-detail.service';
import { cloudTopGradient } from '../../core/satellite/satellite-image';
import { CUSTOM_SOURCES, CustomChannel, DEFAULT_CUSTOM as DEFAULT_RECIPE, OWN_KINDS, OWN_SATELLITES, OwnKind, OwnSatellite } from '../../core/satellite/own-products';

const IST_OFFSET_MS = 5.5 * 3_600_000;

/** "14:45 IST" for a time in epoch ms. */
function istClock(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} IST`;
}

/** Where the labels of the cloud-top colour bar sit along it: the bar runs from +20 °C on the left to -85 °C on the right. */
const LEGEND_MARKS = [-20, -40, -60, -80].map(t => ({ label: `${t}°`, left: ((20 - t) / 105) * 100 }));

/** Controls for the live satellite picture (Meteosat-9): the frame loop, the Cloud-Top hover readout, and opacity. */
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
              <strong>{{ own() ? ownSat().name : sourceLabel }}</strong>
              @if (detailActive()) {
                <span class="hd-badge" [class.loading]="detailLoading()" title="The part of the map in view is drawn from a closer picture of the HRV, at the satellite's own pixel (about 1.3 km)">
                  {{ detailLoading() ? 'HD loading…' : 'HD ' + detailKm() + ' km' }}
                </span>
              }
            </div>
            <span class="sub">Observed, {{ productLabel() }}</span>
          </div>
          <div class="playback" role="group" aria-label="Playback controls">
            <button type="button" class="btn-step" (click)="sat.step(-1)" [disabled]="noLoop()" aria-label="Previous frame" title="Previous frame (15 min)">
              <app-icon name="prev" [size]="11" />
            </button>
            <button type="button" class="play" (click)="sat.togglePlay()" [disabled]="noLoop()" [attr.aria-label]="sat.playing() ? 'Pause loop' : 'Play loop'" [title]="sat.playing() ? 'Pause loop' : 'Play loop'">
              <app-icon [name]="sat.playing() ? 'pause' : 'play'" [size]="13" />
            </button>
            <button type="button" class="btn-step" (click)="sat.step(1)" [disabled]="noLoop()" aria-label="Next frame" title="Next frame (15 min)">
              <app-icon name="next" [size]="11" />
            </button>
          </div>
        </header>

        @if (failed()) {
          <p class="msg">The satellite service did not answer. It will try again in a few minutes.</p>
        } @else {
          <div class="channel" role="group" aria-label="Source">
            <button type="button" [class.on]="!own()" [attr.aria-pressed]="!own()" (click)="sat.setSource('eumetview')" title="EUMETView's pictures of Meteosat-9 (the usual look)">EUMETView</button>
            <button type="button" [class.on]="own()" [attr.aria-pressed]="own()" (click)="sat.setSource(lastOwn)" title="Our own pictures, made from Himawari-9's raw bands every 10 minutes">Our own</button>
          </div>
          @if (own()) {
            <div class="channel view3d" role="group" aria-label="Satellite">
              @for (s of ownSatellites; track s.id) {
                <button type="button" [class.on]="sat.ownSatellite() === s.id" [attr.aria-pressed]="sat.ownSatellite() === s.id" (click)="sat.setOwnSatellite(s.id)">{{ s.name }}</button>
              }
            </div>
            <div class="kinds" role="group" aria-label="Product">
              @for (k of ownKinds(); track k.id) {
                <button type="button" class="kind" [class.on]="sat.source() === k.id" [attr.aria-pressed]="sat.source() === k.id" [title]="k.title" (click)="pick(k.id)">{{ k.label }}</button>
              }
            </div>
            @if (sat.source() === 'custom') {
              <div class="custom" aria-label="Custom RGB recipe: value = ((v − min) / (max − min)) ^ (1 / gamma)">
                @for (c of sat.custom(); track $index; let i = $index) {
                  <div class="crow">
                    <span class="cname" [class]="'cname c' + i">{{ 'RGB'[i] }}</span>
                    <select [value]="c.source" (change)="setCustom(i, 'source', $event)" [attr.aria-label]="'RGB'[i] + ' from'">
                      @for (o of customSources; track o.id) { <option [value]="o.id" [selected]="o.id === c.source">{{ o.label }}</option> }
                    </select>
                    <input type="number" step="1" [value]="c.min" (change)="setCustom(i, 'min', $event)" [attr.aria-label]="'RGB'[i] + ' min (K)'" title="min (K)" />
                    <input type="number" step="1" [value]="c.max" (change)="setCustom(i, 'max', $event)" [attr.aria-label]="'RGB'[i] + ' max (K)'" title="max (K)" />
                    <input type="number" step="0.1" min="0.1" [value]="c.gamma" (change)="setCustom(i, 'gamma', $event)" [attr.aria-label]="'RGB'[i] + ' gamma'" title="gamma" />
                  </div>
                }
                <button type="button" class="reset" (click)="resetCustom()">Reset recipe</button>
              </div>
            }
            @if (sat.ownEmpty() === 'night') {
              <p class="hint3d">This picture needs daylight (the visible channels): at night try Night micro or the infrared kinds.</p>
            } @else if (sat.ownEmpty() === 'none') {
              <p class="hint3d">Nothing published yet: the first pictures come with the next run of the satellite workflow (every 10 minutes).</p>
            }
            <p class="hint3d">{{ ownSat().note }}</p>
          } @else {
          <div class="channel" role="group" aria-label="Picture" [class.off]="night()">
            <button type="button" [class.on]="!sat.infraredOnly() && !night()" [attr.aria-pressed]="!sat.infraredOnly()" [disabled]="night()" (click)="sat.setInfrared(false)" [title]="night() ? nightHint : ''">Visible</button>
            <button type="button" [class.on]="sat.infraredOnly() || night()" [attr.aria-pressed]="sat.infraredOnly() || night()" [disabled]="night()" (click)="sat.setInfrared(true)" [title]="night() ? nightHint : 'Infrared: cloud-top temperature, day and night'">Infrared</button>
          </div>
          <div class="channel view3d" role="group" aria-label="View">
            <button type="button" [class.on]="!sat.threeD()" [attr.aria-pressed]="!sat.threeD()" (click)="sat.setThreeD(false)">Flat</button>
            <button type="button" [class.on]="sat.threeD()" [attr.aria-pressed]="sat.threeD()" (click)="sat.setThreeD(true)" title="The clouds of the live picture in 3D at their heights: tops from the infrared temperature, thickness from the visible brightness">3D clouds</button>
          </div>
          @if (sat.threeD()) {
            <div class="heights">
              <span>Heights</span>
              <div class="channel" role="group" aria-label="Height scale">
                @for (k of heightScales; track k) {
                  <button type="button" [class.on]="sat.heightScale() === k" [attr.aria-pressed]="sat.heightScale() === k" (click)="sat.setHeightScale(k)" [title]="k === 1 ? 'True scale' : 'Heights stretched ' + k + ' times'">{{ k === 1 ? 'True' : '×' + k }}</button>
                }
              </div>
            </div>
            <p class="hint3d">Tops from the cloud-top temperature, thickness from how bright the cloud is; the small billows are drawn, not measured. Tilt with right-drag or two fingers.</p>
          }
          }
          <div class="scan">
            <span>{{ timeLabel() }}</span>
            <span class="age">@if (sat.ageMinutes() !== null) { {{ sat.ageMinutes() }} min old } @else { Loading… }</span>
          </div>
          <input type="range" class="frames" min="0" [max]="Math.max(count() - 1, 0)" step="0.01" [value]="sat.position()" [disabled]="noLoop()" (input)="onFrame($event)" aria-label="Satellite time" />
          <div class="ends"><span>{{ firstLabel() }}</span><span>{{ lastLabel() }}</span></div>
          @if (sat.loading()) { <div class="loading">Loading pictures…</div> }
          @else if (historyHint()) { <div class="loading">Press play to load the last hour.</div> }
        }

        @if (nightLegend()) {
          <div class="cloud-legend" role="img" aria-label="Cloud-top temperature (°C): the colder the top, the brighter the colour">
            <div class="label">Cloud-top temperature (°C)</div>
            <div class="cloud-bar" [style.background]="gradient"></div>
            <div class="cloud-scale">
              @for (m of marks; track m.label) { <span [style.left.%]="m.left">{{ m.label }}</span> }
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

        <label class="opacity">
          <span class="label">Opacity <span class="value">{{ opacityPercent() }}%</span></span>
          <input type="range" min="0.2" max="1" step="0.05" [value]="sat.opacity()" (input)="onOpacity($event)" aria-label="Satellite opacity" />
        </label>
        <p class="note">{{ own() ? ownNote : note }}</p>
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
    .hd-badge { display: inline-flex; align-items: center; font-size: var(--fs-xs); font-weight: 700; padding: 1px 6px; border-radius: 4px; background: rgba(6, 182, 212, 0.16); border: 1px solid rgba(6, 182, 212, 0.45); color: var(--neon-cyan); letter-spacing: 0.02em; white-space: nowrap; line-height: 1.3; }
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
    .heights { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px; color: var(--text-secondary); }
    .heights .channel { flex: 1; margin-top: 0; }
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
  protected readonly sat = inject(SatelliteService);
  private readonly detail = inject(SatelliteDetailService);
  private readonly layers = inject(MapLayerService);
  protected readonly Math = Math;
  protected readonly gradient = cloudTopGradient();
  protected readonly marks = LEGEND_MARKS;

  protected readonly active = computed(() => this.layers.layers().some(l => l.id === 'satellite' && l.active));
  protected readonly count = computed(() => this.sat.frames().length);
  protected readonly failed = this.sat.failed;
  protected readonly detailActive = computed(() => this.detail.shown() !== null && this.sat.source() === 'eumetview');
  protected readonly detailLoading = this.detail.loading;
  /** The pixel of the closer picture on the map, to a tenth of a kilometre. */
  protected readonly detailKm = computed(() => (this.detail.shown()?.window.kmPerPx ?? 0).toFixed(1));
  protected readonly opacityPercent = computed(() => Math.round(this.sat.opacity() * 100));
  /** The picture on the map is the infrared (night, or the night side of the twilight): the colour bar explains its colours. */
  protected readonly nightLegend = computed(() => {
    const f = this.sat.current();
    return !!f && !f.own && (f.product.id === 'ir' || isTwilightTime(f.timeMs));
  });
  /** Nothing to play or step through: the hour is loaded and has fewer than two pictures. (Until the loop is asked for, only the newest is loaded.) */
  /** Night over India: the visible picture is the infrared too, so there is nothing to choose between. */
  protected readonly night = computed(() => {
    const f = this.sat.current();
    return productForTime(f ? f.timeMs : Date.now()).id === 'ir'; // before a picture is there, the clock says
  });
  protected readonly nightHint = 'At night the visible picture is the infrared as well';
  protected readonly noLoop = computed(() => this.count() < 2 && this.sat.historyRequested());
  protected readonly historyHint = computed(() => this.count() === 1 && !this.sat.historyRequested() && !this.own());
  protected readonly productLabel = computed(() => {
    const f = this.sat.current();
    if (!f) return 'loading';
    if (f.own) return OWN_KINDS.find(k => k.id === f.own!.kind)?.label ?? '';
    if (f.product.id === 'ir') return this.sat.infraredOnly() ? 'infrared, cloud tops' : 'night infrared, cloud tops';
    return isTwilightTime(f.timeMs) ? 'twilight HRV + infrared' : 'daylight, HRV';
  });
  protected readonly sourceLabel = SATELLITE_NAME;
  /** Our own pictures are shown instead of EUMETView's. */
  protected readonly own = computed(() => this.sat.source() !== 'eumetview');
  protected readonly ownSat = computed(() => OWN_SATELLITES[this.sat.ownSatellite()]);
  protected readonly ownKinds = computed(() => OWN_KINDS.filter(k => this.ownSat().kinds.includes(k.id)));
  protected readonly ownSatellites = (Object.keys(OWN_SATELLITES) as OwnSatellite[]).map(id => ({ id, name: OWN_SATELLITES[id].name }));
  protected readonly customSources = CUSTOM_SOURCES;
  /** The kind of our own last picked, for the source switch. */
  protected lastOwn: OwnKind = 'natural';
  protected readonly readoutTitle = computed(() => {
    const m = this.sat.hoverReading()?.measured;
    if (m) {
      const c = (k: number) => (Number.isNaN(k) ? '–' : `${(k - 273.15).toFixed(1)} °C (${k.toFixed(1)} K)`);
      return `Measured by ${this.ownSat().name}: ${this.ownSat().ir} µm ${c(m.ir)}, 6.2 µm ${c(m.wv62)}, 7.3 µm ${c(m.wv73)}`;
    }
    return 'Estimated from the grey of the infrared picture, not measured: good to a few degrees and a couple of kilometres';
  });
  protected readonly heightScales = [1, 3, 6] as const;
  protected readonly ownNote = 'Last hour, made by our satellite workflow from raw satellite data: Meteosat-9 © EUMETSAT, Himawari-9 © JMA (via NOAA Open Data on AWS). The hover readout is measured.';
  protected readonly note = `Last hour, every 15 minutes. HRV (high-resolution visible) by day; at night infrared, with cold cloud tops and high cloud picked out. The Infrared switch shows the infrared by day too. ${SATELLITE_CREDIT}`;
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
    if (!this.ownSat().kinds.includes(kind)) return;
    this.lastOwn = kind;
    this.sat.setSource(kind);
  }

  protected setCustom(i: number, key: keyof CustomChannel, event: Event): void {
    const v = parseFloat((event.target as HTMLInputElement | HTMLSelectElement).value);
    if (!Number.isFinite(v)) return;
    this.sat.setCustom(this.sat.custom().map((c, j) => (j === i ? { ...c, [key]: key === 'gamma' ? Math.max(0.1, v) : v } : c)));
  }

  protected resetCustom(): void {
    this.sat.setCustom(DEFAULT_RECIPE);
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
