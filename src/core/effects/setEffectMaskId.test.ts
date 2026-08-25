/**
 * setEffectMaskId — the writer Effect Controls needs so M6 scoped masks are
 * reachable without harness/AI. Bake already reads `Effect.maskId`.
 */

import SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';
import {
  addEffect,
  getNodeEffects,
  setEffectMaskId,
} from './effects';

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

describe('setEffectMaskId', () => {
  beforeEach(() => {
    (defaultSceneGraph as unknown as SceneGraph).clear();
    (defaultSceneGraph as unknown as SceneGraph).addNode(node('layer'));
  });

  it('sets and clears maskId without touching params', () => {
    addEffect('layer', 'blur', 'fx_blur');
    const before = getNodeEffects('layer')[0]!;
    expect(before.maskId).toBeUndefined();

    setEffectMaskId('layer', 'fx_blur', 'm1');
    expect(getNodeEffects('layer')[0]!.maskId).toBe('m1');
    expect(getNodeEffects('layer')[0]!.params).toEqual(before.params);

    setEffectMaskId('layer', 'fx_blur', undefined);
    expect(getNodeEffects('layer')[0]!.maskId).toBeUndefined();
    // Field omitted rather than left as '' — empty is not a scope.
    expect('maskId' in getNodeEffects('layer')[0]!).toBe(false);
  });

  it('treats empty string as unset', () => {
    addEffect('layer', 'blur', 'fx_blur');
    setEffectMaskId('layer', 'fx_blur', 'm1');
    setEffectMaskId('layer', 'fx_blur', '');
    expect(getNodeEffects('layer')[0]!.maskId).toBeUndefined();
  });
});
