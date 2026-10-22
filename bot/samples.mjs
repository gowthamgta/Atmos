// The radar over the rain gauges' cells and the owner's places, kept by the nowcast bot every ten minutes:
//  - for the daily verification (pipeline/verify_radar.py): the radar's rain against the Tamil Nadu gauges (to calibrate the rain rate), and the
//    nowcast's 30 and 60 minute guesses against the pictures that followed (to score it);
//  - for the owner's own rain alerts: a short message to their Telegram chat when rain is about to reach one of their places.

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
  const base = store && store.points ? store : { about: 'radar over the gauge cells, every look of the nowcast bot (bot/samples.mjs)', points: GAUGE_POINTS, halfDeg: CELL_HALF_DEG, records: [] };
  const records = base.records.filter(r => nowMs - r.t <= KEEP_MS);
  if (samples?.timeMs && !records.some(r => r.t === samples.timeMs)) {
    records.push({ t: samples.timeMs, live: samples.live.map(pack), n30: samples.n30.map(pack), n60: samples.n60.map(pack) });
    records.sort((a, b) => a.t - b.t);
  }
  return { ...base, records };
}

// ── the owner's rain alerts ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A place box is "raining" with this share of it at 25 dBZ or more (about 1 mm/h). */
export const ALERT_WET = 0.3;
/** One alert per place in this long, unless the rain was gone in between. */
export const ALERT_COOLDOWN_MS = 3 * 3_600_000;
/** The box around a place (about 10 km). */
export const PLACE_HALF_DEG = 0.05;

/** "Kallakurichi:11.74,78.96;Chennai:13.08,80.27" as places. */
export function parsePlaces(text) {
  return String(text || '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const [name, pos] = s.split(':');
      const [lat, lon] = (pos || '').split(',').map(Number);
      return name && Number.isFinite(lat) && Number.isFinite(lon) ? { name: name.trim(), lat, lon } : null;
    })
    .filter(Boolean);
}

/**
 * Whether to tell the owner rain is coming to a place: dry there now, and the nowcast has it wet in 30 or 60 minutes. Returns the message, or
 * null. `box` is the place's samples ({live, n30, n60}, each {zp, max, wet} or null), `last` the time of the place's last alert.
 */
export function placeAlert(place, box, radarTimeMs, nowMs, last) {
  if (!box?.live) return null;
  const wetNow = box.live.wet >= ALERT_WET;
  if (wetNow) return null; // already raining: they know
  if (last && nowMs - last < ALERT_COOLDOWN_MS) return null;
  const lead = box.n30?.wet >= ALERT_WET ? 30 : box.n60?.wet >= ALERT_WET ? 60 : null;
  if (!lead) return null;
  const peak = (lead === 30 ? box.n30?.max : box.n60?.max) ?? 0; // how strong it is in the picture that brings it
  const strength = peak >= 45 ? 'heavy rain' : peak >= 35 ? 'moderate rain' : 'light rain';
  const clock = new Date(radarTimeMs + lead * 60_000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
  return `Rain likely at ${place.name} within about ${lead} minutes (by ${clock} IST): ${strength} on the way, from the IMD radar nowcast. A guess from the rain's motion, not a forecast model.`;
}
