/**
 * Effect copy/paste and presets.
 *
 * The load-bearing assertion is IDENTITY: a pasted effect must not share an id
 * with its source, because ids key both the keyframe prop paths
 * (`effect.<id>.<param>`) and the renderer's per-effect caching. Two layers
 * sharing one id means editing either one moves both.
 */

import SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { addEffect, getNodeEffects, updateEffectParam, effectPropPath } from './effects';
import {
  copyEffects,
  copyAllEffects,
  pasteEffects,
  clearEffectClipboard,
  hasEffectClipboard,
  effectClipboardSize,
  saveEffectPreset,
  applyEffectPreset,
  listEffectPresets,
  deleteEffectPreset,
} from './effectClipboard';
import type { SceneNode } from '@core/types';

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
  defaultSceneGraph.addNode(node('a'));
  defaultSceneGraph.addNode(node('b'));
  defaultAnimation.clear();
  clearEffectClipboard();
  localStorage.clear();
});

describe('copy / paste between layers', () => {
  it('pastes the effect onto another layer', () => {
    addEffect('a', 'blur');
    copyAllEffects('a');
    expect(hasEffectClipboard()).toBe(true);
    expect(pasteEffects(['b'])).toBe(1);
    expect(getNodeEffects('b').map((e) => e.type)).toEqual(['blur']);
  });

  it('gives the pasted effect a FRESH id — the whole point', () => {
    addEffect('a', 'glow');
    const srcId = getNodeEffects('a')[0]!.id;
    copyAllEffects('a');
    pasteEffects(['b']);
    expect(getNodeEffects('b')[0]!.id).not.toBe(srcId);
  });

  it('gives each target its own id when pasting to several layers', () => {
    addEffect('a', 'blur');
    copyAllEffects('a');
    pasteEffects(['a', 'b']);
    const idsA = getNodeEffects('a').map((e) => e.id);
    const idsB = getNodeEffects('b').map((e) => e.id);
    expect(new Set([...idsA, ...idsB]).size).toBe(idsA.length + idsB.length);
  });

  it('carries the configured parameter values', () => {
    addEffect('a', 'blur');
    const id = getNodeEffects('a')[0]!.id;
    updateEffectParam('a', id, 'amount', 23);
    copyAllEffects('a');
    pasteEffects(['b']);
    expect(getNodeEffects('b')[0]!.params!.amount).toBe(23);
  });

  it('carries KEYFRAMED parameters, re-keyed onto the new id', () => {
    addEffect('a', 'blur');
    const srcId = getNodeEffects('a')[0]!.id;
    const srcProp = `${effectPropPath(srcId)}.amount`;
    defaultAnimation.setKeyframe('a', srcProp, 0, 0);
    defaultAnimation.setKeyframe('a', srcProp, 1, 40);

    copyAllEffects('a');
    pasteEffects(['b']);

    const dstId = getNodeEffects('b')[0]!.id;
    const dstProp = `${effectPropPath(dstId)}.amount`;
    expect(defaultAnimation.isAnimated('b', dstProp)).toBe(true);
    expect(defaultAnimation.sample('b', dstProp, 0.5)).toBeCloseTo(20, 6);
  });

  it('does not couple the source and target animations', () => {
    addEffect('a', 'blur');
    const srcId = getNodeEffects('a')[0]!.id;
    defaultAnimation.setKeyframe('a', `${effectPropPath(srcId)}.amount`, 0, 10);
    copyAllEffects('a');
    pasteEffects(['b']);
    const dstId = getNodeEffects('b')[0]!.id;

    defaultAnimation.setKeyframe('b', `${effectPropPath(dstId)}.amount`, 0, 99);
    // The source is untouched.
    expect(defaultAnimation.sample('a', `${effectPropPath(srcId)}.amount`, 0)).toBe(10);
  });

  it('APPENDS rather than replacing the target stack', () => {
    addEffect('a', 'blur');
    addEffect('b', 'tint');
    copyAllEffects('a');
    pasteEffects(['b']);
    expect(getNodeEffects('b').map((e) => e.type)).toEqual(['tint', 'blur']);
  });

  it('preserves stack order across a multi-effect copy', () => {
    addEffect('a', 'blur');
    addEffect('a', 'glow');
    addEffect('a', 'tint');
    copyAllEffects('a');
    expect(effectClipboardSize()).toBe(3);
    pasteEffects(['b']);
    expect(getNodeEffects('b').map((e) => e.type)).toEqual(['blur', 'glow', 'tint']);
  });

  it('copies a SUBSET when given ids', () => {
    addEffect('a', 'blur');
    addEffect('a', 'glow');
    const glowId = getNodeEffects('a')[1]!.id;
    copyEffects('a', [glowId]);
    pasteEffects(['b']);
    expect(getNodeEffects('b').map((e) => e.type)).toEqual(['glow']);
  });

  it('is a no-op with an empty clipboard or no targets', () => {
    expect(pasteEffects(['b'])).toBe(0);
    addEffect('a', 'blur');
    copyAllEffects('a');
    expect(pasteEffects([])).toBe(0);
    expect(getNodeEffects('b')).toEqual([]);
  });

  it('copying an effect-less layer leaves the clipboard alone', () => {
    addEffect('a', 'blur');
    copyAllEffects('a');
    copyAllEffects('b'); // b has none
    expect(effectClipboardSize()).toBe(1);
  });
});

describe('effect presets', () => {
  it('saves and re-applies a configured stack', () => {
    addEffect('a', 'blur');
    updateEffectParam('a', getNodeEffects('a')[0]!.id, 'amount', 17);
    expect(saveEffectPreset('a', 'My Look')).toBe(true);

    expect(applyEffectPreset('My Look', ['b'])).toBe(true);
    expect(getNodeEffects('b')[0]!.type).toBe('blur');
    expect(getNodeEffects('b')[0]!.params!.amount).toBe(17);
  });

  it('re-keys preset effects too, so two layers never share an id', () => {
    addEffect('a', 'glow');
    saveEffectPreset('a', 'P');
    applyEffectPreset('P', ['a']);
    const ids = getNodeEffects('a').map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not clobber the clipboard when applying a preset', () => {
    addEffect('a', 'blur');
    saveEffectPreset('a', 'P');
    addEffect('a', 'tint');
    copyEffects('a', [getNodeEffects('a')[1]!.id]); // clipboard = tint
    applyEffectPreset('P', ['b']);
    pasteEffects(['b']);
    // The paste used the CLIPBOARD (tint), not the preset.
    expect(getNodeEffects('b').map((e) => e.type)).toEqual(['blur', 'tint']);
  });

  it('refuses to save an empty stack', () => {
    expect(saveEffectPreset('b', 'Nope')).toBe(false);
    expect(listEffectPresets()).toEqual([]);
  });

  it('replaces a preset of the same name rather than duplicating it', () => {
    addEffect('a', 'blur');
    saveEffectPreset('a', 'P');
    saveEffectPreset('a', 'P');
    expect(listEffectPresets().filter((p) => p.name === 'P')).toHaveLength(1);
  });

  it('reports a missing preset instead of silently doing nothing', () => {
    expect(applyEffectPreset('ghost', ['b'])).toBe(false);
  });

  it('deletes a preset', () => {
    addEffect('a', 'blur');
    saveEffectPreset('a', 'P');
    deleteEffectPreset('P');
    expect(listEffectPresets()).toEqual([]);
  });

  it('survives unreadable storage rather than throwing', () => {
    localStorage.setItem('motion-editor.effectPresets.v1', 'not json');
    expect(listEffectPresets()).toEqual([]);
  });
});
