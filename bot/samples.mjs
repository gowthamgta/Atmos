// The radar over the rain gauges' cells, kept every run (sample.mjs) for the daily verification (pipeline/verify_radar.py): the radar's rain
// against the Tamil Nadu gauges (to calibrate the rain rate), and the nowcast's 30 and 60 minute guesses against the pictures that followed
// (to score it).

/** Half the side of a gauge cell (the cells of pipeline/verify_gauges.py: 0.5 degree, centred on x.25 and x.75). */
export const CELL_HALF_DEG = 0.25;
/** The cells over Tamil Nadu and Puducherry (8-14 N, 76-80.5 E). */
export const GAUGE_POINTS = (() => {
  const out = [];
  for (let lat = 8.25; lat <= 13.75; lat += 0.5) for (let lon = 76.25; lon <= 80.25; lon += 0.5) out.push([lat, lon]);
  return out;
})();
/** Days of samples kept (the daily verification needs the last rain day, 09:30 IST to 08:30 IST). */
export const KEEP_MS = 4 * 24 * 3_600_000;

/** One box as kept: [zp, max dBZ, wet share], or null where the radar does not reach. */
const pack = s => (s ? [s.zp, s.max, s.wet] : null);

/**
 * The store with one look added: `samples` as the app gives them (radar-sample.ts), at GAUGE_POINTS. A look at the same picture as the last
 * one, or with no picture, adds nothing; records older than KEEP_MS go.
 */
export function appendSamples(store, samples, nowMs) {
  const base = store && store.points ? store : { about: 'radar over the gauge cells, every look of the radar sampler (bot/samples.mjs)', points: GAUGE_POINTS, halfDeg: CELL_HALF_DEG, records: [] };
  const records = base.records.filter(r => nowMs - r.t <= KEEP_MS);
  if (samples?.timeMs && !records.some(r => r.t === samples.timeMs)) {
    records.push({ t: samples.timeMs, live: samples.live.map(pack), n30: samples.n30.map(pack), n60: samples.n60.map(pack) });
    records.sort((a, b) => a.t - b.t);
  }
  return { ...base, records };
}
