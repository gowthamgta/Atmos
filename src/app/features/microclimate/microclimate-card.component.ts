import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';
import { MicroclimateService } from '../../core/microclimate/microclimate.service';
import {
  DistrictMicroclimate,
  compassPoint,
  districtNames,
  floodTone,
  heatTone,
  istLabel,
  rainSentence,
  seaBreezeSentence,
  stepIndex,
  valuesAt,
} from '../../core/microclimate/microclimate.model';
import { PanelService } from '../../core/ui/panel.service';

/**
 * Tamil Nadu district microclimate: the values of one district at the selected forecast time, and the indicators for the
 * next day (heat, rain timing, sea breeze, flood risk). Built from the all-model blend averaged over the district; no station data.
 */
@Component({
  selector: 'app-microclimate-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <div class="backdrop" (click)="panels.close('microclimate')" aria-hidden="true"></div>
      <section class="panel glass-panel-solid" role="dialog" aria-label="Tamil Nadu microclimate">
        <header>
          <div class="heading">
            <strong>Tamil Nadu microclimate</strong>
            <span class="sub">District averages · model run {{ runLabel() }}</span>
          </div>
          <button type="button" class="close" (click)="panels.close('microclimate')" aria-label="Close" title="Close (Esc)">×</button>
        </header>

        @if (data(); as d) {
          <label class="picker">
            <span class="sr">District</span>
            <select (change)="onDistrict($event)" aria-label="District">
              @for (name of names(); track name) {
                <option [value]="name" [selected]="name === selectedName()">{{ name }}</option>
              }
            </select>
          </label>

          @if (district(); as dist) {
            <p class="when">At {{ whenLabel() }}</p>
            <div class="now">
              <div class="big">
                <span class="temp">{{ fmt(now().tempC, 0) }}<small>°C</small></span>
                <span class="feels">feels {{ fmt(now().heatIndexC, 0) }}°C</span>
              </div>
              <ul class="facts">
                <li><span>Humidity</span><b>{{ fmt(now().rhPct, 0) }}%</b></li>
                <li><span>Wind</span><b>{{ windText() }}</b></li>
                <li><span>Rain now</span><b>{{ fmt(now().precipMmH, 1) }} mm/h</b></li>
                <li><span>Rain chance, next 24 h</span><b>{{ pct(now().chancePct) }}</b></li>
              </ul>
            </div>

            <h3>Next 24 hours</h3>
            <ul class="indicators">
              <li>
                <span class="tag" [attr.data-tone]="heatTone(dist.indicators.heat.band)">Heat</span>
                <div>
                  <b>{{ dist.indicators.heat.band }}</b>
                  <span>{{ heatText(dist) }}</span>
                </div>
              </li>
              <li>
                <span class="tag" data-tone="none">Rain</span>
                <div>
                  <span>{{ rainText(dist) }}</span>
                </div>
              </li>
              <li>
                <span class="tag" [attr.data-tone]="seaTone(dist)">Sea breeze</span>
                <div><span>{{ seaText(dist) }}</span></div>
              </li>
              <li>
                <span class="tag" [attr.data-tone]="floodTone(dist.indicators.flood.band)">Flood</span>
                <div>
                  <b>{{ dist.indicators.flood.band }}</b>
                  <span>{{ floodText(dist) }}</span>
                </div>
              </li>
            </ul>
          }
        } @else if (failed()) {
          <p class="msg">The microclimate is not published yet. It appears after the next model update.</p>
        } @else {
          <p class="msg">Loading…</p>
        }

        <p class="note">
          Model values averaged over each district, with the terrain correction. There is no station data yet, so these
          indicators are not checked against observations; treat them as the models' view. © ECMWF open data and the other models in the blend.
        </p>
      </section>
    }
  `,
  styles: [`
    :host { display: contents; }
    .backdrop { position: fixed; inset: 0; z-index: 899; background: rgba(4, 8, 16, 0.35); }
    .panel { position: fixed; top: 64px; right: 12px; z-index: 900; width: min(340px, calc(100vw - 24px)); max-height: calc(100vh - 88px); overflow: auto; padding: 14px 16px; color: var(--text-primary); font-family: var(--font-body); font-size: 12px; }
    header { display: flex; align-items: flex-start; gap: 10px; }
    .heading { flex: 1; min-width: 0; }
    .heading strong { display: block; font-size: 15px; }
    .sub { color: var(--text-muted); font-size: 11px; }
    .close { background: none; border: 0; color: var(--text-secondary); font-size: 22px; cursor: pointer; line-height: 1; }
    button:focus-visible, select:focus-visible { outline: 2px solid var(--neon-cyan); outline-offset: 2px; }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    .picker select { width: 100%; margin-top: 10px; min-height: 36px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05); color: var(--text-primary); font: 600 13px var(--font-body); padding: 0 8px; }
    .when { margin: 10px 0 0; color: var(--text-secondary); font-size: 11px; }
    .now { display: flex; gap: 14px; align-items: center; margin-top: 6px; }
    .big { display: flex; flex-direction: column; min-width: 96px; }
    .temp { font-size: 38px; font-weight: 700; line-height: 1; }
    .temp small { font-size: 16px; font-weight: 500; margin-left: 2px; }
    .feels { color: var(--text-muted); font-size: 11px; margin-top: 4px; }
    .facts { list-style: none; margin: 0; padding: 0; flex: 1; display: grid; gap: 4px; }
    .facts li { display: flex; justify-content: space-between; gap: 8px; color: var(--text-secondary); }
    .facts b { color: var(--text-primary); font-weight: 600; }
    h3 { margin: 14px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); font-weight: 600; }
    .indicators { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    .indicators li { display: flex; gap: 10px; align-items: flex-start; }
    .indicators div { display: flex; flex-direction: column; gap: 1px; color: var(--text-secondary); }
    .indicators b { color: var(--text-primary); }
    .tag { flex: none; min-width: 74px; text-align: center; padding: 3px 6px; border-radius: 8px; font-size: 11px; font-weight: 600; background: rgba(255,255,255,0.08); color: var(--text-secondary); }
    .tag[data-tone='ok'] { background: rgba(34,197,94,0.18); color: #7ee0a4; }
    .tag[data-tone='watch'] { background: rgba(250,204,21,0.18); color: #facc15; }
    .tag[data-tone='warn'] { background: rgba(249,115,22,0.2); color: #fb923c; }
    .tag[data-tone='alert'] { background: rgba(239,68,68,0.22); color: #f87171; }
    .msg { margin: 10px 0 0; color: var(--text-secondary); }
    .note { margin: 14px 0 0; font-size: 10px; color: var(--text-muted); }
  `],
})
export class MicroclimateCardComponent {
  protected readonly panels = inject(PanelService);
  private readonly service = inject(MicroclimateService);
  private readonly forecast = inject(ForecastStateService);

  protected readonly open = computed(() => this.panels.open() === 'microclimate');
  protected readonly data = this.service.data;
  protected readonly failed = this.service.failed;
  protected readonly selectedName = signal('Chennai');
  protected readonly names = computed(() => (this.data() ? districtNames(this.data()!) : []));
  protected readonly runLabel = computed(() => {
    const run = this.data()?.run;
    return run ? `${run.slice(6, 8)}/${run.slice(4, 6)} ${run.slice(9, 11)}:00 UTC` : '';
  });

  protected readonly district = computed<DistrictMicroclimate | null>(() => {
    const d = this.data();
    return d ? d.districts.find(x => x.name === this.selectedName()) ?? null : null;
  });

  /** The forecast step shown: the timeline's time, or now when there is none. */
  private readonly stepIdx = computed(() => {
    const d = this.data();
    if (!d) return -1;
    return stepIndex(d.times, this.forecast.timeMs() ?? Date.now());
  });

  protected readonly whenLabel = computed(() => {
    const d = this.data();
    return d && this.stepIdx() >= 0 ? istLabel(d.times[this.stepIdx()]) : '';
  });

  protected readonly now = computed(() => {
    const dist = this.district();
    return dist ? valuesAt(dist, this.stepIdx()) : valuesAt({ series: {} } as DistrictMicroclimate, -1);
  });

  constructor() {
    // loaded the first time the card opens, then kept
    effect(() => {
      if (this.open()) this.service.load();
    });
  }

  protected heatTone = heatTone;
  protected floodTone = floodTone;

  protected onDistrict(event: Event): void {
    this.selectedName.set((event.target as HTMLSelectElement).value);
  }

  protected fmt(v: number | null, digits: number): string {
    return v === null || !Number.isFinite(v) ? '–' : v.toFixed(digits);
  }

  protected pct(v: number | null): string {
    return v === null || !Number.isFinite(v) ? '–' : `${Math.round(v)}%`;
  }

  protected windText(): string {
    const v = this.now();
    if (v.windMs === null) return '–';
    const from = compassPoint(v.windFromDeg);
    return `${Math.round(v.windMs * 3.6)} km/h${from ? ` from ${from}` : ''}`;
  }

  protected heatText(d: DistrictMicroclimate): string {
    const h = d.indicators.heat;
    if (h.peakC === null) return 'No data';
    return `feels up to ${Math.round(h.peakC)}°C at ${istLabel(h.peakTime)}`;
  }

  protected rainText(d: DistrictMicroclimate): string {
    return rainSentence(d.indicators.rain);
  }

  protected seaTone(d: DistrictMicroclimate): 'ok' | 'watch' | 'none' {
    const s = d.indicators.seaBreeze;
    if (!s) return 'none';
    return s.likely ? 'ok' : 'watch';
  }

  protected seaText(d: DistrictMicroclimate): string {
    return seaBreezeSentence(d.indicators.seaBreeze);
  }

  protected floodText(d: DistrictMicroclimate): string {
    const f = d.indicators.flood;
    if (f.peakMm === null) return 'No data';
    const chance = f.chance50Pct === null ? '' : ` · chance of 50 mm or more ${Math.round(f.chance50Pct)}%`;
    return `up to ${Math.round(f.peakMm)} mm in 24 h, ${istLabel(f.peakTime)}${chance}`;
  }
}
