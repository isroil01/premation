/**
 * The Animate menu's text rigs through the engine API: ONE entry that adds a
 * text animator (its property values as `init`), sets its range selector's
 * options and keys the selector — undo takes the whole rig back.
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import { sec } from '@core/engine/__testHelpers__/harness';
import { engineIdle } from '@core/engine/engineInstance';
import { TEXT_RIGS, addExpressionControlEdit, textRigEdit } from './topNavEdits';

let h: Harness;

beforeEach(async () => {
  h = await setupAppEngine();
});

afterEach(async () => {
  await h.dispose();
});

async function addText(): Promise<string> {
  const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'text', name: 'Title', init: [] });
  await engineIdle();
  return layer;
}

async function tree(layer: string): Promise<Map<string, { value: unknown; animated: boolean }>> {
  const t = await h.query({ type: 'getPropertyTree', layer, path: 'text/animators', depth: 0 });
  return new Map(t.nodes.map((n) => [n.path, n as unknown as { value: unknown; animated: boolean }]));
}

describe('text rigs', () => {
  it('Tracking Reveal: animator + selector options + two keys as ONE entry; undo restores', async () => {
    const layer = await addText();
    const before = h.doc();
    const entries = historyLabels().length;

    expect(await textRigEdit(layer, TEXT_RIGS.trackingReveal, 0)).toBe(true);
    await engineIdle();

    const nodes = await tree(layer);
    const animator = [...nodes.keys()].find((p) => /^text\/animators\/[^/]+$/.test(p));
    expect(animator).toBeDefined();
    expect(nodes.get(`${animator}/props/tracking`)?.value).toEqual({ kind: 'scalar', value: 40 });
    expect(nodes.get(`${animator}/props/opacity`)?.value).toEqual({ kind: 'scalar', value: 0 });
    const selector = [...nodes.keys()].find((p) => new RegExp(`^${animator}/selectors/[^/]+$`).test(p));
    expect(selector).toBeDefined();
    expect(nodes.get(`${selector}/basedOn`)?.value).toEqual({ kind: 'choice', value: 'characters' });
    expect(nodes.get(`${selector}/shape`)?.value).toEqual({ kind: 'choice', value: 'square' });
    expect(nodes.get(`${selector}/start`)?.animated).toBe(true);

    const keys = await h.query({ type: 'getKeyframes', props: [{ layer, path: `${selector}/start` }] });
    const set = keys.sets[0]!.keyframes;
    expect(set.map((k) => k.time)).toEqual([0, sec(1.5)]);
    expect(set.map((k) => k.value)).toEqual([{ kind: 'scalar', value: 0 }, { kind: 'scalar', value: 100 }]);

    expect(historyLabels().slice(entries)).toEqual(['Tracking Reveal']);
    await h.run({ type: 'undo' });
    await engineIdle();
    expect(h.doc()).toBe(before);
  });

  it('refuses a non-layer and leaves no entry', async () => {
    const entries = historyLabels().length;
    expect(await textRigEdit('nope', TEXT_RIGS.bounceInWords, 0)).toBe(false);
    expect(historyLabels()).toHaveLength(entries);
  });
});

describe('Add Expression Control', () => {
  it('one addPropertyGroup = ONE entry; resolves the name ctrl() takes; undo restores', async () => {
    const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'null', name: 'Rig', init: [] });
    await engineIdle();
    const before = h.doc();
    const entries = historyLabels().length;
    expect(await addExpressionControlEdit(layer, 'point')).toBe('Point 1');
    expect(await addExpressionControlEdit(layer, 'slider')).toBe('Slider 1');
    await engineIdle();
    expect(historyLabels().slice(entries)).toEqual(['Add Expression Control', 'Add Expression Control']);
    const t = await h.query({ type: 'getPropertyTree', layer, path: 'effects', depth: 0 });
    expect(t.nodes.find((n) => n.path === 'effects/ctrl_Point 1')?.matchName).toBe('ADBE Point Control');
    await h.run({ type: 'undo' });
    await h.run({ type: 'undo' });
    expect(h.doc()).toBe(before);
  });
});
