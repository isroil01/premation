import { parseQuery, fuzzyScore, parseTimecode } from './paletteSearch';

describe('parseQuery', () => {
  it('detects mode from the first character', () => {
    expect(parseQuery('>toggle').mode).toBe('commands');
    expect(parseQuery('@circle').mode).toBe('layers');
    expect(parseQuery('#main').mode).toBe('compositions');
    expect(parseQuery(':2:30').mode).toBe('timecode');
    expect(parseQuery('hello').mode).toBe('all');
  });

  it('strips the prefix from the term', () => {
    expect(parseQuery('> Save ').term).toBe('Save');
    expect(parseQuery('@ Rect').term).toBe('Rect');
  });
});

describe('fuzzyScore', () => {
  it('matches subsequences and rejects non-matches', () => {
    expect(fuzzyScore('sv', 'Save Project')).toBeGreaterThanOrEqual(0);
    expect(fuzzyScore('xyz', 'Save Project')).toBe(-1);
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('ranks prefix and contiguous matches higher', () => {
    expect(fuzzyScore('save', 'Save Project')).toBeGreaterThan(
      fuzzyScore('save', 'Auto Save Vault'),
    );
  });
});

describe('parseTimecode', () => {
  it('parses plain seconds', () => {
    expect(parseTimecode('2.5')).toBe(2.5);
    expect(parseTimecode('0')).toBe(0);
  });

  it('parses mm:ss and hh:mm:ss', () => {
    expect(parseTimecode('1:30')).toBe(90);
    expect(parseTimecode('2:00')).toBe(120);
    expect(parseTimecode('1:00:00')).toBe(3600);
  });

  it('rejects garbage', () => {
    expect(parseTimecode('')).toBeNull();
    expect(parseTimecode('abc')).toBeNull();
    expect(parseTimecode('1:2:3:4')).toBeNull();
  });
});
