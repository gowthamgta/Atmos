import type { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import type { AmvGeoJson, AmvVectorProperties, AmvStyle } from '../satellite/amv.service';

export const AMV_SOURCE_ID = 'amv-vectors-source';
export const AMV_SYMBOLS_LAYER_ID = 'amv-vectors-symbols';

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
  if (map && map.getLayer(AMV_SYMBOLS_LAYER_ID)) {
    try {
      map.moveLayer(AMV_SYMBOLS_LAYER_ID);
    } catch {
      // ignore if context not ready
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

  // Speed-based color scale:
  // <10 kt: Soft cyan (#38bdf8)
  // 10-20 kt: Soft green (#4ade80)
  // 20-30 kt: Warm amber (#fbbf24)
  // 30-40 kt: Soft orange (#fb923c)
  // >=40 kt: Coral red (#f87171)
  const arrowSpeedColorExpr: any = [
    'step',
    speedKtExpr,
    '#38bdf8',       // < 10 kt: Soft cyan
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
