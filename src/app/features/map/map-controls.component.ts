import { ChangeDetectionStrategy, Component, HostListener, computed, inject, signal } from '@angular/core';
import { ConsensusService } from '../../core/forecast/consensus.service';
import { ForecastCatalogService } from '../../core/forecast/forecast-catalog.service';
import { FORECAST_MODELS } from '../../core/forecast/forecast-models';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';
import { MapHostService } from '../../core/ui/map-host.service';
import { PanelService } from '../../core/ui/panel.service';
import { IconComponent } from '../../shared/icon.component';

/**
 * The cluster at the bottom right, after windy.com: two switches (the pressure lines and the wind particles), the round map buttons (zoom,
 * home, full screen, about) and the model buttons ("ECMWF 9km", "GFS 13km"…). The model buttons only show while a forecast is on the map.
 */
@Component({
  selector: 'app-map-controls',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <div class="cluster" [class.lifted]="state.forecastActive()">
      @if (state.forecastActive()) {
        <div class="switches">
          <button type="button" class="sw" role="switch" [attr.aria-checked]="state.isobars()" [disabled]="!contourAvailable()" (click)="state.toggleIsobars()"
            [title]="state.level() === 'surface' ? 'Lines of equal sea-level pressure' : 'Lines of equal height of the ' + state.level() + ' hPa surface'">
            <span class="switch" [class.on]="state.isobars()"></span><span class="text">{{ state.level() === 'surface' ? 'pressure' : 'height lines' }}</span>
          </button>
          <button type="button" class="sw" role="switch" [attr.aria-checked]="state.windParticles()" (click)="state.toggleWindParticles()" title="Animated wind streaks at the chosen altitude">
            <span class="switch" [class.on]="state.windParticles()"></span><span class="text">particles animation</span>
          </button>
        </div>
      }

      <div class="buttons" role="group" aria-label="Map">
        <button type="button" (click)="map.zoomIn()" aria-label="Zoom in" title="Zoom in"><app-icon name="plus" [size]="18" /></button>
        <button type="button" (click)="map.zoomOut()" aria-label="Zoom out" title="Zoom out"><app-icon name="minus" [size]="18" /></button>
        <button type="button" (click)="map.home()" aria-label="Back to the home view" title="Home view"><app-icon name="home" [size]="18" /></button>
        @if (fullscreenAvailable) {
          <button type="button" (click)="toggleFullscreen()" [attr.aria-pressed]="fullscreen()" [attr.aria-label]="fullscreen() ? 'Leave full screen' : 'Full screen'" [title]="fullscreen() ? 'Leave full screen' : 'Full screen'">
            <app-icon [name]="fullscreen() ? 'shrink' : 'expand'" [size]="18" />
          </button>
        }
        <button type="button" (click)="panels.toggle('about')" aria-haspopup="dialog" aria-label="About, keys and data credits" title="About, keys and data credits"><app-icon name="info" [size]="18" /></button>
      </div>

      @if (state.forecastActive()) {
        @if (comparing().length) {
          <div class="caption" title="The models whose run covers this time">Compared across {{ comparing().length }} models</div>
        }
        <div class="models" role="radiogroup" aria-label="Forecast model">
          @for (m of models; track m.id) {
            <button type="button" class="chip" role="radio" [class.active]="m.id === catalog.activeModelId()" [attr.aria-checked]="m.id === catalog.activeModelId()" (click)="state.selectModel(m.id)" [title]="m.label + ', ' + m.resolution">
              {{ m.short }}<small>{{ m.gridKm }}km</small>
            </button>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: contents; }
    .cluster { position: fixed; right: var(--gutter); bottom: var(--gutter); z-index: 880; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; max-width: calc(100vw - 2 * var(--gutter)); }
    .cluster.lifted { bottom: calc(var(--stack-h) + 10px); }

    .switches { display: flex; gap: 14px; padding: 5px 12px; border-radius: 16px; background: var(--surface-1); box-shadow: var(--shadow-1); }
    .sw { display: inline-flex; align-items: center; gap: 7px; padding: 2px 0; border: 0; background: transparent; color: var(--text-primary); font-size: 13px; cursor: pointer; }
    .sw:disabled { opacity: 0.45; cursor: not-allowed; }
    .sw .text { white-space: nowrap; }

    .buttons { display: flex; border-radius: 19px; background: var(--surface-1); box-shadow: var(--shadow-1); overflow: hidden; }
    .buttons button { width: 40px; height: 38px; display: grid; place-items: center; border: 0; background: transparent; color: var(--text-primary); cursor: pointer; transition: background var(--t-fast); }
    .buttons button + button { border-left: 1px solid var(--line); }
    .buttons button:hover { background: var(--surface-3); }
    .buttons button[aria-pressed='true'] { color: var(--accent-strong); }
    .buttons button:focus-visible { outline-offset: -3px; }

    .caption { padding: 3px 12px; border-radius: 13px; background: var(--surface-1); color: var(--text-secondary); font-size: 12px; font-weight: 600; box-shadow: var(--shadow-1); }

    .models { display: flex; max-width: 100%; overflow-x: auto; scrollbar-width: none; border-radius: 19px; background: var(--surface-1); box-shadow: var(--shadow-1); padding: 3px; gap: 2px; }
    .models::-webkit-scrollbar { display: none; }
    .chip { flex: none; display: inline-flex; align-items: baseline; gap: 3px; height: 32px; padding: 0 12px; border: 0; border-radius: 16px; background: transparent; color: var(--text-primary); font-size: 14px; font-weight: 650; cursor: pointer; transition: background var(--t-fast); }
    .chip small { font-size: 10px; font-weight: 500; color: var(--text-muted); }
    .chip:hover { background: var(--surface-3); }
    .chip.active { background: var(--accent); color: var(--on-accent); }
    .chip.active small { color: inherit; opacity: 0.75; }

    @media (max-width: 700px) {
      .switches { gap: 10px; padding: 4px 10px; }
      .sw { font-size: 12px; }
      .chip { padding: 0 9px; font-size: 13px; }
    }
  `]
})
export class MapControlsComponent {
  protected readonly state = inject(ForecastStateService);
  protected readonly catalog = inject(ForecastCatalogService);
  protected readonly panels = inject(PanelService);
  protected readonly map = inject(MapHostService);
  private readonly consensus = inject(ConsensusService);

  protected readonly models = FORECAST_MODELS;
  protected readonly fullscreen = signal(false);
  protected readonly fullscreenAvailable = typeof document !== 'undefined' && document.fullscreenEnabled === true;

  /** The models taking part in the extreme-rain comparison (only while that layer is on). */
  protected readonly comparing = computed(() => (this.state.activeLayerId() === 'extreme' ? this.consensus.models() : []));

  protected contourAvailable(): boolean {
    const vars = this.catalog.manifest()?.vars;
    return !vars || this.state.contour().varId in vars;
  }

  protected toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  }

  @HostListener('document:fullscreenchange')
  protected onFullscreenChange(): void {
    this.fullscreen.set(!!document.fullscreenElement);
  }
}
