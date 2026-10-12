import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ConsensusService } from '../../core/forecast/consensus.service';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';
import { MapHostService } from '../../core/ui/map-host.service';
import { PanelService } from '../../core/ui/panel.service';
import { ModelPillComponent } from '../models/model-pill.component';
import { IconComponent } from '../../shared/icon.component';

/**
 * The bottom right corner, kept to what is needed there: the zoom buttons (only with a mouse: a touch screen pinches) and the forecast model.
 * The overlays, the full screen button, the home view and the credits are in the menu, so this corner and the time bar do not compete.
 */
@Component({
  selector: 'app-map-controls',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, ModelPillComponent],
  template: `
    <div class="cluster" [class.lifted]="state.forecastActive()" [class.raised]="panels.open() === 'models'">
      <div class="zoom" role="group" aria-label="Zoom">
        <button type="button" (click)="map.zoomIn()" aria-label="Zoom in" title="Zoom in"><app-icon name="plus" [size]="18" /></button>
        <button type="button" (click)="map.zoomOut()" aria-label="Zoom out" title="Zoom out"><app-icon name="minus" [size]="18" /></button>
      </div>
      @if (state.forecastActive()) {
        @if (comparing().length) {
          <div class="caption" title="The models whose run covers this time">Compared across {{ comparing().length }} models</div>
        }
        <app-model-pill />
      }
    </div>
  `,
  styles: [`
    :host { display: contents; }
    .cluster { position: fixed; right: var(--gutter); bottom: var(--gutter); z-index: var(--z-ui); display: flex; flex-direction: column; align-items: flex-end; gap: var(--sp-2); max-width: calc(100vw - 2 * var(--gutter)); }
    .cluster.lifted { bottom: calc(var(--stack-h) + 10px); }
    /* while the model list is open it is above the meteogram too */
    .cluster.raised { z-index: var(--z-panel); }

    .zoom { display: flex; flex-direction: column; border-radius: calc(var(--hit) / 2); background: var(--surface-1); box-shadow: var(--shadow-1); overflow: hidden; }
    .zoom button { width: var(--hit); height: var(--hit); display: grid; place-items: center; border: 0; background: transparent; color: var(--text-primary); cursor: pointer; transition: background var(--t-fast); }
    .zoom button + button { border-top: 1px solid var(--line); }
    .zoom button:hover { background: var(--surface-3); }
    .zoom button:focus-visible { outline-offset: -3px; }
    /* a touch screen pinches; the buttons would only take room from the map */
    @media (pointer: coarse) { .zoom { display: none; } }

    .caption { padding: 3px 12px; border-radius: 13px; background: var(--surface-1); color: var(--text-secondary); font-size: var(--fs-s); font-weight: var(--fw-medium); box-shadow: var(--shadow-1); }
  `]
})
export class MapControlsComponent {
  protected readonly state = inject(ForecastStateService);
  protected readonly map = inject(MapHostService);
  protected readonly panels = inject(PanelService);
  private readonly consensus = inject(ConsensusService);

  /** The models taking part in the extreme-rain comparison (only while that layer is on). */
  protected readonly comparing = computed(() => (this.state.activeLayerId() === 'extreme' ? this.consensus.models() : []));
}
