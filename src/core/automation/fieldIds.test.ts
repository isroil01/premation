import { slugFieldId, uniqueFieldId, isPublicFieldId } from './fieldIds';

describe('slugFieldId', () => {
  it('camelCases a layer label', () => {
    expect(slugFieldId('Background Video')).toBe('backgroundVideo');
    expect(slugFieldId('Character')).toBe('character');
    expect(slugFieldId('  Caption 1  ')).toBe('caption1');
  });

  it('returns empty for punctuation-only labels', () => {
    expect(slugFieldId('---')).toBe('');
  });
});

describe('uniqueFieldId', () => {
  it('keeps the base when free', () => {
    expect(uniqueFieldId('character', new Set())).toBe('character');
  });

  it('suffixes when taken', () => {
    expect(uniqueFieldId('character', new Set(['character', 'character2']))).toBe('character3');
  });
});

describe('isPublicFieldId', () => {
  it('accepts n8n-friendly slugs', () => {
    expect(isPublicFieldId('character')).toBe(true);
    expect(isPublicFieldId('backgroundVideo')).toBe(true);
  });

  it('rejects internal-looking ids', () => {
    expect(isPublicFieldId('f_node_src')).toBe(false);
    expect(isPublicFieldId('Character')).toBe(false);
    expect(isPublicFieldId('background-video')).toBe(false);
  });
});
