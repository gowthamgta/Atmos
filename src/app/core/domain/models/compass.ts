/** 16-point compass name for a bearing in degrees (0 = north, 90 = east). */
export function degToCompass(deg: number): string {
  const val = Math.round(deg / 22.5);
  const arr = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return arr[((val % 16) + 16) % 16];
}
