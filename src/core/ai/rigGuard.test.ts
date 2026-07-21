/**
 * Honest gating on the AI rig tools: create_puppet_rig / create_skeleton_rig
 * must REJECT a group / precomp target (a rig has no mesh to warp there) with a
 * repair hint pointing at "Rig Logo", instead of silently no-opping.
 */

import { ToolRegistry } from '@motion/ai-tools';
import type { ToolContext } from '@motion/ai-tools';
import { buildAiTools } from './toolHandlers';
import { createToolContext } from './toolContext';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of buildAiTools()) r.register(t);
  return r;
}

function node(id: string, kind: string): SceneNode {
  const components: SceneNode['components'] =
    kind === 'group'
      ? [{ id: `${id}_m`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }]
      : [
          { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 0, y: 0, width: 100, height: 100 } },
          { id: `${id}_s`, type: 'Style', props: { opacity: 100 } },
        ];
  return { id, name: id, parent: null, children: [], transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } }, visible: true, locked: false, components };
}

function reset(): void {
  defaultAnimation.clear();
  defaultSceneGraph.clear();
  defaultSceneGraph.addNode({
    id: 'comp_root',
    name: 'Composition 1',
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: 'comp_root_meta', type: 'group', props: { __kind: 'group' } }],
  });
}

const ctx = (): ToolContext => createToolContext(new AbortController().signal);

describe('rig-tool gating', () => {
  beforeEach(reset);

  it('create_puppet_rig rejects a group with a Rig-Logo hint', async () => {
    defaultSceneGraph.addChild('comp_root', node('logo', 'group'));
    const res = await registry().execute(
      'create_puppet_rig',
      { layerId: 'logo', pins: [{ name: 'a', x: 0, y: 0 }] },
      ctx(),
    );
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/Rig Logo/i);
    // The group carries no puppet rig.
    const fx = defaultSceneGraph.getNode('logo')?.components.find((c) => c.type === 'fx');
    expect(fx?.props.puppet).toBeUndefined();
  });

  it('create_puppet_rig accepts a shape layer', async () => {
    defaultSceneGraph.addChild('comp_root', node('shp', 'shape'));
    const res = await registry().execute(
      'create_puppet_rig',
      { layerId: 'shp', pins: [{ name: 'a', x: 0, y: 0 }] },
      ctx(),
    );
    expect(res.ok).toBe(true);
    const fx = defaultSceneGraph.getNode('shp')?.components.find((c) => c.type === 'fx');
    expect(fx?.props.puppet).toBeDefined();
  });

  it('create_skeleton_rig rejects a group', async () => {
    defaultSceneGraph.addChild('comp_root', node('logo2', 'group'));
    const res = await registry().execute(
      'create_skeleton_rig',
      { layerId: 'logo2', bones: [{ id: 'b0', length: 50 }] },
      ctx(),
    );
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/Rig Logo/i);
  });
});
