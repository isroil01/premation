/**
 * The two footage-assembly operations, pinned at the point each of them used
 * to have to be done by hand.
 *
 * WHAT THESE ARE FOR. Both features are compositions of things that already
 * worked — `createCompositionFromFootage`, `sequenceLayerBars`, `splitClip`,
 * `deleteLayerForClip` — so the risk is never in the parts. It is in the seams:
 * the comp that stays 4 seconds long under a 12-second assembly, the drop pass
 * that empties the comp because the threshold was mistyped, the split walk that
 * loses the right half's node id and so sequences three bars out of forty.
 * Each test below is one of those seams.
 *
 * `applyAssembly` is exercised with SYNTHETIC cut times rather than through the
 * detector: detection needs WebCodecs, which jsdom does not have, and what
 * needs pinning here is what happens to the clips once the cuts are known.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { createCompositionFromClips } from './compFromClips';
import { applyAssembly } from './assembleFromFootage';
import { useProjectStore } from '@stores/projectStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { defaultAnimation } from '@motion/animation';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

// The crossfade writes keyframes through `runAnimEdit`, which records against
// the CommandSystem — absent in a headless run, and its absence THROWS rather
// than degrading. Booting one here is what lets the dissolve half be tested at
// all; `sequenceCrossfade.test.ts` does the same for the same reason.
setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));

/**
 * Empty the graph but LEAVE A COMP ROOT standing.
 *
 * Not decoration. `createOrAdoptComposition` adopts the project's pristine comp
 * rather than stacking a second beside it, and adoption assumes the comp's root
 * NODE exists — it does in the app, where the comp table and the graph are
 * created together. A reset that clears the graph while leaving `comp_root` in
 * the comp table hands the operation a comp whose root is missing, so every
 * inserted layer parents to nothing, no bars are mirrored, and the failure
 * looks like a sequencing bug. Re-seeding the root is what makes this fixture
 * describe the app rather than a state the app never reaches.
 */
function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
  defaultAnimation.clear();
  defaultSceneGraph.addNode({
    id: 'comp_root',
    name: 'Composition 1',
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
}

/** A probed 30fps video of `seconds` — 30 × seconds frames of bar. */
function clip(id: string, seconds: number): ImportedAsset {
  return {
    id,
    name: `${id}.mp4`,
    type: 'video',
    src: `blob:${id}`,
    size: 1024,
    metadata: { width: 1920, height: 1080, duration: seconds, fps: 30 },
  };
}

/** Register assets the way an import would — clip bounding reads the STORE. */
function register(...assets: ImportedAsset[]): ImportedAsset[] {
  useAssetStore.setState((s) => ({ assets: [...s.assets, ...assets] }));
  return assets;
}

beforeEach(resetScene);
afterEach(() => {
  resetScene();
  useAssetStore.setState({ assets: [] });
});

/** Bar geometry per node, in frames, for readable assertions. */
function bars(nodeIds: ReadonlyArray<string>): Array<{ start: number; duration: number }> {
  const c = getTimelineController();
  return nodeIds.map((id) => {
    const bar = c.getLayersForNode(id)[0];
    return { start: bar?.start ?? -1, duration: bar?.duration ?? -1 };
  });
}

describe('New Composition from Selected Clips', () => {
  it('lays the clips end-to-end in the order given', async () => {
    const assets = register(clip('a', 4), clip('b', 3), clip('c', 2));
    const { nodeIds, sequenced } = await createCompositionFromClips(assets, 0);

    expect(sequenced).toBe(true);
    expect(nodeIds).toHaveLength(3);
    // 120 + 90 + 60 frames, butted together: each bar starts where the last ended.
    expect(bars(nodeIds)).toEqual([
      { start: 0, duration: 120 },
      { start: 120, duration: 90 },
      { start: 210, duration: 60 },
    ]);
  });

  it('the comp is the length of the ASSEMBLY, not of its first shot', async () => {
    const assets = register(clip('a', 4), clip('b', 3), clip('c', 2));
    const { compId } = await createCompositionFromClips(assets, 0);

    // The whole bug this exists to prevent: `createCompositionFromFootage`
    // sizes the comp to ONE clip, so an un-extended comp would end at 4s with
    // 5s of assembly hanging past its own duration.
    expect(useProjectStore.getState().comps[compId]!.durationSeconds).toBeCloseTo(9, 6);
    expect(getTimelineController().durationSeconds).toBeCloseTo(9, 6);
  });

  it('an overlap shortens the assembly and cross-dissolves across it', async () => {
    const assets = register(clip('a', 4), clip('b', 3));
    const { compId, nodeIds } = await createCompositionFromClips(assets, 12);

    // 120 + 90 − 12 = 198 frames.
    expect(bars(nodeIds)).toEqual([
      { start: 0, duration: 120 },
      { start: 108, duration: 90 },
    ]);
    expect(useProjectStore.getState().comps[compId]!.durationSeconds).toBeCloseTo(198 / 30, 6);

    // A dissolve is opacity keyframes, not just an overlap: the outgoing clip
    // ramps down and the incoming one up, across exactly the overlap.
    const outgoing = defaultAnimation.getTrackKeyframes(nodeIds[0]!, 'opacity') ?? [];
    const incoming = defaultAnimation.getTrackKeyframes(nodeIds[1]!, 'opacity') ?? [];
    expect(outgoing).toHaveLength(2);
    expect(incoming).toHaveLength(2);
    expect(outgoing.map((k) => k.value)).toEqual([100, 0]);
    expect(incoming.map((k) => k.value)).toEqual([0, 100]);
  });

  it('one clip is still a composition — no overlap, nothing to sequence', async () => {
    const [only] = register(clip('a', 4));
    const { compId, nodeIds, sequenced } = await createCompositionFromClips([only!], 0);

    expect(sequenced).toBe(false);
    expect(nodeIds).toHaveLength(1);
    expect(useProjectStore.getState().comps[compId]!.durationSeconds).toBeCloseTo(4, 6);
  });

  it('refuses an empty selection rather than minting a blank comp', async () => {
    await expect(createCompositionFromClips([], 0)).rejects.toThrow(/at least one/i);
  });
});

describe('Assemble from Footage — the mutating half', () => {
  /** A comp holding one 4s (120-frame) master, ready to be cut up. */
  async function master(): Promise<string> {
    const [a] = register(clip('master', 4));
    const { nodeIds } = await createCompositionFromClips([a!], 0);
    return nodeIds[0]!;
  }

  it('splits at every cut and keeps each shot as its own clip', async () => {
    const nodeId = await master();
    // Cuts at 1s and 2s → 30 / 30 / 60 frames.
    const { shots, dropped, sequenced } = applyAssembly(nodeId, [1, 2], {
      dissolveFrames: 0,
      minShotFrames: 0,
    });

    expect(shots).toHaveLength(3);
    expect(dropped).toBe(0);
    expect(sequenced).toBe(true);
    expect(bars(shots)).toEqual([
      { start: 0, duration: 30 },
      { start: 30, duration: 30 },
      { start: 60, duration: 60 },
    ]);
  });

  it('the split walk follows the RIGHT half, so late cuts still land', async () => {
    const nodeId = await master();
    // Three cuts: the second and third live inside nodes that did not exist
    // when the walk started. A walk that kept addressing the original node
    // would apply the first and silently drop the rest.
    const { shots } = applyAssembly(nodeId, [1, 2, 3], { dissolveFrames: 0, minShotFrames: 0 });
    expect(shots).toHaveLength(4);
    expect(bars(shots).map((b) => b.duration)).toEqual([30, 30, 30, 30]);
  });

  it('drops the runts and closes the gaps they leave', async () => {
    const nodeId = await master();
    const { shots, dropped } = applyAssembly(nodeId, [1, 2], {
      dissolveFrames: 0,
      minShotFrames: 40,
    });

    // The two 30-frame shots are debris; the 60-frame one is a shot.
    expect(dropped).toBe(2);
    expect(shots).toHaveLength(1);
    // And the survivor is not left starting at frame 60 with two seconds of
    // nothing in front of it. This is the case sequencing CANNOT fix — it needs
    // a pair, and there is one bar left — so the re-anchor is what closes the
    // hole, and dropping this assertion would let the bug back in unnoticed.
    expect(bars(shots)).toEqual([{ start: 0, duration: 60 }]);
  });

  it('dropping the OPENING shots does not shift the film', async () => {
    const nodeId = await master();
    // Cuts at 1s and 3s → 30 / 60 / 30. A 40-frame floor kills the first and
    // last, leaving a survivor that began at frame 30.
    const { shots, dropped } = applyAssembly(nodeId, [1, 3], {
      dissolveFrames: 0,
      minShotFrames: 40,
    });

    expect(dropped).toBe(2);
    expect(bars(shots)).toEqual([{ start: 0, duration: 60 }]);
  });

  it('never empties the comp, however wrong the threshold', async () => {
    const nodeId = await master();
    const { shots, dropped } = applyAssembly(nodeId, [1, 2], {
      dissolveFrames: 0,
      minShotFrames: 10_000,
    });

    // A threshold that would delete everything is a threshold the user got
    // wrong. The useful answer is the un-culled assembly, not an empty comp.
    expect(dropped).toBe(0);
    expect(shots).toHaveLength(3);
  });

  it('a dissolve overlaps the shots and writes the ramps', async () => {
    const nodeId = await master();
    const { shots } = applyAssembly(nodeId, [1, 2], { dissolveFrames: 6, minShotFrames: 0 });

    expect(bars(shots)).toEqual([
      { start: 0, duration: 30 },
      { start: 24, duration: 30 },
      { start: 48, duration: 60 },
    ]);
    // The middle shot both fades IN and fades OUT: it arrives from nothing and
    // leaves to nothing. Asserted as the shape of the ramp rather than as a key
    // count — with 30-frame shots and a 6-frame dissolve the fade-in's end and
    // the fade-out's start can land on the same instant and coalesce, which is
    // correct behaviour and not something to pin a number to.
    const middle = defaultAnimation.getTrackKeyframes(shots[1]!, 'opacity') ?? [];
    expect(middle.length).toBeGreaterThanOrEqual(3);
    expect(middle[0]!.value).toBe(0);
    expect(middle[middle.length - 1]!.value).toBe(0);
    expect(Math.max(...middle.map((k) => Number(k.value)))).toBe(100);
  });

  it('no cuts leaves the clip exactly as it was', async () => {
    const nodeId = await master();
    const { shots, dropped, sequenced } = applyAssembly(nodeId, [], {
      dissolveFrames: 0,
      minShotFrames: 0,
    });

    expect(shots).toEqual([nodeId]);
    expect(dropped).toBe(0);
    expect(sequenced).toBe(false);
    expect(bars(shots)).toEqual([{ start: 0, duration: 120 }]);
  });
});
