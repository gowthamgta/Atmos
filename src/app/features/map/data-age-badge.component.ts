import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { IconComponent } from '../../shared/icon.component';
import { MapLayerService } from '../../core/services/map-layer.service';
import { RadarService } from '../../core/services/radar.service';
import { SatelliteService } from '../../core/satellite/satellite.service';

/** The live radar picture counts as old from this age (IMD scans every 10 to 15 minutes, a picture is usually 15 to 25 minutes old). */
export const RADAR_OLD_MIN = 30;
/** The satellite picture counts as old from this age (EUMETView is normally 30 to 45 minutes behind). */
export const SATELLITE_OLD_MIN = 90;

/** "45 min" or "2 h 10 min". */
export function formatAge(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * What the badge says about the observed picture on the map, or null when it is fresh: the newest radar scan or satellite picture when it is
 * old (the source is late or down), or that no radar picture can be shown. Only the live picture counts, not a step of the loop.
 */
export function dataAgeMessage(input: {
  radarOn: boolean;
  radarLive: boolean;
  radarAgeMin: number | null;
  radarAnyShown: boolean;
  radarSyncing: boolean;
  satelliteOn: boolean;
  satelliteNewest: boolean;
  satelliteAgeMin: number | null;
}): string | null {
  if (input.radarOn && input.radarLive) {
    if (input.radarAgeMin !== null && input.radarAgeMin >= RADAR_OLD_MIN) return `Radar: the newest scan is ${formatAge(input.radarAgeMin)} old`;
    if (input.radarAgeMin === null && input.radarAnyShown && !input.radarSyncing) return 'Radar: no picture from IMD right now';
  }
  if (input.satelliteOn && input.satelliteNewest && input.satelliteAgeMin !== null && input.satelliteAgeMin >= SATELLITE_OLD_MIN) {
    return `Satellite: the newest picture is ${formatAge(input.satelliteAgeMin)} old (EUMETSAT is running late)`;
  }
  return null;
}

/** A small badge on the map when the radar or satellite picture shown is old, so a late source is not mistaken for a dry sky. */
@Component({
  selector: 'app-data-age-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    @if (message(); as text) {
      <div class="badge" role="status"><app-icon name="alert" [size]="14" />{{ text }}</div>
    }
  `,
  styles: [`
    :host { display: contents; }
    .badge {
      position: fixed; left: 50%; top: 72px; transform: translateX(-50%); z-index: var(--z-ui);
      display: inline-flex; align-items: center; gap: var(--sp-2); max-width: calc(100vw - 24px);
      min-height: 30px; padding: 4px 14px; border-radius: 15px;
      background: var(--surface-1); color: var(--warn); box-shadow: var(--shadow-2);
      font-size: var(--fs-s); font-weight: var(--fw-medium); line-height: 1.3; text-align: center;
    }
  `],
})
export class DataAgeBadgeComponent {
  private readonly layers = inject(MapLayerService);
  private readonly radar = inject(RadarService);
  private readonly satellite = inject(SatelliteService);

  protected readonly message = computed(() => {
    const on = (id: string) => this.layers.layers().some(l => l.id === id && l.active);
    const live = this.radar.compositeMosaic();
    const radarMs = live?.timing?.epochMs;
    const shownIds = this.radar.stations.filter(s => !this.radar.hiddenStations().has(s.id));
    const frames = this.satellite.frames();
    return dataAgeMessage({
      radarOn: on('radar'),
      radarLive: this.radar.playIndex() === null && this.radar.leadIndex() === null,
      radarAgeMin: radarMs ? Math.max(0, Math.floor((this.radar.liveClock() - radarMs) / 60_000)) : null,
      radarAnyShown: shownIds.length > 0,
      radarSyncing: this.radar.isRefreshing() || this.radar.lastSyncTime() === null,
      satelliteOn: on('satellite'),
      satelliteNewest: frames.length > 0 && Math.round(this.satellite.position()) >= frames.length - 1,
      satelliteAgeMin: this.satellite.ageMinutes(),
    });
  });
}
