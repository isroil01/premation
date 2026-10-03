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
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { readCompRef } from '@core/scene/compInstance';
import { readNodeKind } from '@core/scene/sceneDerive';
import { isPrecomp } from '@core/scene/precomp';
import { useProjectStore } from '@stores/projectStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import type { SceneNode } from '@core/types';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of buildAiTools()) r.register(t);
  return r;
}

const ctx = (): ToolContext => createToolContext(new AbortController().signal);

function layer(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 100, y: 100, width: 100, height: 100 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ffffff' } },
    ],
  } as unknown as SceneNode;
}

// Enabling Time Remapping is an engine command (`setTimeRemap`): the turn's
// writes need the app engine.
let h: Awaited<ReturnType<typeof setupAppEngine>> | null = null;
afterEach(async () => { await h?.dispose(); h = null; });

beforeEach(async () => {
  h = await setupAppEngine();
  defaultAnimation.clear();
  defaultSceneGraph.clear();
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Main', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { __kind: 'group' } }],
  } as unknown as SceneNode);
  const actions = useProjectStore.getState().actions;
  actions.resetTabs();
  actions.replaceComps({
    comp_root: { id: 'comp_root', name: 'Main', width: 1920, height: 1080, fps: 30, durationSeconds: 10, background: '#101014', transparent: false, startFrame: 0 },
  });
  defaultSceneGraph.addChild('comp_root', layer('a') as never);
  defaultSceneGraph.addChild('comp_root', layer('b') as never);
  getTimelineController().syncFromScene('comp_root');
});

const compLayerIn = async (rootId: string): Promise<SceneNode | undefined> =>
  (await docView()).getChildren(rootId).find((n) => readNodeKind(n) === 'comp');

describe('create_precomp', () => {
  it('makes a real composition and a composition layer in the layers’ place', async () => {
    const res = await registry().execute('create_precomp', { nodeIds: ['a', 'b'], name: 'Logo' }, ctx());
    expect(res.ok ? true : res.content).toBe(true);

    const inst = (await compLayerIn('comp_root'))!;
    expect(inst).toBeDefined();
    const compId = readCompRef(inst)!;
    expect(useProjectStore.getState().comps[compId]?.name).toBe('Logo');
    expect((await docView()).getNode(compId)?.parent).toBeNull();
    expect((await docView()).getNode('a')?.parent).toBe(compId);
    expect((await docView()).getNode('b')?.parent).toBe(compId);
  });

  it('leaves a composition layer that set_time_remap can retime', async () => {
    await registry().execute('create_precomp', { nodeIds: ['a'], name: 'Bug' }, ctx());
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
    expect(isPrecomp((await docView()).getNode(inst.id)!)).toBe(true);
  });
});
