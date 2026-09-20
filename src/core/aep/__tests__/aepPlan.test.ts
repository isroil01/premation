/**
 * The mapping layer: AE's conventions → this editor's.
 *
 * Four differences do real damage when they are wrong, and each has a test that
 * fails loudly for it: the anchor's origin, scale's units, AE's habit of
 * omitting defaults rather than writing them, and the direction of the layer
 * stack.
 */

import { parseRifx } from '../riff';
import { readAepProject } from '../aepRead';
import { planAepImport, type PlannedLayer } from '../aepPlan';
import {
  aepFile,
  compItem,
  effect,
  footageItem,
  group,
  layer,
  property,
} from '../__testHelpers__/buildAep';

const plan = (bytes: Uint8Array) => planAepImport(readAepProject(parseRifx(bytes)));

const comp = (overrides: Partial<Parameters<typeof compItem>[0]> = {}) =>
  compItem({ id: 1, name: 'Main', width: 200, height: 100, fps: 24, durationSeconds: 10, ...overrides });

const firstLayer = (bytes: Uint8Array): PlannedLayer => plan(bytes).comps[0]!.layers[0]!;

const transform = (...members: Uint8Array[]) => group('ADBE Transform Group', members);

describe('transform mapping', () => {
  it('places a layer AE never moved at the composition centre', () => {
    // AE omits a property that is both un-keyframed and at its default, so
    // "no ADBE Position" means centred — not (0, 0). Reading it as zero piles
    // every layer into the top-left corner.
    const l = firstLayer(aepFile([comp({ layers: [layer({ id: 1 })] })]));
    expect(l.staticProps.x).toBe(100);
    expect(l.staticProps.y).toBe(50);
  });

  it('defaults scale to a multiplier of one, not a percentage of a hundred', () => {
    const l = firstLayer(aepFile([comp({ layers: [layer({ id: 1 })] })]));
    expect(l.staticProps.scaleX).toBe(1);
    expect(l.staticProps.scaleY).toBe(1);
  });

  it('converts a stated scale from percent to a multiplier', () => {
    const l = firstLayer(
      aepFile([comp({ layers: [layer({ id: 1, properties: transform(...property('ADBE Scale', { dimensions: 3, value: [0.5, 2, 1] })) })] })]),
    );
    expect(l.staticProps.scaleX).toBe(0.5);
    expect(l.staticProps.scaleY).toBe(2);
  });

  it('re-origins the anchor point from AE’s corner to this editor’s centre', () => {
    // A 200×100 layer with AE's anchor at its centre (100, 50) has an anchor of
    // (0, 0) here. Skipping the shift makes every rotation spin around a point
    // half the layer away.
    const bytes = aepFile([
      footageItem({ id: 9, name: 'plate', width: 200, height: 100 }),
      comp({
        layers: [layer({ id: 1, sourceId: 9, properties: transform(...property('ADBE Anchor Point', { dimensions: 3, spatial: true, value: [0.5, 0.5, 0] })) })],
      }),
    ]);
    const l = firstLayer(bytes);
    expect(l.staticProps.anchorX).toBe(0);
    expect(l.staticProps.anchorY).toBe(0);
  });

  it('defaults the anchor to the layer centre, which is zero here', () => {
    const l = firstLayer(aepFile([comp({ layers: [layer({ id: 1 })] })]));
    expect(l.staticProps.anchorX).toBe(0);
    expect(l.staticProps.anchorY).toBe(0);
  });

  it('keeps opacity on AE’s 0–100 scale', () => {
    const l = firstLayer(
      aepFile([comp({ layers: [layer({ id: 1, properties: transform(...property('ADBE Opacity', { dimensions: 1, value: [0.4] })) })] })]),
    );
    expect(l.staticProps.opacity).toBeCloseTo(40, 6);
  });

  it('emits one scalar track per animated axis', () => {
    const l = firstLayer(
      aepFile([
        comp({
          layers: [layer({ id: 1, properties: transform(...property('ADBE Position', {
            dimensions: 3,
            spatial: true,
            value: [0, 0, 0],
            keyframes: [
              { time: 0, value: [0, 50, 0] },
              { time: 2, value: [100, 50, 0] },
            ],
          })) })],
        }),
      ]),
    );
    expect(l.tracks.map((t) => t.prop).sort()).toEqual(['x', 'y']);
    expect(l.tracks.find((t) => t.prop === 'x')!.keyframes.map((k) => k.value)).toEqual([0, 100]);
  });

  it('does not give a 2-D layer depth it never had', () => {
    // AE stores three dimensions of position on every layer. Carrying the third
    // onto a 2-D layer makes the editor treat it as 3-D, which changes how it
    // composites.
    const l = firstLayer(
      aepFile([comp({ layers: [layer({ id: 1, properties: transform(...property('ADBE Position', { dimensions: 3, spatial: true, value: [10, 20, 30] })) })] })]),
    );
    expect(l.staticProps.z).toBeUndefined();
    expect(l.tracks.some((t) => t.prop === 'z')).toBe(false);
  });

  it('gives a 3-D layer its depth and its extra rotations', () => {
    const l = firstLayer(
      aepFile([comp({ layers: [layer({ id: 1, threeD: true, properties: transform(...property('ADBE Position', { dimensions: 3, spatial: true, value: [10, 20, 30] })) })] })]),
    );
    expect(l.staticProps.z).toBe(30);
    expect(l.staticProps.rotationX).toBe(0);
  });
});

describe('layer mapping', () => {
  it('names an unnamed layer after its source, as AE displays it', () => {
    const bytes = aepFile([
      footageItem({ id: 9, name: 'plate.mov', width: 200, height: 100, frameRate: 24, durationSeconds: 4 }),
      comp({ layers: [layer({ id: 1, sourceId: 9, displayName: '' })] }),
    ]);
    expect(firstLayer(bytes).name).toBe('plate.mov');
  });

  it('keeps the stack in AE’s order, top layer first', () => {
    // The applier reverses it; the plan must not, or the two inversions cancel.
    const c = plan(aepFile([comp({ layers: [layer({ id: 1, displayName: 'Top' }), layer({ id: 2, displayName: 'Bottom' })] })])).comps[0]!;
    expect(c.layers.map((l) => l.name)).toEqual(['Top', 'Bottom']);
  });

  it('routes a solid source to a solid layer carrying its colour', () => {
    const bytes = aepFile([
      footageItem({ id: 9, name: '', width: 200, height: 100, solid: { color: [1, 0, 0], name: 'Red Solid' } }),
      comp({ layers: [layer({ id: 1, sourceId: 9 })] }),
    ]);
    const l = firstLayer(bytes);
    expect(l.kind).toBe('solid');
    expect(l.solidColor).toBe('#ff0000');
  });

  it('routes a still to an image layer and a clip to a video layer', () => {
    const still = aepFile([
      footageItem({ id: 9, name: 'logo.png', width: 64, height: 64 }),
      comp({ layers: [layer({ id: 1, sourceId: 9 })] }),
    ]);
    const clip = aepFile([
      footageItem({ id: 9, name: 'plate.mov', width: 64, height: 64, frameRate: 24, durationSeconds: 4 }),
      comp({ layers: [layer({ id: 1, sourceId: 9 })] }),
    ]);
    expect(firstLayer(still).kind).toBe('image');
    expect(firstLayer(clip).kind).toBe('video');
  });

  it('maps a blending mode onto this editor’s id for it', () => {
    expect(firstLayer(aepFile([comp({ layers: [layer({ id: 1, blendingMode: 8 })] })])).blendMode).toBe('soft-light');
  });

  it('resolves a parent through the plan’s own ids', () => {
    const c = plan(aepFile([comp({ layers: [layer({ id: 1 }), layer({ id: 2, parentId: 1 })] })])).comps[0]!;
    expect(c.layers[1]!.parentUid).toBe(c.layers[0]!.uid);
  });

  it('carries the layer switches through to the plan', () => {
    // These are stored three different ways in the scene (a node field, a
    // component, an `fx` key), so the applier routes each through its own API
    // — but only if the plan carried it in the first place.
    const l = firstLayer(aepFile([comp({ layers: [layer({ id: 1, shy: true, guide: true, motionBlur: true, solo: true, locked: true })] })]));
    expect(l.flags).toMatchObject({ shy: true, guide: true, motionBlur: true, solo: true, locked: true });
  });

  it('carries a track matte with its mode and inversion', () => {
    const l = firstLayer(aepFile([comp({ layers: [layer({ id: 1, trackMatte: 4 })] })]));
    expect(l.matte).toMatchObject({ mode: 'luma', inverted: true });
  });
});

describe('effects', () => {
  it('maps a known effect and pulls its parameter across', () => {
    const l = firstLayer(
      aepFile([
        comp({
          layers: [layer({ id: 1, properties: group('ADBE Effect Parade', effect('ADBE Gaussian Blur 2', 'Gaussian Blur', [{ index: 1, label: 'Blurriness', value: [12] }])) })],
        }),
      ]),
    );
    expect(l.effects[0]).toMatchObject({ type: 'gaussian-blur', params: { blurriness: 12 }, defaultsOnly: false });
  });

  it('splits an AE effect that is two of ours', () => {
    // Brightness & Contrast is one effect in AE and two here; mapping only the
    // first half silently discards the contrast, which on a graded shot is the
    // half that shows.
    const l = firstLayer(
      aepFile([
        comp({
          layers: [layer({ id: 1, properties: group('ADBE Effect Parade', effect('ADBE Brightness & Contrast 2', 'Brightness & Contrast', [{ index: 1, label: 'Brightness', value: [20] }])) })],
        }),
      ]),
    );
    expect(l.effects.map((e) => e.type)).toEqual(['brightness', 'contrast']);
  });

  it('reports an effect it cannot map instead of dropping it silently', () => {
    const result = plan(
      aepFile([
        comp({
          layers: [layer({ id: 1, properties: group('ADBE Effect Parade', effect('Third Party Thing', 'Fancy Plugin', [])) })],
        }),
      ]),
    );
    expect(result.summary.unmappedEffects).toEqual(['Fancy Plugin']);
    expect(result.warnings.join(' ')).toMatch(/Fancy Plugin/);
  });
});

describe('summary', () => {
  it('counts what will actually be created, not what was read', () => {
    // A 2-D layer's position is stored with three dimensions and the z track is
    // dropped; counting at read time reports keyframes that nothing will play.
    const result = plan(
      aepFile([
        comp({
          layers: [layer({ id: 1, properties: transform(...property('ADBE Position', {
            dimensions: 3,
            spatial: true,
            value: [0, 0, 0],
            keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [10, 10, 0] }],
          })) })],
        }),
      ]),
    );
    expect(result.summary).toMatchObject({ comps: 1, layers: 1, keyframes: 4 });
  });
});
