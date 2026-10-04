/**
 * The assistant's `create_precomp` makes the same thing the user's Pre-compose
 * does: a REAL composition holding the layers, and a composition layer in their
 * place — and `set_time_remap` then works on that layer.
 *
 * It used to build an in-place precomp GROUP, so the assistant's precomps were
 * a different kind of object from everyone else's; and `set_time_remap`
 * accepted only `kind === 'group'`, which a composition layer is not.
 */

import { ToolRegistry } from '@motion/ai-tools';
import type { ToolContext } from '@motion/ai-tools';
import { buildAiTools } from './toolHandlers';
import { createToolContext } from './toolContext';
import { documentMirror } from '@stores/documentMirror';
import { readNodeKind } from '@core/scene/sceneDerive';
import { useProjectStore } from '@stores/projectStore';
import type { SceneNode } from '@core/types';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { engineIdle } from '@core/engine/engineInstance';

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of buildAiTools()) r.register(t);
  return r;
}

const ctx = (): ToolContext => createToolContext(new AbortController().signal);

// Enabling Time Remapping is an engine command (`setTimeRemap`): the turn's
// writes need the app engine.
let h: Awaited<ReturnType<typeof setupAppEngine>> | null = null;
afterEach(async () => { await h?.dispose(); h = null; });

let A = '';
let B = '';
beforeEach(async () => {
  h = await setupAppEngine();
  A = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'a', init: [] })).layer;
  B = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'b', init: [] })).layer;
  await engineIdle();
});

const compLayerIn = async (rootId: string): Promise<SceneNode | undefined> =>
  (await docView()).getChildren(rootId).find((n) => readNodeKind(n) === 'comp');

describe('create_precomp', () => {
  it('makes a real composition and a composition layer in the layers’ place', async () => {
    const res = await registry().execute('create_precomp', { nodeIds: [A, B], name: 'Logo' }, ctx());
    expect(res.ok ? true : res.content).toBe(true);

    const inst = (await compLayerIn('comp_root'))!;
    expect(inst).toBeDefined();
    const compId = documentMirror().layer(inst.id)!.source!;
    expect(useProjectStore.getState().comps[compId]?.name).toBe('Logo');
    expect((await docView()).getNode(compId)?.parent).toBeNull();
    expect((await docView()).getNode(A)?.parent).toBe(compId);
    expect((await docView()).getNode(B)?.parent).toBe(compId);
  });

  it('leaves a composition layer that set_time_remap can retime', async () => {
    await registry().execute('create_precomp', { nodeIds: [A], name: 'Bug' }, ctx());
    const inst = (await compLayerIn('comp_root'))!;

    const res = await registry().execute(
      'set_time_remap',
      { nodeId: inst.id, keys: [{ t: 0, sourceT: 0 }, { t: 1, sourceT: 2 }] },
      ctx(),
    );
    expect(res.ok ? true : res.content).toBe(true);
    expect((await docView()).isAnimated(inst.id, 'timeRemap')).toBe(true);
    // Exactly the keys the call named: Enable Time Remapping's out-point key is gone.
    expect((await docView()).getTrackKeyframes(inst.id, 'timeRemap')?.map((k) => k.value)).toEqual([0, 2]);
    // Its precomp flag is what makes it render its comp — never cleared.
    expect(documentMirror().layer(inst.id)?.kind).toBe('precomp');
  });
});
