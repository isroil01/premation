import {
  normalizeTracks,
  offsetTracks,
  minTime,
  captureAnimation,
  listPresets,
  saveCurrentAsPreset,
  resolvePresetUnits,
  reindexAnimatorTracks,
  presetFolder,
  BUILTIN_PRESETS,
  type PresetTrack,
} from './animationPresets';
import { TEXT_PRESETS } from './textPresets';
import { DEFAULT_PRESET_CONTEXT } from './presetUnits';
import { samplePresetFrame, PREVIEW_CONTEXT } from './presetPreview';
import { AnimationEngine } from '@motion/animation';

const track = (prop: string, kfs: Array<[number, number]>): PresetTrack => ({
  prop,
  keyframes: kfs.map(([t, value]) => ({ t, value })),
});

describe('minTime', () => {
  test('finds the earliest keyframe across tracks', () => {
    expect(minTime([track('x', [[3, 0], [5, 1]]), track('y', [[1, 0]])])).toBe(1);
  });
  test('empty → 0', () => {
    expect(minTime([])).toBe(0);
  });
});

describe('normalizeTracks', () => {
  test('rebases the earliest keyframe to t=0, preserving spacing + values', () => {
    const out = normalizeTracks([track('x', [[2, 10], [4, 20]]), track('opacity', [[3, 100]])]);
    expect(out[0]!.keyframes.map((k) => k.t)).toEqual([0, 2]); // shifted by min=2
    expect(out[1]!.keyframes[0]!.t).toBe(1);
    expect(out[0]!.keyframes.map((k) => k.value)).toEqual([10, 20]); // values untouched
  });
});

describe('offsetTracks', () => {
  test('shifts every keyframe by dt', () => {
    const out = offsetTracks([track('x', [[0, 0], [1, 1]])], 5);
    expect(out[0]!.keyframes.map((k) => k.t)).toEqual([5, 6]);
  });

  test('normalize → offset(playhead) round-trips to playhead-anchored times', () => {
    const captured = normalizeTracks([track('x', [[2, 0], [4, 1]])]);
    const applied = offsetTracks(captured, 10);
    expect(applied[0]!.keyframes.map((k) => k.t)).toEqual([10, 12]);
  });
});

describe('captureAnimation', () => {
  test('captures a node’s animated tracks, normalized to t=0 and out of pixels', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n', 'x', 1, 0);
    a.setKeyframe('n', 'x', 3, 200);
    const tracks = captureAnimation('n', a, { ...DEFAULT_PRESET_CONTEXT, compWidth: 1000 });
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.prop).toBe('x');
    expect(tracks[0]!.keyframes.map((k) => k.t)).toEqual([0, 2]); // rebased from 1,3
    // Captured as a FRACTION of the comp it was authored in, not as 200px —
    // that is what lets it replay correctly in a comp of another size.
    expect(tracks[0]!.unit).toBe('compW');
    expect(tracks[0]!.keyframes.map((k) => k.value)).toEqual([0, 0.2]);
  });

  test('leaves angular and proportional properties absolute', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n', 'rotation', 0, 0);
    a.setKeyframe('n', 'rotation', 1, 90);
    const tracks = captureAnimation('n', a);
    // 90° is 90° in any comp; expressing it as a fraction of the width would be
    // nonsense.
    expect(tracks[0]!.unit).toBe('abs');
    expect(tracks[0]!.keyframes.map((k) => k.value)).toEqual([0, 90]);
  });

  test('an un-animated node captures nothing', () => {
    expect(captureAnimation('empty', new AnimationEngine())).toEqual([]);
  });
});

describe('relative units', () => {
  const ctx = {
    ...DEFAULT_PRESET_CONTEXT,
    compWidth: 3840,
    compHeight: 2160,
    fontSize: 100,
    layerDuration: 5,
  };

  test('a comp-relative slide scales with the comp instead of flying off-frame', () => {
    const [t] = resolvePresetUnits([{ ...track('x', [[0, -0.25], [1, 0]]), unit: 'compW' }], ctx);
    expect(t!.keyframes.map((k) => k.value)).toEqual([-960, 0]);
    // …and the same preset in a 720p comp travels 320px, not 960.
    const [small] = resolvePresetUnits(
      [{ ...track('x', [[0, -0.25], [1, 0]]), unit: 'compW' }],
      { ...ctx, compWidth: 1280 },
    );
    expect(small!.keyframes[0]!.value).toBe(-320);
  });

  test('type metrics scale with the font size', () => {
    const [t] = resolvePresetUnits(
      [{ ...track('ta.0.tracking', [[0, 0.8]]), unit: 'fontSize' }],
      ctx,
    );
    expect(t!.keyframes[0]!.value).toBeCloseTo(80);
  });

  test('absolute tracks pass through untouched', () => {
    const [t] = resolvePresetUnits([track('rotation', [[0, 90]])], ctx);
    expect(t!.keyframes[0]!.value).toBe(90);
  });

  test('duration-relative times scale to the layer', () => {
    const [t] = resolvePresetUnits([track('opacity', [[0, 0], [0.5, 100]])], ctx, 'duration');
    expect(t!.keyframes.map((k) => k.t)).toEqual([0, 2.5]);
  });

  test('capture → resolve round-trips back to the captured pixels', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n', 'y', 0, 0);
    a.setKeyframe('n', 'y', 1, 540);
    const captured = captureAnimation('n', a, ctx);
    const [resolved] = resolvePresetUnits(captured, ctx);
    expect(resolved!.keyframes.map((k) => k.value)).toEqual([0, 540]);
  });
});

describe('animator track re-indexing', () => {
  test('shifts ta.<i> paths so a preset lands on the animators it installed', () => {
    const shifted = reindexAnimatorTracks(
      [track('ta.0.offset', [[0, -100]]), track('ta.1.x', [[0, 5]]), track('opacity', [[0, 0]])],
      2,
    );
    expect(shifted.map((t) => t.prop)).toEqual(['ta.2.offset', 'ta.3.x', 'opacity']);
  });

  test('a zero shift is the identity', () => {
    const tracks = [track('ta.0.offset', [[0, -100]])];
    expect(reindexAnimatorTracks(tracks, 0).map((t) => t.prop)).toEqual(['ta.0.offset']);
  });
});

describe('the text preset library', () => {
  test('every text preset ships an animator rig and a track to drive it', () => {
    for (const p of TEXT_PRESETS) {
      expect(p.animators && p.animators.length).toBeTruthy();
      expect(p.tracks.length).toBeGreaterThan(0);
      expect(p.requires).toBe('text');
    }
  });

  test('no preset bakes a raw pixel value into a spatial track', () => {
    // The AE bug this library exists to avoid: a position authored in pixels
    // only works in the comp it was authored in.
    for (const p of TEXT_PRESETS) {
      for (const t of p.tracks) {
        const leaf = t.prop.split('.').pop()!;
        if (!['x', 'y', 'z', 'tracking', 'blur', 'lineSpacing', 'strokeWidth'].includes(leaf)) continue;
        expect({ preset: p.name, prop: t.prop, unit: t.unit }).toEqual({
          preset: p.name,
          prop: t.prop,
          unit: expect.stringMatching(/^(compW|compH|compMin|layerW|layerH|fontSize)$/),
        });
      }
    }
  });

  test('preset names are unique across the whole library', () => {
    const names = listPresets().map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('every preset lands in a folder', () => {
    for (const p of listPresets()) expect(presetFolder(p)).toBeTruthy();
  });

  test.each([2, 6, 13, 30])(
    'reveals start from nothing and finish completely on a %i-character string',
    (count) => {
      // Two bugs this catches, both of which look broken rather than subtle:
      //
      //  • Sweeping the whole window across (offset -100 → 100) passes it
      //    STRAIGHT OVER the string, so the text starts visible, blinks out
      //    entirely in the middle, and returns.
      //  • A window of exactly [0, 100] leaves the first and last characters
      //    permanently part-animated, because a soft edge is centred on the
      //    boundary and bleeds half its width past it.
      //
      // The property that matters is the same either way: at the first frame
      // EVERY character is fully covered, and at the last frame NONE is.
      const text = 'M'.repeat(count);
      for (const p of TEXT_PRESETS) {
        const folder = presetFolder(p);
        const isReveal = folder === 'Text/Animate In' || folder === 'Text/Animate Out';
        if (!isReveal) continue;
        const sweep = p.tracks.find((t) => /^ta\.\d+\.(start|end|offset)$/.test(t.prop));
        if (!sweep) continue; // expression-driven presets have no sweep

        const duration = sweep.keyframes[sweep.keyframes.length - 1]!.t;
        // Total deviation from the identity glyph, across EVERY channel — not
        // just opacity. Decode, for instance, only substitutes characters, so
        // an opacity-based coverage proxy would score it as untouched.
        const covered = (t: number): number[] =>
          samplePresetFrame(p, t, PREVIEW_CONTEXT, text).glyphs.map((g) =>
            Number(
              (
                (1 - g.opacity) +
                (1 - g.fillOpacity) +
                Math.abs(g.dx) +
                Math.abs(g.dy) +
                Math.abs(1 - g.scale) +
                Math.abs(1 - g.scaleY) +
                Math.abs(g.rotation) +
                Math.abs(g.skew) +
                Math.abs(g.tracking) +
                g.blur +
                g.strokeWidth +
                (g.displayChar !== g.char ? 1 : 0)
              ).toFixed(3),
            ),
          );

        const hidden = folder === 'Text/Animate In' ? covered(0) : covered(duration);
        const shown = folder === 'Text/Animate In' ? covered(duration) : covered(0);

        // Fully covered at the hidden end: no character is left half-arrived.
        expect({ preset: p.name, allCovered: hidden.every((v) => v > 0) }).toEqual({
          preset: p.name,
          allCovered: true,
        });
        // Fully clear at the shown end: nothing is left mid-animation forever.
        expect({ preset: p.name, allClear: shown.every((v) => v === 0) }).toEqual({
          preset: p.name,
          allClear: true,
        });
      }
    },
  );

  test('no two presets animate the same property set the same way', () => {
    // "Every animation should be totally different from every other." A preset
    // whose animator touches exactly the same properties, with the same
    // selector kind and the same basedOn, as another one is a near-duplicate
    // however differently it is named.
    const seen = new Map<string, string>();
    for (const p of TEXT_PRESETS) {
      const a = p.animators![0]!;
      const touched = (
        ['x', 'y', 'scale', 'rotation', 'opacity', 'fillOpacity', 'tracking',
         'blur', 'skew', 'characterOffset', 'strokeWidth'] as const
      )
        .filter((k) => {
          const v = a[k];
          const idle = k === 'scale' || k === 'opacity' || k === 'fillOpacity' ? 100 : 0;
          return typeof v === 'number' && v !== idle;
        })
        .join('+');
      const sel = a.selectors![0]!;
      const sig = `${presetFolder(p)}|${touched}|${sel.kind}|${sel.basedOn}|${!!a.color}`;
      const prior = seen.get(sig);
      expect({ preset: p.name, duplicateOf: prior ?? null }).toEqual({
        preset: p.name,
        duplicateOf: null,
      });
      seen.set(sig, p.name);
    }
  });

  test('every built-in carries its own description', () => {
    // The panel reads `preset.description`. It used to read a hardcoded
    // name→copy map living in the component, which meant the description and
    // the preset could drift apart — and did, the moment presets were added
    // that the map had never heard of. Copy belongs on the preset.
    for (const p of [...BUILTIN_PRESETS, ...TEXT_PRESETS]) {
      expect({ name: p.name, hasDescription: !!p.description }).toEqual({
        name: p.name,
        hasDescription: true,
      });
    }
  });
});

describe('presets registry', () => {
  test('listPresets always includes the built-ins', () => {
    const names = listPresets().map((p) => p.name);
    for (const b of BUILTIN_PRESETS) expect(names).toContain(b.name);
  });

  test('saving an un-animated layer fails (nothing to capture)', () => {
    // Uses the real default engine; a fresh node id has no keyframes.
    expect(saveCurrentAsPreset('no-such-node-xyz', 'X')).toBe(false);
  });
});

describe('3D presets', () => {
  test('builtins include the 3D set', () => {
    const names = BUILTIN_PRESETS.map((p) => p.name);
    for (const n of ['Flip In 3D', 'Swing In 3D', 'Depth Push In', '3D Twirl In', 'Cinematic Pan 3D']) {
      expect(names).toContain(n);
    }
  });

  test('applying a 3D preset auto-enables the layer 3D switch', async () => {
    const { applyPresetByName } = await import('./animationPresets');
    const { default: defaultSceneGraph } = await import('@core/scene/DefaultSceneGraph');
    const { insertShape } = await import('@core/scene/sceneInsert');
    const { is3DEnabled } = await import('@core/scene/threeD');
    const { useSelectionStore } = await import('@stores/selectionStore');
    const { setCommandSystem, CommandSystem } = await import('@core/commands/CommandSystem');
    // runAnimEdit records onto the command system — boot a minimal one.
    const dummyServices = {
      undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
      selection: { get: () => [], set: () => {}, clear: () => {} },
      panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
      workspace: { setActive: () => {}, getActive: () => '' },
      get: () => undefined,
    } as never;
    setCommandSystem(new CommandSystem({ services: dummyServices, getState: () => ({}) }));
    insertShape('rect', 'Preset Test Rect');
    const nodeId = useSelectionStore.getState().ids[0]!;
    const node = defaultSceneGraph.getNode(nodeId)!;
    expect(is3DEnabled(node)).toBe(false);
    applyPresetByName(nodeId, 'Flip In 3D', 0);
    expect(is3DEnabled(defaultSceneGraph.getNode(nodeId)!)).toBe(true);
  });
});
