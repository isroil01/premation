/**
 * The two pieces of Effect-Controls behaviour that are logic rather than layout:
 * how a stack names two of a kind, and what Reset actually restores.
 *
 * Both were read off a screenshot of After Effects, and both are the kind of
 * rule that looks obviously right and is easy to get subtly wrong — numbering
 * from zero, numbering the first instance, resetting the wrong effect in the
 * stack, or leaving the legacy `amount` behind so a "reset" effect keeps the
 * look it had.
 */

import {
  EFFECT_DEFS,
  addEffect,
  getNodeEffects,
  effectDisplayNames,
  effectParam,
  resetEffectParams,
  setEffectLabelColor,
  updateEffectParam,
  primaryParamKey,
  type Effect,
} from './effects';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { SceneGraph } from '@core/scene/SceneGraph';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

const defOf = (type: string) => EFFECT_DEFS.find((d) => d.type === type)!;

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

beforeEach(() => {
  // `getNodeEffects` reads the process-wide graph, so seed that one.
  (defaultSceneGraph as unknown as SceneGraph).clear();
  defaultSceneGraph.addNode(node('L'));
});

describe('effectDisplayNames — AE numbering', () => {
  const named = (types: string[]): string[] => {
    const effects = types.map((type, i) => ({ id: `e${i}`, type }) as Effect);
    const names = effectDisplayNames(effects);
    return effects.map((e) => names.get(e.id)!);
  };

  it('leaves a lone effect unnumbered', () => {
    expect(named(['blur'])).toEqual([defOf('blur').label]);
  });

  it('numbers from the SECOND of a kind, not the first', () => {
    const label = defOf('blur').label;
    // AE reads "CC Smear / CC Smear 2 / CC Smear 3 / CC Smear 4" — the first
    // keeps its plain name. Numbering all four would be the easy mistake.
    expect(named(['blur', 'blur', 'blur', 'blur'])).toEqual([
      label, `${label} 2`, `${label} 3`, `${label} 4`,
    ]);
  });

  it('counts each type independently, in stack order', () => {
    const blur = defOf('blur').label;
    const glow = defOf('glow').label;
    expect(named(['blur', 'glow', 'blur', 'glow'])).toEqual([
      blur, glow, `${blur} 2`, `${glow} 2`,
    ]);
  });
});

describe('resetEffectParams', () => {
  /** A layer with two Glows, the first one edited away from its defaults. */
  const setup = (): { nodeId: string; first: Effect; second: Effect; key: string } => {
    const nodeId = 'L';
    addEffect(nodeId, 'glow');
    addEffect(nodeId, 'glow');
    const [first, second] = getNodeEffects(nodeId);
    const key = primaryParamKey('glow')!;
    return { nodeId, first: first!, second: second!, key };
  };

  it('restores every parameter to its declared default', () => {
    const { nodeId, first, key } = setup();
    const original = effectParam(first, key);
    updateEffectParam(nodeId, first.id, key, 123);
    expect(effectParam(getNodeEffects(nodeId)[0]!, key)).toBe(123);

    resetEffectParams(nodeId, first.id);
    expect(effectParam(getNodeEffects(nodeId)[0]!, key)).toEqual(original);
  });

  it('resets ONLY the named effect — the other Glow is untouched', () => {
    const { nodeId, first, second, key } = setup();
    updateEffectParam(nodeId, first.id, key, 111);
    updateEffectParam(nodeId, second.id, key, 222);

    resetEffectParams(nodeId, first.id);
    const after = getNodeEffects(nodeId);
    expect(effectParam(after[1]!, key)).toBe(222);
  });

  it('drops the legacy `amount`, which would otherwise survive the reset', () => {
    // `paramsOf` folds `amount` in AHEAD of the stored params, so an effect that
    // came from an old project would read back its pre-reset value from a field
    // the reset never cleared — a reset that visibly does nothing.
    const nodeId = 'L';
    addEffect(nodeId, 'blur');
    const key = primaryParamKey('blur')!;
    const stored = getNodeEffects(nodeId);
    defaultSceneGraph.setEffects(nodeId, [{ ...stored[0]!, amount: 99, params: {} }]);
    expect(effectParam(getNodeEffects(nodeId)[0]!, key)).toBe(99);

    resetEffectParams(nodeId, stored[0]!.id);
    expect(effectParam(getNodeEffects(nodeId)[0]!, key)).toBe(defOf('blur').params[0]!.default);
  });

  it('is a no-op for an id that is not on the layer', () => {
    const { nodeId, first, key } = setup();
    updateEffectParam(nodeId, first.id, key, 77);
    resetEffectParams(nodeId, 'not-an-effect');
    expect(effectParam(getNodeEffects(nodeId)[0]!, key)).toBe(77);
  });

  it('keeps the effect label colour across a Reset', () => {
    const { nodeId, first, key } = setup();
    setEffectLabelColor(nodeId, first.id, '#5282b8');
    updateEffectParam(nodeId, first.id, key, 88);
    resetEffectParams(nodeId, first.id);
    expect(getNodeEffects(nodeId)[0]!.labelColor).toBe('#5282b8');
    expect(effectParam(getNodeEffects(nodeId)[0]!, key)).toBe(defOf('glow').params.find((p) => p.key === key)!.default);
  });
});

describe('setEffectLabelColor', () => {
  it('sets and clears labelColor on one effect', () => {
    addEffect('L', 'blur');
    const id = getNodeEffects('L')[0]!.id;
    setEffectLabelColor('L', id, '#4ea885');
    expect(getNodeEffects('L')[0]!.labelColor).toBe('#4ea885');
    setEffectLabelColor('L', id, undefined);
    expect(getNodeEffects('L')[0]!.labelColor).toBeUndefined();
  });

  it('does not touch sibling effects', () => {
    addEffect('L', 'blur');
    addEffect('L', 'glow');
    const [a, b] = getNodeEffects('L');
    setEffectLabelColor('L', a!.id, '#d0705a');
    expect(getNodeEffects('L')[0]!.labelColor).toBe('#d0705a');
    expect(getNodeEffects('L')[1]!.labelColor).toBeUndefined();
    expect(b!.id).toBe(getNodeEffects('L')[1]!.id);
  });
});
