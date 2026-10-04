/**
 * The batch output-name rules, and the failure they exist to prevent: forty rows
 * rendering to one filename (a pattern that does not vary). It is silent by nature —
 * nothing throws, and nothing is visible until someone opens the output folder —
 * which is why it is tested rather than trusted.
 */

import {
  OutputPatternError,
  patternVariesPerRow,
  resolveOutputName,
  sanitizeNameToken,
} from './batchRender';

describe('sanitizeNameToken', () => {
  it('keeps spaces and hyphens, which are perfectly good in a filename', () => {
    expect(sanitizeNameToken('Ada Lovelace-01')).toBe('Ada Lovelace-01');
  });

  it('removes the characters a filesystem refuses', () => {
    expect(sanitizeNameToken('Q3 / Q4: results?')).toBe('Q3 Q4 results');
  });

  it('collapses a comma-separated name into something openable', () => {
    expect(sanitizeNameToken('Lovelace, Ada')).toBe('Lovelace, Ada');
  });

  it('drops a trailing dot, which Windows can create and cannot open', () => {
    expect(sanitizeNameToken('Version 2.')).toBe('Version 2');
  });

  it('caps a paragraph-length cell', () => {
    expect(sanitizeNameToken('x'.repeat(500)).length).toBeLessThanOrEqual(80);
  });
});

describe('resolveOutputName', () => {
  it('substitutes a column', () => {
    expect(resolveOutputName('out/{name}.mp4', { name: 'Ada' }, 0, 3)).toBe('out/Ada.mp4');
  });

  it('zero-pads {index} to the table width so the folder sorts in table order', () => {
    expect(resolveOutputName('{index}.mp4', { name: 'Ada' }, 0, 40)).toBe('01.mp4');
    expect(resolveOutputName('{index}.mp4', { name: 'Ada' }, 39, 40)).toBe('40.mp4');
  });

  it('accepts {row} as an alias for {index}', () => {
    expect(resolveOutputName('{row}.mp4', { name: 'Ada' }, 4, 9)).toBe('5.mp4');
  });

  it('combines tokens', () => {
    expect(resolveOutputName('{index}-{name}.mp4', { name: 'Ada' }, 0, 10)).toBe('01-Ada.mp4');
  });

  it('falls back to the row number when a cell sanitises to nothing', () => {
    // Otherwise two rows whose names are both punctuation collide on one path,
    // and with an overwriting CLI the second silently replaces the first.
    expect(resolveOutputName('{name}.mp4', { name: '???' }, 6, 10)).toBe('07.mp4');
    expect(resolveOutputName('{name}.mp4', { name: '' }, 0, 10)).toBe('01.mp4');
  });

  it('throws for a token that is not a column, listing what is', () => {
    expect(() => resolveOutputName('{tilte}.mp4', { title: 'x' }, 0, 1)).toThrow(OutputPatternError);
    expect(() => resolveOutputName('{tilte}.mp4', { title: 'x' }, 0, 1)).toThrow(/title/);
  });
});

describe('patternVariesPerRow', () => {
  it('is the check that stops forty renders becoming one file', () => {
    expect(patternVariesPerRow('out/{name}.mp4')).toBe(true);
    expect(patternVariesPerRow('out/promo.mp4')).toBe(false);
  });
});
