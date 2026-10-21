import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { BLEND_MODEL, PointModelDef, isMapModel, modelColor, pointModelById } from '../../core/forecast/forecast-models';
import { ModelRunsService } from '../../core/forecast/model-runs.service';
import { leadHours, leadLabel, runHourLabel, utcStamp, istStamp } from '../../core/forecast/model-runs';
import { CompareTable } from '../../core/meteogram/compare';
import { spreadOf } from '../../core/meteogram/point-series';
import { degToCompass } from '../../core/domain/models/compass';
import { Units, formatPressure, formatRain, formatTemp, formatWind, tempFromC, TEMP_LABEL, windFromMs, WIND_LABEL, pressureFromHpa, PRESSURE_LABEL, rainFromMm, RAIN_LABEL } from '../../core/units/units';

/**
 * The models side by side at one time and one place: temperature, rain, wind, gusts and pressure, each model's run and the forecast hour of
 * that time in its run, and under them how far apart the models are. Clicking a model puts it on the map.
 */
@Component({
  selector: 'app-compare-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <table class="table" aria-label="Models compared at the chosen time">
      <thead>
        <tr>
          <th scope="col" class="model">Model</th>
          <th scope="col" title="The run of the model this forecast comes from (UTC hour it began)">Run</th>
          <th scope="col" title="Forecast hour: how far from the start of its run the chosen time is">Hour</th>
          <th scope="col">Temp.</th>
          <th scope="col" title="Rain in the 24 hours from the chosen time; blank when the model's run ends before then">Rain 24 h</th>
          <th scope="col">Wind</th>
          <th scope="col">Gust</th>
          <th scope="col">Pressure</th>
        </tr>
      </thead>
      <tbody>
        @for (r of rows(); track r.def.id) {
          <tr [class.on-map]="r.def.id === mapModelId()" [class.off]="r.hidden" [class.blend]="r.blend" [style.--model-color]="r.color" (click)="choose(r.def.id)" [title]="r.blend ? r.def.label + ': the models corrected and weighted by how right each has been lately (not a map layer)' : r.mapModel ? 'Show ' + r.def.label + ' on the map' : r.def.label + ': compared here only, not a map layer'">
            <th scope="row" class="model">
              <button type="button" class="pick" [disabled]="!r.mapModel" (click)="$event.stopPropagation(); choose(r.def.id)" [attr.aria-label]="r.mapModel ? 'Show ' + r.def.label + ' on the map' : r.def.label" [attr.aria-pressed]="r.def.id === mapModelId()">
                <span class="model-dot" [class.ai]="r.def.ai" [style.--model-color]="r.color"></span>
                <span class="name">{{ r.def.short }}</span>
                @if (r.def.id === mapModelId()) { <span class="tag">on map</span> }
              </button>
            </th>
            <td [title]="r.runTitle">{{ r.run }}</td>
            <td [class.muted]="!r.covered">{{ r.hour }}</td>
            <td>{{ r.temp }}</td>
            <td>{{ r.rain24h }}</td>
            <td>{{ r.wind }}</td>
            <td>{{ r.gust }}</td>
            <td>{{ r.pressure }}</td>
          </tr>
        }
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" class="model" title="Largest value minus smallest, of the models that have one">Spread</th>
          <td></td><td></td>
          <td>{{ spread().temp }}</td><td>{{ spread().rain24h }}</td><td>{{ spread().wind }}</td><td>{{ spread().gust }}</td><td>{{ spread().pressure }}</td>
        </tr>
      </tfoot>
    </table>
  `,
  styles: [`
    :host { display: block; min-width: 0; overflow-x: auto; }
    .table { width: 100%; border-collapse: collapse; font-size: var(--fs-m); font-variant-numeric: tabular-nums; }
    th, td { padding: 0 var(--sp-2); height: 30px; text-align: right; white-space: nowrap; }
    thead th { font-size: var(--fs-xs); font-weight: var(--fw-medium); color: var(--text-muted); text-transform: uppercase; letter-spacing: var(--ls-caps); border-bottom: 1px solid var(--line); }
    .model { text-align: left; padding-left: 0; }
    tbody th.model { font-weight: var(--fw-strong); }
    .pick { display: flex; align-items: center; gap: var(--sp-2); height: 30px; padding: 0; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
    tbody tr { cursor: pointer; border-bottom: 1px solid var(--line); transition: background var(--t-fast); }
    tbody tr:hover { background: var(--surface-3); }
    /* the model on the map is marked in its own colour (the colour of a model is the colour of choosing it) */
    tbody tr.on-map { background: color-mix(in srgb, var(--model-color) 20%, transparent); box-shadow: inset 3px 0 0 var(--model-color); }
    tbody tr.off { opacity: 0.4; }
    .name { color: var(--text-primary); }
    .tag { padding: 1px 6px; border-radius: 8px; background: var(--surface-4); color: var(--text-secondary); font-size: var(--fs-xs); font-weight: var(--fw-medium); }
    .muted { color: var(--text-muted); }
    td { color: var(--text-primary); }
    tfoot th, tfoot td { color: var(--text-secondary); font-weight: var(--fw-medium); border-top: 1px solid var(--line-strong); }
    tfoot th.model { font-size: var(--fs-s); }
    /* a narrower sheet: tighter columns, and the row's colour says which model is on the map */
    @media (max-width: 1100px) {
      .table { font-size: var(--fs-s); }
      th, td { padding: 0 6px; }
      .tag { display: none; }
    }
  `]
})
export class CompareTableComponent {
  private readonly runs = inject(ModelRunsService);

  readonly table = input.required<CompareTable>();
  readonly units = input.required<Units>();
  /** The model on the map (its row is marked). */
  readonly mapModelId = input.required<string>();
  /** Models the visitor has switched off in the legend. */
  readonly hiddenIds = input<ReadonlySet<string>>(new Set());
  readonly chooseModel = output<string>();

  /** A row was picked: its model goes on the map (the Blend and the models only compared here are not map layers: nothing happens). */
  protected choose(id: string): void {
    if (isMapModel(id)) this.chooseModel.emit(id);
  }

  protected readonly rows = computed(() => {
    const t = this.table();
    const u = this.units();
    const infos = this.runs.infos();
    const dash = '–';
    return t.rows.map(r => {
      const def: PointModelDef = pointModelById(r.modelId);
      const blend = def.id === BLEND_MODEL.id;
      const mapModel = isMapModel(def.id);
      const upstream = infos.find(i => i.model.id === def.id)?.upstream ?? null;
      const init = upstream?.latestInitMs ?? null;
      const hours = init !== null ? leadHours(init, t.timeMs) : null;
      const compass = r.windDir !== null && r.wind !== null ? ` ${degToCompass(r.windDir)}` : '';
      return {
        def,
        blend,
        mapModel,
        color: modelColor(def.id),
        hidden: this.hiddenIds().has(def.id),
        covered: r.covered,
        run: blend ? 'Mix' : init !== null ? runHourLabel(init) : dash,
        runTitle: init !== null ? `Run began ${istStamp(init)} (${utcStamp(init)})` : 'Run not known',
        hour: hours !== null ? (r.covered ? leadLabel(hours) : 'ended') : dash,
        temp: r.temp !== null ? formatTemp(r.temp, u, 1) : dash,
        rain24h: r.rain24h !== null ? formatRain(r.rain24h, u) : dash,
        wind: r.wind !== null ? `${formatWind(r.wind, u)}${compass}` : dash,
        gust: r.gust !== null ? formatWind(r.gust, u) : dash,
        pressure: r.pressure !== null ? formatPressure(r.pressure, u) : dash,
      };
    });
  });

  /** How far apart the models are, in the chosen units: the largest value minus the smallest, worked out after the conversion (Beaufort is not a straight scale). */
  protected readonly spread = computed(() => {
    const rows = this.table().rows;
    const u = this.units();
    const dash = '–';
    const apart = (pick: (r: CompareTable['rows'][number]) => number | null, convert: (v: number) => number): number | null =>
      spreadOf(rows.map(r => (pick(r) === null ? null : convert(pick(r) as number))));
    const text = (v: number | null, digits: number, unit: string): string => (v === null ? dash : `${v.toFixed(digits)} ${unit}`);
    return {
      temp: text(apart(r => r.temp, c => tempFromC(c, u.temp)), 1, TEMP_LABEL[u.temp]),
      rain24h: text(apart(r => r.rain24h, mm => rainFromMm(mm, u.rain)), u.rain === 'in' ? 2 : 1, RAIN_LABEL[u.rain]),
      wind: text(apart(r => r.wind, ms => windFromMs(ms, u.wind)), u.wind === 'ms' ? 1 : 0, WIND_LABEL[u.wind]),
      gust: text(apart(r => r.gust, ms => windFromMs(ms, u.wind)), u.wind === 'ms' ? 1 : 0, WIND_LABEL[u.wind]),
      pressure: text(apart(r => r.pressure, h => pressureFromHpa(h, u.pressure)), u.pressure === 'inHg' ? 2 : 1, PRESSURE_LABEL[u.pressure]),
    };
  });
}
