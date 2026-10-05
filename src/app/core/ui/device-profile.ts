/**
 * What the device can take. Phones (and other small touch screens) get lighter settings by default: fewer texture reads
 * per pixel in the forecast shader, smaller satellite and radar images. Everything stays switchable by the user where it
 * changes the look (the "1 km detail" switch in the layer menu).
 */
export function isPhone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < 700 || ('ontouchstart' in window && window.innerWidth < 900);
}

/** Satellite picture size to request (pixels): about 2 km per pixel on a phone, 1 km elsewhere. */
export function satelliteImageSize(phone: boolean): { width: number; height: number } {
  return phone ? { width: 1100, height: 900 } : { width: 2200, height: 1800 };
}

/** Largest side of the radar mosaic (pixels): 0.5 km per pixel on desktop; about 0.8 km on a phone. */
export function radarMosaicMaxPx(phone: boolean): number {
  return phone ? 1700 : 2800;
}
