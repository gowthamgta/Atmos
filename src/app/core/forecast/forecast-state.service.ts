import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { MapLayerService } from '../services/map-layer.service';
import { isPhone } from '../ui/device-profile';
import { ForecastCatalogService } from './forecast-catalog.service';
import { ObservationsService } from './observations.service';
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
  /** Playback speeds: forecast hours advanced per real second. */
  static readonly SPEEDS = [2, 4, 8, 16] as const;

  private readonly catalog = inject(ForecastCatalogService);
  private readonly mapLayers = inject(MapLayerService);
  private readonly observations = inject(ObservationsService);

  readonly layers = FORECAST_LAYERS;
  readonly activeLayerId = signal<string | null>('wind');   // opens on the wind, as windy.com does: colours, legend and particles
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
  /** The period of the rain accumulation layer, in epoch ms (null until the layer is first chosen). */
  readonly rangeStartMs = signal<number | null>(null);
  readonly rangeEndMs = signal<number | null>(null);
  /** Selected time in epoch ms (UTC); null until the first layer is switched on. */
  readonly timeMs = signal<number | null>(null);
  readonly playing = signal(false);
  /** Forecast hours per real second while playing (one of SPEEDS). */
  readonly speed = signal<number>(4);
  /** Animated wind streaks over the map; independent of the colour layer. */
  readonly windParticles = signal(true);   // on by default: the app opens on the forecast wind, not the radar
  /** Pressure lines (isobars) over the map; independent of the colour layer. */
  readonly isobars = signal(false);
  /** Forecast tracks of tropical cyclones near the region (independent of the colour layer and the timeline). */
  readonly cyclones = signal(false);
  /** Lightning strokes of the last five minutes (ILDN), drawn over any layer. */
  readonly lightning = signal(false);
  /** The weather station markers on the map (SYNOP stations, observed; click one for its readings). Off by default. */
  readonly stationMarkers = signal(false);
  /** The thin district lines on the map (the state and country outlines always stay). Off by default. */
  readonly districtLines = signal(false);
  /** 90 m hill shading of the colour layers and the basemap, on by default (the layer menu switches it off). */
  readonly relief = signal(true);
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
    // the wind animation is on from the start, so the forecast clock is set up now (see initialiseTime)
    if (this.windParticles()) this.start();
  }

  /** Turn a layer on (or off when it is already active). */
  toggleLayer(id: string): void {
    if (this.activeLayerId() === id) {
      this.activeLayerId.set(null);
      this.pauseIfIdle();
      return;
    }
    this.mapLayers.deactivateAll(); // radar and legacy overlays make way
    const picked = forecastLayerById(id);
    if (!supportsLevels(picked)) this.level.set('surface'); // this layer only exists at the ground
    else if (picked?.levelOnly && this.level() === 'surface') this.level.set(this.levels().includes(850) ? 850 : (this.levels().find(l => l !== 'surface') ?? 'surface')); // this one only exists aloft
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
    const active = forecastLayerById(this.activeLayerId());
    if ((level !== 'surface' && !supportsLevels(active)) || (level === 'surface' && active?.levelOnly)) {
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

  toggleCyclones(): void {
    this.cyclones.update(on => !on);
  }

  toggleLightning(): void {
    this.lightning.update(on => !on);
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

  toggleStationMarkers(): void {
    this.stationMarkers.update(on => !on);
    if (this.stationMarkers()) void this.observations.refresh();
  }

  toggleDistrictLines(): void {
    this.districtLines.update(on => !on);
  }

  /** Turn the 90 m relief shading of the colour layers on or off. */
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
    this.lightning.set(true); // lightning comes with the radar and the satellite by default (it can be switched off, and a link says what it wants)
    this.mapLayers.selectSingleLayer('radar');
  }

  /** The Meteosat satellite picture is another observed layer; like the radar it replaces any forecast layer. */
  selectSatellite(): void {
    this.activeLayerId.set(null);
    this.windParticles.set(false);
    this.isobars.set(false);
    this.pause();
    this.lightning.set(true);
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
    this.ensureRainRange();
  }

  setTime(ms: number): void {
    const start = this.startMs();
    const end = this.endMs();
    if (start === null || end === null) return;
    this.timeMs.set(Math.min(Math.max(ms, start), end));
  }

  /** The period shortest the slider allows. */
  static readonly MIN_RANGE_MS = 3 * 3_600_000;

  /** Start of the rain accumulation period (kept at least 3 h before its end and inside the run). */
  setRangeStart(ms: number): void {
    const start = this.startMs();
    const end = this.rangeEndMs();
    if (start === null || end === null) return;
    this.rangeStartMs.set(Math.min(Math.max(ms, start), end - ForecastStateService.MIN_RANGE_MS));
  }

  /** End of the rain accumulation period (kept at least 3 h after its start and inside the run). */
  setRangeEnd(ms: number): void {
    const last = this.endMs();
    const from = this.rangeStartMs();
    if (last === null || from === null) return;
    this.rangeEndMs.set(Math.max(Math.min(ms, last), from + ForecastStateService.MIN_RANGE_MS));
  }

  /** Moves the whole period (its length kept), stopping where it meets either end of the run. */
  shiftRange(deltaMs: number): void {
    const first = this.startMs();
    const last = this.endMs();
    const from = this.rangeStartMs();
    const to = this.rangeEndMs();
    if (first === null || last === null || from === null || to === null) return;
    const d = Math.min(Math.max(deltaMs, first - from), last - to);
    this.rangeStartMs.set(from + d);
    this.rangeEndMs.set(to + d);
  }

  /** The first time the period is needed: from now for 24 h; after that (or after a change of model) it is only kept inside the run. */
  private ensureRainRange(): void {
    const first = this.startMs();
    const last = this.endMs();
    if (first === null || last === null) return;
    const gap = ForecastStateService.MIN_RANGE_MS;
    let from = this.rangeStartMs();
    let to = this.rangeEndMs();
    if (from === null || to === null) {
      from = Math.min(Math.max(Date.now(), first), last - gap);
      to = Math.min(from + 24 * 3_600_000, last);
    }
    from = Math.min(Math.max(from, first), last - gap);
    to = Math.max(Math.min(to, last), from + gap);
    this.rangeStartMs.set(from);
    this.rangeEndMs.set(to);
  }

  /** Move by whole hours (keyboard shortcuts). */
  stepHours(hours: number): void {
    const t = this.timeMs();
    if (t !== null) this.setTime(t + hours * 3_600_000);
  }

  /** Show another model and keep the chosen time inside its forecast window (the model buttons and the menu both use this). */
  selectModel(id: string): void {
    void this.catalog.setModel(id).then(() => this.reclampTime());
  }

  setSpeed(hoursPerSecond: number): void {
    if ((ForecastStateService.SPEEDS as readonly number[]).includes(hoursPerSecond)) this.speed.set(hoursPerSecond);
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
      const t = (this.timeMs() ?? 0) + dt * this.speed() * 3.6e3;
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
    this.ensureRainRange();
  }
}
