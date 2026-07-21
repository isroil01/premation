import { rmsPeak, toDb, meterFraction } from './audioLevels';

describe('rmsPeak', () => {
  test('silence → 0/0', () => {
    expect(rmsPeak(new Float32Array([0, 0, 0, 0]))).toEqual({ rms: 0, peak: 0 });
  });
  test('empty block → 0/0 (no divide-by-zero)', () => {
    expect(rmsPeak(new Float32Array([]))).toEqual({ rms: 0, peak: 0 });
  });
  test('full-scale square wave → rms 1, peak 1', () => {
    const s = rmsPeak(new Float32Array([1, -1, 1, -1]));
    expect(s.rms).toBeCloseTo(1);
    expect(s.peak).toBeCloseTo(1);
  });
  test('peak is the absolute maximum; rms is below peak for a sine-like block', () => {
    const s = rmsPeak(new Float32Array([0, 0.5, -0.8, 0.2]));
    expect(s.peak).toBeCloseTo(0.8);
    expect(s.rms).toBeGreaterThan(0);
    expect(s.rms).toBeLessThan(0.8);
  });
});

describe('toDb', () => {
  test('full scale → 0 dB', () => {
    expect(toDb(1)).toBeCloseTo(0);
  });
  test('half amplitude → ~-6 dB', () => {
    expect(toDb(0.5)).toBeCloseTo(-6.02, 1);
  });
  test('zero clamps to the floor', () => {
    expect(toDb(0, -60)).toBe(-60);
  });
});

describe('meterFraction', () => {
  test('0 dB → full bar', () => {
    expect(meterFraction(0)).toBe(1);
  });
  test('at/below the floor → empty', () => {
    expect(meterFraction(-48, -48)).toBe(0);
    expect(meterFraction(-60, -48)).toBe(0);
  });
  test('half-way down the floor → ~half bar', () => {
    expect(meterFraction(-24, -48)).toBeCloseTo(0.5);
  });
});
