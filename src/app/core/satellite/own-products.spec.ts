import { describe, expect, it } from 'vitest';
import { autoKind, OWN_SATELLITES } from './own-products';
import { cloudTopColor, greyScaleTempFromMeasured, windyInfraredTable } from './satellite-image';

describe('our own satellite pictures', () => {
  it('shows infrared at night and our own RGB by day, on both satellites', () => {
    expect(autoKind('msg', false)).toBe('infrared');
    expect(autoKind('h9', false)).toBe('infrared');
    expect(autoKind('msg', true)).toBe('natural');
    expect(autoKind('h9', true)).toBe('truecolor');
    for (const sat of ['msg', 'h9'] as const) {
      expect(OWN_SATELLITES[sat].kinds).toContain(autoKind(sat, true));
      expect(OWN_SATELLITES[sat].kinds).toContain('infrared');
    }
  });

  it('puts measured temperatures on the grey-level scale the Windy colours were matched on', () => {
    expect(greyScaleTempFromMeasured(-64.1)).toBeCloseTo(-80, 5);
    expect(greyScaleTempFromMeasured(-32.1)).toBeCloseTo(-50, 5);
    expect(greyScaleTempFromMeasured(19.9)).toBeCloseTo(20, 5);
    // monotone, and colder than measured on the cold side (the grey scale read cold tops too cold)
    let last = Infinity;
    for (let t = 30; t >= -90; t -= 1) {
      const g = greyScaleTempFromMeasured(t);
      expect(g).toBeLessThan(last);
      last = g;
    }
    expect(greyScaleTempFromMeasured(-50)).toBeLessThan(-60);
  });

  it('makes the infrared table from the Windy colours', () => {
    const lut = windyInfraredTable(180, 140, 256);
    for (const i of [0, 40, 120, 200, 255]) {
      const tempC = 180 + (i / 255) * 140 - 273.15;
      expect(Array.from(lut.slice(i * 4, i * 4 + 4))).toEqual(cloudTopColor(greyScaleTempFromMeasured(tempC)));
    }
    expect(lut.length).toBe(1024);
  });
});
