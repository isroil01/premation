/**
 * Flip, Reset Transform and the numpad nudges — the pure rules, then the flip
 * BUILDER (what `flipCommands` runs off-document) against the live scene graph
 * and animation engine, keyframed case included. The verbs themselves are
 * engine commands: layerTransformEdits.test.ts.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import type { SceneNode } from '@core/types';
import {
  negateKeyframes,
  flipLayer,
  resetTransformWrites,
  numpadStep,
  nudgedScale,
  propertyResetValue,
} from './layerTransformOps';

function bootCommandSystem(): void {
  const services = {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  } as never;
  setCommandSystem(new CommandSystem({ services, getState: () => ({}) as never }));
}

const ID = 'lto_layer';
const PROPS = ['scaleX', 'scaleY', 'scale', 'rotation', 'x', 'y', 'anchorX', 'anchorY', 'opacity'];

function addLayer(props: Record<string, unknown>): void {
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
  if (!defaultSceneGraph.getNode('comp_root')) {
    defaultSceneGraph.addNode({
      id: 'comp_root', name: 'Composition', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [{ id: 'comp_root_meta', type: 'group', props: { __kind: 'group' } }],
    } as unknown as SceneNode);
  }
  defaultSceneGraph.addChild('comp_root', {
    id: ID, name: ID, parent: 'comp_root', children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${ID}_t`, type: 'Transform', props: { __kind: 'shape', ...props } },
      { id: `${ID}_s`, type: 'Style', props: { opacity: 40 } },
    ],
  } as unknown as SceneNode);
  for (const p of PROPS) defaultAnimation.removeTrack(ID, p);
}

const prop = (name: string): unknown =>
  defaultSceneGraph.getNode(ID)!.components.find((c) => (c.props as Record<string, unknown>)[name] !== undefined)?.props[name];

beforeEach(bootCommandSystem);

describe('pure rules', () => {
  it('negateKeyframes flips values and spatial tangents, keeps timing', () => {
    const out = negateKeyframes([{ t: 0, value: 1, so: 0.2 }, { t: 1, value: 2, si: -0.5, easing: 'easeIn' }]);
    expect(out).toEqual([{ t: 0, value: -1, so: -0.2 }, { t: 1, value: -2, si: 0.5, easing: 'easeIn' }]);
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

describe('the flip builder, against the scene', () => {
  it('flip negates a static scale on one axis only', () => {
    addLayer({ scaleX: 0.5, scaleY: 2 });
    expect(flipLayer(ID, 'horizontal')).toBe(true);
    expect(prop('scaleX')).toBe(-0.5);
    expect(prop('scaleY')).toBe(2);
  });

  it('flip on KEYFRAMED scale negates every keyframe on the axis', () => {
    addLayer({ scaleX: 1, scaleY: 1 });
    defaultAnimation.setKeyframe(ID, 'scaleY', 0, 1);
    defaultAnimation.setKeyframe(ID, 'scaleY', 2, 3);
    flipLayer(ID, 'vertical');
    expect(defaultAnimation.getTrackKeyframes(ID, 'scaleY')!.map((k) => k.value)).toEqual([-1, -3]);
    expect(defaultAnimation.getTrackKeyframes(ID, 'scaleX')).toBeNull();
  });

  it('flip on a layer animated through the uniform `scale` shorthand gets a negated per-axis copy', () => {
    addLayer({});
    defaultAnimation.setKeyframe(ID, 'scale', 0, 1);
    defaultAnimation.setKeyframe(ID, 'scale', 1, 2);
    flipLayer(ID, 'horizontal');
    expect(defaultAnimation.getTrackKeyframes(ID, 'scaleX')!.map((k) => k.value)).toEqual([-1, -2]);
    // The other axis still follows `scale`.
    expect(defaultAnimation.getTrackKeyframes(ID, 'scale')!.map((k) => k.value)).toEqual([1, 2]);
  });
});

describe('reset ONE property (timeline row right-click)', () => {
  it('the value: the Transform default first, then the registry number, else nothing', () => {
    expect(propertyResetValue('x', [{ prop: 'x', value: 500 }], 0)).toBe(500);
    expect(propertyResetValue('strokeWidth', [], 4)).toBe(4);
    expect(propertyResetValue('maskShape', [], null)).toBeUndefined();
  });
});
