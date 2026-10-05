import { Injectable } from '@angular/core';
import { AreaIndex, PlaceMatch, buildAreaIndex, findPlace } from './district-lookup';

/** Loads the district polygons once and answers "which district is this point in?". */
@Injectable({ providedIn: 'root' })
export class DistrictLookupService {
  private index: AreaIndex | null = null;
  private loading: Promise<AreaIndex> | null = null;

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
    this.loading ??= fetch('/data/south-india-districts.geojson')
      .then(res => {
        if (!res.ok) throw new Error(`${res.status} ${res.url}`);
        return res.json();
      })
      .then(json => (this.index = buildAreaIndex(json)))
      .catch(err => {
        this.loading = null;
        throw err;
      });
    return this.loading;
  }
}
