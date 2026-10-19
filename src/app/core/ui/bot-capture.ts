/**
 * The nowcast bot's view of the app (see bot/nowcast.mjs). With `bot=1` in the address the page hides its panels, so a screenshot is the
 * radar map with its time bar and colour scale only, and publishes the storm cells it finds on the live radar for the bot to read. Without
 * it nothing here runs.
 */

/** True when the page was opened by the nowcast bot. */
export const BOT_CAPTURE = typeof location !== 'undefined' && /(?:^#|[#&])bot=1(?:&|$)/.test(location.hash);

/** One storm cell on the live radar, as the bot reads it. */
export interface NowcastCell {
  lat: number;
  lon: number;
  /** Strongest reflectivity in the cell. */
  dbz: number;
  radiusKm: number;
  /** Motion, when it is known (from the radar loop, or else the forecast steering wind). */
  speedKmh: number | null;
  towardsDeg: number | null;
}

/** What the page tells the bot: the time of the live radar picture and the storm cells on it. */
export interface NowcastSnapshot {
  radarTimeMs: number | null;
  /** How the motion was found: 'radar' once the last hour's loop is in, else 'wind', or null without cells. */
  motionSource: 'radar' | 'wind' | null;
  /** The last hour's loop is loaded (the motion is then from the radar itself). */
  loopLoaded: boolean;
  cells: NowcastCell[];
}

/** Hands the snapshot to the bot (a global it polls for); does nothing unless the page is in bot mode. */
export function publishNowcast(snapshot: NowcastSnapshot): void {
  if (BOT_CAPTURE) (window as unknown as { __atmosNowcast?: NowcastSnapshot }).__atmosNowcast = snapshot;
}
