/**
 * Quick Apply — effects and presets reachable from the palette.
 *
 * The claim under test: typing a few letters of an effect applies it to the
 * selection on Enter, for every selected layer, and a preset that cannot act
 * on the selection says so up front instead of applying and doing nothing.
 */

import SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { getNodeEffects } from '@core/effects/effects';
import { useSelectionStore } from '@stores/selectionStore';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import type { SceneNode } from '@core/types';
import { effectHits, presetHits } from './quickApply';
import { parseQuery } from './paletteSearch';

function node(id: string, kind = 'shape'): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 0, y: 0 } },
      { id: `${id}_s`, type: 'Style', props: { fill: '#fff', opacity: 100 } },
      ...(kind === 'text' ? [{ id: `${id}_c`, type: 'Text', props: { content: 'Hi', fontSize: 32 } }] : []),
    ],
  };
}

beforeAll(() => {
  // runAnimEdit records onto the command system — boot a minimal one.
  const dummyServices = {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  } as never;
  setCommandSystem(new CommandSystem({ services: dummyServices, getState: () => ({}) }));
});

beforeEach(() => {
  (defaultSceneGraph as unknown as SceneGraph).clear();
  defaultAnimation.clear();
  defaultSceneGraph.addNode(node('a'));
  defaultSceneGraph.addNode(node('b'));
  defaultSceneGraph.addNode(node('t', 'text'));
  useSelectionStore.getState().set([]);
});

describe('mode prefixes', () => {
  it('route + to effects and * to presets', () => {
    expect(parseQuery('+glow')).toEqual({ mode: 'effects', term: 'glow' });
    expect(parseQuery('* fade')).toEqual({ mode: 'presets', term: 'fade' });
  });
});

describe('effects', () => {
  it('finds an effect by a few letters and files it under its folder', () => {
    const hits = effectHits('gaus', 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.label).toMatch(/Gaussian/i);
    expect(hits[0]!.hint).toBe('Blur & Sharpen');
  });

  it('is disabled with nothing selected, and applies to EVERY selected layer', () => {
    expect(effectHits('gaus', 1)[0]!.enabled).toBe(false);
    useSelectionStore.getState().set(['a', 'b']);
    const hit = effectHits('gaus', 1)[0]!;
    expect(hit.enabled).toBe(true);
    hit.apply();
    expect(getNodeEffects('a')).toHaveLength(1);
    expect(getNodeEffects('b')).toHaveLength(1);
  });

  it('matches on the folder name as a fallback, ranked below label hits', () => {
    const hits = effectHits('Blur & Sharpen', 40);
    expect(hits.every((h) => h.hint === 'Blur & Sharpen' || /blur|sharpen/i.test(h.label))).toBe(true);
  });
});

describe('presets', () => {
  it('marks a text-only preset disabled on a shape, enabled on text', () => {
    useSelectionStore.getState().set(['a']);
    const onShape = presetHits('typewriter', 5).find((h) => /typewriter/i.test(h.label));
    useSelectionStore.getState().set(['t']);
    const onText = presetHits('typewriter', 5).find((h) => /typewriter/i.test(h.label));
    // If the library carries no typewriter preset the assertion is vacuous —
    // guard so a renamed preset fails loudly instead of passing silently.
    expect(onShape && onText).toBeTruthy();
    expect(onShape!.enabled).toBe(false);
    expect(onText!.enabled).toBe(true);
  });

  it('applies a preset at the playhead and leaves keyframes behind', () => {
    useSelectionStore.getState().set(['a']);
    const hit = presetHits('', 200).find((h) => h.enabled)!;
    expect(hit).toBeDefined();
    hit.apply();
    expect(defaultAnimation.tracksFor('a').length + defaultAnimation.dataTracksFor('a').length).toBeGreaterThan(0);
  });
});
