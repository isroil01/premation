import { STYLE_PRESETS,  stylePreset } from './stylePresets';

describe('style presets', () => {
  it('every preset produces at least one paint or stroke', () => {
    for (const p of STYLE_PRESETS) {
      const fills = p.fills('#2b7eff');
      const strokes = p.strokes?.('#2b7eff') ?? [];
      expect(fills.length + strokes.length).toBeGreaterThan(0);
    }
  });

  it('stylePreset() looks presets up by id', () => {
    expect(stylePreset('neon')?.label).toBe('Neon');
    expect(stylePreset('nope')).toBeUndefined();
  });
});
