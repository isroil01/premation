/**
 * The project document round-trip: what Save writes, Open reads.
 *
 * Two bugs this locks down:
 *  1. The ProjectManager's IO was `sceneProjectIO` — SCENE ONLY. Saving a
 *     `.motion` wrote geometry and silently dropped every keyframe, comp
 *     setting and timeline edit.
 *  2. `File ▸ Export ▸ Project` wrote its own shape (`{version, scene,
 *     animation}`) that the loader couldn't read: it looks for a top-level
 *     `nodes`, found none, and opened a SILENTLY EMPTY scene — while the preset
 *     advertised "Re-openable Motion project file".
 */

import { projectDocumentIO } from './projectDocumentIO';
import { projectService } from '@core/persistence/ProjectService';
import { useProjectStore } from '@stores/projectStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { defaultAnimation } from '@motion/animation';
import type { EditorDocument } from '@core/api/cloudDocument';
import type { SceneNode } from '@core/types';

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

function seedProject(): void {
  resetScene();
  defaultAnimation.clear();
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Main', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  defaultSceneGraph.addChild('comp_root', {
    id: 'box', name: 'box', parent: 'comp_root', children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'box_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 10, y: 10 } }],
  } as never);
  useProjectStore.getState().actions.replaceComps({
    comp_root: {
      id: 'comp_root', name: 'Main', width: 1280, height: 720, fps: 48,
      durationSeconds: 7, background: '#123456', transparent: false, startFrame: 0,
    },
  });
  defaultAnimation.setKeyframe('box', 'x', 0, 10);
  defaultAnimation.setKeyframe('box', 'x', 2, 500);
}

/** Save to a string and load it back, exactly as ProjectManager does. */
function roundTrip(): void {
  const json = projectService.serialize(projectDocumentIO.capture());
  // Wipe everything, so anything that survives really came from the file — a
  // reader that left live state in place would otherwise pass by accident.
  resetScene();
  defaultAnimation.clear();
  useProjectStore.getState().actions.replaceComps({});
  getTimelineController().clearWorkArea();
  projectDocumentIO.restore(projectService.parse(json) as EditorDocument);
}

beforeEach(seedProject);

describe('save → open', () => {
  it('keeps the scene', () => {
    roundTrip();
    expect(defaultSceneGraph.getNode('box')).toBeDefined();
  });

  it('keeps the KEYFRAMES', () => {
    // The regression: a `.motion` save wrote the scene only, so every
    // animation was silently gone on reopen.
    roundTrip();
    expect(defaultAnimation.getTrackKeyframes('box', 'x')).toHaveLength(2);
    expect(defaultAnimation.sample('box', 'x', 2)).toBe(500);
  });

  it('keeps the composition settings', () => {
    roundTrip();
    expect(useProjectStore.getState().comps.comp_root).toMatchObject({
      width: 1280, height: 720, fps: 48, durationSeconds: 7, background: '#123456',
    });
  });

  it('keeps the timeline (work area survives)', () => {
    getTimelineController().setWorkArea(1, 3);
    const before = getTimelineController().getWorkArea();

    roundTrip();

    expect(getTimelineController().getWorkArea()).toEqual(before);
  });

  it('produces a document the serializer accepts', () => {
    // serializeProject throws without a version.
    expect(() => projectService.serialize(projectDocumentIO.capture())).not.toThrow();
  });
});

describe('createEmpty', () => {
  it('is a restorable document with a composition root', () => {
    const empty = projectDocumentIO.createEmpty('Untitled');
    projectDocumentIO.restore(empty);
    expect(defaultSceneGraph.getRoots().length).toBeGreaterThan(0);
  });
});

describe('legacy scene-only files', () => {
  it('opens a bare ProjectFile written by an older build', () => {
    // Older `.motion` files are `{version, nodes}` with no `scene` wrapper.
    const legacy = {
      version: '1.0.0',
      nodes: [
        {
          id: 'comp_root', name: 'Old', parent: null, children: [], visible: true, locked: false,
          transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
          components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
        },
      ],
    };

    resetScene();
    projectDocumentIO.restore(legacy as never);

    // Opening it must yield the scene, not an empty project.
    expect(defaultSceneGraph.getNode('comp_root')).toBeDefined();
  });
});
