/**
 * The static value behind a structured prop path.
 *
 * The bug this closes: a stopwatch keys the value the property currently HAS,
 * and the old reader scanned `node.components` for a number of that name. For
 * `effect.fx_1.radius` there is no such prop — the number lives inside the fx
 * component's effect array — so it answered 0, and lighting up a Glow's radius
 * in the timeline silently reset it to zero on the frame you did it.
 */

import SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import {
  addEffect,
  getNodeEffects,
  effectPropPath,
  updateEffectParam,
  effectDefFor,
  paramsOf,
} from '@core/effects/effects';
import { setLayerStyles } from '@core/effects/layerStyles';
import { addPathOp, defaultPathOp, pathOpPropPath, readPathOps } from '@core/scene/pathOps';
import type { SceneNode } from '@core/types';
import {
  readStaticPropertyValue,
  writeStaticPropertyValue,
  canWriteStaticPropertyValue,
  staticOrDefaultValue,
} from './propertyValue';

function node(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 12, y: 0 } },
      { id: `${id}_s`, type: 'Style', props: { fill: '#fff', opacity: 80 } },
    ],
  };
}

beforeEach(() => {
  (defaultSceneGraph as unknown as SceneGraph).clear();
  defaultAnimation.clear();
  defaultSceneGraph.addNode(node('a'));
});

describe('flat component props', () => {
  it('reads and writes them', () => {
    expect(readStaticPropertyValue('a', 'opacity')).toBe(80);
    expect(writeStaticPropertyValue('a', 'opacity', 40)).toBe(true);
    expect(readStaticPropertyValue('a', 'opacity')).toBe(40);
  });

  it('falls back to the registry default, not to zero', () => {
    // Nothing on this node stores `scaleX`; a scale of 0 would collapse the
    // layer, and 1 is what the property rests at.
    expect(readStaticPropertyValue('a', 'scaleX')).toBeUndefined();
    expect(staticOrDefaultValue('a', 'scaleX')).toBe(1);
  });
});

describe('effect parameters', () => {
  it('reads the value the effect actually holds', () => {
    addEffect('a', 'glow');
    const fx = getNodeEffects('a')[0]!;
    const key = effectDefFor(fx.type)!.params.find((p) => p.type === 'number')!.key;
    updateEffectParam('a', fx.id, key, 40);
    expect(readStaticPropertyValue('a', effectPropPath(fx.id, key))).toBe(40);
  });

  it('writes back through the effect stack', () => {
    addEffect('a', 'glow');
    const fx = getNodeEffects('a')[0]!;
    const key = effectDefFor(fx.type)!.params.find((p) => p.type === 'number')!.key;
    expect(writeStaticPropertyValue('a', effectPropPath(fx.id, key), 7)).toBe(true);
    expect(paramsOf(getNodeEffects('a')[0]!)[key]).toBe(7);
  });

  it('reads a colour through its decomposed channels', () => {
    addEffect('a', 'glow');
    const fx = getNodeEffects('a')[0]!;
    const colorKey = effectDefFor(fx.type)!.params.find((p) => p.type === 'color')?.key;
    if (!colorKey) return; // effect has no colour param; nothing to assert
    updateEffectParam('a', fx.id, colorKey, '#ff8000');
    expect(readStaticPropertyValue('a', `${effectPropPath(fx.id, colorKey)}_r`)).toBe(255);
    expect(readStaticPropertyValue('a', `${effectPropPath(fx.id, colorKey)}_g`)).toBe(128);
    expect(readStaticPropertyValue('a', `${effectPropPath(fx.id, colorKey)}_b`)).toBe(0);
    // A channel has no writable base — the stored value is one hex string, and
    // rewriting a channel through it would quietly rewrite the other three.
    expect(canWriteStaticPropertyValue('a', `${effectPropPath(fx.id, colorKey)}_r`)).toBe(false);
  });

  it('answers nothing for an effect that is gone', () => {
    expect(readStaticPropertyValue('a', 'effect.fx_missing.radius')).toBeUndefined();
    expect(canWriteStaticPropertyValue('a', 'effect.fx_missing.radius')).toBe(false);
  });
});

describe('layer styles', () => {
  it('reads through the binding, in the units the track holds', () => {
    setLayerStyles('a', { dropShadow: { enabled: true, color: '#000', opacity: 0.5, distance: 8, angle: 135, blur: 4 } });
    // `distance` maps 1:1...
    expect(readStaticPropertyValue('a', effectPropPath('layerstyle:dropShadow', 'distance'))).toBe(8);
    // ...and the 0..1 opacity is carried as the effect's 0..100 percentage.
    expect(readStaticPropertyValue('a', effectPropPath('layerstyle:dropShadow', 'opacity'))).toBe(50);
  });

  it('writes back in the style\'s own units', () => {
    setLayerStyles('a', { dropShadow: { enabled: true, color: '#000', opacity: 0.5, distance: 8, angle: 135, blur: 4 } });
    expect(writeStaticPropertyValue('a', effectPropPath('layerstyle:dropShadow', 'opacity'), 25)).toBe(true);
    expect(readStaticPropertyValue('a', effectPropPath('layerstyle:dropShadow', 'opacity'))).toBe(25);
  });
});

describe('path operators', () => {
  it('reads and writes one operator\'s parameter, scoped by its id', () => {
    addPathOp('a', { ...defaultPathOp(), id: 'op_1', type: 'trim', end: 60 });
    expect(readStaticPropertyValue('a', pathOpPropPath('op_1', 'end'))).toBe(60);
    expect(writeStaticPropertyValue('a', pathOpPropPath('op_1', 'end'), 30)).toBe(true);
    const node = defaultSceneGraph.getNode('a')!;
    expect(readPathOps(node)[0]!.end).toBe(30);
  });
});

describe('mask properties', () => {
  it('reads and writes a path setting, with opacity in 0..100', async () => {
    const { addMaskPath, rectangleMask, getNodeMask } = await import('@core/effects/mask');
    addMaskPath('a', { ...rectangleMask(10, 10), id: 'mk', feather: 3, opacity: 0.5 });
    expect(readStaticPropertyValue('a', 'mask.mk.feather')).toBe(3);
    expect(readStaticPropertyValue('a', 'mask.mk.opacity')).toBe(50);
    expect(writeStaticPropertyValue('a', 'mask.mk.opacity', 20)).toBe(true);
    expect(getNodeMask('a').paths[0]!.opacity).toBeCloseTo(0.2);
    expect(canWriteStaticPropertyValue('a', 'mask.nope.feather')).toBe(false);
  });
});
