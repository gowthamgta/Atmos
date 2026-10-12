import { ModelSeries, PointSeries, indexAt, spreadOf, sumFrom } from './point-series';

/** What each model says at one hour of the chosen place. A value is null where the model has none (not provided, or its run has ended). */
export interface CompareRow {
  modelId: string;
  temp: number | null;
  feels: number | null;
  /** Rain in that hour (mm). */
  rain1h: number | null;
  /** Rain in the 24 hours from that hour (mm); null when the model's run ends before then. */
  rain24h: number | null;
  wind: number | null;
  gust: number | null;
  windDir: number | null;
  pressure: number | null;
  cloud: number | null;
  /** True when the model has a value for this hour at all. */
  covered: boolean;
}

export interface CompareColumns {
  temp: number | null;
  rain24h: number | null;
  wind: number | null;
  gust: number | null;
  pressure: number | null;
}

export interface CompareTable {
  /** The hour of the series the rows are for. */
  index: number;
  timeMs: number;
  rows: CompareRow[];
  /** How far apart the models are in each column: the largest minus the smallest of the values that exist. */
  spread: CompareColumns;
}

const at = (s: ModelSeries, key: keyof ModelSeries, i: number): number | null => s[key][i] ?? null;

/** The models side by side at one time, for the same place: the multimodel comparison of temperature, rain, wind and pressure. */
export function compareAt(series: PointSeries, modelIds: readonly string[], timeMs: number): CompareTable {
  const index = indexAt(series.times, timeMs);
  const rows: CompareRow[] = modelIds
    .filter(id => series.models[id])
    .map(id => {
      const s = series.models[id];
      const temp = at(s, 'temp', index);
      const wind = at(s, 'wind', index);
      return {
        modelId: id,
        temp,
        feels: at(s, 'feels', index),
        rain1h: at(s, 'rain', index),
        rain24h: sumFrom(s.rain, index, 24, true),
        wind,
        gust: at(s, 'gust', index),
        windDir: at(s, 'windDir', index),
        pressure: at(s, 'pressure', index),
        cloud: at(s, 'cloud', index),
        covered: temp !== null || wind !== null,
      };
    });
  const col = (pick: (r: CompareRow) => number | null) => spreadOf(rows.map(pick));
  return {
    index,
    timeMs: series.times[index] ?? timeMs,
    rows,
    spread: { temp: col(r => r.temp), rain24h: col(r => r.rain24h), wind: col(r => r.wind), gust: col(r => r.gust), pressure: col(r => r.pressure) },
  };
}
