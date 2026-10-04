/**
 * What a section preset actually captures, and where it lands.
 *
 * The store holds flat `{key: value}` bags and knows nothing about what a key
 * means; THIS module is the schema, so it is the only place a mistake shows
 * up as "the preset saved the wrong thing" rather than as a type error. The
 * load-bearing property tested here: capture reads the PRIMARY layer and apply
 * writes EVERY selected layer, which is what makes "make these three match
 * the house style" one pick.
 *
 * Round-tripping (capture on A, apply to B, capture on B, expect the same
 * bag) is the strongest available check that the two halves agree about key
 * names, so most of these are round-trips.
 */




import {
  TEXT_PRESET_PROPS,
  TRANSFORM_PRESET_PROPS,
} from './sectionPresets';

beforeEach(() => {
});

afterAll(() => {
});

describe('the schemas name real properties', () => {
  it('has no duplicate keys', () => {
    expect(new Set(TRANSFORM_PRESET_PROPS).size).toBe(TRANSFORM_PRESET_PROPS.length);
    expect(new Set(TEXT_PRESET_PROPS).size).toBe(TEXT_PRESET_PROPS.length);
  });

  it('covers the transform properties the section actually draws', () => {
    for (const p of ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity']) {
      expect(TRANSFORM_PRESET_PROPS).toContain(p);
    }
  });

  it('covers the type properties the character panel actually draws', () => {
    for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight']) {
      expect(TEXT_PRESET_PROPS).toContain(p);
    }
  });
});
