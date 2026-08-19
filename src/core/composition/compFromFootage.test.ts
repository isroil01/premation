/**
 * New Comp from Footage — the comp must BE the clip.
 *
 * The by-hand version of this workflow drifts silently: a default-1080p comp
 * under a 2160×3840 phone clip, a 10s comp under a 7s clip shipping three
 * seconds of trailing background, a 30fps comp juddering a 23.976 clip. Each
 * assertion here pins one of those drifts. The fps one matters most: the
 * browser cannot report a video's real rate, so an UNPROBED clip must keep the
 * default rather than having one invented for it — a wrong-but-configured-
 * looking frame rate is worse than a default.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { createCompositionFromFootage } from './compositionOps';
import { useProjectStore } from '@stores/projectStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { defaultAnimation } from '@motion/animation';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { readSource } from '@/__testHelpers__/readSource';

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
  defaultAnimation.clear();
}

const clip = (patch: Partial<ImportedAsset['metadata']> = {}, extra: Partial<ImportedAsset> = {}): ImportedAsset => ({
  id: 'a1',
  name: 'shot_04.mp4',
  type: 'video',
  src: 'blob:clip',
  size: 1024,
  metadata: { width: 1280, height: 720, duration: 7.2, ...patch },
  ...extra,
});

beforeEach(resetScene);
afterEach(() => {
  resetScene();
  useAssetStore.setState({ assets: [] });
});

/** Register the asset the way an import would — `footageSourceOf` (and through
 *  it the timeline's clip bounding) reads the asset STORE, not the object the
 *  caller happens to hold. */
function register(a: ImportedAsset): ImportedAsset {
  useAssetStore.setState((s) => ({ assets: [...s.assets, a] }));
  return a;
}

describe('the comp takes the clip’s facts', () => {
  it('size and duration come from the footage; the name drops the extension', async () => {
    const id = await createCompositionFromFootage(clip());
    const comp = useProjectStore.getState().comps[id]!;
    expect(comp.width).toBe(1280);
    expect(comp.height).toBe(720);
    expect(comp.durationSeconds).toBeCloseTo(7.2, 6);
    expect(comp.name).toBe('shot_04');
  });

  it('an anamorphic clip gets its ON-SCREEN width, not its stored width', async () => {
    // PAR is a property of the file: 720 stored × 1.422 ≈ 1024 on screen. A
    // comp at the stored width letterboxes its own footage.
    const id = await createCompositionFromFootage(
      clip({ width: 720, height: 576 }, { interpret: { par: 1024 / 720 } }),
    );
    const comp = useProjectStore.getState().comps[id]!;
    expect(comp.width).toBe(1024);
    expect(comp.height).toBe(576);
  });

  it('a PROBED frame rate is adopted; an unprobed clip keeps the default', async () => {
    const probed = await createCompositionFromFootage(clip({ fps: 23.976 }));
    expect(useProjectStore.getState().comps[probed]!.fps).toBeCloseTo(23.976, 3);

    const unprobed = await createCompositionFromFootage(clip({}, { id: 'a2', name: 'web.mp4' }));
    // No probe ran (web import) → the default survives. Inventing 30 here
    // would look configured while juddering a 23.976 clip every fifth frame.
    expect(useProjectStore.getState().comps[unprobed]!.fps).toBe(30);
  });

  it('a clip with no metadata at all still makes a usable comp', async () => {
    const id = await createCompositionFromFootage(clip({ width: undefined, height: undefined, duration: undefined }));
    const comp = useProjectStore.getState().comps[id]!;
    expect(comp.width).toBeGreaterThan(0);
    expect(comp.height).toBeGreaterThan(0);
    expect(comp.durationSeconds).toBeGreaterThan(0);
  });
});

describe('the clip lands inside', () => {
  it('the new comp contains the footage layer at full frame', async () => {
    const id = await createCompositionFromFootage(clip());
    const children = defaultSceneGraph.getChildren(id);
    expect(children).toHaveLength(1);
    const t = children[0]!.components.find((c) => c.type === 'Transform')!;
    // Contain-fit into a comp that IS the footage size is exact.
    expect(t.props.width).toBe(1280);
    expect(t.props.height).toBe(720);
    expect(t.props.assetId).toBe('a1');
  });

  it('the new comp is the ACTIVE tab, so the user is looking at it', async () => {
    const id = await createCompositionFromFootage(clip());
    const proj = useProjectStore.getState();
    expect(proj.tabs[proj.activeTabId ?? '']?.compositionId).toBe(id);
  });

  it('the timeline clip is bounded by the footage duration', async () => {
    const id = await createCompositionFromFootage(register(clip()));
    const layers = getTimelineController().getLayersForNode(defaultSceneGraph.getChildren(id)[0]!.id);
    expect(layers.length).toBeGreaterThan(0);
    // 7.2s at 30fps = 216 frames of real media.
    expect(layers[0]!.clip.sourceDuration).toBe(216);
  });
});

describe('the control is reachable', () => {
  it('the Assets panel offers it from the asset context menu', () => {
    const ui = readSource('layout/EditorLayout/DemoPanels.tsx');
    expect(ui).toMatch(/createCompositionFromFootage/);
    expect(ui).toMatch(/New Comp from Footage/);
  });

  it('the metadata footer renders from the same panel', () => {
    const ui = readSource('layout/EditorLayout/DemoPanels.tsx');
    expect(ui).toMatch(/assetMetaFooter/);
    // fps only when probed — the honesty rule, pinned as prose in the source.
    expect(ui).toMatch(/m\.fps && m\.fps > 0/);
  });
});
