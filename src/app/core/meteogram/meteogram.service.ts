import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { ForecastInspectorService } from '../forecast/forecast-inspector.service';
import { ForecastStateService } from '../forecast/forecast-state.service';
import { PointSeriesService } from './point-series.service';

export type MeteogramView = 'model' | 'compare';
/** What the model comparison draws: temperature, the rain added up since the window began, the wind speed, or the pressure. */
export type CompareVar = 'temp' | 'rain' | 'wind' | 'pressure';
export type RangeDays = 3 | 5 | 10;
/** Whether the visitor wants the meteogram: never said (it then opens with the first click on the map), open, or put away. */
export type Wish = 'unset' | 'open' | 'closed';

const KEY = 'atmosiq-meteogram';
export const RANGE_DAYS: readonly RangeDays[] = [3, 5, 10];

interface Saved {
  wish: Wish;
  view: MeteogramView;
  compareVar: CompareVar;
  days: RangeDays;
}

function load(): Saved {
  const fallback: Saved = { wish: 'unset', view: 'model', compareVar: 'temp', days: 5 };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Saved> | null;
    if (!raw) return fallback;
    return {
      wish: raw.wish === 'open' || raw.wish === 'closed' ? raw.wish : 'unset',
      view: raw.view === 'compare' ? 'compare' : 'model',
      compareVar: (['temp', 'rain', 'wind', 'pressure'] as const).find(v => v === raw.compareVar) ?? 'temp',
      days: RANGE_DAYS.find(d => d === raw.days) ?? 5,
    };
  } catch {
    return fallback;
  }
}

/** Whether the screen has room for the sheet to open by itself: on a phone it would cover the map the visitor just touched. */
function roomForSheet(): boolean {
  return typeof window !== 'undefined' && window.innerWidth > 760 && window.innerHeight >= 620;
}

/**
 * The meteogram: an hourly chart of the place on the card, in a sheet over the time bar. It opens with the first click on the map; once the
 * visitor puts it away, or leaves it open, that is remembered. It follows the place on the card, and the time on the bar follows a click on it.
 */
@Injectable({ providedIn: 'root' })
export class MeteogramService {
  private readonly inspector = inject(ForecastInspectorService);
  private readonly state = inject(ForecastStateService);
  private readonly series = inject(PointSeriesService);

  private readonly saved = load();
  readonly wish = signal<Wish>(this.saved.wish);
  readonly view = signal<MeteogramView>(this.saved.view);
  readonly compareVar = signal<CompareVar>(this.saved.compareVar);
  readonly days = signal<RangeDays>(this.saved.days);
  /** Models drawn faintly out of the comparison by the visitor (their buttons in the legend). */
  readonly hidden = signal<ReadonlySet<string>>(new Set());
  /** The time under the pointer or the keyboard on the chart (null when none). */
  readonly hoverMs = signal<number | null>(null);

  /** The sheet is on screen: wanted, a place is chosen, and a forecast is showing. */
  readonly visible = computed(() => this.wish() === 'open' && this.inspector.selected() !== null && this.state.forecastActive());

  constructor() {
    effect(() => {
      const value: Saved = { wish: this.wish(), view: this.view(), compareVar: this.compareVar(), days: this.days() };
      try {
        localStorage.setItem(KEY, JSON.stringify(value));
      } catch {
        /* storage blocked: the choice lasts for this visit */
      }
    });
    // the chart follows the place on the card
    effect(() => {
      const sel = this.inspector.selected();
      if (!this.visible() || !sel) return;
      untracked(() => void this.series.load(sel.lat, sel.lon));
    });
  }

  open(): void {
    this.wish.set('open');
  }

  /** Puts the sheet away; it stays away until asked for again. */
  close(): void {
    this.wish.set('closed');
    this.hoverMs.set(null);
  }

  toggle(): void {
    if (this.wish() === 'open') this.close();
    else this.open();
  }

  /** A click on the map chose a place: the first time, the meteogram opens with it. Once the visitor has chosen either way, it is left as chosen. */
  noteMapClick(): void {
    if (this.wish() === 'unset' && roomForSheet()) this.wish.set('open');
  }

  toggleModel(id: string): void {
    this.hidden.update(h => {
      const next = new Set(h);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  retry(): void {
    const sel = this.inspector.selected();
    if (sel) void this.series.load(sel.lat, sel.lon, true);
  }
}
