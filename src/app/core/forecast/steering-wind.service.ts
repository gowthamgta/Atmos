import { Injectable, inject } from '@angular/core';
import { decodeFieldBitmap } from './field-decode';
import { FieldLoaderService } from './field-loader.service';
import { ForecastCatalogService } from './forecast-catalog.service';
import { bracketSteps, sampleGrid } from './forecast.model';

/**
 * The wind that steers the rain where the radar cannot show how it moves (no earlier picture to follow it by): the mean of the forecast
 * 850, 700 and 500 hPa winds, falling back to the 10 m wind.
 */
@Injectable({ providedIn: 'root' })
export class SteeringWindService {
  private readonly catalog = inject(ForecastCatalogService);
  private readonly loader = inject(FieldLoaderService);

  /**
   * Steering wind (m/s east and north) at a point and time, from whichever of those levels the model has. Null when no forecast is available.
   */
  async at(lat: number, lon: number, timeMs: number): Promise<[number, number] | null> {
    try {
      await this.catalog.ensureLoaded();
      const manifest = this.catalog.manifest();
      if (!manifest) return null;
      let levels = [850, 700, 500].filter(l => `u${l}` in manifest.vars && `v${l}` in manifest.vars).map(l => [`u${l}`, `v${l}`]);
      if (levels.length === 0 && 'u10' in manifest.vars && 'v10' in manifest.vars) levels = [['u10', 'v10']];
      if (levels.length === 0) return null;
      const { a, b, mix } = bracketSteps(this.catalog.validTimes(), timeMs);
      const read = async (id: string): Promise<number> => {
        const info = manifest.vars[id];
        const [ba, bb] = await Promise.all([this.loader.get(id, manifest.steps[a].h), this.loader.get(id, manifest.steps[b].h)]);
        const va = sampleGrid(decodeFieldBitmap(ba, info.min, info.max), manifest.grid, lat, lon);
        const vb = sampleGrid(decodeFieldBitmap(bb, info.min, info.max), manifest.grid, lat, lon);
        return Number.isNaN(va) ? vb : Number.isNaN(vb) ? va : va * (1 - mix) + vb * mix;
      };
      let u = 0;
      let v = 0;
      let n = 0;
      for (const [uid, vid] of levels) {
        const [lu, lv] = await Promise.all([read(uid), read(vid)]);
        if (Number.isNaN(lu) || Number.isNaN(lv)) continue;
        u += lu;
        v += lv;
        n++;
      }
      return n > 0 ? [u / n, v / n] : null;
    } catch {
      return null;
    }
  }
}
