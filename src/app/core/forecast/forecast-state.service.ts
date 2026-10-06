import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { MapLayerService } from '../services/map-layer.service';
import { isPhone } from '../ui/device-profile';
import { ForecastCatalogService } from './forecast-catalog.service';
import {
  ALL_LEVELS,
  FORECAST_LAYERS,
  ForecastLayerDef,
  Level,
  availableLevels,
  contourSpec,
  forecastLayerById,
  layerAvailableAt,
  resolveLayer,
  supportsLevels,
  windVars,
} from './forecast-layers';

/** Which forecast layer is shown, at what time, and playback state. */
@Injectable({ providedIn: 'root' })
export class ForecastStateService {
  /** Forecast hours advanced per real second while playing. */
  private static readonly PLAY_HOURS_PER_SECOND = 4;

  private readonly catalog = inject(ForecastCatalogService);
  private readonly mapLayers = inject(MapLayerService);

  readonly layers = FORECAST_LAYERS;
  readonly activeLayerId = signal<string | null>(null);
  /** Altitude: the ground, or a pressure level. Layers that cannot be drawn aloft show the ground. */
  readonly level = signal<Level>('surface');
  /** The selected layer exactly as it is drawn at the selected altitude (variables, range, ticks, label). */
  readonly activeLayer = computed<ForecastLayerDef | null>(() => {
    const def = forecastLayerById(this.activeLayerId());
    return def ? resolveLayer(def, this.level()) : null;
  });
  /** Altitudes the current model has data for. */
  readonly levels = computed<Level[]>(() => availableLevels(this.catalog.manifest()?.vars));
  /** The two variables the wind animation follows at the selected altitude. */
  readonly windVars = computed(() => windVars(this.level()));
  /** Variable and line spacing for the pressure lines at the selected altitude. */
  readonly contour = computed(() => contourSpec(this.level()));
  /** Selected time in epoch ms (UTC); null until the first layer is switched on. */
  readonly timeMs = signal<number | null>(null);
  readonly playing = signal(false);
  /** Animated wind streaks over the map; independent of the colour layer. */
  readonly windParticles = signal(false);
  /** Pressure lines (isobars) over the map; independent of the colour layer. */
  readonly isobars = signal(false);
  /** The thin district lines on the map (the state and country outlines always stay). */
  readonly districtLines = signal(true);
  /** 1 km hill shading blended into the forecast colours (on by default on desktop, off on phones to keep the map smooth). */
  readonly relief = signal(!isPhone());
  /**
   * Full 1 km detail: smooth bicubic fields, and rain/low-cloud lift and sunshine on slopes. Off by default on phones,
   * where it would make the map lag; the colours, height corrections and relief stay either way.
   */
  readonly detail = signal(!isPhone());
  /** The timeline, legend and click inspector are active whenever any forecast overlay is on. */
  readonly forecastActive = computed(() => this.activeLayerId() !== null || this.windParticles() || this.isobars());

  readonly startMs = computed(() => this.catalog.validTimes()[0] ?? null);
  readonly endMs = computed(() => this.catalog.validTimes().at(-1) ?? null);

  private raf = 0;
  private lastFrame = 0;

  constructor() {
    // Switching to a model that lacks the selected altitude falls back to the ground.
    effect(() => {
      const manifest = this.catalog.manifest();
      if (manifest && !this.levels().includes(this.level())) untracked(() => this.level.set('surface'));
    });
    // Switching to a model that does not provide the active layer's variables (e.g. gusts on AIFS) turns it off.
    effect(() => {
      const manifest = this.catalog.manifest();
      const base = forecastLayerById(this.activeLayerId());
      if (manifest && base && !layerAvailableAt(base, this.level(), manifest.vars)) {
        untracked(() => this.activeLayerId.set(null));
      }
    });
    // Radar and the legacy overlays share the single-overlay slot: turning one on replaces the forecast layer.
    effect(() => {
      if (this.mapLayers.activeLayers().length > 0) {
        untracked(() => {
          this.activeLayerId.set(null);
          this.windParticles.set(false);
          this.isobars.set(false);
          this.pause();
        });
      }
    });
  }

  /** Turn a layer on (or off when it is already active). */
  toggleLayer(id: string): void {
    if (this.activeLayerId() === id) {
      this.activeLayerId.set(null);
      this.pauseIfIdle();
      return;
    }
    this.mapLayers.deactivateAll(); // radar and legacy overlays make way
    if (!supportsLevels(forecastLayerById(id))) this.level.set('surface'); // this layer only exists at the ground
    this.activeLayerId.set(id);
    if (forecastLayerById(id)?.varId2) this.windParticles.set(true); // wind layers are shown with their animation
    this.start();
  }

  /**
   * Choose the altitude. A layer that cannot be shown aloft (rain, gusts...) is replaced by temperature, so the map
   * always shows something at the chosen altitude.
   */
  setLevel(level: Level): void {
    if (!ALL_LEVELS.includes(level) || !this.levels().includes(level)) return;
    this.level.set(level);
    if (level !== 'surface' && !supportsLevels(forecastLayerById(this.activeLayerId()))) {
      this.toggleLayerOn('temp');
    }
  }

  private toggleLayerOn(id: string): void {
    if (this.activeLayerId() !== id) this.toggleLayer(id);
  }

  /** Show or hide the wind animation over whatever layer is active. */
  toggleWindParticles(): void {
    if (this.windParticles()) {
      this.windParticles.set(false);
      this.pauseIfIdle();
      return;
    }
    this.mapLayers.deactivateAll();
    this.windParticles.set(true);
    this.start();
  }

  /** Show or hide the pressure lines over whatever layer is active. */
  toggleIsobars(): void {
    if (this.isobars()) {
      this.isobars.set(false);
      this.pauseIfIdle();
      return;
    }
    this.mapLayers.deactivateAll();
    this.isobars.set(true);
    this.start();
  }

  toggleDetail(): void {
    this.detail.update(on => !on);
  }

  toggleDistrictLines(): void {
    this.districtLines.update(on => !on);
  }

  /** Turn the 1 km relief shading of the colour layers on or off. */
  toggleRelief(): void {
    this.relief.update(on => !on);
  }

  private pauseIfIdle(): void {
    if (!this.forecastActive()) this.pause();
  }

  /** Radar is its own entry in the layer menu: selecting it replaces any forecast layer. */
  selectRadar(): void {
    this.activeLayerId.set(null);
    this.windParticles.set(false);
    this.isobars.set(false);
    this.pause();
    this.mapLayers.selectSingleLayer('radar');
  }

  /** The Meteosat satellite picture is another observed layer; like the radar it replaces any forecast layer. */
  selectSatellite(): void {
    this.activeLayerId.set(null);
    this.windParticles.set(false);
    this.isobars.set(false);
    this.pause();
    this.mapLayers.selectSingleLayer('satellite');
  }

  /** The high-detail daily satellite picture is another observed layer, like the others replacing any forecast layer. */
  selectGibs(): void {
    this.activeLayerId.set(null);
    this.windParticles.set(false);
    this.isobars.set(false);
    this.pause();
    this.mapLayers.selectSingleLayer('gibs');
  }

  private start(): void {
    void this.catalog.ensureLoaded().then(() => this.initialiseTime());
  }

  /** After switching model: pull the selected time into the new model's forecast window. */
  reclampTime(): void {
    const t = this.timeMs();
    if (t !== null) this.setTime(t);
  }

  setTime(ms: number): void {
    const start = this.startMs();
    const end = this.endMs();
    if (start === null || end === null) return;
    this.timeMs.set(Math.min(Math.max(ms, start), end));
  }

  /** Move by whole hours (keyboard shortcuts). */
  stepHours(hours: number): void {
    const t = this.timeMs();
    if (t !== null) this.setTime(t + hours * 3_600_000);
  }

  togglePlay(): void {
    if (this.playing()) this.pause();
    else this.play();
  }

  play(): void {
    if (this.playing() || this.timeMs() === null || typeof requestAnimationFrame !== 'function') return;
    if (this.timeMs() === this.endMs()) this.setTime(this.startMs() ?? 0);
    this.playing.set(true);
    this.lastFrame = performance.now();
    const tick = (now: number) => {
      if (!this.playing()) return;
      const dt = Math.min(now - this.lastFrame, 100); // ignore long pauses (hidden tab)
      this.lastFrame = now;
      const t = (this.timeMs() ?? 0) + dt * ForecastStateService.PLAY_HOURS_PER_SECOND * 3.6e3;
      if (t >= (this.endMs() ?? 0)) {
        this.setTime(this.endMs() ?? t);
        this.pause();
        return;
      }
      this.setTime(t);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause(): void {
    this.playing.set(false);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Start at "now" (clamped into the forecast range) the first time a layer is shown. */
  private initialiseTime(): void {
    const start = this.startMs();
    const end = this.endMs();
    if (start === null || end === null) return;
    const current = this.timeMs();
    if (current === null) this.timeMs.set(Math.min(Math.max(Date.now(), start), end));
    else this.setTime(current); // a newer run may have a different range
  }
}
