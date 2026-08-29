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
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { useGuidesStore } from '@stores/guidesStore';
import { resetProjectWorkspace } from './projectSession';
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

  /**
   * A NEW project must not inherit the OLD project's settings.
   *
   * `restoreDocument` is tolerant of partial documents by design — an absent
   * key means "keep what you have", so a file written before a field existed
   * does not wipe it. That is right for opening a file and wrong for starting
   * a new project: `createEmpty` carried only scene + animation, so File ▸ New
   * Project kept the previous project's resolution, frame rate, duration and
   * shutter settings. A "new" project that silently exports at someone else's
   * settings.
   *
   * IF THIS FAILS you have added authored state to `captureDocument` without
   * giving `createEmpty` a default for it — which means New Project now
   * inherits that too.
   */
  it('resets the composition instead of inheriting the previous project', () => {
    // seedProject left 1280x720 @48fps / 7s behind.
    projectDocumentIO.restore(projectDocumentIO.createEmpty('Untitled'));

    const comps = Object.values(useProjectStore.getState().comps);
    expect(comps).toHaveLength(1);
    expect(comps[0]).toMatchObject({ width: 1920, height: 1080, fps: 30, durationSeconds: 10 });
  });

  it('resets render-affecting settings the previous project changed', () => {
    useMotionBlurStore.getState().setShutterAngle(45);
    useGuidesStore.getState().setGridSpacing(37);

    projectDocumentIO.restore(projectDocumentIO.createEmpty('Untitled'));

    expect(useMotionBlurStore.getState().shutterAngle).toBe(180);
    expect(useGuidesStore.getState().gridSpacing).toBe(100);
  });

  it('carries a default for every key captureDocument writes', () => {
    // The general form of the two cases above: anything `capture` persists but
    // `createEmpty` omits is a field a new project silently inherits.
    const captured = Object.keys(projectDocumentIO.capture());
    const empty = Object.keys(projectDocumentIO.createEmpty('Untitled'));
    // `plugins`/`pluginStorage` are absent-when-empty by design, and absent IS
    // their default — a blank document depends on nothing and stores nothing.
    const mustReset = captured.filter((k) => k !== 'plugins' && k !== 'pluginStorage');
    // `timelines` and `openTabs` cannot be expressed as an empty document
    // (an absent key means "keep"); `resetProjectWorkspace` drops those.
    expect(empty).toEqual(expect.arrayContaining(mustReset.filter((k) => k !== 'timelines' && k !== 'openTabs')));
  });
});

describe('resetProjectWorkspace', () => {
  it('drops the previous project timelines and its extra tabs', () => {
    // The half a document cannot say. Timelines restore by MERGE — the comps a
    // document names are replaced and the rest are left — so a new project kept
    // the old one's clips, markers and work area, pointing at scene nodes that
    // no longer existed. Same for precomp tabs, which then referenced comps
    // that had just been replaced.
    getTimelineController().setWorkArea(1, 3);
    useProjectStore.getState().actions.openTab('comp_precomp', ['comp_root', 'comp_precomp'], 'Precomp');
    expect(Object.keys(useProjectStore.getState().tabs).length).toBeGreaterThan(1);

    projectDocumentIO.restore(projectDocumentIO.createEmpty('Untitled'));
    resetProjectWorkspace();

    expect(Object.keys(useProjectStore.getState().tabs)).toHaveLength(1);
    // A fresh timeline spans the whole (default) comp, not the old 1–3 window.
    expect(getTimelineController().getWorkArea()).not.toEqual({ start: 1, duration: 3 });
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
