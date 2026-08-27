/**
 * Parenting a layer must not cost it its timeline clip.
 *
 * In this scene graph `parent` IS the tree, so parenting a rect to a null
 * physically nests it under the null. `syncFromScene` used to mirror only the
 * comp root's IMMEDIATE children — the moment a layer was parented, its clip
 * was garbage-collected as "source node gone": the row, its keyframes and its
 * duration bar all vanished from the timeline while the viewport (which
 * flattens the whole subtree) kept rendering and hit-testing the layer.
 * The After Effects rule this pins: a layer keeps its place in the timeline
 * stack no matter who its parent is; only GROUPS collapse their members.
 */

import { getTimelineController } from './TimelineController';
import { reparentNode } from '@core/scene/parenting';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { useProjectStore } from '@stores/projectStore';
import type { SceneNode } from '@core/types';

const RECT = 'pl_rect';
const NULL = 'pl_null';
const GROUP = 'pl_group';
const MEMBER = 'pl_member';

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

function shapeNode(id: string, kind: string, parent: string): SceneNode {
  return {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 10, y: 10, width: 20, height: 20 } },
    ],
  } as unknown as SceneNode;
}

beforeEach(() => {
  resetScene();
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Main', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  defaultSceneGraph.addChild('comp_root', shapeNode(RECT, 'shape', 'comp_root') as never);
  defaultSceneGraph.addChild('comp_root', shapeNode(NULL, 'null', 'comp_root') as never);
  useProjectStore.getState().actions.replaceComps({
    comp_root: {
      id: 'comp_root', name: 'Main', width: 1920, height: 1080, fps: 30,
      durationSeconds: 10, background: '#101014', transparent: false, startFrame: 0,
    },
  });
  const proj = useProjectStore.getState();
  const tabId = proj.actions.openTab('comp_root', ['comp_root'], 'Main');
  proj.actions.setActiveTab(tabId);
  getTimelineController().syncFromScene('comp_root');
});

describe('parented layers keep their timeline clips', () => {
  it('a layer parented to a null keeps the SAME clip, including its trim', () => {
    const c = getTimelineController();
    const before = c.getLayersForNode(RECT);
    expect(before).toHaveLength(1);
    const clipId = before[0]!.id;
    // User-edited geometry that must survive the reparent untouched.
    c.setClipStart(clipId, 2);

    expect(reparentNode(RECT, NULL)).toBe(true);
    c.syncFromScene('comp_root');

    const after = c.getLayersForNode(RECT);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(clipId); // same clip object, not a re-add
    expect(after[0]!.start).toBe(Math.round(2 * 30));
  });

  it('un-parenting keeps the clip too', () => {
    const c = getTimelineController();
    const clipId = c.getLayersForNode(RECT)[0]!.id;
    reparentNode(RECT, NULL);
    c.syncFromScene('comp_root');
    reparentNode(RECT, null);
    c.syncFromScene('comp_root');
    expect(c.getLayersForNode(RECT).map((l) => l.id)).toEqual([clipId]);
  });

  it('GROUP members still do not get independent clips (a group is one unit)', () => {
    const c = getTimelineController();
    defaultSceneGraph.addChild('comp_root', {
      ...shapeNode(GROUP, 'group', 'comp_root'),
      components: [{ id: `${GROUP}_g`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
    } as never);
    defaultSceneGraph.addChild(GROUP, shapeNode(MEMBER, 'shape', GROUP) as never);
    c.syncFromScene('comp_root');
    expect(c.getLayersForNode(GROUP)).toHaveLength(1);
    expect(c.getLayersForNode(MEMBER)).toHaveLength(0);
  });

  it('a layer parented to another ORDINARY layer keeps its clip as well', () => {
    const c = getTimelineController();
    defaultSceneGraph.addChild('comp_root', shapeNode('pl_other', 'shape', 'comp_root') as never);
    c.syncFromScene('comp_root');
    const clipId = c.getLayersForNode('pl_other')[0]!.id;
    reparentNode('pl_other', RECT);
    c.syncFromScene('comp_root');
    expect(c.getLayersForNode('pl_other').map((l) => l.id)).toEqual([clipId]);
  });
});
