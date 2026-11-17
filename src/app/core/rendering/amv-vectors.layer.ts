import type { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import type { AmvGeoJson, AmvVectorProperties, AmvStyle } from '../satellite/amv.service';
import { CycloneData, runStartMs, smoothTrack, stormAt, trackMotion, windClass } from '../forecast/cyclone-tracks';

export const AMV_SOURCE_ID = 'amv-vectors-source';
export const AMV_SYMBOLS_LAYER_ID = 'amv-vectors-symbols';

export const AMV_CYCLONE_SOURCE_ID = 'amv-cyclone-track-source';
export const AMV_CYCLONE_CASING_LAYER_ID = 'amv-cyclone-casing';
export const AMV_CYCLONE_LINE_LAYER_ID = 'amv-cyclone-line';
export const AMV_CYCLONE_POINTS_LAYER_ID = 'amv-cyclone-points';
export const AMV_CYCLONE_MOTION_LAYER_ID = 'amv-cyclone-motion';
export const AMV_CYCLONE_EYE_PULSE_LAYER_ID = 'amv-cyclone-eye-pulse';
export const AMV_CYCLONE_EYE_LAYER_ID = 'amv-cyclone-eye';
export const AMV_CYCLONE_LABELS_LAYER_ID = 'amv-cyclone-labels';

const ALL_AMV_CYCLONE_LAYERS = [
  AMV_CYCLONE_CASING_LAYER_ID,
  AMV_CYCLONE_LINE_LAYER_ID,
  AMV_CYCLONE_POINTS_LAYER_ID,
  AMV_CYCLONE_MOTION_LAYER_ID,
  AMV_CYCLONE_EYE_PULSE_LAYER_ID,
  AMV_CYCLONE_EYE_LAYER_ID,
  AMV_CYCLONE_LABELS_LAYER_ID,
];

/**
 * Animated wind flow arrow implementing MapLibre's StyleImageInterface.
 * Renders a crisp, solid aerodynamic shaft with a filled arrowhead and a smooth downwind traveling pulse.
 * Solid unbroken lines ensure high visibility without strobe flicker or eye fatigue.
 */
class AnimatedArrowImage {
  readonly width = 32;
  readonly height = 32;
  data: Uint8ClampedArray = new Uint8ClampedArray(32 * 32 * 4);
  private context: CanvasRenderingContext2D | null = null;
  private map: MapLibreMap | null = null;
  private phase = 0;
  private lastRender = 0;
  active = true;

  onAdd(map: MapLibreMap): void {
    this.map = map;
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    this.context = canvas.getContext('2d', { willReadFrequently: true });
    this.drawFrame();
  }

  private drawFrame(): void {
    if (!this.context) return;
    const ctx = this.context;
    ctx.clearRect(0, 0, this.width, this.height);

    const cx = 16;
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 1. Thin clean arrow shaft
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cx, 27);
    ctx.lineTo(cx, 10);
    ctx.stroke();

    // 2. Compact filled arrowhead
    ctx.beginPath();
    ctx.moveTo(cx, 4);
    ctx.lineTo(cx - 3.5, 12);
    ctx.lineTo(cx, 9.5);
    ctx.lineTo(cx + 3.5, 12);
    ctx.closePath();
    ctx.fill();

    // 3. Gentle flow pulse
    const t = (this.phase % 20) / 20.0;
    const pulseY = 25.0 - t * 15.0;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(cx, Math.min(27, pulseY + 2.5));
    ctx.lineTo(cx, Math.max(10, pulseY - 2.0));
    ctx.stroke();

    const imgData = ctx.getImageData(0, 0, this.width, this.height);
    this.data = imgData.data;
  }

  render(): boolean {
    if (!this.active) return false;
    const now = performance.now();
    // Smooth 22 FPS refresh rate for fluid wind flow without CPU overhead
    if (now - this.lastRender < 45) {
      return false;
    }
    this.lastRender = now;
    this.phase = (this.phase + 1) % 20;
    this.drawFrame();
    this.map?.triggerRepaint();
    return true;
  }
}

const animatedArrowInstance = new AnimatedArrowImage();

/**
 * Generate standard meteorological wind barb with 5-kt half-barb, 10-kt full-barb, 50-kt pennant.
 * Designed with clean line separation and slender strokes so barbs never blur or clutter.
 * Base is pinned at (cx, cy) = (22, 22) for exact rotation around the station grid point.
 */
function createBarbImageData(speedKt: number): ImageData {
  const size = 44;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const cx = 22;
  const cy = 22; // Base pinned at center for rotation around station
  const tipY = 3;
  const s = Math.round(speedKt / 5) * 5;

  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (s < 3) {
    // Calm circle centered at (cx, cy)
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, 2 * Math.PI);
    ctx.lineWidth = 1.25;
    ctx.stroke();
    return ctx.getImageData(0, 0, size, size);
  }

  // Slender main staff extending upwind
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, tipY);
  ctx.stroke();

  const pennants = Math.floor(s / 50);
  const rem = s % 50;
  const fullBarbs = Math.floor(rem / 10);
  const halfBarbs = Math.floor((rem % 10) / 5);

  let currY = tipY;
  const barbDx = 9.5;
  const barbDy = 4.5;

  for (let i = 0; i < pennants; i++) {
    ctx.beginPath();
    ctx.moveTo(cx, currY);
    ctx.lineTo(cx + barbDx, currY + barbDy);
    ctx.lineTo(cx, currY + 2 * barbDy);
    ctx.closePath();
    ctx.fill();
    currY += 2 * barbDy + 2;
  }

  for (let i = 0; i < fullBarbs; i++) {
    ctx.beginPath();
    ctx.moveTo(cx, currY);
    ctx.lineTo(cx + barbDx, currY + barbDy);
    ctx.stroke();
    currY += 4.5;
  }

  for (let i = 0; i < halfBarbs; i++) {
    if (pennants === 0 && fullBarbs === 0) {
      currY += 3.5; // offset 5-kt half barb slightly from tip
    }
    ctx.beginPath();
    ctx.moveTo(cx, currY);
    ctx.lineTo(cx + barbDx * 0.55, currY + barbDy * 0.55);
    ctx.stroke();
    currY += 4.5;
  }

  return ctx.getImageData(0, 0, size, size);
}

/** Register all barb icons (barb-0 through barb-100) and animated arrow in MapLibre */
function ensureAmvIcons(map: MapLibreMap): void {
  try {
    if (!map.hasImage('amv-arrow')) {
      map.addImage('amv-arrow', animatedArrowInstance as any, { sdf: true });
    }
  } catch {}

  for (let kt = 0; kt <= 100; kt += 5) {
    const id = `barb-${kt}`;
    try {
      if (!map.hasImage(id)) {
        map.addImage(id, createBarbImageData(kt), { sdf: true });
      }
    } catch {}
  }
}

/** Keep AMV vectors on top of all underlying raster layers (satellite images, radar, terrain) */
export function ensureAmvOnTop(map: MapLibreMap): void {
  if (!map) return;
  const layers = [
    'amv-wind-particles',
    AMV_SYMBOLS_LAYER_ID,
    ...ALL_AMV_CYCLONE_LAYERS,
  ];
  for (const id of layers) {
    if (map.getLayer(id)) {
      try {
        map.moveLayer(id);
      } catch {}
    }
  }
}

/** Synchronize AMV GeoJSON data and layers on the MapLibre map */
export function syncAmvLayer(
  map: MapLibreMap,
  geoJson: AmvGeoJson | null,
  visible: boolean,
  style: AmvStyle = 'barbs',
  _beforeLayerId?: string,
  onHover?: (props: AmvVectorProperties | null) => void
): void {
  if (!map) return;

  // Register wind barbs and arrow icons
  ensureAmvIcons(map);

  // Remove legacy circle layer if it exists
  if (map.getLayer('amv-vectors-circles')) {
    try {
      map.removeLayer('amv-vectors-circles');
    } catch {}
  }

  const existingSource = map.getSource(AMV_SOURCE_ID) as GeoJSONSource | undefined;
  const emptyGeoJson: AmvGeoJson = { type: 'FeatureCollection', time: '', count: 0, features: [] };
  const data = (visible && geoJson) ? geoJson : emptyGeoJson;

  if (existingSource) {
    existingSource.setData(data as any);
  } else {
    map.addSource(AMV_SOURCE_ID, {
      type: 'geojson',
      data: data as any
    });
  }

  const isBarbs = style === 'barbs';

  animatedArrowInstance.active = visible && !isBarbs;
  if (visible && !isBarbs) {
    map.triggerRepaint();
  }

  const iconImageExpr: any = isBarbs
    ? ['coalesce', ['get', 'barb_id'], 'barb-10']
    : 'amv-arrow';

  // Rotation: Barbs point upwind (dir deg), Arrows point downwind / flow (dir + 180 deg)
  const iconRotateExpr: any = isBarbs
    ? ['get', 'dir']
    : ['+', ['get', 'dir'], 180];

  const iconSizeExpr: any = isBarbs
    ? 0.85
    : [
        'interpolate', ['linear'], ['zoom'],
        3, 0.45,
        5, 0.60,
        7, 0.80,
        10, 1.0
      ];

  const speedKtExpr: any = ['coalesce', ['get', 'speed_kt'], ['*', ['get', 'speed'], 1.94384]];

  // Speed-based color scale: muted tones for comfortable viewing
  // <10 kt: Muted dark slate (#475569)
  // 10-20 kt: Soft green (#4ade80)
  // 20-30 kt: Warm amber (#fbbf24)
  // 30-40 kt: Soft orange (#fb923c)
  // >=40 kt: Coral red (#f87171)
  const arrowSpeedColorExpr: any = [
    'step',
    speedKtExpr,
    '#475569',       // < 10 kt: Muted slate
    10.0, '#4ade80', // 10-20 kt: Soft green
    20.0, '#fbbf24', // 20-30 kt: Warm amber
    30.0, '#fb923c', // 30-40 kt: Soft orange
    40.0, '#f87171'  // >= 40 kt: Coral red
  ];

  const iconColorExpr: any = isBarbs
    ? ['case', ['>=', speedKtExpr, 20.0], '#00e676', '#0f172a']
    : arrowSpeedColorExpr;

  // Subtle halo for readability without eye strain
  const iconHaloColorExpr: any = [
    'step',
    speedKtExpr,
    'rgba(255, 255, 255, 0.5)',
    10.0, 'rgba(0, 0, 0, 0.35)'
  ];
  const iconHaloWidth: number = 0.6;

  const allowOverlap = !isBarbs;
  const ignorePlacement = !isBarbs;

  if (!map.getLayer(AMV_SYMBOLS_LAYER_ID)) {
    const symbolSpec: any = {
      id: AMV_SYMBOLS_LAYER_ID,
      type: 'symbol',
      source: AMV_SOURCE_ID,
      layout: {
        visibility: visible ? 'visible' : 'none',
        'icon-image': iconImageExpr,
        'icon-size': iconSizeExpr,
        'icon-rotate': iconRotateExpr,
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': allowOverlap,
        'icon-ignore-placement': ignorePlacement,
        'icon-padding': isBarbs ? 3 : 0,
        // Sort key: higher wind speeds get display placement priority
        'symbol-sort-key': ['-', 1000, speedKtExpr]
      },
      paint: {
        'icon-color': iconColorExpr,
        'icon-halo-color': iconHaloColorExpr,
        'icon-halo-width': iconHaloWidth,
        'icon-opacity': 0.75
      }
    };

    map.addLayer(symbolSpec);

    if (onHover) {
      map.on('mousemove', AMV_SYMBOLS_LAYER_ID, (e: any) => {
        const feat = e.features?.[0];
        if (feat && feat.properties) {
          map.getCanvas().style.cursor = 'pointer';
          onHover(feat.properties as any);
        }
      });
      map.on('mouseleave', AMV_SYMBOLS_LAYER_ID, () => {
        map.getCanvas().style.cursor = '';
        onHover(null);
      });
    }
  } else {
    map.setLayoutProperty(AMV_SYMBOLS_LAYER_ID, 'visibility', visible ? 'visible' : 'none');
    map.setLayoutProperty(AMV_SYMBOLS_LAYER_ID, 'icon-image', iconImageExpr);
    map.setLayoutProperty(AMV_SYMBOLS_LAYER_ID, 'icon-rotate', iconRotateExpr);
    map.setLayoutProperty(AMV_SYMBOLS_LAYER_ID, 'icon-size', iconSizeExpr);
    map.setLayoutProperty(AMV_SYMBOLS_LAYER_ID, 'icon-allow-overlap', allowOverlap);
    map.setLayoutProperty(AMV_SYMBOLS_LAYER_ID, 'icon-ignore-placement', ignorePlacement);
    map.setLayoutProperty(AMV_SYMBOLS_LAYER_ID, 'icon-padding', isBarbs ? 3 : 0);
    map.setPaintProperty(AMV_SYMBOLS_LAYER_ID, 'icon-color', iconColorExpr);
    map.setPaintProperty(AMV_SYMBOLS_LAYER_ID, 'icon-halo-color', iconHaloColorExpr);
    map.setPaintProperty(AMV_SYMBOLS_LAYER_ID, 'icon-halo-width', iconHaloWidth);
    map.setPaintProperty(AMV_SYMBOLS_LAYER_ID, 'icon-opacity', 0.75);
  }

  if (visible) {
    ensureAmvOnTop(map);
  }
}

/**
 * Builds GeoJSON features for active cyclone(s) tailored specifically for the AMV layer:
 * 1. Past track line showing where the cyclone formed and moved from up to the current eye position
 * 2. Historical position points with time and wind speed
 * 3. Direction of movement vector arrow pointing along its current heading
 * 4. Real-time eye position marker with name, intensity, pressure, and motion summary
 */
export function buildAmvCycloneGeoJson(data: CycloneData | null, timeMs: number | null): any {
  const features: any[] = [];
  if (!data || !data.storms || data.storms.length === 0) {
    return { type: 'FeatureCollection', features };
  }

  const start = runStartMs(data.run);
  const targetTime = timeMs ?? Date.now();
  const rawNowH = start !== null ? (targetTime - start) / 3_600_000 : 0;

  for (const s of data.storms) {
    if (!s.track || s.track.length === 0) continue;
    const track = smoothTrack(s.track);
    const nowH = Math.min(Math.max(rawNowH, track[0].h), track[track.length - 1].h);
    const here = stormAt(track, nowH);
    if (!here) continue;

    const cls = windClass(here.wind);
    const motion = trackMotion(track, nowH);

    // 1. Previous positions: points with h <= nowH
    const pastPoints = track.filter(p => p.h <= nowH);
    const allPastCoords: [number, number][] = pastPoints.map(p => [p.lon, p.lat]);
    if (allPastCoords.length === 0 || allPastCoords[allPastCoords.length - 1][0] !== here.lon || allPastCoords[allPastCoords.length - 1][1] !== here.lat) {
      allPastCoords.push([here.lon, here.lat]);
    }

    // 2. Past Track Line (From where it formed/moved in past up to now)
    if (allPastCoords.length >= 2) {
      features.push({
        type: 'Feature',
        properties: {
          kind: 'past-line',
          storm: s.id,
          color: cls.color || '#f59e0b',
        },
        geometry: {
          type: 'LineString',
          coordinates: allPastCoords,
        },
      });
    }

    // 3. Historical Position Fixes along the past track
    for (const p of pastPoints) {
      const pCls = windClass(p.wind);
      const timeStr = start !== null ? new Date(start + p.h * 3_600_000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : `+${p.h}h`;
      const kmhStr = p.wind ? `${Math.round(p.wind * 3.6)} km/h` : '';
      features.push({
        type: 'Feature',
        properties: {
          kind: 'past-fix',
          storm: s.id,
          h: p.h,
          color: pCls.color,
          label: `${timeStr}${kmhStr ? ' · ' + kmhStr : ''}`,
        },
        geometry: {
          type: 'Point',
          coordinates: [p.lon, p.lat],
        },
      });
    }

    // 4. Motion Vector Arrow (Direction & speed of movement)
    if (motion && motion.speedKmh > 0) {
      const radHeading = (motion.bearingDeg * Math.PI) / 180;
      const arrowLenDeg = 0.95;
      const arrowEndLon = here.lon + (arrowLenDeg * Math.sin(radHeading)) / Math.cos((here.lat * Math.PI) / 180);
      const arrowEndLat = here.lat + arrowLenDeg * Math.cos(radHeading);

      features.push({
        type: 'Feature',
        properties: {
          kind: 'motion-arrow',
          storm: s.id,
          bearing: motion.bearingDeg,
          speedKmh: motion.speedKmh,
          dirText: motion.dirText,
          label: `Moving ${motion.dirText} (${motion.bearingDeg}°) @ ${motion.speedKmh} km/h`,
        },
        geometry: {
          type: 'LineString',
          coordinates: [[here.lon, here.lat], [arrowEndLon, arrowEndLat]],
        },
      });
    }

    // 5. Realtime Eye Position
    const kmh = here.wind !== null ? `${Math.round(here.wind * 3.6)} km/h` : '';
    const pMsl = here.pMsl !== null ? `${Math.round(here.pMsl)} hPa` : '';
    const motionLabel = motion ? `Moving ${motion.dirText} @ ${motion.speedKmh} km/h` : '';
    const stormTitle = s.name && s.name !== s.id ? `${s.name} (${s.id})` : s.id;

    features.push({
      type: 'Feature',
      properties: {
        kind: 'realtime-eye',
        storm: s.id,
        color: cls.color || '#ef4444',
        name: stormTitle,
        label: `${stormTitle}\n${cls.name}${kmh ? ' · ' + kmh : ''}${pMsl ? ' · ' + pMsl : ''}\n${motionLabel}`,
      },
      geometry: {
        type: 'Point',
        coordinates: [here.lon, here.lat],
      },
    });
  }

  return { type: 'FeatureCollection', features };
}

/** Synchronize cyclone past track, realtime position, and direction vector directly in the AMV map layer */
export function syncAmvCycloneTrack(
  map: MapLibreMap,
  cycloneData: CycloneData | null,
  timeMs: number | null,
  visible: boolean
): void {
  if (!map) return;

  const existingSource = map.getSource(AMV_CYCLONE_SOURCE_ID) as GeoJSONSource | undefined;
  const emptyGeoJson = { type: 'FeatureCollection', features: [] };
  const data = (visible && cycloneData) ? buildAmvCycloneGeoJson(cycloneData, timeMs) : emptyGeoJson;

  if (existingSource) {
    existingSource.setData(data as any);
  } else {
    map.addSource(AMV_CYCLONE_SOURCE_ID, {
      type: 'geojson',
      data: data as any,
    });
  }

  if (!map.getLayer(AMV_CYCLONE_CASING_LAYER_ID)) {
    // 1. Casing for past track line
    map.addLayer({
      id: AMV_CYCLONE_CASING_LAYER_ID,
      type: 'line',
      source: AMV_CYCLONE_SOURCE_ID,
      filter: ['==', ['get', 'kind'], 'past-line'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#0f172a', 'line-width': 7.5, 'line-opacity': 0.88 },
    });

    // 2. Past track line (where it moved from in the past)
    map.addLayer({
      id: AMV_CYCLONE_LINE_LAYER_ID,
      type: 'line',
      source: AMV_CYCLONE_SOURCE_ID,
      filter: ['==', ['get', 'kind'], 'past-line'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 4.0, 'line-opacity': 0.98 },
    });

    // 3. Motion vector line (direction of movement)
    map.addLayer({
      id: AMV_CYCLONE_MOTION_LAYER_ID,
      type: 'line',
      source: AMV_CYCLONE_SOURCE_ID,
      filter: ['==', ['get', 'kind'], 'motion-arrow'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#38bdf8', 'line-width': 4.5, 'line-dasharray': [2, 1], 'line-opacity': 0.95 },
    });

    // 4. Past position fix circles
    map.addLayer({
      id: AMV_CYCLONE_POINTS_LAYER_ID,
      type: 'circle',
      source: AMV_CYCLONE_SOURCE_ID,
      filter: ['==', ['get', 'kind'], 'past-fix'],
      paint: {
        'circle-radius': 5.0,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.8,
        'circle-opacity': 0.95,
      },
    });

    // 5. Realtime eye halo/pulse
    map.addLayer({
      id: AMV_CYCLONE_EYE_PULSE_LAYER_ID,
      type: 'circle',
      source: AMV_CYCLONE_SOURCE_ID,
      filter: ['==', ['get', 'kind'], 'realtime-eye'],
      paint: {
        'circle-radius': 14.0,
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.35,
      },
    });

    // 6. Realtime eye center circle
    map.addLayer({
      id: AMV_CYCLONE_EYE_LAYER_ID,
      type: 'circle',
      source: AMV_CYCLONE_SOURCE_ID,
      filter: ['==', ['get', 'kind'], 'realtime-eye'],
      paint: {
        'circle-radius': 8.0,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2.5,
        'circle-opacity': 1.0,
      },
    });

    // 7. Labels for eye and motion
    map.addLayer({
      id: AMV_CYCLONE_LABELS_LAYER_ID,
      type: 'symbol',
      source: AMV_CYCLONE_SOURCE_ID,
      filter: ['all', ['has', 'label'], ['!=', ['get', 'label'], '']],
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-size': ['case', ['==', ['get', 'kind'], 'realtime-eye'], 12.0, 10.0],
        'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
        'text-radial-offset': 1.2,
        'text-justify': 'auto',
        'text-line-height': 1.2,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': '#0f172a',
        'text-halo-width': 2.5,
      },
    });
  }

  const visibility = visible ? 'visible' : 'none';
  for (const id of ALL_AMV_CYCLONE_LAYERS) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visibility);
    }
  }

  if (visible) {
    ensureAmvOnTop(map);
  }
}

