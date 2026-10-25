import { describe, it, expect, vi } from 'vitest';
import {
  RADAR_COMPOSITE_LAYER_ID,
  RADAR_COMPOSITE_SOURCE_ID,
  syncRadarCompositeLayer,
  RadarCompositeOverlay,
} from './radar-composite-overlay';

describe('syncRadarCompositeLayer', () => {
  const overlay: RadarCompositeOverlay = {
    url: 'https://gowthamgta.github.io/atmos-radar/india-composite.png',
    coordinates: [
      [67.0, 37.5],
      [98.0, 37.5],
      [98.0, 6.0],
      [67.0, 6.0],
    ],
  };

  it('adds image source and raster layer when visible', () => {
    const layers = new Map<string, any>([['anchor-layer', {}]]);
    const sources = new Map<string, any>();

    const mapMock = {
      getLayer: vi.fn((id: string) => layers.get(id)),
      getSource: vi.fn((id: string) => sources.get(id)),
      addSource: vi.fn((id: string, def: any) => sources.set(id, def)),
      addLayer: vi.fn((def: any) => layers.set(def.id, def)),
      removeLayer: vi.fn((id: string) => layers.delete(id)),
      removeSource: vi.fn((id: string) => sources.delete(id)),
      setPaintProperty: vi.fn(),
    } as any;

    syncRadarCompositeLayer(mapMock, overlay, true, 0.8, 'anchor-layer');

    expect(mapMock.addSource).toHaveBeenCalledWith(
      RADAR_COMPOSITE_SOURCE_ID,
      expect.objectContaining({ type: 'image', url: overlay.url, coordinates: overlay.coordinates })
    );
    expect(mapMock.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({ id: RADAR_COMPOSITE_LAYER_ID, type: 'raster' }),
      'anchor-layer'
    );
  });

  it('removes layer and source when hidden', () => {
    const layers = new Map<string, any>([[RADAR_COMPOSITE_LAYER_ID, {}]]);
    const sources = new Map<string, any>([[RADAR_COMPOSITE_SOURCE_ID, {}]]);

    const mapMock = {
      getLayer: vi.fn((id: string) => layers.get(id)),
      getSource: vi.fn((id: string) => sources.get(id)),
      addSource: vi.fn(),
      addLayer: vi.fn(),
      removeLayer: vi.fn((id: string) => layers.delete(id)),
      removeSource: vi.fn((id: string) => sources.delete(id)),
      setPaintProperty: vi.fn(),
    } as any;

    syncRadarCompositeLayer(mapMock, overlay, false, 1.0, undefined);

    expect(mapMock.removeLayer).toHaveBeenCalledWith(RADAR_COMPOSITE_LAYER_ID);
    expect(mapMock.removeSource).toHaveBeenCalledWith(RADAR_COMPOSITE_SOURCE_ID);
  });
});
