import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ForecastCatalogService } from '../../core/forecast/forecast-catalog.service';
import { forecastLayerById, layerAvailableAt, supportsLevels } from '../../core/forecast/forecast-layers';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';
import { MapLayerService } from '../../core/services/map-layer.service';
import { PanelService } from '../../core/ui/panel.service';
import { IconComponent } from '../../shared/icon.component';
import { IconName } from '../../shared/icons';

interface RailItem {
  id: string;
  label: string;
  icon: IconName;
  /** The forecast layer it switches on (absent for the observed pictures). */
  layerId?: string;
  /** Radar and satellite are observed pictures with their own panels. */
  observed?: 'radar' | 'satellite';
  /** Colours of the round button: the layer's own palette, so each button hints at what the layer looks like. */
  colors?: readonly string[];
}

/** The IMD radar and Meteosat legends, as on windy.com's radar and satellite layers. */
const RADAR_COLORS = ['#28109f', '#182ca8', '#009193', '#00af81', '#48cd5f', '#c7db24', '#f5ca09', '#f49d22', '#de6445', '#bc335f'];
const SATELLITE_COLORS = ['#4143a8', '#4470e6', '#28c0e8', '#35f591', '#a9fb3b', '#efcb38', '#f9791f', '#cb2d04'];

/** The layers shown on the rail, in the order of windy.com's: the observed pictures first, then the main forecast layers. */
const RAIL: readonly RailItem[] = [
  { id: 'radar', label: 'Weather radar', icon: 'radar', observed: 'radar', colors: RADAR_COLORS },
  { id: 'satellite', label: 'Satellite', icon: 'satellite', observed: 'satellite', colors: SATELLITE_COLORS },
  { id: 'wind', label: 'Wind', icon: 'wind', layerId: 'wind' },
  { id: 'rain', label: 'Rain', icon: 'rain', layerId: 'rain' },
  { id: 'temp', label: 'Temperature', icon: 'thermometer', layerId: 'temp' },
  { id: 'humidity', label: 'Humidity', icon: 'humidity', layerId: 'humidity' },
  { id: 'raintot', label: 'Rain accumulation', icon: 'raintot', layerId: 'raintot' },
  { id: 'cape', label: 'Thunderstorms', icon: 'bolt', layerId: 'cape' },
  { id: 'extreme', label: 'Extreme rain', icon: 'alert', layerId: 'extreme' },
];

/**
 * The vertical list of layers down the right edge, as on windy.com: a name in a dark pill and a round button coloured like the layer. The
 * layer on the map is amber. "More layers…" opens the full menu (every layer, the model, the altitude, the overlays).
 */
@Component({
  selector: 'app-layer-rail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <nav class="rail" aria-label="Map layers">
      @for (item of items; track item.id) {
        <button
          type="button" class="item" [class.active]="isActive(item)" [attr.aria-pressed]="isActive(item)" [disabled]="!available(item)"
          [title]="title(item)" (click)="choose(item)"
        >
          <span class="label">{{ item.label }}</span>
          <span class="thumb" [style.background]="thumb(item)"><app-icon [name]="item.icon" [size]="20" /></span>
        </button>
      }
      <button type="button" class="item more" data-menu-toggle (click)="panels.toggle('layers')" [attr.aria-expanded]="panels.open() === 'layers'" aria-haspopup="dialog" title="Every layer, the model, the altitude and the overlays">
        <span class="label">More layers…</span>
        <span class="thumb plain"><app-icon name="more" [size]="20" /></span>
      </button>
    </nav>
  `,
  styles: [`
    :host { display: contents; }
    .rail {
      position: fixed; top: 64px; right: var(--gutter); z-index: 880; display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
      max-height: calc(100dvh - 66px - var(--stack-h) - 14px - var(--cluster-h, 150px)); overflow-y: auto; overflow-x: hidden; padding: 2px 2px 2px 8px; scrollbar-width: none;
    }
    .rail::-webkit-scrollbar { display: none; }
    .item { position: relative; display: flex; align-items: center; justify-content: flex-end; height: 38px; padding: 0; border: 0; background: transparent; color: var(--text-primary); cursor: pointer; flex: none; }
    .label {
      height: 30px; display: grid; place-items: center; padding: 0 30px 0 14px; margin-right: -22px; border-radius: 15px; background: var(--surface-1);
      font-size: 14px; font-weight: 600; white-space: nowrap; box-shadow: var(--shadow-1); transition: background var(--t-fast);
    }
    .thumb {
      position: relative; z-index: 1; width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center; color: #fff; flex: none;
      border: 2px solid rgba(255, 255, 255, 0.9); box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5); transition: transform var(--t-fast);
    }
    .thumb app-icon { filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.7)); }
    .thumb.plain { background: var(--surface-2); color: var(--text-primary); border-color: var(--line-strong); }
    .item:hover:not(:disabled) .label { background: var(--surface-2); }
    .item:hover:not(:disabled) .thumb { transform: scale(1.06); }
    .item.active .label { background: var(--accent); color: var(--on-accent); }
    .item.active .thumb { border-color: var(--accent-strong); box-shadow: 0 0 0 2px var(--accent), 0 1px 4px rgba(0, 0, 0, 0.5); }
    .item:disabled { opacity: 0.45; cursor: not-allowed; }
    .item:focus-visible { outline-offset: 0; border-radius: 22px; }

    /* short screens: the layers that matter most stay, and "More layers…" is always in view */
    @media (max-height: 760px) { .item:nth-last-child(2), .item:nth-last-child(3) { display: none; } }
    @media (max-height: 600px) { .item:nth-last-child(4), .item:nth-last-child(5) { display: none; } }

    /* phones: the round buttons alone, so the map stays visible */
    @media (max-width: 700px) {
      .label { display: none; }
      .rail { gap: 6px; top: 62px; }
      .thumb { width: 38px; height: 38px; }
      .item { height: 38px; }
    }
  `]
})
export class LayerRailComponent {
  protected readonly state = inject(ForecastStateService);
  protected readonly panels = inject(PanelService);
  private readonly catalog = inject(ForecastCatalogService);
  private readonly mapLayers = inject(MapLayerService);

  protected readonly items = RAIL;
  private readonly observedOn = computed(() => {
    const on = (id: string) => this.mapLayers.layers().some(l => l.id === id && l.active);
    return { radar: on('radar'), satellite: on('satellite') };
  });

  protected isActive(item: RailItem): boolean {
    if (item.observed) return this.observedOn()[item.observed];
    return this.state.activeLayerId() === item.layerId;
  }

  /** A forecast layer the shown model does not provide is greyed out (AIGFS has no humidity, for one). */
  protected available(item: RailItem): boolean {
    if (!item.layerId) return true;
    const def = forecastLayerById(item.layerId);
    if (!def) return false;
    const level = supportsLevels(def) ? this.state.level() : 'surface';
    return layerAvailableAt(def, level, this.catalog.manifest()?.vars);
  }

  protected title(item: RailItem): string {
    return this.available(item) ? item.label : `${item.label} is not provided by ${this.catalog.model().label}`;
  }

  /** The round button's colours: a slanted gradient of the layer's palette. */
  protected thumb(item: RailItem): string {
    const colors = item.colors ?? (item.layerId ? forecastLayerById(item.layerId)?.stops : undefined) ?? ['#666'];
    return `linear-gradient(135deg, ${colors.join(', ')})`;
  }

  protected choose(item: RailItem): void {
    if (item.observed === 'radar') {
      if (this.observedOn().radar) this.mapLayers.deactivateAll();
      else this.state.selectRadar();
    } else if (item.observed === 'satellite') {
      if (this.observedOn().satellite) this.mapLayers.deactivateAll();
      else this.state.selectSatellite();
    } else if (item.layerId) {
      this.state.toggleLayer(item.layerId);
    }
  }
}
