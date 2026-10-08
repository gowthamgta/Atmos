/**
 * What the device can take. Phones (and other small touch screens) get lighter settings by default: fewer texture reads
 * per pixel in the forecast shader, smaller satellite and radar images. Everything stays switchable by the user where it
 * changes the look (the terrain relief switch in the layer menu).
 */
export function isPhone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < 700 || ('ontouchstart' in window && window.innerWidth < 900);
}

/**
 * Satellite picture size to request (pixels) for the India box (29.5 by 29.5 degrees, square): about 1.6 km per pixel on
 * desktop, about 3 km on a phone.
 */
export function satelliteImageSize(phone: boolean): { width: number; height: number } {
  return phone ? { width: 1000, height: 1000 } : { width: 2000, height: 2000 };
}

/** Largest side of the radar mosaic (pixels): 0.5 km per pixel on desktop; about 0.6 km on a phone. */
export function radarMosaicMaxPx(phone: boolean): number {
  return phone ? 2300 : 2800;
}

/** Screen pixel ratio cap: phones draw at up to 2x (the forecast shading is light enough there), desktops at native. */
export function maxPixelRatio(phone: boolean, deviceRatio: number): number {
  return phone ? Math.min(deviceRatio, 2) : deviceRatio;
}
