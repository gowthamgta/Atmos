import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { IconComponent } from '../../shared/icon.component';
import { LightningKeyComponent } from '../map/lightning-key.component';
import { MapLayerService } from '../../core/services/map-layer.service';
import { RadarService } from '../../core/services/radar.service';
import { StormTracksService } from '../../core/services/storm-tracks.service';

const FRESHNESS_LABEL: Record<string, string> = {
  fresh: 'Fresh',
  recent: 'Recent',
  stale: 'Old',
  offline: 'Offline',
  syncing: 'Syncing',
};

/** The IMD radar is observed data (what is falling now), so its menu only needs the picture's freshness and the last-hour loop: every radar's PPI, CAZ and PPZ are always merged (the owner, 1 Nov 2026: no product buttons, no opacity). */
@Component({
  selector: 'app-radar-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, LightningKeyComponent],
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
            <app-icon name="refresh" [size]="15" />
          </button>
          <button type="button" class="icon-btn" (click)="expanded.set(!expanded())" [attr.aria-expanded]="expanded()" [attr.aria-label]="expanded() ? 'Show less' : 'Show more'" [title]="expanded() ? 'Show less' : 'Show more'">
            <app-icon name="chevron" [size]="14" [style.transform]="expanded() ? 'rotate(180deg)' : ''" />
          </button>
        </header>

        <div class="scan full-only">
          @if (allOff()) {
            <span>All radars off</span>
          } @else if (age() !== null) {
            <span>Updated {{ agoText() }}</span>
            <span class="age" [attr.data-state]="freshness()">{{ freshnessLabel() }}</span>
          } @else {
            <span class="age" data-state="syncing">Syncing…</span>
          }
        </div>

        <div class="which full-only" role="radiogroup" aria-label="Which radars">
          <button type="button" role="radio" [attr.aria-checked]="radar.onlyStation() === null" [class.on]="radar.onlyStation() === null" (click)="radar.showOnly(null)">Both</button>
          @for (st of stations; track st.id) {
            <button type="button" role="radio" [attr.aria-checked]="radar.onlyStation() === st.id" [class.on]="radar.onlyStation() === st.id" (click)="radar.showOnly(st.id)" [title]="st.name + ' alone'">{{ st.name.replace(' DWR', '') }}</button>
          }
        </div>

        <button type="button" class="storm-toggle full-only" [class.active]="storms.enabled()" [attr.aria-pressed]="storms.enabled()" (click)="storms.toggle()"
          title="Storm cells with the area they are expected to cross in the next hour">
          <span class="cone" aria-hidden="true"></span>
          <span class="storm-text">Storm tracks <span class="storm-sub">{{ stormSummary() }}</span></span>
        </button>


        <div class="legend" role="img" [attr.aria-label]="legendTitle()">
          <div class="label full-only">{{ legendTitle() }}</div>
          <div class="bar"></div>
          <div class="scale full-only">
            @for (t of legendTicks(); track t) { <span>{{ t }}</span> }
          </div>
          <p class="aloft-note full-only">See-through faint echoes: the radars see them only from 2 km or more up, so that rain may not reach the ground.</p>
        </div>
        <app-lightning-key class="full-only" />
      </section>
    }
  `,
  styles: [`
    :host { display: contents; }
    .panel { position: fixed; left: 12px; bottom: calc(var(--bars-h) + 12px); z-index: 900; width: min(300px, calc(100vw - 24px)); padding: 12px 14px; color: var(--text-primary); font-family: var(--font-body); font-size: 12px; max-height: calc(100dvh - var(--bars-h) - 12px - var(--gutter) - 46px - 12px); overflow-y: auto; } /* its top stays 12px under the search bar (46px high, var(--gutter) from the top), so its own buttons can be reached */
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
    .sub[data-state='fresh'] { color: var(--ok); }
    .sub[data-state='recent'] { color: var(--warn); }
    .sub[data-state='stale'] { color: var(--warn); }
    .sub[data-state='offline'] { color: var(--danger); }
    /* compact: one header line, the loop and a thin colour bar */
    .panel.compact { padding: 8px 10px; }
    .panel.compact .full-only { display: none; }
    .panel.compact .compact-only { display: block; }
    .panel.compact header { gap: 8px; }
    .panel.compact .heading strong { font-size: 13px; }
    .panel.compact .compact-only { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .panel.compact .icon-btn { width: 32px; height: 32px; font-size: 16px; }
    .panel.compact .legend { margin-top: 8px; }
    .panel.compact .bar { height: 5px; }
    button:focus-visible { outline: 2px solid var(--neon-cyan); outline-offset: 2px; }
    .scan { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin: 10px 0 8px; color: var(--text-secondary); }
    .age { font-weight: 600; color: var(--text-primary); }
    .age[data-state='fresh'] { color: var(--ok); }
    .age[data-state='recent'] { color: var(--warn); }
    .age[data-state='stale'] { color: var(--warn); }
    .age[data-state='offline'] { color: var(--danger); }
    .which { display: flex; gap: 4px; padding: 3px; border-radius: 10px; background: var(--surface-3); }
    .which button { flex: 1; min-height: 32px; border: 1px solid transparent; border-radius: 8px; background: none; color: var(--text-secondary); font: 600 12px var(--font-body); cursor: pointer; }
    .which button:hover:not(.on) { background: var(--surface-4); }
    .which button.on { background: var(--surface-1, var(--surface-4)); border-color: var(--accent-line); color: var(--text-primary); }
    .stations { margin-top: 10px; }
    .label { color: var(--text-muted); font-size: 11px; margin-bottom: 4px; }
    .value { color: var(--text-primary); float: right; font-weight: 600; }
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
    .legend { margin-top: 10px; }
    .aloft-note { margin: 6px 0 0; font-size: var(--fs-xs); line-height: 1.35; color: var(--text-muted); }
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
    if (this.allOff()) return 'All radars off';
    if (age === null) return 'Syncing…';
    return `Updated ${this.agoText()}`;
  });
  protected readonly active = computed(() => this.layers.layers().some(l => l.id === 'radar' && l.active));

  protected readonly stations = this.radar.stations;
  protected readonly activeId = this.radar.activeStationId;
  protected readonly refreshing = this.radar.isRefreshing;
  /** Minutes since the radar on the map was made (the workflow's run, every 5 minutes), and how fresh that is. */
  protected readonly age = this.radar.updatedAgoMinutes;
  protected readonly freshness = computed(() => {
    const age = this.age();
    return age === null ? 'syncing' : age <= 10 ? 'fresh' : age <= 30 ? 'recent' : 'stale';
  });
  protected readonly agoText = computed(() => {
    const age = this.age() ?? 0;
    return age < 1 ? 'just now' : age < 120 ? `${age} min ago` : `${Math.round(age / 60)} h ago`;
  });
  protected readonly online = this.radar.displayedStationsCount;

  protected readonly freshnessLabel = computed(() => FRESHNESS_LABEL[this.freshness()] ?? '');

  protected readonly legendTitle = computed(() => 'Reflectivity (dBZ)');
  protected readonly legendTicks = computed(() => ['17', '28', '39', '50', '60+']);

  constructor() {
    // On larger screens the last hour is built as soon as the radar is shown (phones wait for the play button, since
    // the animations are several megabytes), and rebuilt every hour while the radar stays on (each new live picture joins it in between).
    effect(() => {
      const on = this.active();
      // the live stills are part of the loop, so wait until every radar's has been fetched
      const liveReady = this.radar.compositeMosaic() !== null && !this.radar.isRefreshing();
      untracked(() => {
        if (on && liveReady && typeof window !== 'undefined' && window.innerWidth > 700 && this.frames().length === 0) void this.radar.loadHistory();
        if (!on) this.radar.pause();
      });
    });
    const timer = setInterval(() => {
      if (this.active() && this.frames().length > 0 && !this.playing()) void this.radar.loadHistory();
    }, 60 * 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
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

  protected shown(id: string): boolean {
    return this.radar.isStationShown(id);
  }

  /** A tap turns the radar off or on (the map does not move). */
  protected toggle(id: string): void {
    this.radar.toggleStation(id);
  }

  /** True when every radar is turned off. */
  protected readonly allOff = computed(() => this.stations.every(st => this.radar.hiddenStations().has(st.id)));

  protected refresh(): void {
    this.radar.fetchRadarSweep();
  }
}
