import { Injectable } from '@angular/core';
import { distanceKm } from './distance';
import { HOME } from './home';

export interface Place {
  name: string;
  /** District and state, for telling places of one name apart ("Salem, Tamil Nadu"). */
  region: string;
  lat: number;
  lon: number;
  /** People living there, when the service knows (it ranks a city above a hamlet of the same name). */
  population?: number;
}

interface GeocodingResult {
  name?: string;
  latitude?: number;
  longitude?: number;
  admin1?: string;
  admin2?: string;
  country?: string;
  country_code?: string;
  population?: number;
}

/** The places of Open-Meteo's geocoding answer: those with a position, without repeats, at most `limit`. */
export function parseGeocoding(json: { results?: GeocodingResult[] } | null | undefined, limit = 8): Place[] {
  const seen = new Set<string>();
  const out: Place[] = [];
  for (const r of json?.results ?? []) {
    if (!r.name || typeof r.latitude !== 'number' || typeof r.longitude !== 'number') continue;
    const key = `${r.name}|${r.latitude.toFixed(2)}|${r.longitude.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const region = [r.admin2, r.admin1, r.country].filter((x, i, all) => !!x && all.indexOf(x) === i && x !== r.name).join(', ');
    out.push({ name: r.name, region, lat: r.latitude, lon: r.longitude, ...(r.population ? { population: r.population } : {}) });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The order of the suggestions: bigger places first, a place named exactly as typed ahead of the others of its size, and nearer places
 * ahead of farther ones when that is equal (the map is centred on South India, so of two unknown hamlets the southern one comes first).
 */
export function rankPlaces(places: readonly Place[], query: string, from: { lat: number; lon: number }): Place[] {
  const q = query.trim().toLowerCase();
  const score = (p: Place) => (p.population ?? 0) + (p.name.toLowerCase() === q ? 300_000 : 0);
  const km = (p: Place) => distanceKm(from.lat, from.lon, p.lat, p.lon);
  return [...places].sort((a, b) => score(b) - score(a) || km(a) - km(b));
}

/**
 * Finds places worldwide by name, with Open-Meteo's free geocoding service (the same provider and the same personal, non-commercial use as the
 * model data). Only the text typed in the search box is sent. A newer search cancels the one before it.
 */
@Injectable({ providedIn: 'root' })
export class PlaceSearchService {
  private controller: AbortController | null = null;
  private readonly reverseCache = new Map<string, Promise<{ name: string; region: string } | null>>();

  async reverse(lat: number, lon: number): Promise<{ name: string; region: string } | null> {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    let p = this.reverseCache.get(key);
    if (!p) {
      const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(lat.toFixed(4))}&longitude=${encodeURIComponent(lon.toFixed(4))}&localityLanguage=en`;
      p = fetch(url, { signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(4000) : undefined })
        .then(r => (r.ok ? (r.json() as Promise<{ city?: string; locality?: string; principalSubdivision?: string; countryName?: string }>) : null))
        .then(j => {
          if (!j) return null;
          const name = (j.city || j.locality || j.principalSubdivision || j.countryName || '').trim();
          if (!name) return null;
          const region = [j.principalSubdivision, j.countryName].filter((x, i, a) => !!x && a.indexOf(x) === i && x !== name).join(', ');
          return { name, region };
        })
        .catch(() => null);
      this.reverseCache.set(key, p);
      if (this.reverseCache.size > 64) this.reverseCache.delete(this.reverseCache.keys().next().value!);
    }
    return p;
  }

  async search(query: string): Promise<Place[]> {
    const q = query.trim();
    this.controller?.abort();
    if (q.length < 2) return [];
    this.controller = new AbortController();
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=30&language=en&format=json`;
    try {
      const res = await fetch(url, { signal: this.controller.signal });
      return res.ok ? rankPlaces(parseGeocoding(await res.json(), 30), q, HOME).slice(0, 8) : [];
    } catch {
      return []; // offline, or cancelled by a newer search
    }
  }
}
