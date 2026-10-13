import { describe, expect, it } from 'vitest';
import { isEmptyField } from './field-decode';

describe('isEmptyField', () => {
  it('is true when every cell is "no data", the picture published for a level the source does not have', () => {
    expect(isEmptyField(new Float32Array([NaN, NaN, NaN, NaN]))).toBe(true);
  });

  it('is false as soon as one cell has a value, even zero', () => {
    expect(isEmptyField(new Float32Array([NaN, NaN, 0, NaN]))).toBe(false);
    expect(isEmptyField(new Float32Array([12.5, 13, 14, 15]))).toBe(false);
  });

  it('is false for a field with gaps (a model that covers part of the map)', () => {
    expect(isEmptyField(new Float32Array([NaN, 3, NaN, 7]))).toBe(false);
  });
});
