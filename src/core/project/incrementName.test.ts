import { incrementName } from './incrementName';

describe('incrementName', () => {
  test('appends 2 when there is no trailing number', () => {
    expect(incrementName('Comp')).toBe('Comp 2');
    expect(incrementName('My Project')).toBe('My Project 2');
  });
  test('bumps a trailing number', () => {
    expect(incrementName('Comp 1')).toBe('Comp 2');
    expect(incrementName('Comp 9')).toBe('Comp 10');
  });
  test('preserves zero padding', () => {
    expect(incrementName('shot_009')).toBe('shot_010');
    expect(incrementName('promo_v03')).toBe('promo_v04');
    expect(incrementName('take099')).toBe('take100');
  });
  test('trims surrounding whitespace', () => {
    expect(incrementName('  Comp 1  ')).toBe('Comp 2');
  });
});
