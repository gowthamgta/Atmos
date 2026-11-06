import { describe, it, expect } from 'vitest';
import { layerMeaning, layerGuide, layerSubtitle } from './layer-meaning';

describe('layer-meaning', () => {
  it('gives meaningful subtitles for forecast layers', () => {
    expect(layerSubtitle('vertical')).toBe('Updrafts (rain) vs downdrafts (clear)');
    expect(layerSubtitle('vorticity')).toBe('Atmospheric spin & storm centers');
    expect(layerSubtitle('cape')).toBe('Thunderstorm potential energy');
    expect(layerSubtitle('unknown')).toBeNull();
  });

  it('provides guides with low and high indicators', () => {
    const vg = layerGuide('vertical');
    expect(vg).not.toBeNull();
    expect(vg?.high).toContain('Rising air');
    expect(vg?.low).toContain('Sinking air');

    const cg = layerGuide('cape');
    expect(cg?.high).toContain('Severe storms');
    expect(cg?.low).toContain('Stable');
  });

  it('interprets vertical velocity correctly', () => {
    expect(layerMeaning('vertical', 20)).toBe('Strong updraft · storm growth');
    expect(layerMeaning('vertical', 5)).toBe('Rising air · cloudy / rain favored');
    expect(layerMeaning('vertical', 0)).toBe('Calm vertical air');
    expect(layerMeaning('vertical', -8)).toBe('Sinking air · dry & clearing');
    expect(layerMeaning('vertical', -25)).toBe('Strong downdraft · sinking air');
  });

  it('interprets vorticity correctly', () => {
    expect(layerMeaning('vorticity', 20)).toBe('Intense cyclonic vortex · storm');
    expect(layerMeaning('vorticity', 8)).toBe('Cyclonic spin · low pressure');
    expect(layerMeaning('vorticity', 0)).toBe('Neutral flow');
    expect(layerMeaning('vorticity', -10)).toBe('Anticyclonic flow · fair ridge');
    expect(layerMeaning('vorticity', -20)).toBe('Strong high-pressure ridge');
  });

  it('interprets divergence correctly', () => {
    expect(layerMeaning('divergence', 10)).toBe('Strong divergence · storm exhaust');
    expect(layerMeaning('divergence', 4)).toBe('Divergence · air spreading aloft');
    expect(layerMeaning('divergence', 2)).toBe('Divergence · air spreading aloft');
    expect(layerMeaning('divergence', 0)).toBe('Neutral horizontal flow');
    expect(layerMeaning('divergence', 1.0)).toBe('Neutral horizontal flow');
    expect(layerMeaning('divergence', -1.0)).toBe('Neutral horizontal flow');
    expect(layerMeaning('divergence', -2)).toBe('Convergence · air gathering');
    expect(layerMeaning('divergence', -5)).toBe('Convergence · air gathering');
    expect(layerMeaning('divergence', -12)).toBe('Strong convergence · low-level inflow');
  });

  it('interprets CAPE and extreme rain probability correctly', () => {
    expect(layerMeaning('cape', 2800)).toBe('Extreme energy · severe storms');
    expect(layerMeaning('cape', 1800)).toBe('High thunderstorm potential');
    expect(layerMeaning('cape', 50)).toBe('Stable · no storm energy');

    expect(layerMeaning('extreme', 80)).toBe('Rain very likely (>70%)');
    expect(layerMeaning('extreme', 10)).toBe('Low rain chance (<15%)');
  });
});
