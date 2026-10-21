import { IMD_RADAR_STATIONS } from '../domain/models/radar.model';

/* Which radars the visitor turned off in the panel, remembered between visits (private windows and blocked storage just forget it). */

const HIDDEN_STATIONS_KEY = 'atmosiq.radar.hiddenStations';

export function readHiddenStations(): ReadonlySet<string> {
  try {
    const ids = JSON.parse(localStorage.getItem(HIDDEN_STATIONS_KEY) ?? '[]');
    const known = IMD_RADAR_STATIONS.map(s => s.id);
    return new Set((Array.isArray(ids) ? ids : []).filter((id): id is string => known.includes(id)));
  } catch {
    return new Set();
  }
}

export function writeHiddenStations(hidden: ReadonlySet<string>): void {
  try {
    localStorage.setItem(HIDDEN_STATIONS_KEY, JSON.stringify([...hidden]));
  } catch {
    // the choice is simply not remembered
  }
}
