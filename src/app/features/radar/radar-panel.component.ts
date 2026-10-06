import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { MapLayerService } from '../../core/services/map-layer.service';
import { RadarService } from '../../core/services/radar.service';
import { StormTracksService } from '../../core/services/storm-tracks.service';
import { RadarProductKey } from '../../core/domain/models/radar.model';

interface ProductOption {
  key: RadarProductKey;
  name: string;
  hint: string;
  title: string;
}

const PRODUCTS: readonly ProductOption[] = [
  { key: 'caz', name: 'Merged', hint: 'CAZ + PPZ', title: 'Column maximum (CAZ, reaches furthest) and reflectivity sweep (PPZ) merged into one picture' },
  { key: 'ppi', name: 'PPI', hint: 'Base scan', title: 'Plan Position Indicator (lowest base reflectivity sweep), shown on its own' },
];

/** "14:45" (IST) for a time in epoch ms. */
function istClock(ms: number): string {
  const d = new Date(ms + 5.5 * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

const FRESHNESS_LABEL: Record<string, string> = {
  fresh: 'Fresh',
  recent: 'Recent',
  stale: 'Old',
  offline: 'Offline',
  syncing: 'Syncing',
};

/** The IMD radar is observed data (a nowcast of what is falling now), so its menu only needs the merged picture's freshness, the last-hour loop and opacity. */
@Component({
  selector: 'app-radar-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (active()) {
      <section class="panel glass-panel" [class.compact]="!expanded()" aria-label="Radar settings">
        <header>
          <span class="live" aria-hidden="true"></span>
          <div class="heading">
            <strong>IMD radar</strong>
            <span class="sub full-only">Observed now, not a forecast</span>
            <span class="sub compact-only" [attr.data-state]="freshness()">{{ compactStatus() }}</span>
          </div>
          <button type="button" class="icon-btn" (click)="refresh()" [disabled]="refreshing()" aria-label="Refresh radar" title="Refresh radar">
            {{ refreshing() ? '…' : '⟳' }}
          </button>
          <button type="button" class="icon-btn" (click)="expanded.set(!expanded())" [attr.aria-expanded]="expanded()" [attr.aria-label]="expanded() ? 'Show less' : 'Show more'" [title]="expanded() ? 'Show less' : 'Show more'">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true" [style.transform]="expanded() ? 'rotate(180deg)' : ''"><path d="m6 15 6-6 6 6"/></svg>
          </button>
        </header>

        <div class="scan full-only">
          <span>{{ scanLabel() }}</span>
          @if (age() !== null) {
            <span class="age" [attr.data-state]="freshness()">{{ age() }} min ago · {{ freshnessLabel() }}</span>
          } @else {
            <span class="age" data-state="syncing">Syncing…</span>
          }
        </div>

        <div class="products" role="group" aria-label="Radar scan mode">
          @for (p of products; track p.key) {
            <button type="button" class="prod" [class.active]="product() === p.key" [attr.aria-pressed]="product() === p.key" [title]="p.title" (click)="setProduct(p.key)">
              <span class="pname">{{ p.name }}</span>
              <span class="phint">{{ p.hint }}</span>
            </button>
          }
        </div>

        @if (historyAvailable()) {
          <div class="loop" role="group" aria-label="Last hour of radar">
            <button type="button" class="icon-btn play" (click)="radar.togglePlay()" [disabled]="loopLoading() && frames().length === 0"
              [attr.aria-label]="playing() ? 'Pause' : 'Play the last hour'" [title]="playing() ? 'Pause' : 'Play the last hour'">
              {{ playing() ? '❚❚' : '▶' }}
            </button>
            @if (frames().length > 0) {
              <input type="range" class="scrub" min="0" [max]="frames().length" step="1" [value]="sliderValue()" (input)="onScrub($event)" aria-label="Radar time" />
            } @else {
              <span class="loop-hint">{{ loopLoading() ? 'Building last hour… ' + progressPercent() + '%' : 'Last hour' }}</span>
            }
            <span class="loop-time" [class.live-time]="radar.playIndex() === null">{{ loopLabel() }}</span>
          </div>
        }

        <button type="button" class="storm-toggle full-only" [class.active]="storms.enabled()" [attr.aria-pressed]="storms.enabled()" (click)="storms.toggle()"
          title="Storm cells with the area they are expected to cross in the next hour">
          <span class="cone" aria-hidden="true"></span>
          <span class="storm-text">Storm tracks <span class="storm-sub">{{ stormSummary() }}</span></span>
        </button>

        <div class="stations full-only">
          <div class="label">Radars online: {{ online() }} of {{ stations.length }}</div>
          <div class="chips">
            @for (st of stations; track st.id) {
              <button type="button" class="chip" [class.active]="activeId() === st.id" [title]="st.fullName + ' · ' + stationStateLabel(st.id)" (click)="select(st.id)">
                <span class="dot" [attr.data-state]="stationState(st.id)"></span>
                {{ shortName(st.name) }}
                <span class="chip-age">{{ stationAge(st.id) }}</span>
              </button>
            }
          </div>
        </div>

        <label class="opacity full-only">
          <span class="label">Opacity <span class="value">{{ opacityPercent() }}%</span></span>
          <input type="range" min="0.2" max="1" step="0.05" [value]="opacity()" (input)="setOpacity($event)" aria-label="Radar opacity" />
        </label>

        <div class="legend" role="img" [attr.aria-label]="legendTitle()">
          <div class="label full-only">{{ legendTitle() }}</div>
          <div class="bar"></div>
          <div class="scale full-only">
            @for (t of legendTicks(); track t) { <span>{{ t }}</span> }
          </div>
        </div>
      </section>
    }
  `,
  styles: [`
    :host { display: contents; }
    .panel { position: fixed; left: 12px; bottom: 12px; z-index: 900; width: min(300px, calc(100vw - 24px)); padding: 12px 14px; color: var(--text-primary); font-family: var(--font-body); font-size: 12px; max-height: calc(100vh - 100px); overflow-y: auto; }
    header { display: flex; align-items: center; gap: 10px; }
    .live { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 8px #22c55e; flex: none; }
    .heading { flex: 1; min-width: 0; }
    .heading strong { display: block; font-size: 14px; }
    .sub { color: var(--text-muted); font-size: 11px; }
    .icon-btn { display: grid; place-items: center; width: 36px; height: 36px; flex: none; border-radius: 10px; border: 1px solid var(--glass-border); background: rgba(255,255,255,0.06); color: var(--text-primary); font-size: 18px; cursor: pointer; }
    .icon-btn:hover:not(:disabled) { background: rgba(255,255,255,0.14); }
    .icon-btn:disabled { opacity: 0.5; cursor: progress; }
    .icon-btn svg { transition: transform 0.2s; }
    .compact-only { display: none; }
    .products { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; margin-top: 10px; }
    .prod { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; min-height: 42px; padding: 5px 4px; border-radius: 10px; border: 1px solid transparent; background: rgba(255,255,255,0.05); color: var(--text-secondary); cursor: pointer; transition: background 0.15s, border-color 0.15s, color 0.15s; }
    .prod:hover { background: rgba(255,255,255,0.1); color: var(--text-primary); }
    .prod.active { background: rgba(0,229,255,0.16); border-color: rgba(0,229,255,0.5); color: var(--neon-cyan); }
    .pname { font-weight: 700; font-size: 13px; }
    .phint { font-size: 10px; opacity: 0.8; }
    .loop { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
    .loop .play { width: 32px; height: 32px; font-size: 13px; }
    .scrub { flex: 1; min-width: 0; margin: 0; accent-color: var(--neon-cyan); cursor: pointer; }
    .loop-hint { flex: 1; color: var(--text-secondary); font-size: 11px; }
    .loop-time { flex: none; min-width: 64px; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
    .loop-time.live-time { color: #4ade80; }
    .storm-toggle { display: flex; align-items: center; gap: 8px; width: 100%; margin-top: 10px; padding: 6px 10px; min-height: 36px; border-radius: 10px;
      border: 1px solid transparent; background: rgba(255,255,255,0.05); color: var(--text-secondary); font: 600 12px var(--font-body); cursor: pointer; text-align: left; }
    .storm-toggle:hover { background: rgba(255,255,255,0.1); }
    .storm-toggle.active { background: rgba(251,191,36,0.12); border-color: rgba(251,191,36,0.5); color: #fde68a; }
    .cone { width: 18px; height: 12px; flex: none; background: linear-gradient(90deg, rgba(251,191,36,0.9), rgba(251,191,36,0.15)); clip-path: polygon(0 40%, 100% 0, 100% 100%, 0 60%); }
    .storm-sub { display: block; font-weight: 400; font-size: 10px; color: var(--text-muted); }
    .panel.compact .loop { margin-top: 8px; }
    .sub[data-state='fresh'] { color: #4ade80; }
    .sub[data-state='recent'] { color: #facc15; }
    .sub[data-state='stale'] { color: #fb923c; }
    .sub[data-state='offline'] { color: #f87171; }
    /* compact: one header line, the product buttons, the loop and a thin colour bar */
    .panel.compact { padding: 8px 10px; }
    .panel.compact .full-only { display: none; }
    .panel.compact .compact-only { display: block; }
    .panel.compact header { gap: 8px; }
    .panel.compact .heading strong { font-size: 13px; }
    .panel.compact .compact-only { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .panel.compact .icon-btn { width: 32px; height: 32px; font-size: 16px; }
    .panel.compact .products { margin-top: 8px; gap: 4px; }
    .panel.compact .prod { min-height: 32px; padding: 3px 2px; flex-direction: row; justify-content: center; gap: 4px; }
    .panel.compact .pname { font-size: 12px; }
    .panel.compact .phint { display: none; }
    .panel.compact .legend { margin-top: 8px; }
    .panel.compact .bar { height: 5px; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--neon-cyan); outline-offset: 2px; }
    .scan { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin: 10px 0 8px; color: var(--text-secondary); }
    .age { font-weight: 600; color: var(--text-primary); }
    .age[data-state='fresh'] { color: #4ade80; }
    .age[data-state='recent'] { color: #facc15; }
    .age[data-state='stale'] { color: #fb923c; }
    .age[data-state='offline'] { color: #f87171; }
    .stations { margin-top: 10px; }
    .label { color: var(--text-muted); font-size: 11px; margin-bottom: 4px; }
    .value { color: var(--text-primary); float: right; font-weight: 600; }
    .chips { display: flex; flex-wrap: wrap; gap: 5px; }
    .chip { display: inline-flex; align-items: center; gap: 5px; padding: 4px 8px; min-height: 28px; border-radius: 14px; border: 1px solid transparent; background: rgba(255,255,255,0.05); color: var(--text-secondary); font-size: 11px; cursor: pointer; }
    .chip:hover { background: rgba(255,255,255,0.1); }
    .chip.active { border-color: rgba(0,229,255,0.5); color: var(--text-primary); }
    .chip-age { color: var(--text-muted); font-size: 10px; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #64748b; }
    .dot[data-state='fresh'] { background: #22c55e; }
    .dot[data-state='recent'] { background: #eab308; }
    .dot[data-state='stale'] { background: #f97316; }
    .dot[data-state='offline'] { background: #ef4444; }
    .opacity { display: block; margin-top: 10px; }
    input[type=range] { width: 100%; margin: 0; accent-color: var(--neon-cyan); cursor: pointer; }
    .legend { margin-top: 10px; }
    .bar { height: 7px; border-radius: 4px; background: linear-gradient(to right, #3ad9e4 0%, #00a33f 20%, #afc600 40%, #facc15 60%, #ef4444 80%, #a855f7 100%); }
    .scale { display: flex; justify-content: space-between; margin-top: 3px; font-size: 10px; color: var(--text-secondary); }
    @media (max-width: 700px) { .panel { bottom: 84px; width: min(260px, calc(100vw - 24px)); } }
  `]
})
export class RadarPanelComponent {
  private readonly layers = inject(MapLayerService);

  protected readonly radar = inject(RadarService);
  protected readonly storms = inject(StormTracksService);
  protected readonly frames = this.radar.history;
  protected readonly playing = this.radar.playing;
  protected readonly loopLoading = this.radar.historyLoading;
  protected readonly historyAvailable = this.radar.historyAvailable;
  protected readonly progressPercent = computed(() => Math.round(this.radar.historyProgress() * 100));
  /** Slider: one notch per loop frame, and the last notch is the live picture. */
  protected readonly sliderValue = computed(() => this.radar.playIndex() ?? this.frames().length);
  protected readonly loopLabel = computed(() => {
    const i = this.radar.playIndex();
    const t = i === null ? this.radar.compositeMosaic()?.timing?.epochMs : this.frames()[i]?.timeMs;
    return t ? `${i === null ? 'Live ' : ''}${istClock(t)}` : i === null ? 'Live' : '';
  });
  protected readonly stormSummary = computed(() => {
    const { count, source } = this.storms.summary();
    if (!this.storms.enabled()) return 'Off';
    if (count === 0) return 'No storm cells now';
    const how = source === 'radar' ? 'motion from radar' : source === 'wind' ? 'motion from steering wind' : 'motion unknown';
    return `${count} cell${count > 1 ? 's' : ''} · ${how}`;
  });
  /** Phones start with the compact panel (it would cover half the map); larger screens start expanded. */
  protected readonly expanded = signal(typeof window === 'undefined' || window.innerWidth > 700);
  /** One-line status for the compact panel: scan age and freshness. */
  protected readonly compactStatus = computed(() => {
    const age = this.age();
    if (age === null) return 'Syncing…';
    return `${age} min · ${FRESHNESS_LABEL[this.freshness()] ?? ''} · ${this.online()}/${this.stations.length} on`;
  });
  protected readonly active = computed(() => this.layers.layers().some(l => l.id === 'radar' && l.active));

  protected readonly products = PRODUCTS;
  protected readonly product = this.radar.activeProduct;
  protected readonly opacity = this.radar.radarOpacity;
  protected readonly stations = this.radar.stations;
  protected readonly activeId = this.radar.activeStationId;
  protected readonly refreshing = this.radar.isRefreshing;
  protected readonly age = this.radar.activeStationAgeMinutes;
  protected readonly freshness = this.radar.activeStationFreshness;
  protected readonly online = this.radar.displayedStationsCount;

  protected readonly opacityPercent = computed(() => Math.round(this.opacity() * 100));
  protected readonly freshnessLabel = computed(() => FRESHNESS_LABEL[this.freshness()] ?? '');
  protected readonly scanLabel = computed(() => {
    const p = this.product();
    const st = this.shortName(this.radar.activeStation().name);
    const t = this.radar.observationTiming();
    const mode = p === 'ppi' ? 'PPI sweep' : 'merged scan (CAZ + PPZ)';
    return t?.ist ? `${st} ${mode} ${t.ist}` : `${st} ${mode}`;
  });

  protected readonly legendTitle = computed(() => 'Reflectivity (dBZ)');
  protected readonly legendTicks = computed(() => ['17', '28', '39', '50', '60+']);

  constructor() {
    // On larger screens the last hour is built as soon as the radar is shown (phones wait for the play button, since
    // the animations are several megabytes), and refreshed every 10 minutes while the radar stays on.
    effect(() => {
      const on = this.active();
      const product = this.product();
      // the live stills are part of the loop, so wait until every radar's has been fetched
      const liveReady = this.radar.compositeMosaic() !== null && !this.radar.isRefreshing();
      untracked(() => {
        if (on && liveReady && typeof window !== 'undefined' && window.innerWidth > 700 && this.frames().length === 0) void this.radar.loadHistory();
        if (!on) this.radar.pause();
      });
      void product;
    });
    const timer = setInterval(() => {
      if (this.active() && this.frames().length > 0 && !this.playing()) void this.radar.loadHistory();
    }, 10 * 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected onScrub(event: Event): void {
    this.radar.pause();
    const v = Number((event.target as HTMLInputElement).value);
    this.radar.setPlayIndex(v >= this.frames().length ? null : v);
  }

  protected shortName(name: string): string {
    return name.replace(' X-DWR', '').replace(' DWR', '');
  }

  protected stationState(id: string): string {
    return this.radar.getStationFreshness(id);
  }

  protected stationStateLabel(id: string): string {
    return FRESHNESS_LABEL[this.radar.getStationFreshness(id)] ?? '';
  }

  protected stationAge(id: string): string {
    const m = this.radar.getStationAge(id);
    if (m === null || this.radar.getStationFreshness(id) === 'offline') return '—'; // an offline radar has no meaningful age
    return m >= 120 ? `${Math.round(m / 60)}h` : `${m}m`;
  }

  protected setProduct(key: RadarProductKey): void {
    this.radar.setProduct(key);
  }

  protected select(id: string): void {
    this.radar.selectStation(id);
  }

  protected refresh(): void {
    this.radar.fetchRadarSweep();
  }

  protected setOpacity(event: Event): void {
    const value = parseFloat((event.target as HTMLInputElement).value);
    this.radar.setOpacity(value);
    this.layers.setLayerOpacity('radar', value);
  }
}
