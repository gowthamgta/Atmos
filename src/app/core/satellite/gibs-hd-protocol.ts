import * as maplibregl from 'maplibre-gl';
import { GIBS_PROTOCOL, GIBS_TILE_SIZE, blackToTransparent, gibsTileUrl, parseGibsUrl } from './gibs-hd';

let registered = false;

/**
 * Teaches MapLibre the `gibs-hd://` address: it fetches the real GIBS tile, makes its black no-data pixels see-through
 * and hands the map a PNG. Registered once for the whole page.
 */
export function registerGibsProtocol(): void {
  if (registered) return;
  registered = true;
  maplibregl.addProtocol(GIBS_PROTOCOL, async (params, abortController) => {
    const tile = parseGibsUrl(params.url);
    if (!tile) throw new Error(`bad GIBS tile address ${params.url}`);
    const res = await fetch(gibsTileUrl(tile.layer, tile.date, tile.z, tile.x, tile.y), { signal: abortController.signal });
    if (!res.ok) throw new Error(`GIBS tile ${res.status}`);
    const bitmap = await createImageBitmap(await res.blob());
    const canvas = new OffscreenCanvas(GIBS_TILE_SIZE, GIBS_TILE_SIZE);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, GIBS_TILE_SIZE, GIBS_TILE_SIZE);
    bitmap.close();
    const image = ctx.getImageData(0, 0, GIBS_TILE_SIZE, GIBS_TILE_SIZE);
    blackToTransparent(image.data);
    ctx.putImageData(image, 0, 0);
    return { data: await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer() };
  });
}
