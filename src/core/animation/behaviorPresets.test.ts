import { compileExpression } from '@motion/animation';
import { BEHAVIOR_PRESETS } from './behaviorPresets';
import { listPresets, presetFolder } from './animationPresets';
import { samplePresetFrame, previewDuration } from './presetPreview';

describe('behaviour presets', () => {
  it('every expression compiles', () => {
    // The failure this catches is the quiet one: a typo'd expression installs
    // fine, evaluates to null every frame, and looks exactly like a preset that
    // did nothing. There is no error surfaced at apply time.
    for (const p of BEHAVIOR_PRESETS) {
      for (const e of p.expressions!) {
        expect({ preset: p.name, prop: e.prop, error: compileExpression(e.expr).compileError }).toEqual({
          preset: p.name,
          prop: e.prop,
          error: null,
        });
      }
    }
  });

  it('every expression evaluates to a finite number across the loop', () => {
    // Compiling is not enough — an expression can parse and still return null
    // (unknown name) or NaN (divide by a zero-length comp).
    for (const p of BEHAVIOR_PRESETS) {
      const d = previewDuration(p);
      for (const f of [0, 0.25, 0.5, 0.75, 1]) {
        const frame = samplePresetFrame(p, f * d);
        expect({
          preset: p.name,
          finite: [frame.x, frame.y, frame.scale, frame.rotation, frame.opacity].every(Number.isFinite),
        }).toEqual({ preset: p.name, finite: true });
      }
    }
  });

  it('every behaviour actually animates in its preview', () => {
    // A behaviour that renders a motionless card teaches the user nothing, and
    // behaviours are precisely the ones whose name does not tell you what they
    // do. Audio Throb is included deliberately: the preview feeds it a
    // synthetic level, because a thumbnail has no soundtrack.
    for (const p of BEHAVIOR_PRESETS) {
      const d = previewDuration(p);
      const states = new Set(
        [0, 0.2, 0.4, 0.6, 0.8, 1].map((f) => {
          const fr = samplePresetFrame(p, f * d);
          return [fr.x, fr.y, fr.scale, fr.rotation, fr.opacity].map((v) => v.toFixed(2)).join();
        }),
      );
      expect({ preset: p.name, animates: states.size > 1 }).toEqual({ preset: p.name, animates: true });
    }
  });

  it('installs expressions, never keyframes', () => {
    // The whole distinction: a behaviour is a rule, not a fixed-length
    // animation. One that shipped keyframe tracks would just be a preset in the
    // wrong folder.
    for (const p of BEHAVIOR_PRESETS) {
      expect({ preset: p.name, tracks: p.tracks.length, hasExpressions: !!p.expressions?.length }).toEqual({
        preset: p.name,
        tracks: 0,
        hasExpressions: true,
      });
    }
  });

  it('uses declared data rather than an applyFn escape hatch', () => {
    for (const p of BEHAVIOR_PRESETS) {
      expect({ preset: p.name, hasApplyFn: !!p.applyFn }).toEqual({ preset: p.name, hasApplyFn: false });
    }
  });

  it('no two behaviours drive the same property set', () => {
    const seen = new Map<string, string>();
    for (const p of BEHAVIOR_PRESETS) {
      const sig = p.expressions!.map((e) => e.prop).sort().join('+');
      const prior = seen.get(sig);
      // Orbit and Drift both drive x+y, so they are allowed to collide on the
      // property signature — they differ in KIND (parametric path vs seeded
      // noise). Assert on the expression text instead, which is what differs.
      if (prior) {
        const a = BEHAVIOR_PRESETS.find((q) => q.name === prior)!.expressions!.map((e) => e.expr).join();
        const b = p.expressions!.map((e) => e.expr).join();
        expect({ preset: p.name, identicalTo: a === b ? prior : null }).toEqual({
          preset: p.name,
          identicalTo: null,
        });
      }
      seen.set(sig, p.name);
    }
  });

  it('appears in the library under its own folder', () => {
    const names = listPresets().map((p) => p.name);
    for (const p of BEHAVIOR_PRESETS) {
      expect(names).toContain(p.name);
      expect(presetFolder(p)).toBe('Behaviors');
    }
  });

  it('carries a description, like every other preset', () => {
    for (const p of BEHAVIOR_PRESETS) {
      expect({ preset: p.name, described: !!p.description }).toEqual({ preset: p.name, described: true });
    }
  });
});
