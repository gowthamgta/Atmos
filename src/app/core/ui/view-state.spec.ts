import { describe, expect, it } from 'vitest';
import { formatViewState, parseViewState } from './view-state';

describe('view state in the address', () => {
  it('writes and reads a whole view', () => {
    const view = {
      layer: 'rain', model: 'gfs', level: '850',
      place: { lat: 11.7412, lon: 78.9601, name: 'Kallakurichi' },
      camera: { lat: 11.74, lon: 78.96, zoom: 6.2 },
      overlays: ['particles', 'cyclones'],
    };
    const hash = formatViewState(view);
    expect(hash).toBe('l=rain&m=gfs&lv=850&p=11.7412,78.9601&n=Kallakurichi&c=11.74,78.96,6.2&o=particles,cyclones');
    expect(parseViewState('#' + hash)).toEqual(view);
  });

  it('reads an address with only some of the parts', () => {
    expect(parseViewState('l=wind')).toEqual({ layer: 'wind' });
    expect(parseViewState('')).toEqual({});
    expect(parseViewState('#c=8.5,77.5,9')).toEqual({ camera: { lat: 8.5, lon: 77.5, zoom: 9 } });
  });

  it('reads overlays separated by a comma, a space or a plus (a copied link often loses its commas)', () => {
    expect(parseViewState('o=relief,districts').overlays).toEqual(['relief', 'districts']);
    expect(parseViewState('o=relief districts').overlays).toEqual(['relief', 'districts']);
    expect(parseViewState('o=relief+districts').overlays).toEqual(['relief', 'districts']);
  });

  it('keeps an empty overlay list (all off) apart from no list (the defaults)', () => {
    expect(parseViewState('o=')).toEqual({ overlays: [] });
    expect(parseViewState('l=wind').overlays).toBeUndefined();
    expect(formatViewState({ overlays: [] })).toBe('o=');
  });

  it('ignores anything that does not fit: odd ids, positions off the globe, unknown levels and overlays', () => {
    expect(parseViewState('l=<script>&m=a b&lv=12345')).toEqual({});
    expect(parseViewState('p=95,10')).toEqual({});                              // no such latitude
    expect(parseViewState('p=abc,10')).toEqual({});
    expect(parseViewState('c=11,78,99')).toEqual({});                           // not a zoom
    expect(parseViewState('c=11,78')).toEqual({});                              // no zoom at all
    expect(parseViewState('o=particles,hack,cyclones')).toEqual({ overlays: ['particles', 'cyclones'] });
  });

  it('shortens a very long place name', () => {
    expect(parseViewState(`p=10,78&n=${'x'.repeat(200)}`).place!.name).toHaveLength(60);
  });
});
