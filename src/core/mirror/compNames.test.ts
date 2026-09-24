import { defaultCompNameIn, defaultPrecompNameIn } from './compNames';
import { settingsResponsiveTime } from './responsiveTime';

const mirror = (...names: string[]) => ({
  comps: new Map(names.map((name, i) => [`c${i}`, { settings: { name } }])),
});

describe('composition default names (mirror)', () => {
  test('Pre-comp N skips taken names, case- and space-insensitively', () => {
    expect(defaultPrecompNameIn(mirror())).toBe('Pre-comp 1');
    expect(defaultPrecompNameIn(mirror('Main', ' pre-comp 1 ', 'Pre-comp 2'))).toBe('Pre-comp 3');
  });

  test('Comp N starts past the composition count and skips taken names', () => {
    expect(defaultCompNameIn(mirror())).toBe('Comp 1');
    expect(defaultCompNameIn(mirror('Main'))).toBe('Comp 2');
    expect(defaultCompNameIn(mirror('Main', 'COMP 3'))).toBe('Comp 4');
  });
});

describe('settingsResponsiveTime', () => {
  test('parses a valid config, rejects malformed or absent ones', () => {
    const cfg = { authoredDurationSec: 10, protectedRegions: [{ startSec: 0, endSec: 1 }] };
    expect(settingsResponsiveTime({ responsiveTime: JSON.stringify(cfg) })).toEqual(cfg);
    expect(settingsResponsiveTime({ responsiveTime: '{"authoredDurationSec":"x"}' })).toBeUndefined();
    expect(settingsResponsiveTime({ responsiveTime: 'not json' })).toBeUndefined();
    expect(settingsResponsiveTime({})).toBeUndefined();
    expect(settingsResponsiveTime(undefined)).toBeUndefined();
  });
});
