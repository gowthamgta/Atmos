import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { ForecastCatalogService } from '../../core/forecast/forecast-catalog.service';
import { FORECAST_MODELS, modelColor } from '../../core/forecast/forecast-models';
import { ForecastStateService } from '../../core/forecast/forecast-state.service';
import { agoLabel, istValid, runLines } from '../../core/forecast/model-runs';
import { ModelRunsService } from '../../core/forecast/model-runs.service';
import { skillLine } from '../../core/forecast/verification';
import { SKILL_WINDOW_DAYS, VerificationService } from '../../core/forecast/verification.service';

/**
 * The forecast models with what is needed to judge how current each is: its colour, its grid spacing, the run it is on (when it began, in India
 * time and UTC), the forecast hour of the time on the bar in that run, when this site published it, how far it reaches, and whether a newer run
 * is out. Choosing a model shows it on the map at the same time.
 */
@Component({
  selector: 'app-model-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="valid">
      <span class="k">Time on the bar</span>
      <strong>{{ valid() }}</strong>
    </p>
    <ul class="models" role="radiogroup" aria-label="Forecast model">
      @for (r of rows(); track r.id) {
        <li>
          <button type="button" class="row" role="radio" [class.active]="r.active" [attr.aria-checked]="r.active" [style.--model-color]="r.color" (click)="choose(r.id)">
            <span class="top">
              <span class="model-dot" [class.ai]="r.ai"></span>
              <span class="name">{{ r.label }}</span>
              <span class="grid">{{ r.gridKm }} km</span>
              @if (r.ai) { <span class="ai-tag" title="An AI model: learned from past weather rather than built from the physics">AI</span> }
              <span class="badge" [title]="r.detail"><span class="status-dot" [class.ok]="r.tone === 'ok'" [class.warn]="r.tone === 'warn'" [class.bad]="r.tone === 'bad'"></span>{{ r.badge }}</span>
            </span>
            <span class="line run"><span>{{ r.lines.run }}</span><span class="hour" [class.off]="!r.lines.covered" title="Forecast hour: how far from the start of this run the time on the bar is">{{ r.lines.hour }}</span></span>
            @if (r.lines.published) { <span class="line muted">{{ r.lines.published }}</span> }
            @if (r.showDetail) { <span class="line detail" [class.warn]="r.tone === 'warn'" [class.bad]="r.tone === 'bad'">{{ r.detail }}</span> }
            @if (r.lines.next) { <span class="line muted">{{ r.lines.next }}</span> }
            @if (r.skill) {
              <span class="line skill" [title]="skillTitle"><span>{{ r.skill }}</span>@if (r.rank === 1) { <span class="best" title="The smallest temperature error a day ahead among the models, over the same days">Best temperature</span> }</span>
            }
          </button>
        </li>
      }
    </ul>
    <p class="foot">
      @if (verification.airportCount()) {
        Accuracy: a day ahead, the last {{ windowDays }} days at {{ verification.airportCount() }} South Indian airports (temperature error, and the rainy hours each model forecast rain in).
      }
      Run is when the model started its forecast (UTC hour). Hour is how many hours into that run the time on the bar is.
      @if (checked()) { Checked {{ checked() }}. }
      <button type="button" class="again" (click)="runs.refresh()" [disabled]="runs.checking()">{{ runs.checking() ? 'Checking…' : 'Check again' }}</button>
    </p>
  `,
  styles: [`
    :host { display: block; }
    .valid { display: flex; justify-content: space-between; align-items: baseline; gap: var(--sp-3); margin: 0 0 var(--sp-2); font-size: var(--fs-s); color: var(--text-secondary); }
    .valid .k { font-size: var(--fs-xs); font-weight: var(--fw-medium); color: var(--text-muted); text-transform: uppercase; letter-spacing: var(--ls-caps); }
    .valid strong { font-size: var(--fs-m); font-weight: var(--fw-strong); color: var(--text-primary); }
    .models { list-style: none; display: flex; flex-direction: column; gap: var(--sp-1); margin: 0; padding: 0; }
    .row { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: var(--sp-2) var(--sp-3); border: 0; border-radius: var(--radius-m); background: var(--surface-3); color: var(--text-primary); text-align: left; cursor: pointer; transition: background var(--t-fast); }
    .row:hover { background: var(--surface-4); }
    .row.active { background: var(--surface-4); box-shadow: inset 3px 0 0 var(--model-color); }
    .top { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
    .name { font-size: var(--fs-l); font-weight: var(--fw-strong); white-space: nowrap; }
    .grid { font-size: var(--fs-s); color: var(--text-secondary); white-space: nowrap; }
    .ai-tag { padding: 0 5px; border-radius: 6px; background: var(--surface-4); font-size: var(--fs-xs); font-weight: var(--fw-medium); color: var(--text-secondary); }
    .badge { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-xs); font-weight: var(--fw-medium); color: var(--text-secondary); white-space: nowrap; }
    .line { display: flex; justify-content: space-between; gap: var(--sp-3); font-size: var(--fs-s); color: var(--text-secondary); font-variant-numeric: tabular-nums; }
    .line.run { color: var(--text-primary); }
    .hour { font-weight: var(--fw-strong); white-space: nowrap; }
    .hour.off { color: var(--text-muted); font-weight: var(--fw-normal); }
    .muted { color: var(--text-muted); }
    .skill { color: var(--text-secondary); justify-content: flex-start; }
    .best { margin-left: auto; padding: 0 6px; border-radius: 6px; background: var(--accent-soft); color: var(--accent-strong); font-size: var(--fs-xs); font-weight: var(--fw-medium); white-space: nowrap; }
    .detail { color: var(--text-secondary); }
    .detail.warn { color: var(--warn); }
    .detail.bad { color: var(--danger); }
    .foot { margin: var(--sp-3) 0 0; font-size: var(--fs-xs); line-height: var(--lh-normal); color: var(--text-muted); }
    .again { display: inline; padding: 0; border: 0; background: none; color: var(--accent-strong); font-size: inherit; font-weight: var(--fw-medium); text-decoration: underline; cursor: pointer; }
    .again:disabled { color: var(--text-muted); text-decoration: none; cursor: default; }
  `]
})
export class ModelListComponent {
  protected readonly runs = inject(ModelRunsService);
  protected readonly catalog = inject(ForecastCatalogService);
  private readonly state = inject(ForecastStateService);
  protected readonly verification = inject(VerificationService);
  protected readonly windowDays = SKILL_WINDOW_DAYS;
  protected readonly skillTitle = 'How far its temperature forecast a day ahead was from the airport reports, and the share of rainy hours it forecast rain in';

  /** A model was chosen (the popover closes). */
  readonly chosen = output<string>();

  constructor() {
    void this.runs.watch(FORECAST_MODELS.map(m => m.id));
    this.verification.load();
  }

  protected readonly valid = computed(() => {
    const t = this.state.timeMs();
    return t === null ? '–' : istValid(t);
  });

  protected readonly rows = computed(() => {
    const now = this.runs.nowMs();
    const valid = this.state.timeMs();
    const active = this.catalog.activeModelId();
    const skill = this.verification.skill();
    const looking = this.runs.checkedMs() === null; // nothing has been asked yet: a model without a run is not missing, it is not known
    return this.runs.infos().map(info => {
      const unknown = looking && !info.published && !info.upstream;
      return {
        id: info.model.id,
        label: info.model.label,
        gridKm: info.model.gridKm,
        ai: info.model.ai,
        color: modelColor(info.model.id),
        active: info.model.id === active,
        badge: unknown ? 'Checking…' : info.badge,
        detail: unknown ? '' : info.detail,
        tone: unknown ? ('none' as const) : info.tone,
        // the sentence under the badge is only for what needs attention
        showDetail: !unknown && (info.status !== 'current' || info.tone === 'warn'),
        lines: unknown ? { run: 'Looking up the latest run…', hour: '–', covered: false, published: '', next: '' } : runLines(info, valid, now),
        skill: skill.get(info.model.id) ? skillLine(skill.get(info.model.id)!) : '',
        rank: skill.get(info.model.id)?.tempRank ?? null,
      };
    });
  });

  protected readonly checked = computed(() => {
    const at = this.runs.checkedMs();
    return at === null ? '' : agoLabel(at, this.runs.nowMs());
  });

  protected choose(id: string): void {
    this.state.selectModel(id);
    this.chosen.emit(id);
  }
}
