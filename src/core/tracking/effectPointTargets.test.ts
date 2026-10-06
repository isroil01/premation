import { effectPointTargets } from './effectPointTargets';

describe('effect points a track can drive', () => {
  it('pairs X/Y px params and skips % points and unknown effects', () => {
    const t = effectPointTargets([
      { id: 'e1', type: 'radial-blur' },
      { id: 'e2', type: 'beam' },
      { id: 'e3', type: 'no-such-effect' },
    ]);
    expect(t.some((p) => p.path === 'effects/e1/center')).toBe(true);
    expect(t.find((p) => p.path === 'effects/e1/center')?.label).toMatch(/›/);
    expect(t.some((p) => p.path.startsWith('effects/e2/start'))).toBe(false);
    expect(t.some((p) => p.path.startsWith('effects/e3'))).toBe(false);
  });
});
