import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MapLayerService } from '../../core/services/map-layer.service';
import { RadarService } from '../../core/services/radar.service';
import { RadarProductKey } from '../../core/domain/models/radar.model';

interface ProductOption {
  key: RadarProductKey;
  name: string;
  hint: string;
  title: string;
}

const PRODUCTS: readonly ProductOption[] = [
  { key: 'caz', name: 'CAZ', hint: 'Max dBZ', title: 'Column maximum reflectivity (MAX_Z)' },
  { key: 'ppi', name: 'PPI', hint: 'Base Z', title: 'Plan position indicator (base reflectivity)' },
  { key: 'sri', name: 'SRI', hint: 'Rain rate', title: 'Surface rainfall intensity (mm/h)' },
  { key: 'pac', name: 'PAC', hint: 'Total', title: 'Precipitation accumulation (rain total)' },
];

const FRESHNESS_LABEL: Record<string, string> = {
  fresh: 'Fresh',
  recent: 'Recent',
  stale: 'Old',
  offline: 'Offline',
  syncing: 'Syncing',
};

/** The IMD radar is observed data (a nowcast of what is falling now), so its menu only needs product, freshness and opacity. */
@Component({
  selector: 'app-radar-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (active()) {
      <section class="panel glass-panel" aria-label="Radar settings">
        <header>
          <span class="live" aria-hidden="true"></span>
          <div class="heading">
            <strong>IMD radar</strong>
            <span class="sub">Observed now, not a forecast</span>
          </div>
          <button type="button" class="refresh" (click)="refresh()" [disabled]="refreshing()" aria-label="Refresh radar" title="Refresh radar">
            {{ refreshing() ? '…' : '⟳' }}
          </button>
        </header>

        <div class="scan">
          <span>{{ scanLabel() }}</span>
          @if (age() !== null) {
            <span class="age" [attr.data-state]="freshness()">{{ age() }} min ago · {{ freshnessLabel() }}</span>
          } @else {
            <span class="age" data-state="syncing">Syncing…</span>
          }
        </div>

        <div class="products" role="group" aria-label="Radar product">
          @for (p of products; track p.key) {
            <button type="button" class="prod" [class.active]="product() === p.key" [attr.aria-pressed]="product() === p.key" [title]="p.title" (click)="setProduct(p.key)">
              <span class="pname">{{ p.name }}</span>
              <span class="phint">{{ p.hint }}</span>
            </button>
          }
        </div>

        <div class="stations">
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

        <label class="opacity">
          <span class="label">Opacity <span class="value">{{ opacityPercent() }}%</span></span>
          <input type="range" min="0.2" max="1" step="0.05" [value]="opacity()" (input)="setOpacity($event)" aria-label="Radar opacity" />
        </label>

        <div class="legend" role="img" [attr.aria-label]="legendTitle()">
          <div class="label">{{ legendTitle() }}</div>
          <div class="bar"></div>
          <div class="scale">
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
    .refresh { width: 36px; height: 36px; border-radius: 10px; border: 1px solid var(--glass-border); background: rgba(255,255,255,0.06); color: var(--text-primary); font-size: 18px; cursor: pointer; }
    .refresh:hover:not(:disabled) { background: rgba(255,255,255,0.14); }
    .refresh:disabled { opacity: 0.5; cursor: progress; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--neon-cyan); outline-offset: 2px; }
    .scan { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin: 10px 0 8px; color: var(--text-secondary); }
    .age { font-weight: 600; color: var(--text-primary); }
    .age[data-state='fresh'] { color: #4ade80; }
    .age[data-state='recent'] { color: #facc15; }
    .age[data-state='stale'] { color: #fb923c; }
    .age[data-state='offline'] { color: #f87171; }
    .products { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
    .prod { display: flex; flex-direction: column; align-items: center; gap: 1px; min-height: 44px; padding: 6px 2px; border-radius: 10px; border: 1px solid transparent; background: rgba(255,255,255,0.05); color: var(--text-secondary); cursor: pointer; }
    .prod:hover { background: rgba(255,255,255,0.1); color: var(--text-primary); }
    .prod.active { background: rgba(0,229,255,0.16); border-color: rgba(0,229,255,0.5); color: var(--neon-cyan); }
    .pname { font-weight: 700; font-size: 13px; }
    .phint { font-size: 10px; opacity: 0.8; }
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
    @media (max-width: 700px) { .panel { bottom: 84px; } }
  `]
})
export class RadarPanelComponent {
  private readonly layers = inject(MapLayerService);
  private readonly radar = inject(RadarService);

  protected readonly products = PRODUCTS;
  protected readonly active = computed(() => this.layers.layers().some(l => l.id === 'radar' && l.active));

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
    const st = this.shortName(this.radar.activeStation().name);
    const t = this.radar.observationTiming();
    return t?.ist ? `${st} scan ${t.ist}` : `${st} scan`;
  });

  protected readonly legendTitle = computed(() => {
    const p = this.product();
    return p === 'sri' ? 'Rain rate (mm/h)' : p === 'pac' ? 'Rain total (mm)' : 'Reflectivity (dBZ)';
  });
  protected readonly legendTicks = computed(() => {
    const p = this.product();
    return p === 'sri' ? ['0.4', '2', '10', '50', '100+'] : p === 'pac' ? ['0.4', '2', '10', '50', '100+'] : ['17', '28', '39', '50', '60+'];
  });

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
