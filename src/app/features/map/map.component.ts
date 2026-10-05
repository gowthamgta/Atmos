import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  effect,
  signal,
  computed,
  ViewChild,
  ElementRef,
  untracked,
  isDevMode
} from '@angular/core';
import * as maplibregl from 'maplibre-gl';
import { Map as MapLibreMap, Marker } from 'maplibre-gl';
import { MapLayerService, LayerConfig } from '../../core/services/map-layer.service';
import { RadarService } from '../../core/services/radar.service';
import {
  RadarProductKey,
  ProcessedRadarResult
} from '../../core/domain/models/radar.model';

/** [[west, south], [east, north]]: the whole forecast area (South India, Sri Lanka and the seas around them). */
const SOUTH_INDIA_VIEW: [[number, number], [number, number]] = [[67.5, 3.5], [90.5, 22.5]];
/** How far the map can be panned and zoomed out: wide enough to roam freely beyond the forecast area. */
const MAP_MAX_BOUNDS: [[number, number], [number, number]] = [[52, -10], [108, 34]];

// Tamil Nadu state + district outlines (built by scripts/build-tn-data.py). The lines are drawn
// above every raster overlay (radar, microclimate) so boundaries stay readable on top of them.
const BOUNDARY_SOURCE_ID = 'tn-boundaries';
const BOUNDARY_FIRST_LAYER_ID = 'tn-district-casing';
import { MicroclimateService } from '../../core/services/microclimate.service';
import { ForecastMapController } from '../../core/forecast/forecast-map.controller';
import { blendDirectionDeg } from '../../core/domain/models/microclimate.model';

@Component({
  selector: 'app-map',
  standalone: true,
  template: `
    <div id="map-container">
      <!-- 🍃 Viewport Overlay Canvas for Uniform-Density Wind Streamlines at ALL Zooms -->
      <canvas #windViewportCanvas class="wind-viewport-overlay" [class.active]="isWindActive()"></canvas>

      <!-- ⛰️ South India Regional Microclimate Click Inspector Tooltip -->
      @if (mcInspection()) {
        <div
          class="radar-hover-tooltip mc-tooltip"
          [style.left.px]="mcInspection()!.x"
          [style.top.px]="mcInspection()!.y"
        >
          <div class="tooltip-top-row">
            <span class="mc-zone-badge">📍 {{ mcInspection()!.zone }}</span>
            <span class="mc-elev-badge">
              @if (mcInspection()!.sliceElevationMeters === 0) {
                🌱 Surface (0m)
              } @else {
                ✈️ {{ (mcInspection()!.sliceElevationMeters / 1000).toFixed(1) }} km ({{ mcInspection()!.sliceElevationMeters }}m)
              }
            </span>
            <button class="mc-tooltip-close-btn" (click)="mcService.clearInspection()" title="Close inspection pin">✕</button>
          </div>
          <div class="mc-data-grid single-item">
            @if (isTempActive()) {
              <div class="mc-cell highlight-temp">
                <span class="mc-label">SURFACE TEMPERATURE</span>
                <span class="mc-val temp">{{ mcInspection()!.temperatureC }}°C</span>
              </div>
            } @else if (isHumidityActive()) {
              <div class="mc-cell highlight-hum">
                <span class="mc-label">RELATIVE HUMIDITY</span>
                <span class="mc-val hum">{{ mcInspection()!.humidityPercent }}%</span>
              </div>
            } @else if (isWindActive()) {
              <div class="mc-cell highlight-wind">
                <span class="mc-label">WIND STREAMLINE VELOCITY</span>
                <span class="mc-val wind">{{ mcInspection()!.windSpeedKmh }} km/h ({{ mcInspection()!.windDirectionLabel }} • {{ mcInspection()!.windDirectionDeg }}°)</span>
                <span class="mc-wind-mode-tag" [class.cold]="mcInspection()!.humidityPercent > 70" [class.dry]="mcInspection()!.humidityPercent <= 70">
                  {{ mcInspection()!.humidityPercent > 70 ? '❄️ Cold Cyan (>70% RH)' : '🏜️ Dry Amber (≤70% RH)' }}
                </span>
              </div>
            } @else if (isRain24hActive()) {
              <div class="mc-cell highlight-rain">
                <span class="mc-label">24H EXTREME RAINFALL FORECAST (ECMWF)</span>
                <span class="mc-val rain">{{ mcInspection()!.rain24hMm }} mm</span>
                <span class="mc-risk-badge" [class.heavy]="mcInspection()!.rain24hMm >= 64.5">
                  {{ mcInspection()!.rainRiskLabel }}
                </span>
              </div>
            } @else if (isCapeActive()) {
              <div class="mc-cell highlight-cape">
                <span class="mc-label">CAPE INSTABILITY INDEX (ECMWF)</span>
                <span class="mc-val cape">{{ mcInspection()!.capeJkg }} J/kg</span>
                <span class="mc-risk-badge cape" [class.severe]="mcInspection()!.capeJkg >= 2000">
                  {{ mcInspection()!.capeRiskLabel }}
                </span>
              </div>
            }
          </div>
          <div class="tooltip-desc-row">
            <span class="tooltip-coords">
              {{ mcInspection()!.lat.toFixed(3) }}°N, {{ mcInspection()!.lon.toFixed(3) }}°E • Terrain: {{ mcInspection()!.groundElevationMeters }}m ASL • {{ mcInspection()!.sliceLabel }}
            </span>
          </div>
        </div>
      }

      <!-- 🏔️ Floating 100m Elevation & Nowcast Control Widget on Map -->
      @if (is500mActive()) {
        <div class="map-mc-elevation-widget" [class.collapsed]="isWidgetCollapsed()">
          <div class="mc-widget-header">
            <div class="mc-widget-title-group" (click)="toggleWidgetCollapsed()">
              <span class="mc-widget-live-dot"></span>
              <span class="mc-widget-title">500m NOWCAST ({{ (mcService.selectedElevationMeters() / 1000).toFixed(1) }} km)</span>
            </div>
            <div class="mc-widget-header-actions">
              <button class="mc-widget-collapse-btn" (click)="toggleWidgetCollapsed()" [title]="isWidgetCollapsed() ? 'Expand Altitude Controls' : 'Collapse'">
                {{ isWidgetCollapsed() ? '▲' : '▼' }}
              </button>
              <button class="mc-widget-off-btn" (click)="turnOffMicroclimate($event)" title="Turn off regional microclimate completely">
                ✕ Off
              </button>
            </div>
          </div>

          @if (!isWidgetCollapsed()) {
            <div class="mc-widget-body">
              <!-- Active Altitude & Sounding Readout -->
              <div class="mc-widget-status-row">
                <span class="alt-badge">{{ mcService.currentSoundingState().levelLabel }}</span>
                <span class="mc-sync-dot" [class.stale]="mcService.dataStatus() !== 'live'" [title]="mcService.fetchError() ?? 'ECMWF IFS via Open-Meteo'">● {{ mcService.statusLabel() }}</span>
              </div>

              <!-- Metrics Row -->
              <div class="mc-widget-metrics-row">
                <div class="m-pill temp" (click)="mcService.setRasterMode('temp')" title="View Temperature Layer">
                  <span class="m-icon">🌡️</span>
                  <span class="m-text">{{ mcService.currentSoundingState().temperatureC }}°C</span>
                </div>
                <div class="m-pill hum" (click)="mcService.setRasterMode('humidity')" title="View Humidity Layer">
                  <span class="m-icon">💧</span>
                  <span class="m-text">{{ mcService.currentSoundingState().humidityPercent }}%</span>
                </div>
                <div class="m-pill wind" (click)="mcService.setRasterMode('wind')" title="View Wind Streamlines">
                  <span class="m-icon">🍃</span>
                  <span class="m-text">{{ mcService.currentSoundingState().windSpeedKmh }} km/h</span>
                </div>
              </div>

              <!-- Continuous Elevation Slider (0m to 13,000m) -->
              <div class="mc-widget-slider-box">
                <div class="slider-labels">
                  <span>Ground (0m)</span>
                  <span class="slider-active-alt">{{ (mcService.selectedElevationMeters() / 1000).toFixed(1) }} km</span>
                  <span>13.0 km</span>
                </div>
                <input
                  type="range"
                  class="mc-altitude-slider"
                  min="0"
                  max="13000"
                  step="100"
                  [value]="mcService.selectedElevationMeters()"
                  (input)="onElevationSliderChange($event)"
                  title="Slide altitude from ground level to 13 km"
                />
              </div>

              <!-- Quick Altitude Presets -->
              <div class="mc-widget-presets">
                @for (preset of mcService.elevationPresets; track preset.meters) {
                  <button
                    class="alt-preset-btn"
                    [class.active]="mcService.selectedElevationMeters() === preset.meters"
                    (click)="mcService.setElevation(preset.meters)"
                    [title]="preset.tag"
                  >
                    {{ preset.label }}
                  </button>
                }
              </div>

              <!-- View Selector (Temp, Hum, Wind, Rain 24h, CAPE) -->
              <div class="mc-widget-mode-row">
                <span class="mode-lbl">VIEW:</span>
                <button
                  class="mode-chip"
                  [class.active]="mcService.rasterMode() === 'temp'"
                  (click)="mcService.setRasterMode('temp')"
                >
                  🌡️ Temp
                </button>
                <button
                  class="mode-chip"
                  [class.active]="mcService.rasterMode() === 'humidity'"
                  (click)="mcService.setRasterMode('humidity')"
                >
                  💧 Hum
                </button>
                <button
                  class="mode-chip"
                  [class.active]="mcService.rasterMode() === 'wind'"
                  (click)="mcService.setRasterMode('wind')"
                >
                  🍃 Wind
                </button>
                <button
                  class="mode-chip"
                  [class.active]="mcService.rasterMode() === 'rain-24h'"
                  (click)="mcService.setRasterMode('rain-24h')"
                >
                  🌧️ Rain 24h
                </button>
                <button
                  class="mode-chip"
                  [class.active]="mcService.rasterMode() === 'cape'"
                  (click)="mcService.setRasterMode('cape')"
                >
                  ⚡ CAPE
                </button>
              </div>

              <!-- Dedicated Wind Streamlines Menu: Dynamic RH Palette -->
              @if (mcService.rasterMode() === 'wind') {
                <div class="mc-wind-menu-box">
                  <div class="wind-menu-top">
                    <span class="wind-menu-lbl">🍃 WIND STREAMLINES:</span>
                    <span class="wind-menu-flow-tag">{{ mcService.currentSoundingState().windSpeedKmh }} km/h</span>
                  </div>
                  <div class="wind-pal-row dynamic-info">
                    <div class="wind-pal-badge cold">
                      <span class="pal-dot cold"></span> ❄️ Cold Cyan (>70% RH)
                    </div>
                    <div class="wind-pal-badge dry">
                      <span class="pal-dot dry"></span> 🏜️ Dry Amber (≤70% RH)
                    </div>
                  </div>
                </div>
              }
            </div>
          }
        </div>
      }

      <!-- 📡 Real-time IMD Radar dBZ Hover Inspector Tooltip -->
      @if (hoverInfo() && !mcInspection()) {
        <div
          class="radar-hover-tooltip"
          [style.left.px]="hoverInfo()!.x"
          [style.top.px]="hoverInfo()!.y"
        >
          <div class="tooltip-top-row">
            <span
              class="tooltip-badge-dot"
              [style.background-color]="hoverInfo()!.color"
              [style.box-shadow]="'0 0 10px ' + hoverInfo()!.color"
            ></span>
            <span class="tooltip-dbz-val" [style.color]="hoverInfo()!.color">
              {{ hoverInfo()!.dbz }} dBZ
            </span>
            <span class="tooltip-rate-lbl">{{ hoverInfo()!.rate }}</span>
          </div>
          <div class="tooltip-desc-row">
            <strong style="color: #f8fafc">{{ hoverInfo()!.label }}</strong>
            <span class="tooltip-sep">•</span>
            <span class="tooltip-coords">
              {{ hoverInfo()!.lat.toFixed(3) }}°N, {{ hoverInfo()!.lng.toFixed(3) }}°E
            </span>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      position: absolute;
      inset: 0;
    }
    #map-container {
      width: 100%;
      height: 100%;
      position: relative;
      z-index: 1;
      background: #2b2e35;
    }

    .wind-viewport-overlay {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 20;
      display: none;
    }
    .wind-viewport-overlay.active {
      display: block;
    }

    ::ng-deep .custom-marker {
      width: 24px;
      height: 24px;
      position: relative;
      pointer-events: none;
    }

    /* ── Live Radar Hover dBZ Tooltip ── */
    .radar-hover-tooltip {
      position: absolute;
      transform: translate(14px, -110%);
      pointer-events: none;
      z-index: 1000;
      background: rgba(15, 23, 42, 0.94);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(56, 189, 248, 0.35);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5), 0 0 15px rgba(56, 189, 248, 0.15);
      border-radius: 10px;
      padding: 0.55rem 0.85rem;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      white-space: nowrap;
      animation: tooltipFadeIn 0.15s ease-out;
    }

    @keyframes tooltipFadeIn {
      from { opacity: 0; transform: translate(14px, -95%) scale(0.95); }
      to { opacity: 1; transform: translate(14px, -110%) scale(1); }
    }

    .tooltip-top-row {
      display: flex;
      align-items: center;
      gap: 0.45rem;
    }

    .tooltip-badge-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .tooltip-dbz-val {
      font-size: 0.95rem;
      font-weight: 800;
      font-family: monospace;
      letter-spacing: -0.02em;
    }

    .tooltip-rate-lbl {
      font-size: 0.75rem;
      color: #cbd5e1;
      background: rgba(255, 255, 255, 0.08);
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: 500;
    }

    .tooltip-desc-row {
      font-size: 0.75rem;
      color: #94a3b8;
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }

    .tooltip-sep {
      color: #475569;
    }

    .tooltip-coords {
      font-family: monospace;
      font-size: 0.72rem;
      color: #64748b;
    }

    /* ── South India Regional Microclimate Click Tooltip ── */
    .mc-tooltip {
      border-color: rgba(56, 189, 248, 0.45);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6), 0 0 20px rgba(56, 189, 248, 0.2);
      min-width: 220px;
      pointer-events: auto;
    }
    .mc-tooltip-close-btn {
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 0.8rem;
      cursor: pointer;
      padding: 0 4px;
      margin-left: 6px;
      border-radius: 3px;
      line-height: 1;
      transition: all 0.15s ease;
    }
    .mc-tooltip-close-btn:hover {
      color: #ef4444;
      background: rgba(239, 68, 68, 0.2);
    }
    .mc-zone-badge {
      font-size: 0.8rem;
      font-weight: 700;
      color: #38bdf8;
    }
    .mc-elev-badge {
      font-size: 0.72rem;
      font-weight: 700;
      color: #c084fc;
      background: rgba(192, 132, 252, 0.15);
      border: 1px solid rgba(192, 132, 252, 0.35);
      padding: 1px 6px;
      border-radius: 4px;
      margin-left: auto;
    }
    .mc-data-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
      margin: 4px 0;
      background: rgba(255, 255, 255, 0.04);
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }
    .mc-data-grid.single-item {
      display: flex;
      flex-direction: column;
      gap: 3px;
      margin: 4px 0;
      background: rgba(255, 255, 255, 0.05);
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .mc-cell {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .mc-label {
      font-size: 0.65rem;
      font-weight: 700;
      color: #64748b;
      letter-spacing: 0.05em;
    }
    .mc-val {
      font-size: 0.82rem;
      font-weight: 700;
      font-family: monospace;
    }
    .mc-val.temp { color: #f4a261; }
    .mc-val.hum { color: #9fb9cb; }
    .mc-val.wind { color: #4ade80; }
    .mc-cell.highlight-temp .mc-val {
      font-size: 1.18rem;
      color: #f4a261;
      font-weight: 800;
    }
    .mc-cell.highlight-hum .mc-val {
      font-size: 1.18rem;
      color: #9fb9cb;
      font-weight: 800;
    }
    .mc-cell.highlight-wind .mc-val {
      font-size: 1.02rem;
      color: #38bdf8;
      font-weight: 800;
    }
    .mc-wind-mode-tag {
      font-size: 0.65rem;
      font-weight: 700;
      margin-top: 3px;
      padding: 2px 6px;
      border-radius: 4px;
      display: inline-block;
      width: fit-content;
    }
    .mc-wind-mode-tag.cold {
      color: #38bdf8;
      background: rgba(56, 189, 248, 0.15);
      border: 1px solid rgba(56, 189, 248, 0.3);
    }
    .mc-wind-mode-tag.dry {
      color: #f59e0b;
      background: rgba(245, 158, 11, 0.15);
      border: 1px solid rgba(245, 158, 11, 0.3);
    }
    .mc-cell.highlight-rain .mc-val {
      font-size: 1.18rem;
      color: #38bdf8;
      font-weight: 800;
    }
    .mc-cell.highlight-cape .mc-val {
      font-size: 1.18rem;
      color: #eab308;
      font-weight: 800;
    }
    .mc-val.rain { color: #38bdf8; }
    .mc-val.cape { color: #eab308; }
    .mc-risk-badge {
      font-size: 0.65rem;
      font-weight: 700;
      margin-top: 3px;
      padding: 2px 6px;
      border-radius: 4px;
      display: inline-block;
      width: fit-content;
      color: #38bdf8;
      background: rgba(56, 189, 248, 0.15);
      border: 1px solid rgba(56, 189, 248, 0.3);
    }
    .mc-risk-badge.heavy {
      color: #ef4444;
      background: rgba(239, 68, 68, 0.15);
      border-color: rgba(239, 68, 68, 0.4);
    }
    .mc-risk-badge.cape {
      color: #facc15;
      background: rgba(234, 179, 8, 0.15);
      border-color: rgba(234, 179, 8, 0.35);
    }
    .mc-risk-badge.cape.severe {
      color: #ec4899;
      background: rgba(236, 72, 153, 0.15);
      border-color: rgba(236, 72, 153, 0.4);
    }

    /* ── Windy-Style Peninsular City Badges ── */
    ::ng-deep .windy-city-badge {
      display: flex;
      flex-direction: column;
      align-items: center;
      cursor: pointer;
      user-select: none;
      transform: translate(-50%, -50%);
      transition: transform 0.15s ease;
      z-index: 28;
      pointer-events: auto;
    }
    ::ng-deep .windy-city-badge:hover {
      transform: translate(-50%, -50%) scale(1.18);
      z-index: 55;
    }
    ::ng-deep .windy-city-badge .city-name {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 11px;
      font-weight: 700;
      color: #ffffff;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.95), 0 0 6px rgba(0, 0, 0, 0.85);
      white-space: nowrap;
      letter-spacing: 0.02em;
    }
    ::ng-deep .windy-city-badge .city-metric {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      font-size: 12px;
      font-weight: 800;
      color: #fde047;
      text-shadow: 0 1px 4px rgba(0, 0, 0, 0.95), 0 0 6px rgba(0, 0, 0, 0.85);
      white-space: nowrap;
      line-height: 1.1;
    }
    ::ng-deep .windy-city-badge .city-metric.temp { color: #fed7aa; }
    ::ng-deep .windy-city-badge .city-metric.hum { color: #bae6fd; }
    ::ng-deep .windy-city-badge .city-metric.wind { color: #bbf7d0; }
    ::ng-deep .windy-city-badge .city-metric.rain { color: #67e8f9; }
    ::ng-deep .windy-city-badge .city-metric.cape { color: #f472b6; }

    /* ── Floating 500m Elevation & Nowcast Widget on Map ── */
    .map-mc-elevation-widget {
      position: absolute;
      bottom: 24px;
      left: 18px;
      z-index: 40;
      width: 310px;
      background: rgba(15, 23, 42, 0.94);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border: 1px solid rgba(56, 189, 248, 0.35);
      border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.65), 0 0 20px rgba(56, 189, 248, 0.15);
      overflow: hidden;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      user-select: none;
    }
    .map-mc-elevation-widget.collapsed {
      width: 250px;
    }
    .mc-widget-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: rgba(255, 255, 255, 0.04);
      cursor: pointer;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .mc-widget-title-group {
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .mc-widget-live-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #22c55e;
      box-shadow: 0 0 8px #22c55e;
      animation: pulseGreen 2s infinite;
    }
    @keyframes pulseGreen {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.3); opacity: 0.7; }
    }
    .mc-widget-title {
      font-size: 0.76rem;
      font-weight: 800;
      color: #38bdf8;
      letter-spacing: 0.03em;
    }
    .mc-widget-collapse-btn {
      background: none;
      border: none;
      color: #94a3b8;
      font-size: 0.72rem;
      cursor: pointer;
    }
    .mc-widget-body {
      padding: 9px 11px;
      display: flex;
      flex-direction: column;
      gap: 7px;
    }
    .mc-widget-status-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .alt-badge {
      font-size: 0.74rem;
      font-weight: 700;
      color: #f8fafc;
      background: rgba(56, 189, 248, 0.2);
      border: 1px solid rgba(56, 189, 248, 0.4);
      padding: 2px 7px;
      border-radius: 5px;
    }
    .mc-sync-dot {
      font-size: 0.68rem;
      font-weight: 600;
      color: #4ade80;
    }
    .mc-sync-dot.stale {
      color: #fbbf24;
    }
    .mc-widget-metrics-row {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 5px;
    }
    .m-pill {
      display: flex;
      align-items: center;
      gap: 3px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 6px;
      padding: 3px 5px;
      font-size: 0.7rem;
      font-family: monospace;
      font-weight: 700;
    }
    .m-pill.temp { color: #f4a261; border-color: rgba(244, 162, 97, 0.35); }
    .m-pill.hum { color: #9fb9cb; border-color: rgba(159, 185, 203, 0.35); }
    .m-pill.wind { color: #4ade80; border-color: rgba(74, 222, 128, 0.35); }
    .mc-widget-slider-box {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin-top: 1px;
    }
    .slider-labels {
      display: flex;
      justify-content: space-between;
      font-size: 0.64rem;
      font-weight: 600;
      color: #64748b;
    }
    .slider-active-alt {
      color: #38bdf8;
      font-weight: 800;
    }
    .mc-altitude-slider {
      width: 100%;
      height: 5px;
      accent-color: #38bdf8;
      cursor: pointer;
    }
    .mc-widget-presets {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 3px;
    }
    .alt-preset-btn {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: #94a3b8;
      font-size: 0.64rem;
      font-weight: 600;
      border-radius: 4px;
      padding: 2.5px 2px;
      cursor: pointer;
      transition: all 0.15s ease;
      text-align: center;
    }
    .alt-preset-btn:hover {
      background: rgba(56, 189, 248, 0.15);
      color: #f0f9ff;
      border-color: rgba(56, 189, 248, 0.35);
    }
    .alt-preset-btn.active {
      background: #0284c7;
      color: #ffffff;
      border-color: #38bdf8;
      font-weight: 800;
      box-shadow: 0 0 8px rgba(56, 189, 248, 0.4);
    }
    .mc-widget-mode-row {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-top: 2px;
      padding-top: 4px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
    }
    .mode-lbl {
      font-size: 0.63rem;
      font-weight: 700;
      color: #64748b;
    }
    .mode-chip {
      flex: 1;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: #94a3b8;
      font-size: 0.65rem;
      font-weight: 600;
      padding: 2.5px 0;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s ease;
      text-align: center;
    }
    .mode-chip:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #f8fafc;
    }
    .mode-chip.active {
      background: rgba(56, 189, 248, 0.25);
      border-color: #38bdf8;
      color: #38bdf8;
      font-weight: 700;
    }
    .mc-widget-header-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .mc-widget-off-btn {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.35);
      color: #f87171;
      font-size: 0.65rem;
      font-weight: 700;
      border-radius: 4px;
      padding: 1.5px 5px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .mc-widget-off-btn:hover {
      background: rgba(239, 68, 68, 0.35);
      color: #ffffff;
      border-color: #ef4444;
    }
    .mc-wind-menu-box {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 6px;
      padding: 5px 7px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .wind-menu-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .wind-menu-lbl {
      font-size: 0.63rem;
      font-weight: 700;
      color: #64748b;
      letter-spacing: 0.03em;
    }
    .wind-menu-flow-tag {
      font-size: 0.65rem;
      font-family: monospace;
      font-weight: 700;
      color: #38bdf8;
    }
    .wind-pal-row {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .wind-pal-row.dynamic-info {
      gap: 4px;
    }
    .wind-pal-badge {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 0.62rem;
      font-weight: 600;
      padding: 3px 4px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
    }
    .wind-pal-badge.cold {
      color: #38bdf8;
      border-color: rgba(56, 189, 248, 0.3);
    }
    .wind-pal-badge.dry {
      color: #f59e0b;
      border-color: rgba(245, 158, 11, 0.3);
    }
    .wind-pal-btn {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: #94a3b8;
      font-size: 0.65rem;
      font-weight: 600;
      padding: 3px 2px;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .wind-pal-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #f8fafc;
    }
    .wind-pal-btn.cold.active {
      background: rgba(56, 189, 248, 0.2);
      border-color: #38bdf8;
      color: #38bdf8;
      font-weight: 700;
      box-shadow: 0 0 8px rgba(56, 189, 248, 0.3);
    }
    .wind-pal-btn.dry.active {
      background: rgba(245, 158, 11, 0.2);
      border-color: #f59e0b;
      color: #f59e0b;
      font-weight: 700;
      box-shadow: 0 0 8px rgba(245, 158, 11, 0.3);
    }
    .pal-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }
    .pal-dot.cold {
      background: #38bdf8;
      box-shadow: 0 0 4px #38bdf8;
    }
    .pal-dot.dry {
      background: #f59e0b;
      box-shadow: 0 0 4px #f59e0b;
    }

    /* ── Radar Station Pins & Range Rings ── */
    ::ng-deep .radar-station-marker {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      user-select: none;
      transform: translate(-50%, -50%);
      z-index: 35;
      transition: transform 0.18s ease-out, filter 0.18s ease-out;
    }
    ::ng-deep .radar-station-marker:hover {
      z-index: 60;
      transform: translate(-50%, -50%) scale(1.18);
    }
    ::ng-deep .radar-station-marker .station-dot-container {
      position: relative;
      width: 14px;
      height: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    ::ng-deep .radar-station-marker .station-center-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #0ea5e9;
      box-shadow: 0 0 6px #0ea5e9;
      border: 1px solid #ffffff;
      transition: all 0.2s ease;
    }
    ::ng-deep .radar-station-marker.active-station {
      z-index: 55;
    }
    ::ng-deep .radar-station-marker.active-station .station-center-dot {
      width: 9px;
      height: 9px;
      background: #22c55e;
      box-shadow: 0 0 10px #22c55e, 0 0 20px rgba(34, 197, 94, 0.5);
      border: 1.5px solid #ffffff;
    }
    ::ng-deep .radar-station-marker.active-station .station-pulse-ring {
      position: absolute;
      top: -4px;
      left: -4px;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: 1.5px solid rgba(34, 197, 94, 0.85);
      animation: radarStationPulse 2s cubic-bezier(0.215, 0.61, 0.355, 1) infinite;
      pointer-events: none;
    }
    @keyframes radarStationPulse {
      0% { transform: scale(0.5); opacity: 1; }
      100% { transform: scale(2.4); opacity: 0; }
    }
    ::ng-deep .station-badge-label {
      background: rgba(15, 23, 42, 0.92);
      border: 1px solid rgba(56, 189, 248, 0.35);
      color: #93c5fd;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 10px;
      font-weight: 700;
      padding: 1.5px 6px;
      border-radius: 4px;
      box-shadow: 0 3px 10px rgba(0, 0, 0, 0.6);
      white-space: nowrap;
      backdrop-filter: blur(6px);
      display: none;
    }
    ::ng-deep .radar-station-marker.active-station .station-badge-label {
      border-color: rgba(34, 197, 94, 0.6);
      color: #4ade80;
      display: block;
    }
    ::ng-deep .radar-station-marker:hover .station-badge-label,
    ::ng-deep .radar-station-marker.show-label .station-badge-label {
      display: block;
    }

    ::ng-deep .dwr-ring-label-marker {
      pointer-events: none;
      user-select: none;
    }
    ::ng-deep .dwr-ring-badge {
      background: rgba(15, 23, 42, 0.9);
      color: #38bdf8;
      font-family: monospace;
      font-size: 10px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 4px;
      border: 1px solid rgba(56, 189, 248, 0.4);
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.6);
      white-space: nowrap;
    }
    ::ng-deep .dwr-ring-badge.outer {
      color: #ef4444;
      border-color: rgba(239, 68, 68, 0.5);
    }

  `]
})
export class MapComponent implements OnInit, OnDestroy {
  private layerService = inject(MapLayerService);
  private radarService = inject(RadarService);
  protected mcService = inject(MicroclimateService);
  private forecastMap = inject(ForecastMapController);

  readonly hoverInfo = this.radarService.hoverInfo;
  readonly mcInspection = this.mcService.inspectionInfo;

  // Floating Elevation & Nowcast widget state
  readonly isWidgetCollapsed = signal<boolean>(false);
  readonly is500mActive = computed(() =>
    this.layerService.layers().some(l => (
      l.id === 'temp-500m' ||
      l.id === 'humidity-500m' ||
      l.id === 'wind-500m' ||
      l.id === 'rain-24h' ||
      l.id === 'cape'
    ) && l.active)
  );

  readonly isTempActive = computed(() =>
    this.layerService.layers().find(l => l.id === 'temp-500m')?.active ?? false
  );
  readonly isHumidityActive = computed(() =>
    this.layerService.layers().find(l => l.id === 'humidity-500m')?.active ?? false
  );
  readonly isWindActive = computed(() =>
    this.layerService.layers().find(l => l.id === 'wind-500m')?.active ?? false
  );
  readonly isRain24hActive = computed(() =>
    this.layerService.layers().find(l => l.id === 'rain-24h')?.active ?? false
  );
  readonly isCapeActive = computed(() =>
    this.layerService.layers().find(l => l.id === 'cape')?.active ?? false
  );

  toggleWidgetCollapsed(): void {
    this.isWidgetCollapsed.update(v => !v);
  }

  turnOffMicroclimate(event?: Event): void {
    if (event) event.stopPropagation();
    this.mcService.turnOffMicroclimate();
  }

  onElevationSliderChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.mcService.setElevation(parseFloat(input.value));
  }

  @ViewChild('windViewportCanvas') windCanvasRef?: ElementRef<HTMLCanvasElement>;
  private windViewportCtx: CanvasRenderingContext2D | null = null;
  private windAnimFrameId: number | null = null;
  private viewportParticles: { x: number; y: number; age: number; maxLife: number }[] = [];
  private readonly NUM_STREAMLINES = 480;
  private cityMarkers: Marker[] = [];

  private map: MapLibreMap | null = null;
  private ringLabelMarkers: Marker[] = [];
  readonly isMapLoaded = signal<boolean>(false);
  private isRadarActive = true;

  // Reactive Effect: Layers Visibility and Opacity
  private layerEffect = effect(() => {
    const layers = this.layerService.layers();
    if (!this.map || !this.isMapLoaded()) return;
    this.syncOverlays(layers);
  });

  // Reactive Effect: 500m Microclimate Heatmaps Update
  private microclimateDataEffect = effect(() => {
    this.mcService.tempDataUrl();
    this.mcService.humidityDataUrl();
    this.mcService.rainDataUrl();
    this.mcService.capeDataUrl();
    if (!this.map || !this.isMapLoaded()) return;
    this.syncOverlays(this.layerService.layers());
  });

  // Reactive Effect: Windy-style City Weather Badges
  private cityBadgesEffect = effect(() => {
    const isAct = this.is500mActive();
    const cities = this.mcService.citiesWeather();
    const tempOn = this.isTempActive();
    const humOn = this.isHumidityActive();
    const windOn = this.isWindActive();
    const rainOn = this.isRain24hActive();
    const capeOn = this.isCapeActive();
    if (!this.map || !this.isMapLoaded()) return;
    this.syncCityMarkers(isAct, cities, { tempOn, humOn, windOn, rainOn, capeOn });
  });

  // Reactive Effect: Screen-Space Wind Streamline Overlay Animation
  private windOverlayEffect = effect(() => {
    const windOn = this.isWindActive();
    if (!this.map || !this.isMapLoaded()) return;
    this.syncWindViewportOverlay(windOn);
  });

  // Reactive Effect: leaving the microclimate view returns to the radar mosaic, so the user
  // isn't left zoomed in on the microclimate view where there may be no echoes to see
  private wasMicroclimateActive = false;
  private microclimateExitEffect = effect(() => {
    const active = this.is500mActive();
    const radarOn = this.layerService.layers().some(l => l.id === 'radar' && l.active);
    const exited = this.wasMicroclimateActive && !active;
    this.wasMicroclimateActive = active;
    if (exited && radarOn) {
      untracked(() => this.flyToMosaicCenter());
    }
  });

  // Reactive Effect: Recenter 500m Region Request
  private center500mEffect = effect(() => {
    const req = this.mcService.centerRegionRequest();
    if (req > 0 && this.map) {
      this.flyTo500mRegion();
    }
  });

  // Reactive Effect: Unified Merged Radar Mosaic across all active stations
  private radarMosaicEffect = effect(() => {
    const mosaic = this.radarService.compositeMosaic();
    if (!this.map || !this.isMapLoaded()) return;
    this.updateRadarMosaicOverlay(mosaic);
  });

  // Reactive Effect: Basemap Switcher (Terrain vs Dark)
  private basemapEffect = effect(() => {
    const basemap = this.layerService.activeBasemap();
    if (!this.map || !this.isMapLoaded()) return;
    this.syncBasemap(basemap);
  });

  // Reactive Effect: Radar Opacity Slider
  private radarOpacityEffect = effect(() => {
    const opacity = this.radarService.radarOpacity();
    if (!this.map || !this.isMapLoaded()) return;
    if (this.map.getLayer('radar-layer-mosaic')) {
      this.map.setPaintProperty('radar-layer-mosaic', 'raster-opacity', opacity);
    }
  });

  // Reactive Effect: Recenter Mosaic Request
  private centerStationEffect = effect(() => {
    const req = this.radarService.centerStationRequest();
    if (req > 0 && this.map) {
      this.flyToMosaicCenter();
    }
  });

  // Reactive Effect: Active Station Focus & Range Rings sync (camera stays locked over South India)
  private activeStationEffect = effect(() => {
    this.radarService.activeStationId();
    if (!this.map || !this.isMapLoaded()) return;
    const product = this.radarService.activeProduct();
    const ringsSource = this.map.getSource('radar-rings-source') as maplibregl.GeoJSONSource;
    if (ringsSource) {
      ringsSource.setData(this.buildRingsGeoJson(product));
    }
    this.createRingLabelMarkers(product);
  });

  ngOnInit(): void {
    this.initMap();
  }

  ngOnDestroy(): void {
    this.ringLabelMarkers.forEach(m => m.remove());
    this.ringLabelMarkers = [];
    this.cityMarkers.forEach(m => m.remove());
    this.cityMarkers = [];

    if (this.map?.getLayer('radar-layer-mosaic')) {
      this.map.removeLayer('radar-layer-mosaic');
    }
    if (this.map?.getSource('radar-source-mosaic')) {
      this.map.removeSource('radar-source-mosaic');
    }

    this.stopViewportWindAnimation();

    const cleanupLayers = [
      'wind-500m-layer', 'temp-500m-layer', 'humidity-500m-layer',
      'rain-24h-layer', 'cape-layer'
    ];
    for (const lId of cleanupLayers) {
      if (this.map?.getLayer(lId)) this.map.removeLayer(lId);
    }
    const cleanupSources = [
      'wind-500m-source', 'temp-500m-source', 'humidity-500m-source',
      'rain-24h-source', 'cape-source'
    ];
    for (const sId of cleanupSources) {
      if (this.map?.getSource(sId)) this.map.removeSource(sId);
    }

    this.forecastMap.detach();
    this.map?.remove();
    this.map = null;
  }

  private initMap(): void {
    if (typeof maplibregl.setWorkerUrl === 'function') {
      maplibregl.setWorkerUrl('/maplibre-gl-worker.mjs');
    }

    const map = new maplibregl.Map({
      container: 'map-container',
      pixelRatio: typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1,
      style: {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
          'esri-dark-base': {
            type: 'raster',
            tiles: [
              'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
            ],
            tileSize: 256,
            maxzoom: 16,
            attribution: '&copy; Esri'
          },
          'esri-dark-hillshade': {
            type: 'raster',
            tiles: [
              'https://services.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade_Dark/MapServer/tile/{z}/{y}/{x}'
            ],
            tileSize: 256,
            maxzoom: 16
          },
          'esri-dark-ref': {
            type: 'raster',
            tiles: [
              'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}'
            ],
            tileSize: 256,
            maxzoom: 16
          }
        },
        layers: [
          {
            id: 'map-background-layer',
            type: 'background',
            paint: {
              'background-color': '#2b2e35'
            }
          },
          {
            id: 'dark-base-layer',
            type: 'raster',
            source: 'esri-dark-base',
            minzoom: 0,
            maxzoom: 19,
            paint: {
              'raster-brightness-min': 0.18,
              'raster-contrast': -0.05
            }
          },
          {
            id: 'dark-hillshade-layer',
            type: 'raster',
            source: 'esri-dark-hillshade',
            minzoom: 0,
            maxzoom: 19,
            paint: {
              'raster-opacity': 0.65,
              'raster-brightness-min': 0.14
            }
          },
          {
            id: 'dark-ref-layer',
            type: 'raster',
            source: 'esri-dark-ref',
            minzoom: 0,
            maxzoom: 19,
            paint: {
              'raster-opacity': 0.95
            }
          }
        ]
      },
      // Open on the whole forecast area; the map can be panned and zoomed out freely beyond it
      bounds: SOUTH_INDIA_VIEW,
      fitBoundsOptions: { padding: 12 },
      minZoom: 3.2,
      maxZoom: 15,
      maxBounds: MAP_MAX_BOUNDS,
      attributionControl: false
    });
    this.map = map;
    if (isDevMode()) (window as unknown as Record<string, unknown>)['__atmosMap'] = map; // debugging handle, dev builds only

    map.on('load', () => {
      this.isMapLoaded.set(true);

      // 1. Set initial basemap visibility (Dark Terrain)
      this.syncBasemap('dark');

      // 1b. Tamil Nadu boundary lines (must exist before any overlay layer is mounted)
      this.initBoundaries();

      // 2. Add Radar Range Rings GeoJSON Source & Layer
      this.initRangeRings();

      // 4. Initial Radar Mosaic Mount
      this.updateRadarMosaicOverlay(this.radarService.compositeMosaic());

      // 5. Initialize screen-space viewport wind canvas
      this.initViewportWindCanvas();

      // 6. Initial overlay sync & trigger concurrent fetch of all radar sweeps
      this.syncOverlays(this.layerService.layers());

      // 7. ECMWF forecast layer (GPU), mounted below the boundary lines
      this.forecastMap.attach(map, this.overlayAnchorId());
    });

    map.on('click', (e) => {
      const layers = this.layerService.layers();
      const has500mActive = layers.some(l => (
        l.id === 'temp-500m' ||
        l.id === 'humidity-500m' ||
        l.id === 'wind-500m' ||
        l.id === 'rain-24h' ||
        l.id === 'cape'
      ) && l.active);
      if (has500mActive) {
        const handled = this.mcService.inspect(e.lngLat.lat, e.lngLat.lng, {
          x: e.point.x,
          y: e.point.y
        });
        if (handled) {
          this.radarService.clearHover();
          return;
        }
      }

      if (this.isRadarActive) {
        this.mcService.clearInspection();
        this.radarService.inspectLocation(e.lngLat.lat, e.lngLat.lng, {
          x: e.point.x,
          y: e.point.y
        });
      }
    });

    // Real-time IMD Radar dBZ Hover Inspector (Microclimate tooltip is click-only, not on hover)
    map.on('mousemove', (e) => {
      if (!this.isRadarActive) {
        this.radarService.clearHover();
        return;
      }
      this.radarService.inspectLocation(e.lngLat.lat, e.lngLat.lng, {
        x: e.point.x,
        y: e.point.y
      });
    });

    map.on('mouseout', () => {
      this.radarService.clearHover();
    });

    map.on('resize', () => {
      this.initViewportWindCanvas();
    });

    // Adaptive zoom detail scaling
    map.on('zoom', () => {
      this.syncZoomVisuals();
    });
  }

  // --- 1. IMD Doppler Weather Radar Unified Merged Composite Mosaic ---

  private updateRadarMosaicOverlay(mosaic: ProcessedRadarResult | null): void {
    if (!this.map || !this.isMapLoaded()) return;

    const sourceId = 'radar-source-mosaic';
    const layerId = 'radar-layer-mosaic';

    if (!mosaic || !mosaic.dataUrl || mosaic.isDisplayed === false) {
      if (this.map.getLayer(layerId)) {
        this.map.removeLayer(layerId);
      }
      if (this.map.getSource(sourceId)) {
        this.map.removeSource(sourceId);
      }
      return;
    }

    const existingSource = this.map.getSource(sourceId) as maplibregl.ImageSource;
    if (existingSource && typeof existingSource.updateImage === 'function') {
      existingSource.updateImage({
        url: mosaic.dataUrl,
        coordinates: mosaic.coordinates
      });
    } else if (!existingSource) {
      this.map.addSource(sourceId, {
        type: 'image',
        url: mosaic.dataUrl,
        coordinates: mosaic.coordinates
      });

      const targetBefore = this.overlayAnchorId();

      this.map.addLayer(
        {
          id: layerId,
          type: 'raster',
          source: sourceId,
          paint: {
            'raster-opacity': this.radarService.radarOpacity(),
            'raster-fade-duration': 0,
            'raster-resampling': 'linear'
          },
          layout: {
            visibility: this.isRadarActive ? 'visible' : 'none'
          }
        },
        targetBefore
      );
    }

    if (this.map.getLayer(layerId)) {
      this.map.setLayoutProperty(
        layerId,
        'visibility',
        this.isRadarActive ? 'visible' : 'none'
      );
      this.map.setPaintProperty(
        layerId,
        'raster-opacity',
        this.radarService.radarOpacity()
      );
    }
  }

  // --- Tamil Nadu boundary lines (state + 38 districts) ---

  /** Layer id that raster overlays are inserted before, so boundaries and labels stay on top. */
  private overlayAnchorId(): string | undefined {
    if (!this.map) return undefined;
    if (this.map.getLayer(BOUNDARY_FIRST_LAYER_ID)) return BOUNDARY_FIRST_LAYER_ID;
    return this.map.getLayer('dark-ref-layer') ? 'dark-ref-layer' : undefined;
  }

  private initBoundaries(): void {
    if (!this.map || this.map.getSource(BOUNDARY_SOURCE_ID)) return;

    this.map.addSource(BOUNDARY_SOURCE_ID, {
      type: 'geojson',
      data: '/data/south-india-districts.geojson'
    });

    const before = this.map.getLayer('dark-ref-layer') ? 'dark-ref-layer' : undefined;
    const widths = (z5: number, z10: number): maplibregl.ExpressionSpecification =>
      ['interpolate', ['linear'], ['zoom'], 5, z5, 10, z10];
    const isDistrict: maplibregl.ExpressionSpecification = ['==', ['get', 'kind'], 'district'];
    const isState: maplibregl.ExpressionSpecification = ['==', ['get', 'kind'], 'state'];
    const line = (
      id: string,
      filter: maplibregl.ExpressionSpecification,
      color: string,
      width: maplibregl.ExpressionSpecification
    ) => this.map!.addLayer({
      id,
      type: 'line',
      source: BOUNDARY_SOURCE_ID,
      filter,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': color, 'line-width': width }
    }, before);

    // A dark casing under a light core keeps every line readable on both the pale humidity palette
    // and the dark teal / navy ends of the other palettes.
    line(BOUNDARY_FIRST_LAYER_ID, isDistrict, 'rgba(8, 12, 22, 0.5)', widths(1.8, 3.2));
    line('tn-district-lines', isDistrict, 'rgba(255, 255, 255, 0.66)', widths(0.6, 1.2));
    line('tn-state-casing', isState, 'rgba(8, 12, 22, 0.72)', widths(3.4, 6.0));
    line('tn-state-line', isState, 'rgba(255, 255, 255, 0.96)', widths(1.5, 2.6));

    // District names outside Tamil Nadu (Tamil Nadu's districts already have HQ markers). Bigger districts
    // appear first as you zoom in, so low zoom stays readable.
    const labelMinZoom: Record<number, number> = { 1: 6.2, 2: 7.2, 3: 8.2 };
    for (const rank of [1, 2, 3]) {
      this.map.addLayer({
        id: `district-labels-${rank}`,
        type: 'symbol',
        source: BOUNDARY_SOURCE_ID,
        minzoom: labelMinZoom[rank],
        filter: ['all',
          ['==', ['get', 'kind'], 'label'],
          ['==', ['get', 'rank'], rank],
          ['!=', ['get', 'state'], 'Tamil Nadu']
        ],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10, 10, 13],
          'text-max-width': 8
        },
        paint: {
          'text-color': 'rgba(255, 255, 255, 0.9)',
          'text-halo-color': 'rgba(8, 12, 22, 0.92)',
          'text-halo-width': 1.4
        }
      }, before);
    }
  }

  // --- 2. Concentric Radar Range Rings & Station Pins ---

  private initRangeRings(): void {
    if (!this.map) return;

    const product = this.radarService.activeProduct();
    this.map.addSource('radar-rings-source', {
      type: 'geojson',
      data: this.buildRingsGeoJson(product)
    });

    this.map.addLayer(
      {
        id: 'radar-rings-lines',
        type: 'line',
        source: 'radar-rings-source',
        paint: {
          'line-color': ['case', ['get', 'isOuter'], 'rgba(239, 68, 68, 0.65)', 'rgba(56, 189, 248, 0.4)'],
          'line-width': 1.0,
          'line-dasharray': [4, 4]
        },
        layout: {
          visibility: 'none'
        }
      },
      this.overlayAnchorId()
    );

    this.createRingLabelMarkers(product);
  }

  private buildRingsGeoJson(productKey: RadarProductKey): any {
    const center = this.radarService.activeStation();
    const prod = center.products[productKey] || center.products.caz;
    const rings = prod.rings;
    const maxKm = rings[rings.length - 1];

    const features = rings.map(km => {
      const coords = this.createCircleCoordinates(center.lng, center.lat, km);
      return {
        type: 'Feature',
        properties: {
          km,
          isOuter: km === maxKm
        },
        geometry: {
          type: 'LineString',
          coordinates: coords
        }
      };
    });

    return {
      type: 'FeatureCollection',
      features
    };
  }

  private createCircleCoordinates(centerLng: number, centerLat: number, radiusKm: number, steps = 72): [number, number][] {
    const coords: [number, number][] = [];
    const latRadius = radiusKm / 111.32;
    const lonRadius = radiusKm / (111.32 * Math.cos((centerLat * Math.PI) / 180));

    for (let i = 0; i <= steps; i++) {
      const angle = (i * 2 * Math.PI) / steps;
      const lon = centerLng + Math.sin(angle) * lonRadius;
      const lat = centerLat + Math.cos(angle) * latRadius;
      coords.push([lon, lat]);
    }
    return coords;
  }

  private createRingLabelMarkers(productKey: RadarProductKey): void {
    if (!this.map) return;

    this.ringLabelMarkers.forEach(m => m.remove());
    this.ringLabelMarkers = [];

    const center = this.radarService.activeStation();
    const prod = center.products[productKey] || center.products.caz;
    const rings = prod.rings;
    const maxKm = rings[rings.length - 1];

    for (const km of rings) {
      const isOuter = km === maxKm;
      const labelLat = center.lat + (km / 111.32);

      const el = document.createElement('div');
      el.className = 'dwr-ring-label-marker';
      el.innerHTML = `<span class="dwr-ring-badge ${isOuter ? 'outer' : ''}">${km}km</span>`;

      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([center.lng, labelLat])
        .addTo(this.map);

      el.style.display = 'none';
      this.ringLabelMarkers.push(marker);
    }
  }

  private syncBasemap(type: string = 'dark'): void {
    if (!this.map || !this.isMapLoaded()) return;
    if (this.map.getLayer('dark-base-layer')) {
      this.map.setLayoutProperty('dark-base-layer', 'visibility', 'visible');
    }
    if (this.map.getLayer('dark-hillshade-layer')) {
      this.map.setLayoutProperty('dark-hillshade-layer', 'visibility', 'visible');
    }
    if (this.map.getLayer('dark-ref-layer')) {
      this.map.setLayoutProperty('dark-ref-layer', 'visibility', 'visible');
    }
  }

  private syncZoomVisuals(): void {
    if (!this.map) return;
    const z = this.map.getZoom();

    const showRingLabels = z >= 7.5 && this.isRadarActive && this.radarService.showRangeRings();
    this.ringLabelMarkers.forEach(m => {
      m.getElement().style.display = showRingLabels ? 'block' : 'none';
    });

    // Statewide view: label the 10 major cities; the other district HQs appear once zoomed in
    const showMinorCities = z >= 7.2;
    this.cityMarkers.forEach(m => {
      const el = m.getElement();
      el.style.display = el.dataset['tier'] === '2' && !showMinorCities ? 'none' : '';
    });
  }

  public flyToMosaicCenter(): void {
    if (!this.map) return;
    this.map.fitBounds(SOUTH_INDIA_VIEW, { padding: 12, essential: true });
  }

  public zoomIn(): void {
    this.map?.zoomIn();
  }

  public zoomOut(): void {
    this.map?.zoomOut();
  }

  private syncOverlays(layers: LayerConfig[]): void {
    if (!this.map || !this.isMapLoaded()) return;

    const radarLayer = layers.find(l => l.id === 'radar');
    const wasRadarActive = this.isRadarActive;
    this.isRadarActive = radarLayer?.active ?? true;

    // Toggle Unified Radar Mosaic Layer (opacity is owned by radarOpacityEffect)
    if (this.map.getLayer('radar-layer-mosaic')) {
      this.map.setLayoutProperty(
        'radar-layer-mosaic',
        'visibility',
        this.isRadarActive ? 'visible' : 'none'
      );
    }

    // Toggle Concentric Range Rings
    if (this.map.getLayer('radar-rings-lines')) {
      const showRings = this.radarService.showRangeRings();
      this.map.setLayoutProperty(
        'radar-rings-lines',
        'visibility',
        (this.isRadarActive && showRings) ? 'visible' : 'none'
      );
    }

    // Refresh live sweeps only when radar is switched back on. The service already
    // auto-refreshes every minute, so re-fetching on every layer/opacity change
    // would re-download and re-decode every station GIF on each slider tick.
    if (this.isRadarActive && !wasRadarActive) {
      untracked(() => this.radarService.fetchAllRadarSweeps());
    }

    // --- 500m Regional Temperature Layer ---
    const temp500mLayer = layers.find(l => l.id === 'temp-500m');
    const isTempActive = temp500mLayer?.active ?? false;
    this.syncRaster500mOverlay(
      'temp-500m',
      this.mcService.tempDataUrl(),
      isTempActive,
      temp500mLayer?.opacity ?? 0.85
    );

    // --- 500m Regional Humidity Layer ---
    const humidity500mLayer = layers.find(l => l.id === 'humidity-500m');
    const isHumidityActive = humidity500mLayer?.active ?? false;
    this.syncRaster500mOverlay(
      'humidity-500m',
      this.mcService.humidityDataUrl(),
      isHumidityActive,
      humidity500mLayer?.opacity ?? 0.85
    );

    // --- 24h Extreme Rain Forecast Layer (ECMWF) ---
    const rain24hLayer = layers.find(l => l.id === 'rain-24h');
    const isRainActive = rain24hLayer?.active ?? false;
    this.syncRaster500mOverlay(
      'rain-24h',
      this.mcService.rainDataUrl(),
      isRainActive,
      rain24hLayer?.opacity ?? 0.85
    );

    // --- CAPE Instability Layer (ECMWF) ---
    const capeLayer = layers.find(l => l.id === 'cape');
    const isCapeActive = capeLayer?.active ?? false;
    this.syncRaster500mOverlay(
      'cape',
      this.mcService.capeDataUrl(),
      isCapeActive,
      capeLayer?.opacity ?? 0.85
    );

    // --- Screen-Space Viewport Wind Streamlines Animation Layer ---
    const wind500mLayer = layers.find(l => l.id === 'wind-500m');
    const isWindActive = wind500mLayer?.active ?? false;
    this.syncWindViewportOverlay(isWindActive);

    this.syncZoomVisuals();
  }

  // --- 500m Regional Microclimate Raster & Streamline Mount Helpers ---

  private syncRaster500mOverlay(
    layerPrefix: string,
    dataUrl: string | null,
    isActive: boolean,
    opacity: number
  ): void {
    if (!this.map || !this.isMapLoaded()) return;

    const sourceId = `${layerPrefix}-source`;
    const layerId = `${layerPrefix}-layer`;

    if (!dataUrl || !isActive) {
      if (this.map.getLayer(layerId)) {
        this.map.setLayoutProperty(layerId, 'visibility', 'none');
      }
      return;
    }

    const existingSource = this.map.getSource(sourceId) as maplibregl.ImageSource;
    if (existingSource && typeof existingSource.updateImage === 'function') {
      existingSource.updateImage({
        url: dataUrl,
        coordinates: this.mcService.coordinates
      });
      this.map.triggerRepaint();
    } else if (!existingSource) {
      this.map.addSource(sourceId, {
        type: 'image',
        url: dataUrl,
        coordinates: this.mcService.coordinates
      });

      const beforeLayer = this.overlayAnchorId();

      this.map.addLayer(
        {
          id: layerId,
          type: 'raster',
          source: sourceId,
          paint: {
            'raster-opacity': opacity,
            'raster-fade-duration': 0,
            'raster-resampling': 'linear'
          },
          layout: {
            visibility: 'visible'
          }
        },
        beforeLayer
      );
    }

    if (this.map.getLayer(layerId)) {
      this.map.setLayoutProperty(layerId, 'visibility', 'visible');
      this.map.setPaintProperty(layerId, 'raster-opacity', opacity);
    }
  }

  private syncCityMarkers(
    isActive: boolean,
    cities: any[],
    activeModes: { tempOn: boolean; humOn: boolean; windOn: boolean; rainOn: boolean; capeOn: boolean }
  ): void {
    if (!this.map) return;

    if (!isActive) {
      this.cityMarkers.forEach(m => m.remove());
      this.cityMarkers = [];
      return;
    }

    if (this.cityMarkers.length === cities.length) {
      for (let i = 0; i < cities.length; i++) {
        const c = cities[i];
        const m = this.cityMarkers[i];
        const el = m.getElement();
        const metricEl = el.querySelector('.city-metric');
        if (metricEl) {
          const { text, cssClass } = this.getCityMetricDisplay(c, activeModes);
          metricEl.textContent = text;
          metricEl.className = `city-metric ${cssClass}`;
        }
      }
      return;
    }

    this.cityMarkers.forEach(m => m.remove());
    this.cityMarkers = [];

    for (const c of cities) {
      const el = document.createElement('div');
      el.className = 'windy-city-badge';
      el.dataset['tier'] = String(c.tier ?? 2);
      const { text, cssClass } = this.getCityMetricDisplay(c, activeModes);
      el.innerHTML = `
        <div class="city-name">${c.name}</div>
        <div class="city-metric ${cssClass}">${text}</div>
      `;

      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (this.map) {
          const pt = this.map.project([c.lon, c.lat]);
          this.mcService.inspect(c.lat, c.lon, { x: pt.x, y: pt.y });
        }
      });

      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([c.lon, c.lat])
        .addTo(this.map);

      this.cityMarkers.push(marker);
    }
    this.syncZoomVisuals();
  }

  private getCityMetricDisplay(
    city: any,
    modes: { tempOn: boolean; humOn: boolean; windOn: boolean; rainOn: boolean; capeOn: boolean }
  ): { text: string; cssClass: string } {
    if (modes.tempOn) {
      return { text: `${Math.round(city.temp)}°`, cssClass: 'temp' };
    } else if (modes.humOn) {
      return { text: `${city.hum}%`, cssClass: 'hum' };
    } else if (modes.windOn) {
      return { text: `${city.wind} km/h`, cssClass: 'wind' };
    } else if (modes.rainOn) {
      return { text: `${city.rain} mm`, cssClass: 'rain' };
    } else if (modes.capeOn) {
      return { text: `${city.cape} J/kg`, cssClass: 'cape' };
    }
    return { text: `${Math.round(city.temp)}°`, cssClass: 'temp' };
  }

  // --- Real-time Screen-Space Viewport Wind Streamlines Animation Engine ---

  private initViewportWindCanvas(): void {
    if (!this.windCanvasRef?.nativeElement || !this.map) return;
    const canvas = this.windCanvasRef.nativeElement;
    const container = this.map.getContainer();
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    const w = container.clientWidth;
    const h = container.clientHeight;

    if (w <= 0 || h <= 0) return;

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      this.windViewportCtx = ctx;
    }

    if (this.viewportParticles.length === 0) {
      this.initViewportParticles(w, h);
    }
  }

  private initViewportParticles(w: number, h: number): void {
    this.viewportParticles = [];
    for (let i = 0; i < this.NUM_STREAMLINES; i++) {
      this.viewportParticles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        age: Math.floor(Math.random() * 50),
        maxLife: 40 + Math.floor(Math.random() * 50)
      });
    }
  }

  private syncWindViewportOverlay(isActive: boolean): void {
    if (!isActive) {
      this.stopViewportWindAnimation();
      return;
    }
    this.startViewportWindAnimation();
  }

  private startViewportWindAnimation(): void {
    if (this.windAnimFrameId !== null) return;
    this.initViewportWindCanvas();
    if (!this.windViewportCtx) return;

    let lastTime = performance.now();

    const loop = (currentTime: number) => {
      const dt = Math.min((currentTime - lastTime) / 1000, 0.05);
      lastTime = currentTime;

      this.stepViewportWind(dt);

      this.windAnimFrameId = requestAnimationFrame(loop);
    };

    this.windAnimFrameId = requestAnimationFrame(loop);
  }

  private stopViewportWindAnimation(): void {
    if (this.windAnimFrameId !== null) {
      cancelAnimationFrame(this.windAnimFrameId);
      this.windAnimFrameId = null;
    }
    if (this.windViewportCtx && this.windCanvasRef?.nativeElement) {
      const canvas = this.windCanvasRef.nativeElement;
      const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
      this.windViewportCtx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    }
  }

  private stepViewportWind(dt: number): void {
    const ctx = this.windViewportCtx;
    if (!ctx || !this.map || !this.windCanvasRef?.nativeElement) return;

    const canvas = this.windCanvasRef.nativeElement;
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    if (w <= 0 || h <= 0) return;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';

    const speedMult = this.layerService.windSpeedMultiplier();
    const bounds = this.mcService.bounds;
    const alt = this.mcService.selectedElevationMeters();
    const slice = this.mcService.currentSoundingState();
    const coldSegments: number[] = [];
    const drySegments: number[] = [];

    for (let i = 0; i < this.viewportParticles.length; i++) {
      const p = this.viewportParticles[i];
      p.age++;

      if (p.age >= p.maxLife || p.x < 0 || p.x >= w || p.y < 0 || p.y >= h) {
        p.x = Math.random() * w;
        p.y = Math.random() * h;
        p.age = 0;
        p.maxLife = 40 + Math.floor(Math.random() * 50);
        continue;
      }

      const lngLat = this.map.unproject([p.x, p.y]);
      const lat = lngLat.lat;
      const lon = lngLat.lng;

      if (lat < bounds.minLat || lat > bounds.maxLat || lon < bounds.minLon || lon > bounds.maxLon) {
        p.x = Math.random() * w;
        p.y = Math.random() * h;
        p.age = 0;
        p.maxLife = 40 + Math.floor(Math.random() * 50);
        continue;
      }

      const sample = this.mcService.sampleSpatialWeather(lat, lon);
      let speedKmh = sample.windSpeed;
      let windDir = sample.windDir;

      if (alt > 0) {
        // Blend from surface wind → sounding wind linearly across 0–5500m
        const frac = Math.min(1.0, alt / 5500);
        speedKmh = speedKmh * (1 - frac) + slice.windSpeedKmh * frac;
        // Direction blends in gradually above 500m (below that, terrain dominates)
        if (alt > 500) {
          const dirFrac = Math.min(1.0, (alt - 500) / 5000);
          windDir = blendDirectionDeg(windDir, slice.windDirectionDeg, dirFrac);
        }
      }

      const degRad = (windDir * Math.PI) / 180;
      const u = -Math.sin(degRad);
      const v = -Math.cos(degRad);

      const pixelSpeed = (speedKmh / 3.6) * speedMult * 6.5;
      const nextX = p.x + u * pixelSpeed * dt;
      const nextY = p.y - v * pixelSpeed * dt;

      const altDeltaH = alt > 0 ? slice.humidityPercent - (this.mcService.soundingLevels()[0]?.humidityPercent ?? 58) : 0;
      const rh = Math.min(100, Math.max(10, sample.hum + altDeltaH));

      if (rh > 70) {
        coldSegments.push(p.x, p.y, nextX, nextY);
      } else {
        drySegments.push(p.x, p.y, nextX, nextY);
      }

      p.x = nextX;
      p.y = nextY;
    }

    if (coldSegments.length > 0) {
      ctx.strokeStyle = this.mcService.windPaletteCold.stroke;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < coldSegments.length; i += 4) {
        ctx.moveTo(coldSegments[i], coldSegments[i + 1]);
        ctx.lineTo(coldSegments[i + 2], coldSegments[i + 3]);
      }
      ctx.stroke();
    }

    if (drySegments.length > 0) {
      ctx.strokeStyle = this.mcService.windPaletteDry.stroke;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < drySegments.length; i += 4) {
        ctx.moveTo(drySegments[i], drySegments[i + 1]);
        ctx.lineTo(drySegments[i + 2], drySegments[i + 3]);
      }
      ctx.stroke();
    }
  }

  public flyTo500mRegion(): void {
    if (!this.map) return;
    const b = this.mcService.bounds;
    this.map.fitBounds([[b.minLon, b.minLat], [b.maxLon, b.maxLat]], { padding: 24, essential: true });
  }
}
