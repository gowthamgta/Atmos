import { Injectable, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { ForecastCatalogService } from './forecast-catalog.service';
import { FORECAST_MODELS, ForecastModelDef } from './forecast-models';
import { ModelRunInfo, PublishedRun, Upstream, buildIdToMs, combineUpstream, modelRunInfo, parseDatasetRun, runIdToMs } from './model-runs';

const STATUS_URL = (dataset: string) => `https://api.open-meteo.com/data/${dataset}/static/meta.json`;
const REFRESH_MS = 10 * 60 * 1000;
const TICK_MS = 60 * 1000;
const TIMEOUT_MS = 8000;

/**
 * How current each forecast model is. The run on the site comes from the model's own latest.json (the one on screen from its manifest),
 * the newest run that exists from Open-Meteo's status files. Nothing is fetched until a model button or the model list needs it, and what has
 * been looked at is checked again every 10 minutes.
 */
@Injectable({ providedIn: 'root' })
export class ModelRunsService implements OnDestroy {
  private readonly catalog = inject(ForecastCatalogService);

  /** The run on the site, by model (only the models looked at). */
  private readonly publishedById = signal<Record<string, PublishedRun | null>>({});
  /** The newest run that exists, by model; null when the status could not be read. */
  private readonly upstreamById = signal<Record<string, Upstream | null>>({});
  private readonly wanted = new Set<string>();
  /** The clock the "x h ago" texts are made from, moved once a minute while anything is being shown. */
  readonly nowMs = signal(Date.now());
  /** When the status was last checked (null until the first time). */
  readonly checkedMs = signal<number | null>(null);
  readonly checking = signal(false);

  /** A model was added to the ones looked at while a check was under way: the check goes round once more. */
  private again = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;

  /** The model on screen has its run from the catalog: what it holds is newer than any file fetched for it. */
  private readonly activePublished = computed<PublishedRun | null>(() => {
    const m = this.catalog.manifest();
    if (!m) return null;
    const initMs = runIdToMs(m.run);
    if (initMs === null) return null;
    return { run: m.run, initMs, builtMs: buildIdToMs(m.build), complete: true, reachHours: m.steps.at(-1)?.h ?? 0 };
  });

  /** Info for every model that has been looked at, in the order of the model list. */
  readonly infos = computed<ModelRunInfo[]>(() => {
    const now = this.nowMs();
    const active = this.catalog.activeModelId();
    const published = this.publishedById();
    const upstream = this.upstreamById();
    return FORECAST_MODELS.map(model => {
      const run = model.id === active ? (this.activePublished() ?? published[model.id] ?? null) : (published[model.id] ?? null);
      return modelRunInfo(model, run, upstream[model.id] ?? null, now);
    });
  });

  /** The model on screen. */
  readonly active = computed<ModelRunInfo | null>(() => this.infos().find(i => i.model.id === this.catalog.activeModelId()) ?? null);

  constructor() {
    // the model on screen is looked at as soon as there is one (the model button shows whether it is current); a change of run looks again
    effect(() => {
      const id = this.catalog.activeModelId();
      if (!this.catalog.manifest()) return;       // the run on screen is not known yet: looking now would only be done again
      untracked(() => {
        // the model that was on screen before is looked up from its own latest.json from now on, and a new run is a reason to look again
        this.wanted.add(id);
        this.again = true;
        this.startTimers();
        void this.refresh();
      });
    });
  }

  /** Looks at these models too (all of them, when the list is opened). Safe to call again: it only fetches what is not known yet. */
  watch(ids: readonly string[]): Promise<void> {
    const fresh = ids.filter(id => !this.wanted.has(id));
    ids.forEach(id => this.wanted.add(id));
    this.startTimers();
    if (!fresh.length) return this.inflight ?? Promise.resolve();
    this.again = true; // a check already under way began without them
    return this.refresh();
  }

  /** Checks every model looked at, now. Concurrent calls share one check. */
  refresh(): Promise<void> {
    this.inflight ??= this.load().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private startTimers(): void {
    if (typeof setInterval !== 'function') return;
    this.refreshTimer ??= setInterval(() => void this.refresh(), REFRESH_MS);
    this.tickTimer ??= setInterval(() => this.nowMs.set(Date.now()), TICK_MS);
  }

  private async load(): Promise<void> {
    this.checking.set(true);
    try {
      do {
        this.again = false;
        await this.loadWanted();
      } while (this.again);
      this.nowMs.set(Date.now());
      this.checkedMs.set(Date.now());
    } finally {
      this.checking.set(false);
    }
  }

  private async loadWanted(): Promise<void> {
    const models = FORECAST_MODELS.filter(m => this.wanted.has(m.id));
    const active = this.catalog.activeModelId();
    await Promise.all(
      models.map(async model => {
        const [published, upstream] = await Promise.all([model.id === active ? Promise.resolve(null) : this.fetchPublished(model), this.fetchUpstream(model)]);
        if (model.id !== active) this.publishedById.update(p => ({ ...p, [model.id]: published }));
        this.upstreamById.update(u => ({ ...u, [model.id]: upstream }));
      })
    );
  }

  /** A model that is not on screen: its latest.json says which run is on the site, its manifest how far the run reaches. */
  private async fetchPublished(model: ForecastModelDef): Promise<PublishedRun | null> {
    try {
      const latest = await this.getJson<{ run?: string; build?: string; complete?: boolean }>(`${model.baseUrl}/latest.json?t=${Math.floor(Date.now() / 60000)}`);
      const initMs = runIdToMs(latest.run);
      if (!latest.run || initMs === null) return null;
      const known = this.publishedById()[model.id];
      let reachHours = known && known.run === latest.run ? known.reachHours : model.reachHours;
      if (!known || known.run !== latest.run) {
        try {
          const manifest = await this.getJson<{ steps?: { h: number }[] }>(`${model.baseUrl}/${latest.run}/manifest.json${latest.build ? `?b=${encodeURIComponent(latest.build)}` : ''}`);
          reachHours = manifest.steps?.at(-1)?.h ?? reachHours;
        } catch {
          /* the nominal reach stands */
        }
      }
      return { run: latest.run, initMs, builtMs: buildIdToMs(latest.build), complete: latest.complete !== false, reachHours };
    } catch {
      return null;
    }
  }

  private async fetchUpstream(model: ForecastModelDef): Promise<Upstream | null> {
    const parts = await Promise.all(
      model.datasets.map(async dataset => {
        try {
          return parseDatasetRun(await this.getJson<unknown>(STATUS_URL(dataset)));
        } catch {
          return null;
        }
      })
    );
    return combineUpstream(parts);
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(TIMEOUT_MS) : undefined });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return (await res.json()) as T;
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
  }
}
