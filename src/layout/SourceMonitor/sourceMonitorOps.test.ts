/**
 * A marked SOURCE range must arrive in the comp as the trimmed clip it
 * describes — not as the whole file with the range written down somewhere.
 *
 * The failure this pins is silent by construction: `insertMedia` has no
 * opinion about time, so an insert that forgets the trim still produces a
 * perfectly good clip — the whole rush, starting at frame 0. Nothing errors.
 * The user sees the right clip in the right comp and only later notices it is
 * the wrong three seconds. So the assertions here are on `Clip` itself
 * (`sourceIn`, `duration`, `start`, in FRAMES) rather than on the fact that an
 * insert happened.
 */

import { getTimelineController } from '@core/timeline/TimelineController';
import { insertFromSource, applySourceRange, overwriteUnder, compEndSeconds } from './sourceMonitorOps';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useAssetStore } from '@stores/assetStore';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import type { CommandServices } from '@core/commands/Command';
import type { ImportedAsset } from '@stores/assetStore';
import type { SceneNode } from '@core/types';

/**
 * The real `insertMedia` fits, PAR-corrects and routes by file type — none of
 * which this file is about. The fake keeps the ONE contract the ops depend on
 * (it adds a footage node and SELECTS it) so what is under test is the timing.
 */
jest.mock('@core/scene/sceneInsert', () => {
  // A counter, because every insert must produce a DISTINCT layer — reusing an
  // id made the second insert silently re-trim the first clip, which is the
  // exact bug shape these tests exist to catch.
  let seq = 0;
  return {
    insertMedia: jest.fn(async (asset: { id: string; name: string; src: string }) => {
      const graph = jest.requireActual('@core/scene/DefaultSceneGraph').default;
      const { useSelectionStore: sel } = jest.requireActual('@stores/selectionStore');
      const { SCENE_KIND_PROP: KIND } = jest.requireActual('@core/scene/seedDefaultScene');
      const id = `layer_${asset.id}_${++seq}`;
      graph.addChild('comp_root', {
        id, name: asset.name, parent: 'comp_root', children: [], visible: true, locked: false,
        transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
        components: [{
          id: `${id}_t`, type: 'Transform',
          props: { [KIND]: 'video', src: asset.src, assetId: asset.id, x: 0, y: 0, width: 64, height: 48 },
        }],
      });
      sel.getState().set([id]);
    }),
  };
});

const ASSET: ImportedAsset = {
  id: 'a1', name: 'clip.mp4', type: 'video', src: 'blob:nowhere/clip', size: 1,
  metadata: { width: 64, height: 48, duration: 10, fps: 30 },
};

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as CommandServices, getState: () => ({}) }));
  getTimelineController().reset();
  resetScene();
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Main', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  useProjectStore.getState().actions.replaceComps({
    comp_root: {
      id: 'comp_root', name: 'Main', width: 1920, height: 1080, fps: 30,
      durationSeconds: 10, background: '#101014', transparent: false, startFrame: 0,
    },
  });
  const proj = useProjectStore.getState();
  proj.actions.setActiveTab(proj.actions.openTab('comp_root', ['comp_root'], 'Main'));
  useSelectionStore.getState().clear();
  useAssetStore.setState({ assets: [ASSET] });
});

describe('insertFromSource', () => {
  it('lands the MARKED part of the file, at the playhead', async () => {
    const c = getTimelineController();
    c.seekSeconds(1);

    const nodeId = await insertFromSource(ASSET, { inSec: 2, outSec: 5 }, { at: 'playhead' });
    expect(nodeId).not.toBeNull();

    const clip = c.getLayersForNode(nodeId!)[0]!.clip;
    // 30fps: two seconds in, three seconds long, parked one second along.
    expect(clip.sourceIn).toBe(60);
    expect(clip.duration).toBe(90);
    expect(clip.start).toBe(30);
  });

  it('an unmarked clip inserts whole — the range falls back to the file', async () => {
    const c = getTimelineController();
    const nodeId = await insertFromSource(ASSET, { inSec: 0, outSec: 10 }, { at: 'time', seconds: 0 });
    const clip = c.getLayersForNode(nodeId!)[0]!.clip;
    expect(clip.sourceIn).toBe(0);
    expect(clip.duration).toBe(300);
  });

  it('“add to comp end” starts where the last clip finishes, not at the playhead', async () => {
    const c = getTimelineController();
    c.seekSeconds(4); // deliberately NOT where the answer should be
    await insertFromSource(ASSET, { inSec: 0, outSec: 2 }, { at: 'time', seconds: 0 });

    const second = await insertFromSource(ASSET, { inSec: 4, outSec: 6 }, { at: 'end' });
    const clip = c.getLayersForNode(second!)[0]!.clip;
    expect(clip.start).toBe(60); // frame 60 = the first clip's 2s end
    expect(clip.sourceIn).toBe(120);
    expect(clip.duration).toBe(60);
  });

  it('compEndSeconds is 0 in an empty comp', () => {
    expect(compEndSeconds()).toBe(0);
  });
});

describe('applySourceRange', () => {
  it('is a no-op on a node with no clip bar', () => {
    expect(applySourceRange('nope', { inSec: 0, outSec: 1 }, 0)).toBeNull();
  });
});

describe('overwrite', () => {
  it('trims the clip the new one lands on the tail of', async () => {
    const c = getTimelineController();
    // An existing clip covering 0–6s.
    const first = await insertFromSource(ASSET, { inSec: 0, outSec: 6 }, { at: 'time', seconds: 0 });
    const firstClipId = c.getLayersForNode(first!)[0]!.id;

    // A new one over 4–7s, with overwrite.
    const second = await insertFromSource(ASSET, { inSec: 0, outSec: 3 }, { at: 'time', seconds: 4 }, { overwrite: true });

    expect(c.timeline.getLayer(firstClipId)!.clip.duration).toBe(120); // 0–4s
    const newClip = c.getLayersForNode(second!)[0]!.clip;
    expect(newClip.start).toBe(120);
    expect(newClip.duration).toBe(90);
  });

  it('splits a clip that spans the whole insert, leaving a hole', async () => {
    const c = getTimelineController();
    const first = await insertFromSource(ASSET, { inSec: 0, outSec: 10 }, { at: 'time', seconds: 0 });
    const firstClipId = c.getLayersForNode(first!)[0]!.id;
    const before = c.layersOfComp().length;

    await insertFromSource(ASSET, { inSec: 0, outSec: 2 }, { at: 'time', seconds: 4 }, { overwrite: true });

    expect(c.timeline.getLayer(firstClipId)!.clip.duration).toBe(120); // trimmed to 0–4s
    // +1 for the inserted clip, +1 for the right-hand piece of the split.
    expect(c.layersOfComp().length).toBe(before + 2);
  });

  it('leaves a clip that sits ENTIRELY inside the range alone, and says so', async () => {
    const c = getTimelineController();
    const inner = await insertFromSource(ASSET, { inSec: 0, outSec: 2 }, { at: 'time', seconds: 3 });
    const innerClipId = c.getLayersForNode(inner!)[0]!.id;
    const covered = overwriteUnder('none', 2, 6);
    expect(covered).toBe(1);
    expect(c.timeline.getLayer(innerClipId)!.clip.duration).toBe(60);
  });

  it('a plain Insert touches nothing else', async () => {
    const c = getTimelineController();
    const first = await insertFromSource(ASSET, { inSec: 0, outSec: 6 }, { at: 'time', seconds: 0 });
    const firstClipId = c.getLayersForNode(first!)[0]!.id;
    await insertFromSource(ASSET, { inSec: 0, outSec: 3 }, { at: 'time', seconds: 4 });
    expect(c.timeline.getLayer(firstClipId)!.clip.duration).toBe(180);
  });
});
