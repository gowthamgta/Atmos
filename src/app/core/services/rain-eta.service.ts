import { Injectable, computed, effect, inject } from '@angular/core';
import { ForecastInspectorService } from '../forecast/forecast-inspector.service';
import { MAX_SCAN_AGE_MIN } from './radar-mosaic';
import { COVERAGE_GOOD, COVERAGE_LIMITED } from './radar-coverage';
import { RadarCoverageService } from './radar-coverage.service';
import { RadarNowcastService } from './radar-nowcast.service';
import { describeRainEta, makeSampler, rainEta } from './radar-nowcast';
import { RadarService } from './radar.service';

/** Beyond this fraction of a radar's range its picture is too thin to say whether it rains at a place. */
const RANGE_MARGIN_KM = 10;
const HORIZON_MIN = 90;

/** The line of the place card about rain on the radar. */
export interface RainLine {
  text: string;
  /** Wet now or soon (the line is drawn in the rain colour). */
  wet: boolean;
  /** Where the words come from: the age of the radar picture, how the rain's motion was found, and how well the radar sees the place. */
  detail: string;
}

/**
 * When rain reaches the place on the card, or stops there, from the radar picture and the motion of the rain (see rainEta). It says nothing where
 * no working radar covers the place, so a blank picture is never read as a dry hour, and it says so where the radars see low rain only partly.
 */
@Injectable({ providedIn: 'root' })
export class RainEtaService {
  private readonly radar = inject(RadarService);
  private readonly nowcast = inject(RadarNowcastService);
  private readonly coverage = inject(RadarCoverageService);
  private readonly inspector = inject(ForecastInspectorService);

  /** The whole minute now (the line is worked out again once a minute, not every second). */
  private readonly minute = computed(() => Math.floor(this.radar.liveClock() / 60_000));

  readonly line = computed<RainLine | null>(() => {
    const place = this.inspector.selected();
    const motion = this.nowcast.motion();
    const frame = this.radar.liveFrame();
    this.minute();
    if (!place || !motion || !frame || frame.timeMs === null) return null;
    if (!this.seenByARadar(place.lat, place.lon)) return null;
    const eta = rainEta(makeSampler(frame.field, frame.width, frame.height, frame.coordinates), motion.field, place.lat, place.lon, HORIZON_MIN);
    const { text, wet } = describeRainEta(eta, HORIZON_MIN);
    const age = Math.max(0, Math.round((this.radar.liveClock() - frame.timeMs) / 60_000));
    const parts = [`radar ${age} min ago`, motion.source === 'radar' ? 'rain followed on the radar' : 'moving with the forecast wind'];
    const cls = this.coverage.classAt(place.lat, place.lon);
    if (cls !== null && cls < COVERAGE_GOOD) parts.push(cls >= COVERAGE_LIMITED ? 'radar sees low rain only partly here' : 'radar sees low rain poorly here');
    return { text, wet, detail: parts.join(' · ') };
  });

  constructor() {
    // the motion is kept up to date while a place is on the card, even with the radar layer off
    effect(() => this.nowcast.wanted.set(this.inspector.selected() !== null));
  }

  /** Whether a working radar's picture of the moment reaches the place. */
  private seenByARadar(lat: number, lon: number): boolean {
    const product = this.radar.activeProduct();
    const now = this.radar.liveClock();
    for (const station of this.radar.stations) {
      const result = this.radar.allRadarResults().get(station.id);
      const at = result?.timing?.epochMs;
      if (!result || result.isDisplayed === false || at === undefined || now - at > MAX_SCAN_AGE_MIN * 60_000) continue;
      const km = Math.hypot((lat - station.lat) * 111.32, (lon - station.lng) * 111.32 * Math.cos((station.lat * Math.PI) / 180));
      if (km <= (station.products[product]?.rangeKm ?? station.operationalRangeKm) - RANGE_MARGIN_KM) return true;
    }
    return false;
  }
}
