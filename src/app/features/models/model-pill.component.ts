import { ChangeDetectionStrategy, Component, HostListener, computed, inject } from '@angular/core';
import { ForecastCatalogService } from '../../core/forecast/forecast-catalog.service';
import { modelColor } from '../../core/forecast/forecast-models';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';
import { runLines } from '../../core/forecast/model-runs';
import { ModelRunsService } from '../../core/forecast/model-runs.service';
import { PanelService } from '../../core/ui/panel.service';
import { IconComponent } from '../../shared/icon.component';
import { ModelListComponent } from './model-list.component';

/**
 * The forecast model on the map, in one button at the bottom right: its colour, name and grid spacing, and under them the run it is on and the
 * forecast hour of the time on the bar. A dot says whether it is the newest run. It opens the list of all the models.
 */
@Component({
  selector: 'app-model-pill',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, ModelListComponent],
  template: `
    <div class="wrap">
      <button type="button" class="pill" [class.open]="open()" [attr.aria-expanded]="open()" aria-haspopup="dialog" (click)="panels.toggle('models')"
        [style.--model-color]="color()" [attr.aria-label]="label()" [title]="title()" data-model-toggle>
        <span class="model-dot" [class.ai]="catalog.model().ai"></span>
        <span class="text">
          <span class="l1"><strong>{{ catalog.model().short }}</strong><span class="grid">{{ catalog.model().gridKm }} km</span></span>
          <span class="l2"><span class="status-dot" [class.ok]="tone() === 'ok'" [class.warn]="tone() === 'warn'" [class.bad]="tone() === 'bad'"></span>{{ line() }}</span>
        </span>
        <app-icon class="chev" name="chevron" [size]="14" />
      </button>
      @if (open()) {
        <div class="pop" role="dialog" aria-label="Forecast models and how current they are">
          <header class="pop-head">
            <strong>Forecast model</strong>
            <button type="button" class="btn-icon" (click)="panels.close('models')" aria-label="Close the model list" title="Close (Esc)"><app-icon name="close" [size]="16" /></button>
          </header>
          <app-model-list (chosen)="panels.close('models')" />
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: contents; }
    .wrap { position: relative; display: flex; justify-content: flex-end; }
    .pill {
      display: inline-flex; align-items: center; gap: var(--sp-2); min-height: var(--hit); padding: var(--sp-1) var(--sp-3) var(--sp-1) var(--sp-3); border: 0; border-radius: 22px;
      background: var(--surface-1); color: var(--text-primary); box-shadow: var(--shadow-1); cursor: pointer; text-align: left; transition: background var(--t-fast);
    }
    .pill:hover, .pill.open { background: var(--surface-2); }
    .pill.open { box-shadow: 0 0 0 2px var(--model-color), var(--shadow-1); }
    .text { display: flex; flex-direction: column; line-height: var(--lh-tight); min-width: 0; }
    .l1 { display: flex; align-items: baseline; gap: 5px; font-size: var(--fs-l); }
    .l1 strong { font-weight: var(--fw-strong); }
    .grid { font-size: var(--fs-xs); color: var(--text-secondary); }
    .l2 { display: flex; align-items: center; gap: 6px; font-size: var(--fs-xs); color: var(--text-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .chev { color: var(--text-muted); transition: transform var(--t-fast); }
    .pill.open .chev { transform: rotate(180deg); }
    .pop {
      position: absolute; right: 0; bottom: calc(100% + 8px); width: min(430px, calc(100vw - 2 * var(--gutter))); max-height: calc(100dvh - var(--stack-h) - 90px); overflow-y: auto;
      padding: var(--sp-3); background: var(--surface-solid); border-radius: var(--radius-l); box-shadow: var(--shadow-2); animation: sheet-in var(--t-med) both; overscroll-behavior: contain;
    }
    .pop-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--sp-2); }
    .pop-head strong { font-size: var(--fs-xl); font-weight: var(--fw-strong); }
    @media (max-width: 700px) {
      .pop { position: fixed; left: var(--gutter); right: var(--gutter); bottom: calc(var(--stack-h) + 10px); width: auto; max-height: calc(100dvh - var(--stack-h) - 90px); }
    }
  `]
})
export class ModelPillComponent {
  protected readonly catalog = inject(ForecastCatalogService);
  protected readonly panels = inject(PanelService);
  private readonly state = inject(ForecastStateService);
  private readonly runs = inject(ModelRunsService);

  protected readonly open = computed(() => this.panels.open() === 'models');
  protected readonly color = computed(() => modelColor(this.catalog.activeModelId()));
  private readonly info = computed(() => this.runs.active());

  protected readonly tone = computed(() => this.info()?.tone ?? 'none');
  /** "Run 18Z · +15 h": the run the model is on, and the forecast hour of the time on the bar. */
  protected readonly line = computed(() => {
    const info = this.info();
    if (!info?.published) return this.catalog.status() === 'loading' ? 'Loading…' : 'No run';
    const lines = runLines(info, this.state.timeMs(), this.runs.nowMs());
    return `${lines.run.split(' · ')[0]} · ${lines.hour}`;    // "Run 18Z · +15 h", or "Run 18Z · not reached"
  });
  protected readonly label = computed(() => {
    const info = this.info();
    return `Forecast model: ${this.catalog.model().label}. ${this.line()}. ${info?.badge ?? ''}. Open the model list`;
  });
  protected readonly title = computed(() => {
    const info = this.info();
    return info ? `${this.catalog.model().label} · ${info.badge}. ${info.detail}` : this.catalog.model().label;
  });

  @HostListener('window:keydown.escape', ['$event'])
  protected onEscape(event: Event): void {
    if (!this.open()) return;
    this.panels.close('models');
    event.preventDefault();
  }

  /** Clicking outside the list closes it (the button that opens it does not count as outside). */
  @HostListener('document:click', ['$event'])
  protected onDocumentClick(event: MouseEvent): void {
    if (this.open() && !(event.target as HTMLElement | null)?.closest?.('app-model-pill')) this.panels.close('models');
  }
}
