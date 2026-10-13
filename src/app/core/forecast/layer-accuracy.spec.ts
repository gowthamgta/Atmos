import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio, over, parseColor } from '../ui/contrast';
import { FORECAST_LAYERS, PRESSURE_LEVELS, buildPaletteLut, legendPosition, resolveLayer } from './forecast-layers';
import { LAYER_NOTES, layerFacts } from './layer-notes';

/**
 * Checks every layer against what the pipeline publishes: the variable is there, in the unit the legend says (after the display scale), its
 * colours cover only values the picture can hold (the pictures are 16 bit and clip at the ends of their range: pipeline/config.py), its palette
 * is valid, and the numbers on the colour bar can be read on every colour. Layers that are drawn aloft are checked at every level.
 */

interface Encoding {
  unit: string;
  lo: number;
  hi: number;
}

/** The variables of pipeline/config.py with their unit and the range they are encoded over, read from the source so there is one list. */
function pipelineVars(): Record<string, Encoding> {
  const src = readFileSync('pipeline/config.py', 'utf-8').replace(/\r\n/g, '\n');
  const out: Record<string, Encoding> = {};
  for (const m of src.matchAll(/Var\("([a-z0-9_]+)",\s*"([^"]*)",\s*(-?[\d.]+),\s*(-?[\d.]+)/g)) out[m[1]] = { unit: m[2], lo: +m[3], hi: +m[4] };
  // the pressure levels: the same variables at each level, some with a range of their own for each
  const table = (name: string): Record<number, [number, number]> => {
    const block = new RegExp(`${name} = \\{([^}]*)\\}`).exec(src)?.[1] ?? '';
    return Object.fromEntries([...block.matchAll(/(\d+): \((-?\d+), (-?\d+)\)/g)].map(m => [+m[1], [+m[2], +m[3]] as [number, number]]));
  };
  const temp = table('_LEVEL_T');
  const height = table('_LEVEL_GH');
  for (const level of PRESSURE_LEVELS) {
    out[`t${level}`] = { unit: '°C', lo: temp[level][0], hi: temp[level][1] };
    out[`gh${level}`] = { unit: 'm', lo: height[level][0], hi: height[level][1] };
    for (const m of src.matchAll(/Var\(f"([a-z]+)\{lvl\}",\s*"([^"]*)",\s*(-?\d+),\s*(-?\d+)/g)) out[`${m[1]}${level}`] = { unit: m[2], lo: +m[3], hi: +m[4] };
  }
  return out;
}

const PIPELINE = pipelineVars();
const LEGEND_SOURCE = readFileSync('src/app/features/forecast/forecast-legend.component.ts', 'utf-8');

/** Whether a legend unit is the field's own unit after the layer's display scale. */
function unitAgrees(fieldUnit: string, layerUnit: string, scale: number): boolean {
  switch (fieldUnit) {
    case 'm/s': return (scale === 3.6 && layerUnit === 'km/h') || (scale === 100 && layerUnit.startsWith('cm/s')) || (scale === 1 && layerUnit === 'm/s');
    case 'mm': return scale === 1 && layerUnit.startsWith('mm');          // mm, mm/h (the rain rate is published as mm per hour), mm in the chosen period
    case 'level': return layerUnit.startsWith('IMD');                      // the IMD rain category
    default: return scale === 1 && layerUnit.startsWith(fieldUnit);
  }
}

/** Every layer as it can be drawn: at the ground, and at each level it supports. */
const SHOWN = FORECAST_LAYERS.flatMap(layer => [
  { layer, level: 'surface' as const, shown: layer },
  ...(layer.atLevel ? PRESSURE_LEVELS.map(level => ({ layer, level, shown: resolveLayer(layer, level) })) : []),
]);

describe('the pipeline list that these checks read', () => {
  it('has the variables, including every level', () => {
    expect(PIPELINE['t2m']).toEqual({ unit: '°C', lo: -10, hi: 50 });
    expect(PIPELINE['u10']).toEqual({ unit: 'm/s', lo: -60, hi: 60 });
    expect(PIPELINE['t500']).toEqual({ unit: '°C', lo: -28, hi: 2 });
    expect(PIPELINE['gh850']).toEqual({ unit: 'm', lo: 1100, hi: 1800 });
    expect(PIPELINE['vo850'].unit).toContain('s');
    expect(Object.keys(PIPELINE).length).toBeGreaterThan(70);
  });
});

describe.each(SHOWN.map(s => [`${s.layer.id} at ${s.level}`, s] as const))('layer %s', (_name, { layer, level, shown }) => {
  const field = PIPELINE[shown.varId];
  const scale = shown.displayScale ?? 1;

  it('reads a variable the pipeline publishes', () => {
    expect(field, shown.varId).toBeDefined();
    if (shown.varId2) expect(PIPELINE[shown.varId2], shown.varId2).toBeDefined();
  });

  it('says its unit as the field has it, after the display scale', () => {
    expect(unitAgrees(field.unit, shown.unit, scale), `${shown.varId} is ${field.unit}; the legend says ${shown.unit} (x${scale})`).toBe(true);
  });

  it('colours only values the picture can hold, so nothing is clipped before it is drawn', () => {
    if (shown.varId2) {
      // a speed from two components: it can reach as far as the components can
      const reach = Math.hypot(Math.abs(field.hi), Math.abs(PIPELINE[shown.varId2].hi));
      expect(shown.max).toBeLessThanOrEqual(reach);
    } else {
      expect(shown.min).toBeGreaterThanOrEqual(field.lo);
      expect(shown.max).toBeLessThanOrEqual(field.hi);
    }
  });

  it('has ticks in the displayed unit that rise and stay on the scale', () => {
    const ticks = shown.ticks;
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
    for (const t of ticks) {
      expect(t / scale).toBeGreaterThanOrEqual(shown.min - 1e-9);
      expect(t / scale).toBeLessThanOrEqual(shown.max + 1e-9);
    }
  });

  it('has a valid palette, a positive gamma, and a transparency threshold inside the scale', () => {
    expect(shown.stops.length).toBeGreaterThanOrEqual(2);
    for (const stop of shown.stops) expect(parseColor(stop), stop).not.toBeNull();
    expect(shown.gamma).toBeGreaterThan(0);
    expect(shown.clearBelow === 0 || shown.clearBelow < shown.max).toBe(true);   // 0 means never transparent
    expect(shown.opacity).toBeGreaterThan(0);
    expect(shown.opacity).toBeLessThanOrEqual(1);
  });

  it('keeps the numbers on the colour bar readable: white on the dark chip behind each, over the colour under it (4.5:1)', () => {
    const lut = buildPaletteLut(shown.stops);
    const chip = parseColor(/--tick-bg:\s*(rgba\([^)]*\))/.exec(LEGEND_SOURCE)![1])!;   // the chip the legend really draws
    const white = parseColor('#ffffff')!;
    for (const tick of shown.ticks) {
      const i = Math.round(legendPosition(shown, tick) * 255);
      const under = { r: lut[i * 4], g: lut[i * 4 + 1], b: lut[i * 4 + 2], a: 1 };
      expect(contrastRatio(white, over(chip, under)), `${shown.label} at ${tick}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('is explained: what it is, how it relates to the time, and where it is left out', () => {
    expect(LAYER_NOTES[layer.id], layer.id).toBeDefined();
    const facts = layerFacts(layer, shown, level);
    for (const text of [facts.what, facts.scale, facts.time, facts.gaps, facts.ground]) expect(text.length).toBeGreaterThan(10);
    expect(facts.scale).toContain(shown.unit.startsWith('mm') ? 'mm' : shown.unit);
  });
});

describe('what each layer says about time', () => {
  const note = (id: string) => LAYER_NOTES[id];

  it('tells apart a value at the time, a rate over the hour before it, and a total over the next 24 hours', () => {
    expect(note('temp').time).toContain('at the time on the bar');
    expect(note('rain').what).toContain('interval before the time on the bar');
    for (const id of ['rain24', 'tmin24', 'tmax24', 'extreme']) expect(note(id).time).toContain('24 hours that START at the time');
    expect(note('raintot').what).toContain('period chosen on the time bar');
  });

  it('says that a day the run does not reach is left out, never shown as a part', () => {
    for (const id of ['rain24', 'tmin24', 'tmax24', 'extreme']) expect(note(id).gaps).toContain('run ends before');
  });

  it('describes the rain of the layer as the model reports it, in mm per hour', () => {
    const facts = layerFacts(FORECAST_LAYERS.find(l => l.id === 'rain')!, FORECAST_LAYERS.find(l => l.id === 'rain')!, 'surface');
    expect(facts.scale).toMatch(/mm\/h|mm/);
    expect(facts.ground).toContain('slopes');
  });
});
