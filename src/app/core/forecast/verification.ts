/**
 * How right each model has been lately, from the daily scores at the South Indian airports (pipeline/verify.py writes
 * public/data/verification/scores.json): what each model forecast 1, 2 and 3 days ahead against the airports' hourly reports.
 */

export interface ErrorScore {
  /** Mean absolute error and bias (forecast minus observed), in C or m/s, over `n` hours. */
  mae: number;
  bias: number;
  n: number;
}

export interface RainScore {
  hits: number;
  misses: number;
  false: number;
}

export interface LeadScores {
  temp?: ErrorScore;
  /** The same after the model's correction (learn_bias.py), where it has one. */
  temp_c?: ErrorScore;
  dewp?: ErrorScore;
  wind?: ErrorScore;
  rain?: RainScore;
}

export interface VerificationFile {
  airports: string[];
  leads: number[];
  updated: string;
  days: { date: string; models: Record<string, Record<string, LeadScores>>; nowcast?: Record<string, { nowcast: RainScore; still: RainScore }> }[];
}

/** The radar nowcast's threat score over the last days, and that of a picture that does not move (the baseline), `lead` minutes ahead. */
export function nowcastSkill(file: VerificationFile, windowDays = 14, lead = 30): { days: number; nowcast: number; still: number } | null {
  const days = file.days.slice(-windowDays).map(d => d.nowcast?.[String(lead)]).filter((x): x is { nowcast: RainScore; still: RainScore } => !!x);
  const sum = (pick: (x: { nowcast: RainScore; still: RainScore }) => RainScore) =>
    days.reduce((a, x) => ({ hits: a.hits + pick(x).hits, misses: a.misses + pick(x).misses, false: a.false + pick(x).false }), { hits: 0, misses: 0, false: 0 });
  const threat = (r: RainScore) => (r.hits + r.misses + r.false > 0 ? r.hits / (r.hits + r.misses + r.false) : 0);
  const n = sum(x => x.nowcast);
  if (days.length === 0 || n.hits + n.misses < 20) return null;
  return { days: days.length, nowcast: threat(n), still: threat(sum(x => x.still)) };
}

export interface ModelSkill {
  modelId: string;
  /** Days with scores in the window. */
  days: number;
  /** Mean absolute error of temperature (C) and its bias (+: too warm), weighted by hours. */
  tempMae: number | null;
  tempBias: number | null;
  /** The temperature error after the model's correction (null where it has none). */
  tempMaeCorrected: number | null;
  windMae: number | null;
  /** Share of the rainy hours the model had rain in, and share of its rainy hours that stayed dry (null: too few to say). */
  rainCaught: number | null;
  rainFalse: number | null;
  /** 1 for the smallest temperature error among the models, 2 for the next... (null without a score). */
  tempRank: number | null;
}

/** Fewer rainy hours than this in the window and the rain shares say nothing. */
const MIN_RAIN_HOURS = 10;

function pool(scores: (ErrorScore | undefined)[]): { mae: number; bias: number } | null {
  let n = 0, abs = 0, sum = 0;
  for (const s of scores) {
    if (!s || s.n === 0) continue;
    n += s.n;
    abs += s.mae * s.n;
    sum += s.bias * s.n;
  }
  return n === 0 ? null : { mae: abs / n, bias: sum / n };
}

/**
 * Each model's skill over the last `windowDays` days of the file at `lead` days ahead, ranked by temperature error; `only`: the models to
 * give (and rank among), all of them by default.
 */
export function summarizeSkill(file: VerificationFile, windowDays = 14, lead = 1, only?: readonly string[]): ModelSkill[] {
  const days = file.days.slice(-windowDays);
  const ids = [...new Set(days.flatMap(d => Object.keys(d.models ?? {})))].filter(id => !only || only.includes(id));
  const out: ModelSkill[] = ids.map(id => {
    const at = days.map(d => d.models?.[id]?.[String(lead)]).filter((s): s is LeadScores => !!s);
    const temp = pool(at.map(s => s.temp));
    const tempC = pool(at.map(s => s.temp_c));
    const wind = pool(at.map(s => s.wind));
    const rain = at.reduce((acc, s) => ({ hits: acc.hits + (s.rain?.hits ?? 0), misses: acc.misses + (s.rain?.misses ?? 0), false: acc.false + (s.rain?.false ?? 0) }), { hits: 0, misses: 0, false: 0 });
    const wet = rain.hits + rain.misses;
    const forecastWet = rain.hits + rain.false;
    return {
      modelId: id,
      days: at.length,
      tempMae: temp?.mae ?? null,
      tempBias: temp?.bias ?? null,
      tempMaeCorrected: tempC?.mae ?? null,
      windMae: wind?.mae ?? null,
      rainCaught: wet >= MIN_RAIN_HOURS ? rain.hits / wet : null,
      rainFalse: forecastWet >= MIN_RAIN_HOURS ? rain.false / forecastWet : null,
      tempRank: null,
    };
  });
  const ranked = out.filter(s => s.tempMae !== null).sort((a, b) => a.tempMae! - b.tempMae!);
  ranked.forEach((s, i) => (s.tempRank = i + 1));
  return out;
}

/** One line for the model list, e.g. "Last 14 days: 1.1 °C off on average (0.9 too cold) · rain caught 62%". */
export function skillLine(s: ModelSkill): string {
  if (s.tempMae === null) return '';
  const parts = [`${s.tempMae.toFixed(1)} °C off on average`];
  if (s.tempBias !== null && Math.abs(s.tempBias) >= 0.3) parts[0] += ` (${Math.abs(s.tempBias).toFixed(1)} too ${s.tempBias < 0 ? 'cold' : 'warm'})`;
  if (s.tempMaeCorrected !== null && s.tempMaeCorrected < s.tempMae - 0.05) parts.push(`${s.tempMaeCorrected.toFixed(1)} °C corrected`);
  if (s.rainCaught !== null) parts.push(`rain caught ${Math.round(s.rainCaught * 100)}%`);
  if (s.rainFalse !== null) parts.push(`false alarms ${Math.round(s.rainFalse * 100)}%`);
  return parts.join(' · ');
}
