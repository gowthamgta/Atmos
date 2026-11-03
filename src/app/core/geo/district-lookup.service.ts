import { Injectable } from '@angular/core';
import { AreaIndex, PlaceMatch, buildAreaIndex, findPlace } from './district-lookup';
/** The published outlines (a GeoJSON FeatureCollection; MapLibre and buildAreaIndex read it as it is). */
type GeoJSONFeatureCollection = { type: 'FeatureCollection'; features: unknown[] };

/** Loads the district polygons once and answers "which district is this point in?". */
@Injectable({ providedIn: 'root' })
export class DistrictLookupService {
  private index: AreaIndex | null = null;
  private loading: Promise<AreaIndex> | null = null;
  private raw: Promise<GeoJSONFeatureCollection> | null = null;

  /** The district and state outlines as published (one download, shared with the map's boundary lines). */
  geojson(): Promise<GeoJSONFeatureCollection> {
    this.raw ??= fetch('/data/south-india-districts.geojson').then(res => {
      if (!res.ok) throw new Error(`${res.status} ${res.url}`);
      return res.json() as Promise<GeoJSONFeatureCollection>;
    });
    this.raw.catch(() => (this.raw = null));
    return this.raw;
  }

  async lookup(lat: number, lon: number): Promise<PlaceMatch> {
    try {
      return findPlace(await this.ensureLoaded(), lat, lon);
    } catch (err) {
      console.warn('[districts] lookup unavailable', err);
      return { district: null, state: null };
    }
  }

  private ensureLoaded(): Promise<AreaIndex> {
    if (this.index) return Promise.resolve(this.index);
    this.loading ??= this.geojson()
      .then(json => (this.index = buildAreaIndex(json as never)))
      .catch(err => {
        this.loading = null;
        throw err;
      });
    return this.loading;
  }
}
