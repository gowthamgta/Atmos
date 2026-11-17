import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { IconComponent } from '../../shared/icon.component';
import { LightningKeyComponent } from '../map/lightning-key.component';
import { MapLayerService } from '../../core/services/map-layer.service';
import { productForTime } from '../../core/satellite/satellite.config';
import { SatelliteService } from '../../core/satellite/satellite.service';
import { AmvService } from '../../core/satellite/amv.service';
import { MapHostService } from '../../core/ui/map-host.service';
import { cloudTopGradient, greyScaleTempFromMeasured } from '../../core/satellite/satellite-image';
import { CUSTOM_PRESETS, CUSTOM_SOURCES, CustomChannel, DEFAULT_CUSTOM as DEFAULT_RECIPE, OWN_KINDS, OWN_SATELLITES, OwnKind, OwnSatellite } from '../../core/satellite/own-products';

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
              <strong>{{ ownSat().name }}</strong>
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
          <div class="channel" role="group" aria-label="Satellite">
              @for (s of ownSatellites; track s.id) {
                <button type="button" [class.on]="sat.ownSatellite() === s.id" [attr.aria-pressed]="sat.ownSatellite() === s.id" (click)="sat.setOwnSatellite(s.id)">{{ s.name }}</button>
              }
            </div>
            <div class="channel view3d" role="group" aria-label="Picture">
              <button type="button" [class.on]="sat.source() === 'rgb'" [attr.aria-pressed]="sat.source() === 'rgb'" (click)="pick('rgb')" title="The visible picture in its own colours (by day)">RGB</button>
              <button type="button" [class.on]="sat.source() === 'infrared'" [attr.aria-pressed]="sat.source() === 'infrared'" (click)="pick('infrared')" title="Cloud-top temperature in Windy's colours, day and night">Infrared</button>
            </div>
            @if (sat.ownEmpty() === 'night') {
              <p class="hint3d">The RGB needs daylight: the infrared takes over at night.</p>
            } @else if (sat.ownEmpty() === 'none') {
              <p class="hint3d">Nothing published yet: the first pictures come with the next run of the satellite workflow.</p>
            }
            <p class="hint3d full-only">{{ ownSat().note }}</p>

            <!-- Satellite Winds (AMV) Section with Height Level Selector -->
            <div class="amv-section full-only">
              <div class="amv-toggle-row">
                <button type="button" class="btn-amv" [class.on]="amv.active()" (click)="amv.toggleActive()" title="Dual-Satellite Atmospheric Motion Vectors">
                  <span class="amv-dot" [class.active]="amv.active()"></span>
                  <strong>Satellite Winds (AMV)</strong>
                </button>
                @if (amv.active()) {
                  <div class="amv-badge-group">
                    <span class="amv-badge">{{ activeVectorCount() }} vectors</span>
                    @if (amv.currentFrameTimeLabel()) {
                      <span class="amv-run-pill" title="AMV satellite run time">{{ amv.currentFrameTimeLabel() }}</span>
                    }
                  </div>
                }
              </div>

              @if (amv.active()) {
                @if (amv.activeCyclones().length > 0) {
                  <div class="amv-cyclone-card">
                    @for (cyc of amv.activeCyclones(); track cyc.id) {
                      <div class="amv-cyc-header">
                        <span class="amv-cyc-badge" [style.background]="cyc.classColor">{{ cyc.className }}</span>
                        <strong class="amv-cyc-name">{{ cyc.name }} ({{ cyc.id }})</strong>
                        <button type="button" class="btn-locate-eye" (click)="locateEye(cyc.lat, cyc.lon)" title="Center map on eye">
                          Locate Eye
                        </button>
                      </div>
                      <div class="amv-cyc-metrics">
                        <span class="cyc-pos">Eye: <strong>{{ cyc.lat }}°N, {{ cyc.lon }}°E</strong></span>
                        @if (cyc.pMsl) {
                          <span class="cyc-p">{{ cyc.pMsl }} hPa</span>
                        }
                        @if (cyc.windKt) {
                          <span class="cyc-wind">{{ cyc.windKt }} kt ({{ cyc.windKmh }} km/h)</span>
                        }
                      </div>
                      @if (cyc.motion) {
                        <div class="amv-cyc-motion">
                          <span class="motion-icon">🧭</span>
                          <span>Moving <strong>{{ cyc.motion.dirText }} ({{ cyc.motion.bearingDeg }}°)</strong> at <strong>{{ cyc.motion.speedKmh }} km/h</strong></span>
                        </div>
                      }
                      <div class="amv-cyc-origin">
                        <span>Tracked from {{ cyc.startPoint.lat }}°N, {{ cyc.startPoint.lon }}°E (+{{ cyc.historyHours }}h elapsed)</span>
                      </div>
                    }
                  </div>
                }

                <div class="amv-level-row" role="group" aria-label="Wind altitude level">
                  <button type="button" [class.on]="amv.layerFilter() === 'low'" (click)="amv.setLayerFilter('low')" title="Surface to 700 hPa boundary layer flow">Low (&le;700)</button>
                  <button type="button" [class.on]="amv.layerFilter() === 'mid'" (click)="amv.setLayerFilter('mid')" title="700 to 400 hPa mid-tropospheric flow">Mid (700–400)</button>
                  <button type="button" [class.on]="amv.layerFilter() === 'high'" (click)="amv.setLayerFilter('high')" title="Upper-level jet stream and cirrus outflow (&lt;400 hPa)">High (&lt;400)</button>
                  <button type="button" [class.on]="amv.layerFilter() === 'all'" (click)="amv.setLayerFilter('all')" title="All atmosphere levels combined">All</button>
                </div>

                <div class="amv-style-row" role="group" aria-label="Wind visualization style">
                  <button type="button" [class.on]="amv.style() === 'particles'" (click)="amv.setStyle('particles')" title="Animated particle streamlines like the forecast wind layer">Flow Particles</button>
                  <button type="button" [class.on]="amv.style() === 'arrows'" (click)="amv.setStyle('arrows')" title="Directional wind arrows">Arrows</button>
                  <button type="button" [class.on]="amv.style() === 'barbs'" (click)="amv.setStyle('barbs')" title="Meteorological wind barbs">Barbs</button>
                </div>

                <div class="amv-height-info">
                  @switch (amv.layerFilter()) {
                    @case ('low') {
                      <span>Altitude: <strong>~1.5 km</strong> (Surface – 700 hPa Boundary Layer)</span>
                    }
                    @case ('mid') {
                      <span>Altitude: <strong>~3–7 km</strong> (700 – 400 hPa Mid-Troposphere)</span>
                    }
                    @case ('high') {
                      <span>Altitude: <strong>~7–14 km</strong> (400 – 150 hPa Cirrus Jet)</span>
                    }
                    @default {
                      <span>Altitude: <strong>All Levels</strong> (Surface to 150 hPa)</span>
                    }
                  }
                </div>

                @if (amv.style() === 'particles') {
                  <div class="amv-particles-hint">Particle ribbons flow along atmospheric currents</div>
                } @else {
                  <div class="amv-legend">
                    <span class="leg-item"><span class="leg-color c-black"></span>&lt;10 kt</span>
                    <span class="leg-item"><span class="leg-color c-green"></span>10–20</span>
                    <span class="leg-item"><span class="leg-color c-yellow"></span>20–30</span>
                    <span class="leg-item"><span class="leg-color c-orange"></span>30–40</span>
                    <span class="leg-item"><span class="leg-color c-red"></span>&gt;40 kt</span>
                  </div>
                  @if (amv.hoveredVector(); as hv) {
                    <div class="amv-readout" aria-live="polite">
                      <span class="amv-spd">{{ hv.speed }} m/s ({{ hv.speed_kt ? Math.round(hv.speed_kt) : Math.round(hv.speed * 1.94384) }} kt · {{ Math.round(hv.speed * 3.6) }} km/h) · {{ hv.dir }}°</span>
                      <span class="amv-meta">
                        {{ hv.p }} hPa (~{{ hv.z ? (hv.z / 1000).toFixed(1) : '1.5' }} km) · {{ hv.sat }}
                      </span>
                    </div>
                  }
                }
              }
            </div>
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
    .amv-section { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--glass-border); }
    .amv-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .btn-amv { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border: 1px solid var(--glass-border); border-radius: 7px; background: var(--surface-3); color: var(--text-secondary); font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; transition: background 0.15s, color 0.15s; }
    .btn-amv:hover { background: var(--surface-4); color: var(--text-primary); }
    .btn-amv.on { background: var(--surface-4); border-color: var(--neon-cyan); color: var(--neon-cyan); }
    .amv-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); flex-shrink: 0; }
    .amv-dot.active { background: var(--neon-cyan); box-shadow: 0 0 6px var(--neon-cyan); }
    .amv-badge-group { display: inline-flex; align-items: center; gap: 6px; }
    .amv-badge { font-size: 11px; font-weight: 600; color: var(--text-muted); }
    .amv-run-pill { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 4px; background: rgba(56, 189, 248, 0.12); color: var(--neon-cyan); border: 1px solid rgba(56, 189, 248, 0.28); }
    .amv-level-row { display: flex; gap: 2px; margin-top: 6px; padding: 2px; border-radius: 7px; background: var(--surface-3); }
    .amv-level-row button { flex: 1; padding: 3px 4px; border: 0; border-radius: 5px; background: transparent; color: var(--text-secondary); font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; text-align: center; transition: background 0.15s, color 0.15s; }
    .amv-level-row button:hover { background: var(--surface-4); color: var(--text-primary); }
    .amv-level-row button.on { background: var(--accent); color: #fff; }
    .amv-style-row { display: flex; gap: 2px; margin-top: 5px; padding: 2px; border-radius: 7px; background: var(--surface-3); }
    .amv-style-row button { flex: 1; padding: 3px 4px; border: 0; border-radius: 5px; background: transparent; color: var(--text-secondary); font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; text-align: center; transition: background 0.15s, color 0.15s; }
    .amv-style-row button:hover { background: var(--surface-4); color: var(--text-primary); }
    .amv-style-row button.on { background: var(--accent); color: #fff; }
    .amv-particles-hint { font-size: 11px; color: var(--neon-cyan); margin-top: 5px; }
    .amv-height-info { font-size: 11px; color: var(--text-secondary); margin-top: 4px; display: flex; align-items: center; justify-content: space-between; }
    .amv-height-info strong { color: var(--neon-cyan); }
    .amv-legend { display: flex; align-items: center; justify-content: space-between; gap: 4px; margin-top: 6px; font-size: 11px; color: var(--text-muted); }
    .leg-item { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; }
    .leg-color { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
    .leg-color.c-black { background: #475569; border: 1px solid rgba(255,255,255,0.5); }
    .leg-color.c-green { background: #4ade80; }
    .leg-color.c-yellow { background: #fbbf24; }
    .leg-color.c-orange { background: #fb923c; }
    .leg-color.c-red { background: #f87171; }
    .amv-readout { margin-top: 5px; padding: 4px 6px; border-radius: 6px; background: var(--surface-2); font-size: 11px; display: flex; flex-direction: column; gap: 1px; }
    .amv-spd { font-weight: 700; color: var(--neon-cyan); }
    .amv-meta { color: var(--text-secondary); }
    .amv-cyclone-card {
      margin-top: 8px;
      margin-bottom: 4px;
      padding: 8px 10px;
      border-radius: 8px;
      background: linear-gradient(135deg, rgba(239, 68, 68, 0.14), rgba(15, 23, 42, 0.85));
      border: 1px solid rgba(239, 68, 68, 0.4);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .amv-cyc-header {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .amv-cyc-badge {
      font-size: 9.5px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 1px 6px;
      border-radius: 4px;
      color: #fff;
      letter-spacing: 0.5px;
    }
    .amv-cyc-name {
      font-size: 12px;
      font-weight: 700;
      color: #fff;
      flex: 1;
    }
    .btn-locate-eye {
      padding: 2px 7px;
      border-radius: 5px;
      border: 1px solid rgba(56, 189, 248, 0.45);
      background: rgba(56, 189, 248, 0.15);
      color: var(--neon-cyan);
      font: inherit;
      font-size: 10.5px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .btn-locate-eye:hover {
      background: var(--neon-cyan);
      color: #0b1120;
    }
    .amv-cyc-metrics {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 10px;
      font-size: 11px;
      color: var(--text-primary);
    }
    .cyc-pos strong { color: #f87171; }
    .cyc-p { color: var(--text-secondary); }
    .cyc-wind { color: #facc15; font-weight: 600; }
    .amv-cyc-motion {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: #38bdf8;
      background: rgba(56, 189, 248, 0.1);
      padding: 3px 6px;
      border-radius: 5px;
    }
    .amv-cyc-motion strong { color: #fff; }
    .motion-icon { font-size: 12px; }
    .amv-cyc-origin {
      font-size: 10px;
      color: var(--text-muted);
    }
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
  protected readonly presets = CUSTOM_PRESETS;
  protected isPreset(recipe: readonly CustomChannel[]): boolean {
    const c = this.sat.custom();
    return recipe.every((r, i) => c[i] && r.source === c[i].source && r.min === c[i].min && r.max === c[i].max && r.gamma === c[i].gamma);
  }
  protected readonly sat = inject(SatelliteService);
  protected readonly amv = inject(AmvService);
  private readonly layers = inject(MapLayerService);
  private readonly mapHost = inject(MapHostService);
  protected readonly Math = Math;
  protected readonly gradient = cloudTopGradient();
  protected readonly legendMarks = MEASURED_MARKS;

  protected readonly active = computed(() => this.layers.layers().some(l => l.id === 'satellite' && l.active));
  protected readonly count = computed(() => this.sat.frames().length);
  protected readonly activeVectorCount = computed(() => this.amv.filteredGeoJson()?.count ?? 0);
  protected readonly failed = this.sat.failed;
  protected readonly opacityPercent = computed(() => Math.round(this.sat.opacity() * 100));
  /** The picture on the map is the infrared (night, or the night side of the twilight): the colour bar explains its colours. */
  protected readonly nightLegend = computed(() => this.sat.current()?.own.kind === 'infrared');
  /** Night over India: the visible picture is the infrared too, so there is nothing to choose between. */
  protected readonly night = computed(() => {
    const f = this.sat.current();
    return productForTime(f ? f.timeMs : Date.now()).id === 'ir'; // before a picture is there, the clock says
  });
  protected readonly nightHint = 'At night the visible picture is the infrared as well';
  /** Nothing to play or step through: the loop is loaded and has fewer than two pictures. (Until Play, only the newest three are loaded.) */
  protected readonly noLoop = computed(() => this.count() < 2 && this.sat.historyRequested());
  protected readonly historyHint = computed(() => this.count() > 0 && !this.sat.historyRequested());
  protected readonly productLabel = computed(() => {
    const f = this.sat.current();
    return f ? (OWN_KINDS.find(k => k.id === f.own.kind)?.label ?? '') : 'loading';
  });
  protected readonly ownSat = computed(() => OWN_SATELLITES[this.sat.ownSatellite()]);
  protected readonly ownKinds = computed(() => OWN_KINDS.filter(k => this.ownSat().kinds.includes(k.id)));
  protected readonly ownSatellites = (Object.keys(OWN_SATELLITES) as OwnSatellite[]).map(id => ({ id, name: OWN_SATELLITES[id].name }));
  protected readonly customSources = CUSTOM_SOURCES;
  protected readonly readoutTitle = computed(() => {
    const m = this.sat.hoverReading()?.measured;
    if (m) {
      const c = (k: number) => (Number.isNaN(k) ? '–' : `${(k - 273.15).toFixed(1)} °C (${k.toFixed(1)} K)`);
      return `Measured by ${this.ownSat().name}: ${this.ownSat().ir} µm ${c(m.ir)}, 6.2 µm ${c(m.wv62)}, 7.3 µm ${c(m.wv73)}`;
    }
    return 'Estimated from the grey of the infrared picture, not measured: good to a few degrees and a couple of kilometres';
  });
  protected readonly ownNote = 'Last 4 hours, made by our satellite workflow from raw satellite data: Meteosat-9 © EUMETSAT, Himawari-9 © JMA (via NOAA Open Data on AWS). The hover readout is measured.';
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
    if (this.ownSat().kinds.includes(kind)) this.sat.pickKind(kind);
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

  protected locateEye(lat: number, lon: number): void {
    this.mapHost.flyTo(lat, lon, 7.5);
  }
}
