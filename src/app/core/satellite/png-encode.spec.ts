import { describe, expect, it } from 'vitest';
import { pngBytes } from './png-encode';

describe('pngBytes', () => {
  it('writes a valid PNG header and chunks for an RGBA picture', async () => {
    const pixels = new Uint8ClampedArray([255, 0, 0, 255, 10, 20, 30, 3, 0, 0, 0, 0, 1, 2, 3, 4]);
    const bytes = await pngBytes(pixels, 2, 2);
    expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const text = String.fromCharCode(...bytes);
    expect(text).toContain('IHDR');
    expect(text).toContain('IDAT');
    expect(text.endsWith('IEND\xae\x42\x60\x82')).toBe(true);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(16)).toBe(2); // width
    expect(view.getUint32(20)).toBe(2); // height
    expect(bytes[25]).toBe(6); // RGBA
  });
});
