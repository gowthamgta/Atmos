import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { IconComponent } from '../../shared/icon.component';
import { MapLayerService } from '../../core/services/map-layer.service';
import { RadarService } from '../../core/services/radar.service';
import { StormTracksService } from '../../core/services/storm-tracks.service';
import { RadarNowcastService } from '../../core/services/radar-nowcast.service';
import { RadarProductKey } from '../../core/domain/models/radar.model';

interface ProductOption {
  key: RadarProductKey;
  name: string;
  hint: string;
  /** How the scan is named in the status line. */
  scan: string;
  title: string;
}

/** Each product is its own picture and downloads only its own pictures (one per radar). */
const PRODUCTS: readonly ProductOption[] = [
  { key: 'caz', name: 'CAZ', hint: 'Column max', scan: 'column maximum (CAZ)', title: 'Column maximum reflectivity (CAZ): the strongest echo in each column of air, out to the range of each radar' },
  { key: 'ppz', name: 'PPZ', hint: 'Reflectivity', scan: 'reflectivity sweep (PPZ)', title: 'Plan Position Indicator reflectivity (PPZ): the radar sweep, out to its longer range (up to 500 km), shown on its own' },
  { key: 'ppi', name: 'PPI', hint: 'Base scan', scan: 'PPI sweep', title: 'Plan Position Indicator (lowest base reflectivity sweep), shown on its own' },
];

const FRESHNESS_LABEL: Record<string, string> = {
  fresh: 'Fresh',
  recent: 'Recent',
  stale: 'Old',
  offline: 'Offline',
  syncing: 'Syncing',
};

/** The IMD radar is observed data (a nowcast of what is falling now), so its menu only needs the picture's freshness, the last-hour loop and opacity. */
@Component({
  selector: 'app-radar-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    @if (active()) {
      <section class="panel glass-panel" [class.compact]="!expanded()" aria-label="Radar settings">
        <header>
          <span class="live" aria-hidden="true"></span>
          <div class="heading">
            <strong>IMD radar</strong>
            <span class="sub full-only" [attr.data-state]="guess() ? 'guess' : null">{{ guess() ?? 'Observed now, not a forecast' }}</span>
            <span class="sub compact-only" [attr.data-state]="guess() ? 'guess' : freshness()">{{ guess() ?? compactStatus() }}</span>
          </div>
          <button type="button" class="icon-btn" (click)="refresh()" [disabled]="refreshing()" aria-label="Refresh radar" title="Refresh radar">
            <app-icon name="refresh" [size]="15" />
          </button>
          <button type="button" class="icon-btn" (click)="expanded.set(!expanded())" [attr.aria-expanded]="expanded()" [attr.aria-label]="expanded() ? 'Show less' : 'Show more'" [title]="expanded() ? 'Show less' : 'Show more'">
            <app-icon name="chevron" [size]="14" [style.transform]="expanded() ? 'rotate(180deg)' : ''" />
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

        <button type="button" class="storm-toggle full-only" [class.active]="storms.enabled()" [attr.aria-pressed]="storms.enabled()" (click)="storms.toggle()"
          title="Storm cells with the area they are expected to cross in the next hour">
          <span class="cone" aria-hidden="true"></span>
          <span class="storm-text">Storm tracks <span class="storm-sub">{{ stormSummary() }}</span></span>
        </button>

        @if (nowcastLine(); as line) {
          <p class="nowcast full-only" role="status">{{ line }}</p>
        }

        <div class="stations full-only">
          <div class="label">Radars online: {{ online() }} of {{ stations.length }} · tap to turn one off</div>
          <div class="chips">
            @for (st of stations; track st.id) {
              <button type="button" class="chip" [class.active]="activeId() === st.id" [class.off]="!shown(st.id)" [attr.aria-pressed]="shown(st.id)"
                [title]="st.fullName + ' · ' + (shown(st.id) ? stationStateLabel(st.id) + ' · tap to turn off' : 'off · tap to turn on')" (click)="toggle(st.id)">
                <span class="switch" aria-hidden="true"></span>
                <span class="dot" [attr.data-state]="stationState(st.id)"></span>
                {{ shortName(st.name) }}
                <span class="chip-age">{{ shown(st.id) ? stationAge(st.id) : 'off' }}</span>
              </button>
            }
          </div>
          @if (scanGap(); as gap) {
            <div class="gap-note" role="status">The radars scanned {{ gap }} min apart: where they overlap, cells can sit in different places.</div>
          }
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
    .panel { position: fixed; left: 12px; bottom: calc(var(--bars-h) + 12px); z-index: 900; width: min(300px, calc(100vw - 24px)); padding: 12px 14px; color: var(--text-primary); font-family: var(--font-body); font-size: 12px; max-height: calc(100vh - 100px); overflow-y: auto; }
    header { display: flex; align-items: center; gap: 10px; }
    .live { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); box-shadow: none; flex: none; }
    .heading { flex: 1; min-width: 0; }
    .heading strong { display: block; font-size: 14px; }
    .sub { color: var(--text-muted); font-size: 11px; }
    .icon-btn { display: grid; place-items: center; width: 36px; height: 36px; flex: none; border-radius: 10px; border: 1px solid var(--glass-border); background: var(--surface-3); color: var(--text-primary); font-size: 18px; cursor: pointer; }
    .icon-btn:hover:not(:disabled) { background: var(--surface-4); }
    .icon-btn:disabled { opacity: 0.5; cursor: progress; }
    .icon-btn svg { transition: transform 0.2s; }
    .compact-only { display: none; }
    .products { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 10px; }
    .prod { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; min-height: 42px; padding: 5px 4px; border-radius: 10px; border: 1px solid transparent; background: var(--surface-3); color: var(--text-secondary); cursor: pointer; transition: background 0.15s, border-color 0.15s, color 0.15s; }
    .prod:hover { background: var(--surface-4); color: var(--text-primary); }
    .prod.active { background: var(--accent-soft); border-color: var(--accent-line); color: var(--neon-cyan); }
    .pname { font-weight: 700; font-size: 13px; }
    .phint { font-size: var(--fs-xs); opacity: 0.8; }
    .nowcast { margin: 8px 2px 0; font-size: var(--fs-xs); line-height: 1.35; color: var(--text-secondary); }
    .storm-toggle { display: flex; align-items: center; gap: 8px; width: 100%; margin-top: 10px; padding: 6px 10px; min-height: 36px; border-radius: 10px;
      border: 1px solid transparent; background: var(--surface-3); color: var(--text-secondary); font: 600 12px var(--font-body); cursor: pointer; text-align: left; }
    .storm-toggle:hover { background: var(--surface-4); }
    .storm-toggle.active { background: rgba(251,191,36,0.12); border-color: rgba(251,191,36,0.5); color: var(--warn); }
    .cone { width: 18px; height: 12px; flex: none; background: linear-gradient(90deg, rgba(251,191,36,0.9), rgba(251,191,36,0.15)); clip-path: polygon(0 40%, 100% 0, 100% 100%, 0 60%); }
    .storm-sub { display: block; font-weight: 400; font-size: var(--fs-xs); color: var(--text-muted); }
    .faint-icon { position: relative; width: 18px; height: 12px; flex: none; }
    .faint-icon::before, .faint-icon::after { content: ''; position: absolute; border-radius: 50%; }
    .faint-icon::before { left: 1px; top: 4px; width: 5px; height: 5px; background: rgba(58, 217, 228, 0.55); }    /* a faint echo */
    .faint-icon::after { right: 1px; top: 1px; width: 9px; height: 9px; background: rgba(250, 204, 21, 0.95); }     /* a firm one */
    .sub[data-state='guess'] { color: var(--warn); font-weight: 600; }
    .sub[data-state='fresh'] { color: var(--ok); }
    .sub[data-state='recent'] { color: var(--warn); }
    .sub[data-state='stale'] { color: var(--warn); }
    .sub[data-state='offline'] { color: var(--danger); }
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
    .age[data-state='fresh'] { color: var(--ok); }
    .age[data-state='recent'] { color: var(--warn); }
    .age[data-state='stale'] { color: var(--warn); }
    .age[data-state='offline'] { color: var(--danger); }
    .stations { margin-top: 10px; }
    .label { color: var(--text-muted); font-size: 11px; margin-bottom: 4px; }
    .value { color: var(--text-primary); float: right; font-weight: 600; }
    .chips { display: flex; flex-wrap: wrap; gap: 5px; }
    .chip { display: inline-flex; align-items: center; gap: 5px; padding: 4px 8px; min-height: 28px; border-radius: 14px; border: 1px solid transparent; background: var(--surface-3); color: var(--text-secondary); font-size: 11px; cursor: pointer; }
    .chip:hover { background: var(--surface-4); }
    .chip.active { border-color: var(--accent-line); color: var(--text-primary); }
    .chip.off { opacity: 0.55; border-color: transparent; text-decoration: line-through; text-decoration-color: var(--text-muted); }
    .switch { position: relative; width: 20px; height: 11px; flex: none; border-radius: 6px; background: var(--accent-line, var(--neon-cyan)); transition: background 0.15s; }
    .switch::after { content: ''; position: absolute; top: 1.5px; left: 10.5px; width: 8px; height: 8px; border-radius: 50%; background: #fff; transition: left 0.15s; }
    .chip.off .switch { background: var(--surface-4); }
    .chip.off .switch::after { left: 1.5px; }
    .gap-note { margin-top: 6px; font-size: var(--fs-xs); color: var(--warn, var(--text-muted)); }
    .chip-age { color: var(--text-muted); font-size: var(--fs-xs); }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); }
    .dot[data-state='fresh'] { background: var(--ok); }
    .dot[data-state='recent'] { background: var(--warn); }
    .dot[data-state='stale'] { background: var(--danger); }
    .dot[data-state='offline'] { background: var(--text-muted); }
    .opacity { display: block; margin-top: 10px; }
    input[type=range] { width: 100%; margin: 0; accent-color: var(--neon-cyan); cursor: pointer; }
    .legend { margin-top: 10px; }
    .bar { height: 7px; border-radius: 4px; background: linear-gradient(to right, #241898 0%, #0e609a 14%, #02998f 28%, #3ecd7d 42%, #afd42c 55%, #ebcf16 64%, #f19f21 76%, #cd5846 88%, #91126a 100%); }
    .scale { display: flex; justify-content: space-between; margin-top: 3px; font-size: var(--fs-xs); color: var(--text-secondary); }
    @media (max-width: 700px) { .panel { width: min(260px, calc(100vw - 24px)); } }
  `]
})
export class RadarPanelComponent {
  private readonly layers = inject(MapLayerService);

  protected readonly radar = inject(RadarService);
  protected readonly storms = inject(StormTracksService);
  protected readonly frames = this.radar.history;
  protected readonly playing = this.radar.playing;
  protected readonly nowcast = inject(RadarNowcastService);
  /** While a picture of the nowcast is on the map, the panel says it is a guess (empty otherwise). */
  protected readonly guess = computed(() => {
    const i = this.radar.leadIndex();
    const frame = i === null ? null : this.radar.nowcast()[i];
    return frame ? `Nowcast +${frame.leadMin} min: a guess, not observed` : null;
  });
  /** What the nowcast rests on, and how it did on the last hour (nothing until there is something to say). */
  protected readonly nowcastLine = computed(() => {
    const motion = this.nowcast.motion();
    if (!motion || this.radar.nowcast().length === 0) return '';
    const how = motion.source === 'radar' ? `rain followed over the last ${Math.round(motion.minutes ?? 30)} minutes` : 'no earlier picture yet: moved with the forecast wind';
    const skill = this.nowcast.skill();
    const check = skill ? ` On the last hour a ${skill.leadMin}-minute guess matched ${Math.round(skill.nowcast * 100)}% of the rain area (a picture that did not move: ${Math.round(skill.still * 100)}%).` : '';
    return `Nowcast: ${how}.${check}`;
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
    const mode = PRODUCTS.find(o => o.key === this.product())?.scan ?? '';
    const st = this.shortName(this.radar.activeStation().name);
    const t = this.radar.observationTiming();
    return t?.ist ? `${st} ${mode} ${t.ist}` : `${st} ${mode}`;
  });

  protected readonly legendTitle = computed(() => 'Reflectivity (dBZ)');
  protected readonly legendTicks = computed(() => ['17', '28', '39', '50', '60+']);

  constructor() {
    // On larger screens the last hour is built as soon as the radar is shown (phones wait for the play button, since
    // the animations are several megabytes), and rebuilt every hour while the radar stays on (each new live picture joins it in between).
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
    }, 60 * 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
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

  /** Minutes between the oldest and the newest scan of the radars that are showing, when it is long enough to move a cell (null otherwise). */
  protected readonly scanGap = computed(() => {
    const ages = this.stations.filter(st => this.shown(st.id)).map(st => this.radar.getStationAge(st.id)).filter((m): m is number => m !== null && m <= 180);
    if (ages.length < 2) return null;
    const gap = Math.max(...ages) - Math.min(...ages);
    return gap >= 10 ? gap : null;
  });

  protected stationAge(id: string): string {
    const m = this.radar.getStationAge(id);
    if (m === null || this.radar.getStationFreshness(id) === 'offline') return '—'; // an offline radar has no meaningful age
    return m >= 120 ? `${Math.round(m / 60)}h` : `${m}m`;
  }

  protected setProduct(key: RadarProductKey): void {
    this.radar.setProduct(key);
  }

  protected shown(id: string): boolean {
    return this.radar.isStationShown(id);
  }

  /** A tap turns the radar off or on (the last one on stays on); turning one on also makes it the radar the status line is about. */
  protected toggle(id: string): void {
    const wasShown = this.shown(id);
    this.radar.toggleStation(id);
    if (!wasShown) this.radar.selectStation(id);
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
