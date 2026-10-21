import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio, over, parseColor } from './contrast';

const WHITE = parseColor('#ffffff')!;
const BLACK = parseColor('#000000')!;

describe('contrast arithmetic', () => {
  it('reads the colour forms of the style sheet', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#cf8a00')).toEqual({ r: 207, g: 138, b: 0, a: 1 });
    expect(parseColor('rgba(48, 50, 54, 0.93)')).toEqual({ r: 48, g: 50, b: 54, a: 0.93 });
    expect(parseColor('rgb(1,2,3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseColor('#ffffff80')!.a).toBeCloseTo(0.5, 2);
    expect(parseColor('var(--x)')).toBeNull();
  });

  it('gives the known ratios', () => {
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 5);
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 5);
    // white on amber, the case that made the labels on amber dark
    expect(contrastRatio(WHITE, parseColor('#cf8a00')!)).toBeLessThan(3.2);
  });

  it('lays a see-through colour over another', () => {
    expect(over({ r: 255, g: 255, b: 255, a: 0.5 }, BLACK)).toEqual({ r: 127.5, g: 127.5, b: 127.5, a: 1 });
  });
});

/** The custom properties of one block of styles.css (":root" or ":root[data-theme='light']"), by name. */
function tokens(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} in styles.css`);
  const end = css.indexOf('\n}', start);
  const out: Record<string, string> = {};
  for (const m of css.slice(start, end).matchAll(/(--[a-z0-9_-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const CSS = readFileSync('src/styles.css', 'utf-8').replace(/\r\n/g, '\n');
const DARK = tokens(CSS, ':root');
const LIGHT = { ...DARK, ...tokens(CSS, ":root[data-theme='light']") };

/** What a token looks like on a solid panel of the theme (a see-through colour is laid over it). */
function onPanel(theme: Record<string, string>, token: string, panel: string): ReturnType<typeof over> {
  const back = parseColor(theme[panel])!;
  const color = parseColor(theme[token]);
  if (!color) throw new Error(`${token} is ${theme[token]}, not a colour`);
  return over(color, over(back, parseColor(theme['--surface-0'])!));
}

describe.each([
  ['dark', DARK],
  ['light', LIGHT],
])('the %s theme is readable', (_name, theme) => {
  const panels = ['--surface-solid', '--surface-1'] as const;

  it('keeps text at 4.5:1 or better on every panel (WCAG AA)', () => {
    for (const panel of panels) {
      const back = over(parseColor(theme[panel])!, parseColor(theme['--surface-0'])!);
      for (const token of ['--text-primary', '--text-secondary', '--text-muted', '--accent-strong', '--warn', '--danger', '--ok']) {
        const ratio = contrastRatio(onPanel(theme, token, panel), back);
        expect(ratio, `${token} on ${panel}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps the dark text on amber, the label of every chosen thing, at 4.5:1', () => {
    expect(contrastRatio(onPanel(theme, '--on-accent', '--accent'), over(parseColor(theme['--accent'])!, parseColor(theme['--surface-0'])!))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the colour of each model and each chart line at 3:1 on a panel (WCAG non-text contrast)', () => {
    const back = over(parseColor(theme['--surface-solid'])!, parseColor(theme['--surface-0'])!);
    for (const token of ['--m-ecmwf_ifs', '--m-aifs', '--m-ukmo', '--m-gfs', '--m-aigfs', '--m-blend', '--m-icon', '--s-temp', '--s-rain', '--s-wind', '--s-pressure']) {
      expect(contrastRatio(onPanel(theme, token, '--surface-solid'), back), token).toBeGreaterThanOrEqual(3);
    }
  });

  it('tells the models apart: no two of them share a colour', () => {
    const colours = ['--m-ecmwf_ifs', '--m-aifs', '--m-ukmo', '--m-gfs', '--m-aigfs', '--m-blend', '--m-icon'].map(t => theme[t]);
    expect(new Set(colours).size).toBe(colours.length);
  });
});

describe('the type scale', () => {
  it('has no size below 11 px, and keeps controls at 36 px with a mouse and 44 px on a touch screen', () => {
    for (const token of ['--fs-xs', '--fs-s', '--fs-m', '--fs-l', '--fs-xl', '--fs-2xl']) {
      expect(parseFloat(DARK[token]), token).toBeGreaterThanOrEqual(11);
    }
    expect(DARK['--hit']).toBe('36px');
    expect(CSS).toMatch(/@media \(pointer: coarse\) \{\s*:root \{\s*--hit: 44px;/);
  });

  it('steps up: each size is larger than the one before it', () => {
    const sizes = ['--fs-xs', '--fs-s', '--fs-m', '--fs-l', '--fs-xl', '--fs-2xl'].map(t => parseFloat(DARK[t]));
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
  });
});

describe('the component styles keep to the type scale', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(`${dir}/${e.name}`) : e.name.endsWith('.ts') || e.name.endsWith('.css') ? [`${dir}/${e.name}`] : []));

  it('sets no text below 11 px (the ▲ that marks a value moved to the 90 m terrain is a symbol, not text)', () => {
    const small: string[] = [];
    for (const file of files('src/app')) {
      if (file.endsWith('.spec.ts')) continue;
      readFileSync(file, 'utf-8').split(/\r?\n/).forEach((line, i) => {
        for (const m of line.matchAll(/font-size:\s*([\d.]+)px/g)) {
          if (parseFloat(m[1]) < 11 && !line.includes('.adj')) small.push(`${file}:${i + 1} ${m[0]}`);
        }
      });
    }
    expect(small).toEqual([]);
  });
});
