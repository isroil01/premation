/**
 * Flip, Reset Transform and the numpad nudges — the pure rules. The verbs
 * themselves are engine commands composed from the document mirror:
 * layerTransformEdits.test.ts.
 */

import type { Keyframe } from '@motion/engine-api';
import {
  negateKeyMember,
  resetTransformWrites,
  numpadStep,
  nudgedScale,
  propertyResetValue,
} from './layerTransformOps';

const key = (id: string, time: number, x: number, y: number, extra: Partial<Keyframe> = {}): Keyframe => ({
  id, time, value: { kind: 'vec2', value: { x, y } }, easing: 'linear', continuous: false, roving: false,
  spatialInterp: 'auto', spatialIn: [], spatialOut: [], label: 0, dims: [], ...extra,
});

describe('pure rules', () => {
  it('negateKeyMember flips one dimension and its spatial tangents, keeps ids and timing', () => {
    const out = negateKeyMember([
      key('k1', 0, 100, 50, { spatialOut: [2, 3] }),
      key('k2', 10, 200, 60, { spatialIn: [-4, 5], easing: 'easeIn' }),
    ], 0);
    expect(out.map((k) => [k.id, k.time, k.value])).toEqual([
      ['k1', 0, { kind: 'vec2', value: { x: -100, y: 50 } }],
      ['k2', 10, { kind: 'vec2', value: { x: -200, y: 60 } }],
    ]);
    expect(out[0]!.spatialOut).toEqual([-2, 3]);
    expect(out[1]!.spatialIn).toEqual([4, 5]);
    expect(out[1]!.easing).toBe('easeIn');
    expect(negateKeyMember([key('k', 0, 1, 2)], 1)[0]!.value).toEqual({ kind: 'vec2', value: { x: 1, y: -2 } });
  });

  it('numpad steps 1, Shift 10, signed', () => {
    expect(numpadStep(1, false)).toBe(1);
    expect(numpadStep(-1, true)).toBe(-10);
  });

  it('scale nudges grow the magnitude, keep a flip, never cross zero', () => {
    expect(nudgedScale(1, 10)).toBeCloseTo(1.1);
    expect(nudgedScale(-1, 10)).toBeCloseTo(-1.1);
    expect(nudgedScale(0.05, -10)).toBe(0);
  });

  it('reset defaults: comp centre, 100 %, anchor at content centre; 3D and camera variants', () => {
    const w = resetTransformWrites({ kind: 'shape', is3D: false, hasOpacity: true, centre: { x: 960, y: 540 } });
    const map = Object.fromEntries(w.map((x) => [x.prop, x.value]));
    expect(map).toEqual({ anchorX: 0, anchorY: 0, x: 960, y: 540, scaleX: 1, scaleY: 1, rotation: 0, opacity: 100 });
    const threeD = resetTransformWrites({ kind: 'shape', is3D: true, hasOpacity: false, centre: { x: 0, y: 0 } }).map((x) => x.prop);
    expect(threeD).toEqual(expect.arrayContaining(['z', 'anchorZ', 'scaleZ', 'rotationX', 'rotationY', 'orientationZ']));
    expect(threeD).not.toContain('opacity');
    const cam = resetTransformWrites({ kind: 'camera', is3D: true, hasOpacity: false, centre: { x: 0, y: 0 } }).map((x) => x.prop);
    expect(cam).toEqual(['orientationX', 'orientationY', 'orientationZ']);
  });
});

describe('reset ONE property (timeline row right-click)', () => {
  it('the value: the Transform default first, then the registry number, else nothing', () => {
    expect(propertyResetValue('x', [{ prop: 'x', value: 500 }], 0)).toBe(500);
    expect(propertyResetValue('strokeWidth', [], 4)).toBe(4);
    expect(propertyResetValue('maskShape', [], null)).toBeUndefined();
  });
});
