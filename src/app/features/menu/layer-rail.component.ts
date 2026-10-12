import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ForecastCatalogService } from '../../core/forecast/forecast-catalog.service';
import { forecastLayerById, layerAvailableAt, supportsLevels } from '../../core/forecast/forecast-layers';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';
import { MapLayerService } from '../../core/services/map-layer.service';
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
}

/** The layers on the rail, the ones used most: the observed pictures first, then the main forecast layers. The rest are in the menu. */
const RAIL: readonly RailItem[] = [
  { id: 'radar', label: 'Weather radar', icon: 'radar', observed: 'radar' },
  { id: 'satellite', label: 'Satellite', icon: 'satellite', observed: 'satellite' },
  { id: 'wind', label: 'Wind', icon: 'wind', layerId: 'wind' },
  { id: 'rain', label: 'Rain', icon: 'rain', layerId: 'rain' },
  { id: 'temp', label: 'Temperature', icon: 'thermometer', layerId: 'temp' },
  { id: 'humidity', label: 'Humidity', icon: 'humidity', layerId: 'humidity' },
  { id: 'raintot', label: 'Rain accumulation', icon: 'raintot', layerId: 'raintot' },
  { id: 'cape', label: 'Thunderstorms', icon: 'bolt', layerId: 'cape' },
  { id: 'extreme', label: 'Extreme rain', icon: 'alert', layerId: 'extreme' },
];

/**
 * The layers used most, down the right edge under the menu button: plain round buttons. The layer on the map is the one amber button, with its
 * name beside it; the others show their name when pointed at. A layer's own colours are on the colour bar, not on the buttons, so the rail
 * does not compete with the map.
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
          [attr.aria-label]="item.label" [title]="title(item)" (click)="choose(item)"
        >
          <span class="label" aria-hidden="true">{{ item.label }}</span>
          <span class="thumb"><app-icon [name]="item.icon" [size]="20" /></span>
        </button>
      }
    </nav>
  `,
  styles: [`
    /* --rail-top: under the menu button; --cluster-h: what the bottom right takes (the zoom buttons and the model button; on a touch screen only the latter) */
    :host { display: contents; --rail-top: calc(var(--gutter) + var(--hit) + 12px); --cluster-h: 140px; }
    .rail {
      position: fixed; top: var(--rail-top); right: var(--gutter); z-index: var(--z-ui); display: flex; flex-direction: column; align-items: flex-end; gap: var(--sp-2);
      --room: calc(100dvh - var(--rail-top) - var(--stack-h) - var(--cluster-h) - 14px);
      max-height: var(--room);
      /* whole buttons only: a button cut in half looks broken, and the rest are in the menu */
      max-height: calc(round(down, calc(var(--room) + var(--sp-2) - 4px), calc(var(--hit) + var(--sp-2))) - var(--sp-2) + 4px);
      overflow-y: auto; overflow-x: hidden; padding: 2px 2px 2px 8px; scrollbar-width: none;
    }
    @media (pointer: coarse) { :host { --cluster-h: 66px; } }
    .rail::-webkit-scrollbar { display: none; }
    .item { position: relative; display: flex; align-items: center; justify-content: flex-end; height: var(--hit); padding: 0; border: 0; background: transparent; color: var(--text-primary); cursor: pointer; flex: none; }
    .thumb {
      position: relative; z-index: 1; width: var(--hit); height: var(--hit); border-radius: 50%; display: grid; place-items: center; flex: none;
      background: var(--surface-1); color: var(--text-primary); box-shadow: var(--shadow-1); transition: background var(--t-fast), color var(--t-fast), transform var(--t-fast);
    }
    .label {
      height: calc(var(--hit) - 8px); display: grid; place-items: center; padding: 0 calc(var(--hit) / 2 + 4px) 0 var(--sp-3); margin-right: calc(var(--hit) / -2 - 2px); border-radius: calc(var(--hit) / 2);
      background: var(--surface-1); font-size: var(--fs-l); font-weight: var(--fw-medium); white-space: nowrap; box-shadow: var(--shadow-1);
      opacity: 0; transform: translateX(8px); pointer-events: none; transition: opacity var(--t-fast), transform var(--t-fast);
    }
    @media (hover: hover) {
      .item:hover:not(:disabled) .label { opacity: 1; transform: none; }
      .item:hover:not(:disabled) .thumb { background: var(--surface-2); }
    }
    .item:focus-visible .label { opacity: 1; transform: none; }
    .item:focus-visible { outline-offset: 0; border-radius: 22px; }
    /* the layer on the map: the one amber button, named */
    .item.active .thumb { background: var(--accent); color: var(--on-accent); }
    .item.active .label { opacity: 1; transform: none; background: var(--accent); color: var(--on-accent); }
    .item:disabled { opacity: 0.45; cursor: not-allowed; }

    /* short screens: the layers that matter most stay */
    @media (max-height: 760px) { .item:nth-last-child(1), .item:nth-last-child(2) { display: none; } }
    @media (max-height: 600px) { .item:nth-last-child(3), .item:nth-last-child(4) { display: none; } }

    /* a touch screen has no pointer to rest on a button: only the layer on the map is named, and the rest are in the menu */
    @media (max-width: 700px) {
      /* the meteogram fills the bottom of a phone: the rail would be a sliver above it, so it steps aside (the layers are in the menu) */
      :host-context(html[data-sheet='open']) .rail { display: none; }
      :host { --rail-top: calc(var(--gutter) + 52px + var(--hit) + 8px); }
      .label { display: none; }
    }
  `]
})
export class LayerRailComponent {
  protected readonly state = inject(ForecastStateService);
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
