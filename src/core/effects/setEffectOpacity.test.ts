/**
 * setEffectOpacity — the writer behind Effect Controls → Compositing Options →
 * Effect Opacity, plus the timeline row it earns.
 *
 * The behaviour worth pinning is the ASYMMETRY at 100: writing 100 CLEARS the
 * field rather than storing it, because absent is the state that lets the
 * effect keep its GPU-native path (see `Effect.opacity`), and an author who
 * drags the slider back to full expects the effect to cost what it did before
 * they touched it. Everything else is an ordinary clamp.
 */

import SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';
import {
  addEffect,
  getNodeEffects,
  setEffectMaskId,
  setEffectOpacity,
  effectOpacityPath,
} from './effects';
import { effectsNeedCpuBake } from './effectBake';
import { buildStaticPropertyTree } from '@core/timeline/propertyTree';

function node(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0 } },
      { id: `${id}_s`, type: 'Style', props: { fill: '#fff', opacity: 100 } },
    ],
  };
}

describe('setEffectOpacity', () => {
  beforeEach(() => {
    (defaultSceneGraph as unknown as SceneGraph).clear();
    (defaultSceneGraph as unknown as SceneGraph).addNode(node('layer'));
    addEffect('layer', 'blur', 'fx_blur');
  });

  const fx = () => getNodeEffects('layer')[0]!;

  it('stores a partial value and leaves params alone', () => {
    const before = fx();
    expect(before.opacity).toBeUndefined();

    setEffectOpacity('layer', 'fx_blur', 40);
    expect(fx().opacity).toBe(40);
    expect(fx().params).toEqual(before.params);
  });

  it('CLEARS the field at 100 rather than storing it', () => {
    setEffectOpacity('layer', 'fx_blur', 40);
    setEffectOpacity('layer', 'fx_blur', 100);
    // Omitted, not stored — absent is what returns the effect to its GPU path.
    expect('opacity' in fx()).toBe(false);
    expect(effectsNeedCpuBake([fx()])).toBe(false);
  });

  it('stores 0, which is a real setting and not a clear', () => {
    setEffectOpacity('layer', 'fx_blur', 0);
    expect(fx().opacity).toBe(0);
    expect(effectsNeedCpuBake([fx()])).toBe(true);
  });

  it('clears on undefined and clamps out-of-range input', () => {
    setEffectOpacity('layer', 'fx_blur', 40);
    setEffectOpacity('layer', 'fx_blur', undefined);
    expect('opacity' in fx()).toBe(false);

    setEffectOpacity('layer', 'fx_blur', -20);
    expect(fx().opacity).toBe(0);
    setEffectOpacity('layer', 'fx_blur', 250); // ≥100 reads as "back to full"
    expect('opacity' in fx()).toBe(false);
  });

  it('does not disturb a mask scope set on the same effect', () => {
    // They are one section in the UI and one composite in the bake, but two
    // independent fields — setting either must not clear the other.
    setEffectMaskId('layer', 'fx_blur', 'm1');
    setEffectOpacity('layer', 'fx_blur', 30);
    expect(fx().maskId).toBe('m1');
    expect(fx().opacity).toBe(30);

    setEffectOpacity('layer', 'fx_blur', 100);
    expect(fx().maskId).toBe('m1');
  });

  it('touches only the addressed effect', () => {
    addEffect('layer', 'glow', 'fx_glow');
    setEffectOpacity('layer', 'fx_blur', 25);
    expect(getNodeEffects('layer').find((e) => e.id === 'fx_glow')!.opacity).toBeUndefined();
  });
});

describe('the timeline row', () => {
  beforeEach(() => {
    (defaultSceneGraph as unknown as SceneGraph).clear();
    (defaultSceneGraph as unknown as SceneGraph).addNode(node('layer'));
    addEffect('layer', 'blur', 'fx_blur');
  });

  const paths = () => buildStaticPropertyTree('layer').map((r) => r.prop);

  it('appears once the dial is in use and retires when it is not', () => {
    // Unconditional listing would add a row to every effect on every layer for
    // a dial almost none of them are using.
    expect(paths()).not.toContain(effectOpacityPath('fx_blur'));

    setEffectOpacity('layer', 'fx_blur', 40);
    expect(paths()).toContain(effectOpacityPath('fx_blur'));

    setEffectOpacity('layer', 'fx_blur', 100);
    expect(paths()).not.toContain(effectOpacityPath('fx_blur'));
  });

  it('does not displace the effect own parameter rows', () => {
    setEffectOpacity('layer', 'fx_blur', 40);
    // Blur's declared params still have theirs, and the opacity row is last —
    // where AE draws Compositing Options.
    const effectPaths = paths().filter((p) => p.startsWith('effect.fx_blur'));
    expect(effectPaths.length).toBeGreaterThan(1);
    expect(effectPaths[effectPaths.length - 1]).toBe(effectOpacityPath('fx_blur'));
  });
});
