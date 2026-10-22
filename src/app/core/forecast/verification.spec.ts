import { describe, it, expect } from 'vitest';
import { nowcastSkill, skillLine, summarizeSkill, type VerificationFile } from './verification';

const day = (date: string, models: VerificationFile['days'][number]['models']) => ({ date, models });

const file: VerificationFile = {
  airports: ['VOMM', 'VOMD'],
  leads: [1, 2, 3],
  updated: '2026-10-21T01:30:00Z',
  days: [
    day('2026-10-19', {
      a: { '1': { temp: { mae: 2, bias: -2, n: 10 }, rain: { hits: 6, misses: 4, false: 2 } } },
      b: { '1': { temp: { mae: 1, bias: 0.5, n: 10 }, rain: { hits: 2, misses: 1, false: 0 } } },
    }),
    day('2026-10-20', {
      a: { '1': { temp: { mae: 1, bias: -1, n: 30 }, rain: { hits: 0, misses: 0, false: 0 } } },
      b: { '1': { temp: { mae: 1, bias: 0.5, n: 10 } } },
    }),
  ],
};

describe('model skill from the airport scores', () => {
  it('pools the days by hours and ranks the models by temperature error', () => {
    const [a, b] = summarizeSkill(file, 14, 1);
    expect(a.modelId).toBe('a');
    expect(a.tempMae).toBeCloseTo((2 * 10 + 1 * 30) / 40, 6);
    expect(a.tempBias).toBeCloseTo((-2 * 10 - 1 * 30) / 40, 6);
    expect(a.days).toBe(2);
    expect(b.tempMae).toBe(1);
    expect(b.tempRank).toBe(1);
    expect(a.tempRank).toBe(2);
  });

  it('gives the rain shares only with enough rainy hours', () => {
    const [a, b] = summarizeSkill(file, 14, 1);
    expect(a.rainCaught).toBeCloseTo(0.6, 6);   // 6 of 10 rainy hours
    expect(a.rainFalse).toBeNull();             // 8 hours with rain forecast: too few
    expect(b.rainCaught).toBeNull();            // 3 rainy hours
  });

  it('keeps to the window of days', () => {
    const [a] = summarizeSkill(file, 1, 1);
    expect(a.days).toBe(1);
    expect(a.tempMae).toBe(1);
  });

  it('writes one line for the model list', () => {
    const [a, b] = summarizeSkill(file, 14, 1);
    expect(skillLine(a)).toBe('1.3 °C off on average (1.3 too cold) · rain caught 60%');
    expect(skillLine(b)).toBe('1.0 °C off on average (0.5 too warm)');
  });
});

describe('nowcast skill from the daily scores', () => {
  it('pools the days and gives the nowcast beside a still picture', () => {
    const f: VerificationFile = { ...file, days: [
      { date: '2026-10-19', models: {}, nowcast: { '30': { nowcast: { hits: 15, misses: 5, false: 5 }, still: { hits: 10, misses: 10, false: 10 } } } },
      { date: '2026-10-20', models: {}, nowcast: { '30': { nowcast: { hits: 5, misses: 0, false: 5 }, still: { hits: 0, misses: 5, false: 0 } } } },
    ] };
    const s = nowcastSkill(f, 14, 30)!;
    expect(s.days).toBe(2);
    expect(s.nowcast).toBeCloseTo(20 / 35, 6);
    expect(s.still).toBeCloseTo(10 / 35, 6);
    expect(nowcastSkill(f, 14, 60)).toBeNull();
    expect(nowcastSkill({ ...f, days: f.days.slice(1) }, 14, 30)).toBeNull(); // too few rainy cells to say
  });
});
