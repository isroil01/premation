import { samplePresetFrame, previewDuration, PREVIEW_CONTEXT, PREVIEW_TEXT } from './presetPreview';
import { TEXT_PRESETS } from './textPresets';
import { BUILTIN_PRESETS, type AnimationPreset } from './animationPresets';

const byName = (name: string): AnimationPreset =>
  [...TEXT_PRESETS, ...BUILTIN_PRESETS].find((p) => p.name === name)!;

describe('previewDuration', () => {
  it('spans the preset plus a beat', () => {
    const p = byName('Typewriter');
    expect(previewDuration(p)).toBeGreaterThan(1.4);
  });

  it('gives a keyframeless behaviour preset a loop anyway', () => {
    // Jitter is driven entirely by a wiggly selector — no keyframes, but very
    // much animated. A duration of 0 would freeze its preview.
    expect(previewDuration(byName('Jitter'))).toBeGreaterThan(1);
  });
});

describe('samplePresetFrame', () => {
  it('drives layer transform tracks', () => {
    const frame = samplePresetFrame(byName('Fade In'), 0);
    expect(frame.opacity).toBeCloseTo(0);
    const later = samplePresetFrame(byName('Fade In'), 0.5);
    expect(later.opacity).toBeCloseTo(1);
  });

  it('resolves relative units against the preview comp, not raw pixels', () => {
    // Slide In travels 0.21 of the comp width. In the tiny preview comp
    // that must be ~46px, not the 400px the old baked-pixel preset used.
    const frame = samplePresetFrame(byName('Slide In'), 0);
    expect(Math.abs(frame.x)).toBeLessThan(PREVIEW_CONTEXT.compWidth);
    expect(Math.abs(frame.x)).toBeCloseTo(0.21 * PREVIEW_CONTEXT.compWidth, 1);
  });

  it('produces per-glyph transforms for an animator preset', () => {
    const frame = samplePresetFrame(byName('Cascade'), 0.6);
    expect(frame.glyphs).toHaveLength(PREVIEW_TEXT.length);
  });

  it('staggers characters for a good share of the sweep, not an instant', () => {
    // The stagger IS the feature. A reveal whose front crosses the string in a
    // blink has every character arriving at once, which reads as the whole
    // block fading rather than as kinetic type — and that is what a
    // strong ease-out on the sweep does, because the front spends its speed
    // crossing the margin parked outside the string. Rather than pin a
    // hand-picked time, scan the loop and require the stagger to be visible for
    // a meaningful share of it.
    for (const name of ['Cascade', 'Word Rise', 'Scatter In', 'Typewriter']) {
      const p = byName(name);
      const dur = previewDuration(p);
      let staggered = 0;
      const N = 60;
      for (let i = 0; i <= N; i++) {
        const g = samplePresetFrame(p, (i / N) * dur).glyphs;
        const states = new Set(g.map((x) => x.opacity.toFixed(2) + ':' + x.dy.toFixed(1)));
        if (states.size > 1) staggered++;
      }
      expect({ preset: name, visibleShare: staggered / N > 0.35 }).toEqual({
        preset: name,
        visibleShare: true,
      });
    }
  });

  it('animates a wiggly preset over time with no keyframes at all', () => {
    const a = samplePresetFrame(byName('Jitter'), 0.1);
    const b = samplePresetFrame(byName('Jitter'), 0.9);
    expect(a.glyphs.map((g) => g.dx)).not.toEqual(b.glyphs.map((g) => g.dx));
  });

  it('runs an expression-selector preset without throwing', () => {
    const frame = samplePresetFrame(byName('Spring In'), 0.3);
    expect(frame.glyphs).toHaveLength(PREVIEW_TEXT.length);
    expect(frame.glyphs.every((g) => Number.isFinite(g.dy))).toBe(true);
  });

  it('produces a finite frame for every preset in the library', () => {
    // The preview is generated from preset data, so a broken preset shows up
    // here rather than as a blank card in the panel.
    for (const p of [...TEXT_PRESETS, ...BUILTIN_PRESETS]) {
      for (const t of [0, previewDuration(p) / 2, previewDuration(p)]) {
        const f = samplePresetFrame(p, t);
        expect(
          [f.x, f.y, f.scale, f.rotation, f.opacity].every(Number.isFinite),
        ).toBe(true);
        expect(f.glyphs.every((g) => Number.isFinite(g.dx) && Number.isFinite(g.opacity))).toBe(true);
      }
    }
  });
});
