import { Component, inject, computed } from '@angular/core';
import { MapLayerService } from '../../core/services/map-layer.service';
import { RadarService } from '../../core/services/radar.service';
import { RadarProductKey } from '../../core/domain/models/radar.model';
import { MicroclimateService } from '../../core/services/microclimate.service';
import { degToCompass } from '../../core/domain/models/microclimate.model';

@Component({
  selector: 'app-layers',
  standalone: true,
  template: `
    <div class="layers-panel glass-panel animate-slide-in-right">
      <div class="panel-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="12 2 22 8.5 12 15 2 8.5"/>
          <polyline points="2 15.5 12 22 22 15.5"/>
        </svg>
        <span>Visualization Layers</span>
        @if (activeCount() > 0) {
          <span class="badge">{{ activeCount() }}</span>
        }
      </div>

      <div class="layer-list">
        @for (layer of layers(); track layer.id) {
          <button
            class="layer-item"
            [class.active]="layer.active"
            (click)="toggle(layer.id)"
            [title]="layer.name"
          >
            <span class="layer-icon">{{ layer.icon }}</span>
            <span class="layer-name">{{ layer.name }}</span>
            <span class="layer-status" [class.on]="layer.active">
              {{ layer.active ? 'ON' : 'OFF' }}
            </span>
          </button>
        }
      </div>

      <!-- 📡 IMD Doppler Weather Radar Controls -->
      @if (isRadarActive()) {
        <div class="radar-box animate-fade-in">
          <div class="radar-header">
            <span class="live-pulse"></span>
            <span class="radar-title">Regional Radar Network</span>
            <button
              class="icon-action-btn"
              (click)="refreshRadar()"
              [disabled]="isRadarRefreshing()"
              title="Force Refresh Live Sweeps"
            >{{ isRadarRefreshing() ? '⏳' : '🔄' }}</button>
          </div>

          <!-- Sweep Timing Banner -->
          <div class="sweep-meta-banner">
            <div class="meta-row">
              <span class="meta-label">{{ activeStation().name.replace(' DWR', '').replace(' X-DWR', '') }} Scan:</span>
              <span class="meta-val highlight">{{ obsTiming() ? obsTiming()?.ist : 'Syncing sweeps...' }}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Live Clock:</span>
              <span class="meta-val clock">{{ liveClock() }}</span>
            </div>
            <div class="meta-freshness-row">
              <span class="meta-label">Observation Age:</span>
              @if (sweepAge() !== null) {
                <span
                  class="freshness-badge"
                  [class.fresh]="sweepFreshness() === 'fresh'"
                  [class.recent]="sweepFreshness() === 'recent'"
                  [class.stale]="sweepFreshness() === 'stale'"
                  [class.offline]="sweepFreshness() === 'offline'"
                >
                  {{ sweepAge() }}m ago • {{ sweepFreshness() === 'fresh' ? '🟢 FRESH (<=60m)' : sweepFreshness() === 'recent' ? '🟡 RECENT (<=120m)' : sweepFreshness() === 'stale' ? '🟠 EXTENDED (<=180m)' : '🔴 OFFLINE / HIDDEN (>180m)' }}
                </span>
              } @else {
                <span class="meta-sub">Evaluating...</span>
              }
            </div>
            @if (obsTiming()?.utc) {
              <div class="meta-sub">
                {{ obsTiming()?.utc }} • {{ obsTiming()?.date }}
              </div>
            }
            <div class="meta-sub sync">
              Auto Sync: 1m (Active)
            </div>
          </div>

          <!-- Radar Station Focus / Switcher -->
          <div class="radar-stations">
            <div class="control-header">
              <span class="control-label">Radar Stations ({{ displayedCount() }}/{{ stations.length }} Active)</span>
              <button
                class="mosaic-view-btn"
                (click)="focusAllMosaic()"
                title="View composite mosaic across South India"
              >🌐 Mosaic</button>
            </div>
            <div class="station-pills-grid">
              @for (st of stations; track st.id) {
                <button
                  class="station-pill"
                  [class.active]="activeStationId() === st.id"
                  (click)="onSelectStation(st.id)"
                  [title]="st.fullName"
                >
                  <div class="station-pill-left">
                    <span
                      class="station-status-dot"
                      [class.dot-fresh]="getStationFreshness(st.id) === 'fresh'"
                      [class.dot-recent]="getStationFreshness(st.id) === 'recent'"
                      [class.dot-stale]="getStationFreshness(st.id) === 'stale'"
                      [class.dot-offline]="getStationFreshness(st.id) === 'offline'"
                    ></span>
                    <span class="station-pill-name">{{ st.name.replace(' DWR', '').replace(' X-DWR', '') }}</span>
                  </div>
                  <div class="station-pill-right">
                    <span class="station-pill-age">
                      {{ getStationAge(st.id) !== null ? getStationAge(st.id) + 'm' : '—' }}
                    </span>
                    <span class="station-pill-band">{{ st.band }}</span>
                  </div>
                </button>
              }
            </div>
          </div>

          <!-- Product Selector: CAZ, PPI, SRI, PAC -->
          <div class="radar-products">
            <span class="control-label">Radar Product Layer</span>
            <div class="product-pills-grid">
              <button
                class="prod-pill"
                [class.active]="activeProduct() === 'caz'"
                (click)="setProduct('caz')"
                title="Column Maximum Reflectivity (MAX_Z)"
              >
                <span class="prod-icon">🌩️</span>
                <span class="prod-name">CAZ</span>
                <span class="prod-sub">Max dBZ</span>
              </button>
              <button
                class="prod-pill"
                [class.active]="activeProduct() === 'ppi'"
                (click)="setProduct('ppi')"
                title="Plan Position Indicator (Base Reflectivity)"
              >
                <span class="prod-icon">⚡</span>
                <span class="prod-name">PPI</span>
                <span class="prod-sub">Base Z</span>
              </button>
              <button
                class="prod-pill"
                [class.active]="activeProduct() === 'sri'"
                (click)="setProduct('sri')"
                title="Surface Rainfall Intensity (mm/h)"
              >
                <span class="prod-icon">🌧️</span>
                <span class="prod-name">SRI</span>
                <span class="prod-sub">Rain Rate</span>
              </button>
              <button
                class="prod-pill"
                [class.active]="activeProduct() === 'pac'"
                (click)="setProduct('pac')"
                title="Precipitation Accumulation (Rain Total)"
              >
                <span class="prod-icon">💧</span>
                <span class="prod-name">PAC</span>
                <span class="prod-sub">Accum</span>
              </button>
            </div>
          </div>

          <!-- Toggles: Transparent Mode (Organic Blending) -->
          <div class="radar-toggles">
            <label class="toggle-row" title="Isolate precipitation echoes with organic intensity blending">
              <input
                type="checkbox"
                [checked]="isTransparent()"
                (change)="onTransparentChange($event)"
              />
              <span class="toggle-text">Organic Blending</span>
            </label>
          </div>

          <!-- Opacity Slider -->
          <div class="opacity-control">
            <div class="control-header">
              <span class="control-label">Radar Opacity</span>
              <span class="speed-value">{{ Math.round(radarOpacity() * 100) }}%</span>
            </div>
            <input
              type="range"
              class="speed-slider"
              min="0.2"
              max="1.0"
              step="0.05"
              [value]="radarOpacity()"
              (input)="onRadarOpacityChange($event)"
              title="Adjust Radar Transparency"
            />
          </div>

          <!-- IMD Rain Intensity Legend -->
          <div class="radar-legend">
            <span class="control-label">
              {{ activeProduct() === 'sri' ? 'Rain Rate (mm/h)' : activeProduct() === 'pac' ? 'Accumulation (mm)' : 'Rain Intensity (dBZ)' }}
            </span>
            <div class="legend-bar"></div>
            <div class="legend-scale">
              <span>{{ activeProduct() === 'sri' ? '0.4 Lgt' : activeProduct() === 'pac' ? '0.4mm' : '17 Lgt' }}</span>
              <span>{{ activeProduct() === 'sri' ? '2 Mod' : activeProduct() === 'pac' ? '2mm' : '28' }}</span>
              <span>{{ activeProduct() === 'sri' ? '10 Hvy' : activeProduct() === 'pac' ? '10mm' : '39 Hvy' }}</span>
              <span>{{ activeProduct() === 'sri' ? '50 Tor' : activeProduct() === 'pac' ? '50mm' : '50' }}</span>
              <span>{{ activeProduct() === 'sri' ? '100+ Svr' : activeProduct() === 'pac' ? '100+' : '60+ Hail' }}</span>
            </div>
          </div>
        </div>

        <!-- IMD Doppler Weather Radar Network Status Card -->
        <div class="downscaling-card">
          <div class="downscale-status">
            <span class="pulse-indicator"></span>
            <span class="downscale-title">IMD Radar Network</span>
            <span class="resolution-tag">{{ displayedCount() }} of {{ stations.length }} Active</span>
          </div>
          <div class="downscale-desc">
            Official IMD radar network with independent observation timing and seamless intensity blending across South India
          </div>
        </div>
      }

      <!-- ⛰️ 500m Regional Microclimate Controls (Tamil Nadu) -->
      @if (hasAny500mActive()) {
        <div class="microclimate-box animate-fade-in">
          <div class="mc-panel-header">
            <span class="pulse-indicator mc-pulse"></span>
            <span class="mc-panel-title">Tamil Nadu Microclimate</span>
            <div class="mc-header-btns">
              <button
                class="icon-action-btn"
                (click)="refreshMicroclimate()"
                [disabled]="mc.isRefreshing()"
                title="Refresh Live Weather Anchor"
              >{{ mc.isRefreshing() ? '⏳' : '🔄' }}</button>
              <button
                class="mc-turn-off-btn"
                (click)="mc.turnOffMicroclimate()"
                title="Turn off all Tamil Nadu microclimate layers"
              >✕ Turn Off</button>
            </div>
          </div>

          <div class="mc-action-row">
            <button
              class="mc-focus-btn"
              (click)="focus500mRegion()"
              title="Center camera on Tamil Nadu"
            >📍 Focus Region</button>
            <span class="mc-sync-lbl">{{ mc.lastUpdated() }}</span>
          </div>

          <!-- 🟢 Always-On Live Nowcast Banner (Temp, Humidity, Wind) -->
          <div class="mc-nowcast-card">
            <div class="nowcast-top">
              <span class="nowcast-tag">● {{ mc.dataStatus() === 'live' ? 'LIVE' : mc.dataStatus() === 'cached' ? 'CACHED' : 'ESTIMATED' }} NOWCAST (Tamil Nadu)</span>
              <span class="nowcast-alt-tag">{{ mc.currentSoundingState().levelLabel }}</span>
            </div>
            <div class="nowcast-tri-grid">
              <div class="nc-stat temp">
                <span class="nc-label">TEMP</span>
                <span class="nc-val">{{ mc.currentSoundingState().temperatureC }}°C</span>
              </div>
              <div class="nc-stat hum">
                <span class="nc-label">HUMIDITY</span>
                <span class="nc-val">{{ mc.currentSoundingState().humidityPercent }}%</span>
              </div>
              <div class="nc-stat wind">
                <span class="nc-label">WIND</span>
                <span class="nc-val">{{ mc.currentSoundingState().windSpeedKmh }} km/h</span>
                <span class="nc-sub">{{ degToCompass(mc.currentSoundingState().windDirectionDeg) }} ({{ mc.currentSoundingState().windDirectionDeg }}°)</span>
              </div>
            </div>
            <!-- Quick View Mode Switcher (Temp, Humidity, Wind, Rain, CAPE) -->
            <div class="nc-mode-toggle">
              <button
                class="nc-mode-btn"
                [class.active]="mc.rasterMode() === 'temp'"
                (click)="mc.setRasterMode('temp')"
              >🌡️ Temp</button>
              <button
                class="nc-mode-btn"
                [class.active]="mc.rasterMode() === 'humidity'"
                (click)="mc.setRasterMode('humidity')"
              >💧 Hum</button>
              <button
                class="nc-mode-btn"
                [class.active]="mc.rasterMode() === 'wind'"
                (click)="mc.setRasterMode('wind')"
              >🍃 Wind</button>
              <button
                class="nc-mode-btn"
                [class.active]="mc.rasterMode() === 'rain-24h'"
                (click)="mc.setRasterMode('rain-24h')"
              >🌧️ Rain</button>
              <button
                class="nc-mode-btn"
                [class.active]="mc.rasterMode() === 'cape'"
                (click)="mc.setRasterMode('cape')"
              >⚡ CAPE</button>
            </div>
          </div>

          <!-- 🏔️ Altitude / Sounding Slider from Ground Level to 13 km -->
          <div class="mc-sub-control mc-elevation-section">
            <div class="control-header">
              <span class="control-label">Altitude Level (0 to 13 km)</span>
              <span class="speed-value highlight-alt">{{ mc.currentSoundingState().levelLabel }}</span>
            </div>
            <input
              type="range"
              class="speed-slider alt-slider"
              min="0"
              max="13000"
              step="100"
              [value]="mc.selectedElevationMeters()"
              (input)="onElevationSliderChange($event)"
              title="Slide altitude from ground level to 13 km"
            />
            <div class="slider-endpoints">
              <span>Ground (0m)</span>
              <span class="slider-mid-tag">{{ (mc.selectedElevationMeters() / 1000).toFixed(1) }} km</span>
              <span>13.0 km (150 hPa)</span>
            </div>
            <div class="elevation-chips-grid">
              @for (preset of mc.elevationPresets; track preset.meters) {
                <button
                  class="elev-chip"
                  [class.active]="mc.selectedElevationMeters() === preset.meters"
                  (click)="mc.setElevation(preset.meters)"
                  [title]="preset.tag"
                >
                  {{ preset.label }}
                </button>
              }
            </div>
          </div>

          <!-- Microclimate Landmark Sensor Chips -->
          <div class="mc-sensor-chips">
            @for (lm of mc.landmarks(); track lm.id) {
              <div class="mc-chip">
                <div class="chip-title">{{ lm.icon }} {{ lm.name }} ({{ lm.elev }}m)</div>
                <div class="chip-metrics">
                  <span class="m-val temp">{{ lm.temp }}°C</span>
                  <span class="m-sep">•</span>
                  <span class="m-val hum">{{ lm.hum }}%</span>
                  <span class="m-sep">•</span>
                  <span class="m-val wind">{{ lm.wind }}kph</span>
                </div>
              </div>
            }
          </div>

          <!-- Temperature Legend & Controls (User Palette 1) -->
          @if (isTemp500mActive()) {
            <div class="mc-sub-control">
              <div class="control-header">
                <span class="control-label">Temperature (°C) • Palette 1</span>
                <span class="speed-value">{{ Math.round(tempOpacity() * 100) }}%</span>
              </div>
              <input
                type="range"
                class="speed-slider"
                min="0.2"
                max="1.0"
                step="0.05"
                [value]="tempOpacity()"
                (input)="onTempOpacityChange($event)"
                title="Adjust Temperature Layer Opacity"
              />
              <div class="temp-legend-bar"></div>
              <div class="legend-scale">
                <span>≤18° Cold</span>
                <span>22°</span>
                <span>26°</span>
                <span>30°</span>
                <span>≥34° Hot</span>
              </div>
            </div>
          }

          <!-- 24h Rain Legend & Controls (IMD Standard) -->
          @if (isRain24hActive()) {
            <div class="mc-sub-control">
              <div class="control-header">
                <span class="control-label">24h Rain Forecast (mm) • IMD</span>
                <span class="speed-value">{{ Math.round(rainOpacity() * 100) }}%</span>
              </div>
              <input
                type="range"
                class="speed-slider"
                min="0.2"
                max="1.0"
                step="0.05"
                [value]="rainOpacity()"
                (input)="onRainOpacityChange($event)"
                title="Adjust 24h Rain Layer Opacity"
              />
              <div class="rain-legend-bar"></div>
              <div class="legend-scale">
                <span>0 Dry</span>
                <span>10 Light</span>
                <span>35 Mod</span>
                <span>90 Heavy</span>
                <span>204+ Extr</span>
              </div>
            </div>
          }

          <!-- CAPE Convective Instability Legend & Controls (WMO Standard) -->
          @if (isCapeActive()) {
            <div class="mc-sub-control">
              <div class="control-header">
                <span class="control-label">CAPE Index (J/kg) • Storm Risk</span>
                <span class="speed-value">{{ Math.round(capeOpacity() * 100) }}%</span>
              </div>
              <input
                type="range"
                class="speed-slider"
                min="0.2"
                max="1.0"
                step="0.05"
                [value]="capeOpacity()"
                (input)="onCapeOpacityChange($event)"
                title="Adjust CAPE Layer Opacity"
              />
              <div class="cape-legend-bar"></div>
              <div class="legend-scale">
                <span>0 Stable</span>
                <span>750</span>
                <span>1800 Mod</span>
                <span>3100 High</span>
                <span>4500+ Extr</span>
              </div>
            </div>
          }

          <!-- Humidity Legend & Controls (User Palette 2) -->
          @if (isHumidity500mActive()) {
            <div class="mc-sub-control">
              <div class="control-header">
                <span class="control-label">Relative Humidity (%) • Palette 2</span>
                <span class="speed-value">{{ Math.round(humidityOpacity() * 100) }}%</span>
              </div>
              <input
                type="range"
                class="speed-slider"
                min="0.2"
                max="1.0"
                step="0.05"
                [value]="humidityOpacity()"
                (input)="onHumidityOpacityChange($event)"
                title="Adjust Humidity Layer Opacity"
              />
              <div class="hum-legend-bar"></div>
              <div class="legend-scale">
                <span>20% Dry</span>
                <span>40% Low</span>
                <span>60% Mod</span>
                <span>80% Hum</span>
                <span>100% Sat</span>
              </div>
            </div>
          }

          <!-- Wind Streamline Palette & Speed Control -->
          @if (isWind500mActive()) {
            <div class="mc-sub-control">
              <div class="control-header">
                <span class="control-label">Wind Streamlines (500m)</span>
                <span class="speed-value">{{ windSpeedMultiplier() }}x</span>
              </div>
              <input
                type="range"
                class="speed-slider"
                min="0.4"
                max="3.0"
                step="0.1"
                [value]="windSpeedMultiplier()"
                (input)="onWindSpeedMultiplierChange($event)"
                title="Adjust Wind Streamlines Speed"
              />
              <div class="wind-pal-select-row dynamic-info">
                <div class="wind-pal-chip cold active">
                  <span class="pal-dot cold"></span> ❄️ Cold Cyan (>70% RH)
                </div>
                <div class="wind-pal-chip dry active">
                  <span class="pal-dot dry"></span> 🏜️ Dry Amber (≤70% RH)
                </div>
              </div>
              <div class="wind-meta-info">
                <span>🍃 Flow: {{ mc.currentSoundingState().windSpeedKmh }} km/h {{ degToCompass(mc.currentSoundingState().windDirectionDeg) }} ({{ mc.currentSoundingState().windDirectionDeg }}°)</span>
                <span class="orographic-tag">
                  {{ mc.selectedElevationMeters() < 1200 ? 'Orographic Deflection' : 'Geostrophic Flow' }} • 350 Streamlines
                </span>
              </div>
            </div>
          }

          <!-- 100m Downscaling Resolution Card -->
          <div class="downscaling-card mc-downscale-card">
            <div class="downscale-status">
              <span class="pulse-indicator"></span>
              <span class="downscale-title">Tamil Nadu 500m Grid</span>
              <span class="resolution-tag">{{ mc.gridWidth }} × {{ mc.gridHeight }} (500m)</span>
            </div>
            <div class="downscale-desc">
              Ground to 13 km vertical sounding • ECMWF IFS (130 model nodes) downscaled to 500 m with real terrain: lapse rate &amp; orography
            </div>
          </div>
        </div>
      }

      <!-- Quick Restore Card when Microclimate is turned off -->
      @if (!hasAny500mActive()) {
        <div class="mc-turn-on-card animate-fade-in">
          <div class="turn-on-desc">
            <span class="turn-on-title">⛰️ Tamil Nadu 500m Microclimate</span>
            <span class="turn-on-sub">Turned off • Click to restore high-resolution layers</span>
          </div>
          <button
            class="mc-turn-on-btn"
            (click)="mc.turnOnMicroclimate('temp')"
            title="Turn on 500m Tamil Nadu microclimate layers"
          >
            Turn On
          </button>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }

    .layers-panel {
      width: 256px;
      max-height: calc(100vh - 120px);
      overflow-y: auto;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .layers-panel::-webkit-scrollbar {
      width: 4px;
    }
    .layers-panel::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.15);
      border-radius: 2px;
    }

    .panel-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: var(--font-display);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 1px;
      text-transform: uppercase;
      color: var(--text-secondary);
    }
    .panel-title svg {
      color: var(--neon-cyan);
      opacity: 0.7;
    }
    .badge {
      margin-left: auto;
      background: var(--neon-cyan);
      color: var(--bg-primary);
      font-family: var(--font-display);
      font-size: 10px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 10px;
    }

    .layer-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .layer-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
      color: var(--text-primary);
      font-family: var(--font-body);
      font-size: 13px;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      width: 100%;
      text-align: left;
    }
    .layer-item:hover {
      background: rgba(0, 229, 255, 0.08);
      border-color: rgba(0, 229, 255, 0.25);
      transform: translateX(2px);
    }
    .layer-item.active {
      background: rgba(0, 229, 255, 0.12);
      border-color: var(--neon-cyan);
      box-shadow: 0 0 15px rgba(0, 229, 255, 0.2);
    }

    .layer-icon {
      font-size: 16px;
      line-height: 1;
    }

    .layer-name {
      flex: 1;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .layer-status {
      font-family: var(--font-display);
      font-size: 10px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-muted);
    }
    .layer-status.on {
      background: var(--neon-cyan);
      color: var(--bg-primary);
      box-shadow: 0 0 8px rgba(0, 229, 255, 0.5);
    }

    /* ── Radar Control Box ──────────────────────────────────── */
    .radar-box {
      display: flex;
      flex-direction: column;
      gap: 9px;
      padding: 11px 12px;
      border-radius: 10px;
      background: rgba(14, 165, 233, 0.06);
      border: 1px solid rgba(56, 189, 248, 0.25);
    }

    .radar-header {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .live-pulse {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #22c55e;
      box-shadow: 0 0 8px #22c55e;
      animation: pulseDot 1.8s infinite;
    }
    @keyframes pulseDot {
      0% { transform: scale(0.95); opacity: 0.8; }
      50% { transform: scale(1.3); opacity: 1; }
      100% { transform: scale(0.95); opacity: 0.8; }
    }
    .radar-title {
      font-size: 11px;
      font-weight: 700;
      color: #38bdf8;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .time-period-tag {
      font-size: 8.5px;
      font-weight: 700;
      letter-spacing: 0.5px;
      padding: 1.5px 5px;
      border-radius: 4px;
      text-transform: uppercase;
      font-family: var(--font-display);
      white-space: nowrap;
    }
    .time-period-tag.day {
      background: rgba(234, 179, 8, 0.15);
      border: 1px solid rgba(234, 179, 8, 0.45);
      color: #facc15;
    }
    .time-period-tag.night {
      background: rgba(99, 102, 241, 0.15);
      border: 1px solid rgba(129, 140, 248, 0.45);
      color: #a5b4fc;
    }
    .icon-action-btn {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .icon-action-btn:hover {
      background: rgba(56, 189, 248, 0.2);
      border-color: #38bdf8;
    }

    /* Station Dropdown & Chips */
    .station-select-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .station-dropdown {
      background: rgba(15, 23, 42, 0.85);
      border: 1px solid rgba(56, 189, 248, 0.35);
      color: #f1f5f9;
      font-size: 11px;
      padding: 5px 7px;
      border-radius: 6px;
      outline: none;
      cursor: pointer;
      width: 100%;
    }
    .station-dropdown:focus {
      border-color: #38bdf8;
      box-shadow: 0 0 8px rgba(56, 189, 248, 0.3);
    }
    .station-dropdown option {
      background: #0f172a;
      color: #f1f5f9;
    }

    .quick-station-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 3px;
    }
    .chip-btn {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: #cbd5e1;
      font-size: 9.5px;
      padding: 2px 6px;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .chip-btn:hover {
      background: rgba(56, 189, 248, 0.15);
      color: #38bdf8;
      border-color: rgba(56, 189, 248, 0.3);
    }
    .chip-btn.active {
      background: rgba(56, 189, 248, 0.25);
      color: #38bdf8;
      border-color: #38bdf8;
      font-weight: 700;
    }

    .sweep-meta-banner {
      background: rgba(15, 23, 42, 0.7);
      border: 1px solid rgba(56, 189, 248, 0.15);
      border-radius: 6px;
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: 10px;
    }
    .meta-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .meta-label {
      color: var(--text-muted);
    }
    .meta-val.highlight {
      color: #38bdf8;
      font-family: var(--font-mono);
      font-weight: 600;
    }
    .meta-val.clock {
      color: #34d399;
      font-family: var(--font-mono);
      font-weight: 600;
    }
    .meta-freshness-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 1px;
    }
    .freshness-badge {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 4px;
      font-weight: 600;
      font-family: var(--font-mono);
    }
    .freshness-badge.fresh {
      background: rgba(34, 197, 94, 0.15);
      border: 1px solid rgba(34, 197, 94, 0.4);
      color: #4ade80;
    }
    .freshness-badge.recent {
      background: rgba(234, 179, 8, 0.15);
      border: 1px solid rgba(234, 179, 8, 0.4);
      color: #facc15;
    }
    .freshness-badge.stale {
      background: rgba(249, 115, 22, 0.15);
      border: 1px solid rgba(249, 115, 22, 0.4);
      color: #fb923c;
    }
    .freshness-badge.offline {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.4);
      color: #f87171;
    }
    .meta-sub {
      color: #94a3b8;
      font-size: 9px;
    }
    .meta-sub.sync {
      color: #a78bfa;
      font-size: 9px;
    }

    .radar-products {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .control-label {
      font-size: 10px;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }

    .radar-stations {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .mosaic-view-btn {
      background: rgba(56, 189, 248, 0.12);
      border: 1px solid rgba(56, 189, 248, 0.3);
      color: #38bdf8;
      border-radius: 4px;
      padding: 1px 6px;
      font-size: 9px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .mosaic-view-btn:hover {
      background: rgba(56, 189, 248, 0.25);
      color: #ffffff;
    }
    .station-pills-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 4px;
    }
    .station-pill {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 5px 7px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .station-pill:hover {
      background: rgba(56, 189, 248, 0.10);
      border-color: rgba(56, 189, 248, 0.3);
      color: #38bdf8;
    }
    .station-pill.active {
      background: rgba(56, 189, 248, 0.20);
      border-color: #38bdf8;
      color: #ffffff;
      box-shadow: 0 0 8px rgba(56, 189, 248, 0.2);
    }
    .station-pill-left {
      display: flex;
      align-items: center;
      gap: 5px;
      overflow: hidden;
    }
    .station-status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #64748b;
      flex-shrink: 0;
    }
    .station-status-dot.dot-fresh {
      background: #22c55e;
      box-shadow: 0 0 5px rgba(34, 197, 94, 0.8);
    }
    .station-status-dot.dot-recent {
      background: #eab308;
      box-shadow: 0 0 5px rgba(234, 179, 8, 0.8);
    }
    .station-status-dot.dot-stale {
      background: #f97316;
      box-shadow: 0 0 5px rgba(249, 115, 22, 0.8);
    }
    .station-status-dot.dot-offline {
      background: #ef4444;
      box-shadow: 0 0 5px rgba(239, 68, 68, 0.8);
    }
    .station-pill-name {
      font-family: var(--font-display);
      font-size: 10px;
      font-weight: 600;
      white-space: nowrap;
      text-overflow: ellipsis;
      overflow: hidden;
    }
    .station-pill-right {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    .station-pill-age {
      font-family: var(--font-mono);
      font-size: 8.5px;
      color: #94a3b8;
    }
    .station-pill.active .station-pill-age {
      color: #bae6fd;
    }
    .station-pill-band {
      font-size: 8px;
      padding: 1px 4px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.08);
      color: #94a3b8;
    }
    .station-pill.active .station-pill-band {
      background: rgba(56, 189, 248, 0.3);
      color: #bae6fd;
    }

    .product-pills-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 5px;
    }
    .prod-pill {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      padding: 6px 4px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .prod-pill:hover {
      background: rgba(56, 189, 248, 0.12);
      border-color: rgba(56, 189, 248, 0.35);
      color: #38bdf8;
    }
    .prod-pill.active {
      background: rgba(56, 189, 248, 0.22);
      border-color: #38bdf8;
      color: #ffffff;
      box-shadow: 0 0 10px rgba(56, 189, 248, 0.25);
    }
    .prod-icon {
      font-size: 13px;
      line-height: 1;
    }
    .prod-name {
      font-family: var(--font-display);
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.5px;
    }
    .prod-sub {
      font-size: 8.5px;
      opacity: 0.75;
    }

    .radar-toggles {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .toggle-row {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      font-size: 10.5px;
      color: var(--text-primary);
    }
    .toggle-row input {
      cursor: pointer;
      accent-color: #38bdf8;
    }

    .opacity-control {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .radar-legend {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 2px;
    }
    .legend-bar {
      width: 100%;
      height: 7px;
      border-radius: 3px;
      background: linear-gradient(to right, #1e40d7 0%, #0ea5e9 15%, #22c55e 32%, #facc15 53%, #f97316 68%, #ef4444 83%, #a855f7 100%);
      box-shadow: 0 0 6px rgba(168, 85, 247, 0.25);
    }
    .legend-scale {
      display: flex;
      justify-content: space-between;
      font-size: 8.5px;
      color: #94a3b8;
      font-family: var(--font-mono);
    }



    /* ── Wind Speed Box ─────────────────────────────────────── */
    .control-box {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(0, 229, 255, 0.05);
      border: 1px solid rgba(0, 229, 255, 0.2);
    }
    .control-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 10px;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .speed-value {
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 700;
      color: var(--neon-cyan);
      background: rgba(0, 229, 255, 0.12);
      padding: 1px 6px;
      border-radius: 4px;
    }
    .speed-slider {
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: 4px;
      border-radius: 2px;
      background: rgba(255, 255, 255, 0.15);
      outline: none;
      cursor: pointer;
    }
    .speed-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--neon-cyan);
      box-shadow: 0 0 8px rgba(0, 229, 255, 0.8);
      cursor: pointer;
      transition: transform 0.1s ease;
    }
    .speed-slider::-webkit-slider-thumb:hover {
      transform: scale(1.2);
    }
    .preset-buttons {
      display: flex;
      gap: 4px;
      justify-content: space-between;
    }
    .preset-btn {
      flex: 1;
      font-size: 10px;
      font-family: var(--font-mono);
      font-weight: 600;
      padding: 4px 0;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: var(--text-muted);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .preset-btn:hover {
      background: rgba(0, 229, 255, 0.1);
      color: var(--neon-cyan);
    }
    .preset-btn.active {
      background: var(--neon-cyan);
      color: var(--bg-primary);
      border-color: var(--neon-cyan);
      font-weight: 700;
    }

    /* Downscaling Card */
    .downscaling-card {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 9px 11px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.06);
    }
    .downscale-status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .pulse-indicator {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #00e676;
      box-shadow: 0 0 8px #00e676;
    }
    .resolution-tag {
      margin-left: auto;
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 3px;
      background: rgba(0, 230, 118, 0.15);
      color: #00e676;
      border: 1px solid rgba(0, 230, 118, 0.3);
    }
    .downscale-desc {
      font-size: 9.5px;
      color: var(--text-muted);
      line-height: 1.3;
    }

    .basemap-box {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.06);
    }
    .basemap-pills {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }
    .bm-pill {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 7px 10px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.03);
      color: var(--text-secondary);
      font-family: var(--font-display);
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .bm-pill:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-primary);
    }
    .bm-pill.active {
      background: rgba(0, 229, 255, 0.15);
      border-color: rgba(0, 229, 255, 0.4);
      color: #38bdf8;
      box-shadow: 0 0 10px rgba(0, 229, 255, 0.2);
    }

    /* ── 500m Regional Microclimate Panel ───────────────────────── */
    .microclimate-box {
      background: rgba(15, 23, 42, 0.75);
      border: 1px solid rgba(56, 189, 248, 0.3);
      border-radius: 8px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    }
    .mc-panel-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding-bottom: 5px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .mc-panel-title {
      font-size: 0.8rem;
      font-weight: 700;
      color: #f1f5f9;
      flex: 1;
      letter-spacing: -0.01em;
    }
    .mc-pulse {
      background: #38bdf8;
      box-shadow: 0 0 8px #38bdf8;
    }
    .mc-action-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    .mc-focus-btn {
      background: rgba(56, 189, 248, 0.16);
      border: 1px solid rgba(56, 189, 248, 0.4);
      color: #38bdf8;
      font-size: 0.72rem;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 5px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .mc-focus-btn:hover {
      background: rgba(56, 189, 248, 0.35);
      color: #f0f9ff;
      box-shadow: 0 0 10px rgba(56, 189, 248, 0.35);
    }
    .mc-sync-lbl {
      font-size: 0.68rem;
      color: #94a3b8;
      font-family: monospace;
    }
    .mc-sensor-chips {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .mc-chip {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 5px;
      padding: 4px 6px;
    }
    .chip-title {
      font-size: 0.68rem;
      font-weight: 700;
      color: #cbd5e1;
      margin-bottom: 2px;
    }
    .chip-metrics {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 0.7rem;
      font-family: monospace;
      font-weight: 600;
    }
    .m-val.temp { color: #f4a261; }
    .m-val.hum { color: #9fb9cb; }
    .m-val.wind { color: #4ade80; }
    .m-sep { color: #475569; }
    .mc-nowcast-card {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(56, 189, 248, 0.3);
      border-radius: 8px;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .nowcast-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .nowcast-tag {
      font-size: 0.68rem;
      font-weight: 800;
      color: #38bdf8;
      letter-spacing: 0.04em;
    }
    .nowcast-alt-tag {
      font-size: 0.65rem;
      font-weight: 700;
      color: #cbd5e1;
      background: rgba(255, 255, 255, 0.08);
      padding: 1px 5px;
      border-radius: 3px;
    }
    .nowcast-tri-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 4px;
      background: rgba(255, 255, 255, 0.03);
      padding: 5px;
      border-radius: 5px;
    }
    .nc-stat {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .nc-label {
      font-size: 0.6rem;
      font-weight: 700;
      color: #64748b;
    }
    .nc-val {
      font-size: 0.78rem;
      font-weight: 800;
      font-family: monospace;
    }
    .nc-sub {
      font-size: 0.6rem;
      color: #94a3b8;
    }
    .nc-stat.temp .nc-val { color: #f4a261; }
    .nc-stat.hum .nc-val { color: #9fb9cb; }
    .nc-stat.wind .nc-val { color: #4ade80; }
    .nc-mode-toggle {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 3px;
    }
    .nc-mode-btn {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: #94a3b8;
      font-size: 0.62rem;
      font-weight: 600;
      padding: 3.5px 1px;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s ease;
      text-align: center;
      white-space: nowrap;
    }
    .nc-mode-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #f1f5f9;
    }
    .nc-mode-btn.active {
      background: rgba(56, 189, 248, 0.25);
      border-color: #38bdf8;
      color: #38bdf8;
      font-weight: 700;
    }
    .mc-sub-control {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 6px;
      padding: 6px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .highlight-alt {
      color: #38bdf8;
      font-weight: 800;
      font-size: 0.72rem;
    }
    .alt-slider {
      accent-color: #38bdf8;
      height: 5px;
    }
    .slider-endpoints {
      display: flex;
      justify-content: space-between;
      font-size: 0.62rem;
      color: #64748b;
      font-weight: 600;
    }
    .slider-mid-tag {
      color: #38bdf8;
      font-weight: 800;
    }
    .elevation-chips-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 3px;
      margin-top: 3px;
    }
    .elev-chip {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.07);
      color: #94a3b8;
      font-size: 0.63rem;
      font-weight: 600;
      border-radius: 4px;
      padding: 2.5px 2px;
      cursor: pointer;
      text-align: center;
      transition: all 0.15s ease;
    }
    .elev-chip:hover {
      background: rgba(56, 189, 248, 0.15);
      color: #f0f9ff;
    }
    .elev-chip.active {
      background: #0284c7;
      color: #ffffff;
      border-color: #38bdf8;
      font-weight: 800;
      box-shadow: 0 0 8px rgba(56, 189, 248, 0.4);
    }
    .temp-legend-bar {
      height: 6px;
      border-radius: 3px;
      background: linear-gradient(to right, #264653, #2a9d8f, #e9c46a, #f4a261, #e76f51);
      margin: 2px 0;
    }
    .hum-legend-bar {
      height: 6px;
      border-radius: 3px;
      background: linear-gradient(to right, #f7f7ef, #ddddd4, #9fb9cb, #355c77, #07253a);
      margin: 2px 0;
    }
    .rain-legend-bar {
      height: 6px;
      border-radius: 3px;
      background: linear-gradient(to right, #f8fafc, #38bdf8, #22c55e, #eab308, #f97316, #ef4444, #a855f7);
      margin: 2px 0;
    }
    .cape-legend-bar {
      height: 6px;
      border-radius: 3px;
      background: linear-gradient(to right, #64748b, #06b6d4, #22c55e, #eab308, #f97316, #ef4444, #d946ef);
      margin: 2px 0;
    }
    .wind-meta-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: 0.68rem;
      color: #94a3b8;
      margin-top: 2px;
    }
    .orographic-tag {
      font-size: 0.63rem;
      color: #c084fc;
      font-style: italic;
    }
    .mc-downscale-card {
      margin-top: 2px;
    }
    .mc-header-btns {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .mc-turn-off-btn {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.35);
      color: #f87171;
      font-size: 0.65rem;
      font-weight: 700;
      border-radius: 4px;
      padding: 2px 6px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .mc-turn-off-btn:hover {
      background: rgba(239, 68, 68, 0.3);
      color: #ffffff;
      border-color: #ef4444;
    }
    .wind-pal-select-row {
      display: flex;
      align-items: center;
      gap: 5px;
      margin-top: 4px;
      padding: 4px 6px;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 5px;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }
    .pal-sub-lbl {
      font-size: 0.62rem;
      font-weight: 700;
      color: #64748b;
    }
    .wind-pal-chip {
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
      padding: 3px 4px;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .wind-pal-chip:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #f8fafc;
    }
    .wind-pal-chip.cold.active {
      background: rgba(56, 189, 248, 0.2);
      border-color: #38bdf8;
      color: #38bdf8;
      font-weight: 700;
      box-shadow: 0 0 8px rgba(56, 189, 248, 0.3);
    }
    .wind-pal-chip.dry.active {
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
    .mc-turn-on-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 12px;
      background: rgba(15, 23, 42, 0.7);
      border: 1px dashed rgba(56, 189, 248, 0.3);
      border-radius: 8px;
      margin-top: 4px;
    }
    .turn-on-desc {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .turn-on-title {
      font-size: 0.76rem;
      font-weight: 700;
      color: #cbd5e1;
    }
    .turn-on-sub {
      font-size: 0.65rem;
      color: #64748b;
    }
    .mc-turn-on-btn {
      background: rgba(56, 189, 248, 0.2);
      border: 1px solid rgba(56, 189, 248, 0.5);
      color: #38bdf8;
      font-size: 0.72rem;
      font-weight: 700;
      border-radius: 5px;
      padding: 4px 10px;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s ease;
    }
    .mc-turn-on-btn:hover {
      background: rgba(56, 189, 248, 0.35);
      color: #ffffff;
      box-shadow: 0 0 10px rgba(56, 189, 248, 0.4);
    }

    @media (max-width: 768px) {
      .layers-panel {
        width: 100%;
        max-height: 65vh;
        padding: 14px;
      }
    }
  `]
})
export class LayersComponent {
  protected readonly Math = Math;

  private ls = inject(MapLayerService);
  private rs = inject(RadarService);
  readonly layers = this.ls.layers;
  readonly activeCount = this.ls.activeLayerCount;

  // Radar State & Controls
  readonly activeProduct = this.rs.activeProduct;
  readonly isTransparent = this.rs.transparentMode;
  readonly showRings = this.rs.showRangeRings;
  readonly radarOpacity = this.rs.radarOpacity;
  readonly obsTiming = this.rs.observationTiming;
  readonly lastSync = this.rs.lastSyncTime;
  readonly isRadarRefreshing = this.rs.isRefreshing;

  // Dynamic Live Clock & Radar Freshness
  readonly liveClock = this.rs.liveTimeString;
  readonly sweepAge = this.rs.activeStationAgeMinutes;
  readonly sweepFreshness = this.rs.activeStationFreshness;

  // Radar Stations
  readonly stations = this.rs.stations;
  readonly activeStationId = this.rs.activeStationId;
  readonly activeStation = this.rs.activeStation;
  readonly displayedCount = this.rs.displayedStationsCount;

  getStationAge(id: string): number | null {
    return this.rs.getStationAge(id);
  }

  getStationFreshness(id: string): 'fresh' | 'recent' | 'stale' | 'offline' | 'syncing' {
    return this.rs.getStationFreshness(id);
  }

  readonly isRadarActive = computed(() =>
    this.layers().find(l => l.id === 'radar')?.active ?? false
  );

  onSelectStation(id: string): void {
    this.rs.selectStation(id);
  }

  focusAllMosaic(): void {
    this.rs.requestCenterStation();
  }

  toggle(id: string): void {
    this.ls.toggleLayer(id);
  }

  setProduct(product: RadarProductKey): void {
    this.rs.setProduct(product);
  }

  onTransparentChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.rs.setTransparent(input.checked);
  }

  onRadarOpacityChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const val = parseFloat(input.value);
    this.rs.setOpacity(val);
    this.ls.setLayerOpacity('radar', val);
  }

  refreshRadar(): void {
    this.rs.fetchRadarSweep();
  }

  // ── 500m Regional Microclimate Controls & Signals ───────────
  protected readonly mc = inject(MicroclimateService);
  protected readonly degToCompass = degToCompass;

  readonly hasAny500mActive = computed(() =>
    this.layers().some(l => (l.id === 'temp-500m' || l.id === 'humidity-500m' || l.id === 'wind-500m' || l.id === 'rain-24h' || l.id === 'cape') && l.active)
  );

  readonly isTemp500mActive = computed(() =>
    this.layers().find(l => l.id === 'temp-500m')?.active ?? false
  );

  readonly isHumidity500mActive = computed(() =>
    this.layers().find(l => l.id === 'humidity-500m')?.active ?? false
  );

  readonly isWind500mActive = computed(() =>
    this.layers().find(l => l.id === 'wind-500m')?.active ?? false
  );

  readonly isRain24hActive = computed(() =>
    this.layers().find(l => l.id === 'rain-24h')?.active ?? false
  );

  readonly isCapeActive = computed(() =>
    this.layers().find(l => l.id === 'cape')?.active ?? false
  );

  readonly tempOpacity = computed(() =>
    this.layers().find(l => l.id === 'temp-500m')?.opacity ?? 0.85
  );

  readonly humidityOpacity = computed(() =>
    this.layers().find(l => l.id === 'humidity-500m')?.opacity ?? 0.85
  );

  readonly rainOpacity = computed(() =>
    this.layers().find(l => l.id === 'rain-24h')?.opacity ?? 0.85
  );

  readonly capeOpacity = computed(() =>
    this.layers().find(l => l.id === 'cape')?.opacity ?? 0.85
  );

  readonly windSpeedMultiplier = this.ls.windSpeedMultiplier;

  focus500mRegion(): void {
    this.mc.requestCenterRegion();
  }

  refreshMicroclimate(): void {
    this.mc.fetchLiveAnchorData();
  }

  onTempOpacityChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const val = parseFloat(input.value);
    this.ls.setLayerOpacity('temp-500m', val);
  }

  onHumidityOpacityChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const val = parseFloat(input.value);
    this.ls.setLayerOpacity('humidity-500m', val);
  }

  onRainOpacityChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const val = parseFloat(input.value);
    this.ls.setLayerOpacity('rain-24h', val);
  }

  onCapeOpacityChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const val = parseFloat(input.value);
    this.ls.setLayerOpacity('cape', val);
  }

  onWindSpeedMultiplierChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const val = parseFloat(input.value);
    this.ls.setWindSpeedMultiplier(val);
  }

  onElevationSliderChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const val = parseFloat(input.value);
    this.mc.setElevation(val);
  }
}
