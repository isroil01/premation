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
 *
 * B3: the range, the overwrite trims and the splits go through the engine
 * API — ONE undo entry after the insert's, and undo restores the document.
 */

import { getTimelineController } from '@core/timeline/TimelineController';
import { insertFromSource, sourceRangeEdit, overwriteUnder, compEndSeconds } from './sourceMonitorOps';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';

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
    ...jest.requireActual('@core/scene/sceneInsert'),
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

let h: Harness & { engine: LocalEngine };

beforeEach(async () => {
  h = await setupAppEngine();
  // A 30 fps, 10 s composition (the fixture every assertion below counts in).
  await h.run({ type: 'setCompositionSettings', comp: 'comp_root', patch: { frameRate: { num: 30, den: 1 }, duration: 10 * 705_600_000 } });
  useAssetStore.setState({ assets: [...useAssetStore.getState().assets, ASSET] });
});

afterEach(async () => {
  await h.dispose();
});

describe('insertFromSource', () => {
  it('lands the MARKED part of the file, at the playhead — one entry, undoable', async () => {
    const c = getTimelineController();
    c.seekSeconds(1);

    const nodeId = await insertFromSource(ASSET, { inSec: 2, outSec: 5 }, { at: 'playhead' });
    await engineIdle();
    expect(nodeId).not.toBeNull();

    const clip = c.getLayersForNode(nodeId!)[0]!.clip;
    // 30fps: two seconds in, three seconds long, parked one second along.
    expect(clip.sourceIn).toBe(60);
    expect(clip.duration).toBe(90);
    expect(clip.start).toBe(30);
    expect(historyLabels().at(-1)).toBe('Insert from Source');

    await h.run({ type: 'undo' });
    const back = c.getLayersForNode(nodeId!)[0]!.clip;
    expect(back.sourceIn).toBe(0);
    expect(back.start).toBe(0);
  });

  it('an unmarked clip inserts whole — the range falls back to the file', async () => {
    const c = getTimelineController();
    const nodeId = await insertFromSource(ASSET, { inSec: 0, outSec: 10 }, { at: 'time', seconds: 0 });
    await engineIdle();
    const clip = c.getLayersForNode(nodeId!)[0]!.clip;
    expect(clip.sourceIn).toBe(0);
    expect(clip.duration).toBe(300);
  });

  it('“add to comp end” starts where the last clip finishes, not at the playhead', async () => {
    const c = getTimelineController();
    c.seekSeconds(4); // deliberately NOT where the answer should be
    await insertFromSource(ASSET, { inSec: 0, outSec: 2 }, { at: 'time', seconds: 0 });
    await engineIdle();

    const second = await insertFromSource(ASSET, { inSec: 4, outSec: 6 }, { at: 'end' });
    await engineIdle();
    const clip = c.getLayersForNode(second!)[0]!.clip;
    expect(clip.start).toBe(60); // frame 60 = the first clip's 2s end
    expect(clip.sourceIn).toBe(120);
    expect(clip.duration).toBe(60);
  });

  it('compEndSeconds is 0 in an empty comp', () => {
    expect(compEndSeconds()).toBe(0);
  });
});

describe('sourceRangeEdit', () => {
  it('is null for a node with no clip bar', () => {
    expect(sourceRangeEdit('nope', { inSec: 0, outSec: 1 }, 0)).toBeNull();
  });
});

describe('overwrite', () => {
  it('trims the clip the new one lands on the tail of — with the insert, one entry', async () => {
    const c = getTimelineController();
    // An existing clip covering 0–6s.
    const first = await insertFromSource(ASSET, { inSec: 0, outSec: 6 }, { at: 'time', seconds: 0 });
    await engineIdle();

    // A new one over 4–7s, with overwrite.
    const entries = historyLabels().length;
    const second = await insertFromSource(ASSET, { inSec: 0, outSec: 3 }, { at: 'time', seconds: 4 }, { overwrite: true });
    await engineIdle();

    expect(c.getLayersForNode(first!)[0]!.clip.duration).toBe(120); // 0–4s
    const newClip = c.getLayersForNode(second!)[0]!.clip;
    expect(newClip.start).toBe(120);
    expect(newClip.duration).toBe(90);
    // The insert's own entry (legacy router) + ONE for the range and the trims.
    expect(historyLabels().slice(entries).filter((l) => l === 'Overwrite from Source')).toHaveLength(1);
  });

  it('splits a clip that spans the whole insert, leaving a hole', async () => {
    const c = getTimelineController();
    const first = await insertFromSource(ASSET, { inSec: 0, outSec: 10 }, { at: 'time', seconds: 0 });
    await engineIdle();
    const before = c.layersOfComp().length;

    await insertFromSource(ASSET, { inSec: 0, outSec: 2 }, { at: 'time', seconds: 4 }, { overwrite: true });
    await engineIdle();

    expect(c.getLayersForNode(first!)[0]!.clip.duration).toBe(120); // trimmed to 0–4s
    // +1 for the inserted clip, +1 for the right-hand piece of the split
    // (a new layer, AE's split — the left part keeps the original's id).
    expect(c.layersOfComp().length).toBe(before + 2);
    const right = c.layersOfComp().find((l) => l.start === 180);
    expect(right).toBeDefined();
  });

  it('leaves a clip that sits ENTIRELY inside the range alone, and says so', async () => {
    const c = getTimelineController();
    const inner = await insertFromSource(ASSET, { inSec: 0, outSec: 2 }, { at: 'time', seconds: 3 });
    await engineIdle();
    const covered = await overwriteUnder('none', 2, 6);
    expect(covered).toBe(1);
    expect(c.getLayersForNode(inner!)[0]!.clip.duration).toBe(60);
  });

  it('a plain Insert touches nothing else', async () => {
    const c = getTimelineController();
    const first = await insertFromSource(ASSET, { inSec: 0, outSec: 6 }, { at: 'time', seconds: 0 });
    await engineIdle();
    await insertFromSource(ASSET, { inSec: 0, outSec: 3 }, { at: 'time', seconds: 4 });
    await engineIdle();
    expect(c.getLayersForNode(first!)[0]!.clip.duration).toBe(180);
  });
});
