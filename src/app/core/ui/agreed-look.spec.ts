import { describe, it, expect } from 'vitest';
import { cloudTopColor, shadePixel } from '../satellite/satellite-image';
import { sampleRadarColorRamp } from '../services/radar-field';

/**
 * Fingerprints of the looks the user has agreed (see DESIGN-DECISIONS.md at the repository root): the visible satellite colours, the
 * infrared cloud-top colours and the radar colours. A change to any of them fails here on purpose. Change a look only when the user asks
 * for it (with a screenshot of what they want), then update DESIGN-DECISIONS.md and the fingerprint together.
 */
function fnv(values: Iterable<number>): string {
  let h = 0x811c9dc5;
  for (const v of values) {
    h ^= Math.round(v) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function* visibleSamples(): Generator<number> {
  const out = new Uint8ClampedArray(4);
  for (let r = 0; r <= 255; r += 15) {
    for (let g = 0; g <= 255; g += 15) {
      for (let b = 0; b <= 255; b += 51) {
        for (const background of [40, 90]) {
          shadePixel('hrv', r, g, b, background, out, 0);
          yield* out;
        }
      }
    }
  }
}

function* infraredSamples(): Generator<number> {
  for (let t = 40; t >= -95; t -= 1) yield* cloudTopColor(t);
}

function* radarSamples(): Generator<number> {
  for (let v = 0; v <= 6.0001; v += 0.05) yield* sampleRadarColorRamp(v).map((c, i) => (i === 3 && c <= 1 ? c * 255 : c));
}

describe('the agreed looks (DESIGN-DECISIONS.md)', () => {
  const why = 'this look was agreed with the user: change it only on their request, and update DESIGN-DECISIONS.md and this fingerprint together';

  it('keeps the visible satellite colours of 17 Oct (HRV with the Windy exposure ramps)', () => {
    expect(fnv(visibleSamples()), why).toBe('1a1b7b34');
  });

  it('keeps the infrared cloud-top colours', () => {
    expect(fnv(infraredSamples()), why).toBe('c67da769');
  });

  it('keeps the radar colours', () => {
    expect(fnv(radarSamples()), why).toBe('dc404f80');
  });
});
