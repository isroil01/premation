/**
 * The FULL local-first round-trip: live engines → `.motion` bundle → live engines.
 *
 * Unlike the pure codec tests, this drives the REAL `captureDocument` /
 * `restoreDocument` against the actual scene/animation/comp engines through a
 * `BundleRepository`, so it proves the directory-bundle path loses nothing that
 * the monolithic `projectDocumentIO` round-trip guards — scene, KEYFRAMES, and
 * composition settings all survive a save → wipe → open.
 */

import { saveProjectBundle, openProjectBundle, hasProjectBundle } from './bundleProjectIO';
import { BundleRepository } from './BundleRepository';
import { MemoryBundleFs } from './BundleFs';
import { useProjectStore } from '@stores/projectStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { defaultAnimation } from '@motion/animation';
import type { SceneNode } from '@core/types';

const ROOT = '/projects/My.motion';

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

/** Save to a bundle, wipe every engine, then open the bundle back. */
async function bundleRoundTrip(repo: BundleRepository): Promise<void> {
  await saveProjectBundle(ROOT, repo);
  resetScene();
  defaultAnimation.clear();
  useProjectStore.getState().actions.replaceComps({});
  getTimelineController().clearWorkArea();
  await openProjectBundle(ROOT, repo);
}

let repo: BundleRepository;
beforeEach(() => {
  repo = new BundleRepository(new MemoryBundleFs());
  seedProject();
});

describe('save bundle → open bundle', () => {
  it('keeps the scene', async () => {
    await bundleRoundTrip(repo);
    expect(defaultSceneGraph.getNode('box')).toBeDefined();
  });

  it('keeps the KEYFRAMES', async () => {
    await bundleRoundTrip(repo);
    expect(defaultAnimation.getTrackKeyframes('box', 'x')).toHaveLength(2);
    expect(defaultAnimation.sample('box', 'x', 2)).toBe(500);
  });

  it('keeps the composition settings', async () => {
    await bundleRoundTrip(repo);
    expect(useProjectStore.getState().comps.comp_root).toMatchObject({
      width: 1280, height: 720, fps: 48, durationSeconds: 7, background: '#123456',
    });
  });

  it('keeps the timeline work area', async () => {
    getTimelineController().setWorkArea(1, 3);
    const before = getTimelineController().getWorkArea();
    await bundleRoundTrip(repo);
    expect(getTimelineController().getWorkArea()).toEqual(before);
  });
});

describe('open when nothing is there', () => {
  it('reports no bundle and restores nothing', async () => {
    expect(await hasProjectBundle('/projects/absent.motion', repo)).toBe(false);
    expect(await openProjectBundle('/projects/absent.motion', repo)).toBe(false);
  });
});
