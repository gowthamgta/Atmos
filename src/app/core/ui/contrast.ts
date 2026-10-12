/**
 * WCAG contrast of colours, used by the tests that keep the interface readable (the tokens of styles.css, the numbers on the colour bar).
 * Colours are "#rgb", "#rrggbb", "#rrggbbaa" or "rgb(a)(r, g, b, a)".
 */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Reads a CSS colour (null when it is not one of the forms above). */
export function parseColor(text: string): Rgba | null {
  const t = text.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(t);
  if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), a: 1 };
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(t);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  }
  const f = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(t);
  if (f) return { r: +f[1], g: +f[2], b: +f[3], a: f[4] === undefined ? 1 : +f[4] };
  return null;
}

/** A colour laid over an opaque one: what the eye gets. */
export function over(top: Rgba, under: Rgba): Rgba {
  const a = top.a;
  return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
}

/** Relative luminance (WCAG 2). */
export function luminance(c: Rgba): number {
  const f = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

/** The contrast ratio of two opaque colours, from 1 to 21. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
