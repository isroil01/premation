/**
 * The footage workflow verbs: insert-at-playhead, and replace-source.
 *
 * The playhead test's load-bearing detail is WHEN the position is read: the
 * insert is async (an SVG import reads its file) and the transport can be
 * running, so the playhead is captured before the await. A clip landing where
 * the playhead drifted TO — rather than where it was when the user acted — is
 * off by however long decoding took, which is unreproducible and reads as
 * flakiness.
 *
 * Replace's contract is what SURVIVES: transform, keyframes, place in the
 * stack. Replace exists precisely because delete-and-reinsert loses those.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import { insertMediaAtPlayhead, retargetLayerSource, replaceableSelectedLayer } from './footageWorkflow';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { defaultAnimation } from '@motion/animation';
import { readSource } from '@/__testHelpers__/readSource';
import type { SceneNode } from '@core/types';

const COMP = {
  width: 1920, height: 1080, fps: 30, durationSeconds: 10,
  background: '#000', transparent: false, startFrame: 0,
};

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
  defaultAnimation.clear();
  useSelectionStore.getState().clear();
  useAssetStore.setState({ assets: [] });
}

function addComp(id: string): void {
  defaultSceneGraph.addNode({
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
}

const clip = (patch: Partial<ImportedAsset> = {}): ImportedAsset => ({
  id: 'a1', name: 'take2.mp4', type: 'video', src: 'blob:take2', size: 10,
  metadata: { width: 640, height: 360, duration: 4 },
  ...patch,
});

function addImageLayer(id: string, kind: 'image' | 'video' | 'shape' = 'image'): void {
  defaultSceneGraph.addChild('comp_root', {
    id, name: id, parent: 'comp_root', children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 0, y: 0, width: 100, height: 100, src: 'blob:old', assetId: 'old' } },
    ],
  } as never);
}

beforeEach(() => {
  resetScene();
  addComp('comp_root');
  useProjectStore.getState().actions.replaceComps({
    comp_root: { id: 'comp_root', name: 'Main', ...COMP },
  });
  const proj = useProjectStore.getState();
  proj.actions.setActiveTab(proj.actions.openTab('comp_root', ['comp_root'], 'Main'));
  getTimelineController().syncFromScene('comp_root');
  // The controller registry outlives resetScene, and with it the playhead —
  // without this, the previous test's 2s seek leaks into the next.
  getTimelineController().seekSeconds(0);
});

afterEach(resetScene);

describe('insert at playhead', () => {
  it('the clip starts where the playhead is parked, not at frame 0', async () => {
    const controller = getTimelineController();
    controller.seekSeconds(2);
    const nodeId = await insertMediaAtPlayhead(clip());
    expect(nodeId).not.toBeNull();
    const layers = controller.getLayersForNode(nodeId!);
    expect(layers.length).toBeGreaterThan(0);
    expect(layers[0]!.clip.start).toBe(60); // 2s at 30fps
  });

  it('at playhead 0 it behaves exactly like a plain insert', async () => {
    const nodeId = await insertMediaAtPlayhead(clip());
    const layers = getTimelineController().getLayersForNode(nodeId!);
    expect(layers[0]!.clip.start).toBe(0);
  });
});

describe('replace source', () => {
  it('points the layer at the new footage and keeps everything else', () => {
    addImageLayer('img');
    defaultAnimation.setKeyframe('img', 'x', 0, 0);
    defaultAnimation.setKeyframe('img', 'x', 1, 500);

    const ok = retargetLayerSource('img', clip({ type: 'image', src: 'blob:new', id: 'a9' }));
    expect(ok).toBe(true);
    const t = defaultSceneGraph.getNode('img')!.components.find((c) => c.type === 'Transform')!;
    expect(t.props.src).toBe('blob:new');
    expect(t.props.assetId).toBe('a9');
    // The keyframes are untouched — replace exists so they survive.
    expect(defaultAnimation.getTrackKeyframes('img', 'x')).toHaveLength(2);
  });

  it('refuses an AUDIO asset for a visual layer, loudly not silently', () => {
    // Pointing a video layer at audio errors nowhere downstream — the texture
    // provider just never produces a frame and the layer goes black. The
    // refusal up front is the diagnosable version.
    addImageLayer('img');
    expect(retargetLayerSource('img', clip({ type: 'audio' }))).toBe(false);
    const t = defaultSceneGraph.getNode('img')!.components.find((c) => c.type === 'Transform')!;
    expect(t.props.src).toBe('blob:old');
  });

  it('refuses a SHAPE layer as the target', () => {
    addImageLayer('sh', 'shape');
    expect(retargetLayerSource('sh', clip({ type: 'image' }))).toBe(false);
  });

  it('replaceableSelectedLayer answers only for a single image/video selection', () => {
    addImageLayer('img');
    addImageLayer('img2');
    expect(replaceableSelectedLayer()).toBeNull(); // nothing selected
    useSelectionStore.getState().set(['img']);
    expect(replaceableSelectedLayer()).toBe('img');
    useSelectionStore.getState().set(['img', 'img2']);
    expect(replaceableSelectedLayer()).toBeNull(); // two targets is no target
    addImageLayer('sh', 'shape');
    useSelectionStore.getState().set(['sh']);
    expect(replaceableSelectedLayer()).toBeNull();
  });
});

describe('the controls are reachable', () => {
  it('double-click opens the PREVIEW, and insertion moved to the menu', () => {
    const ui = readSource('layout/EditorLayout/DemoPanels.tsx');
    expect(ui).toMatch(/onDoubleClick=\{\(\) => openFootagePreview\(row\.asset\)\}/);
    expect(ui).toMatch(/Add at Playhead/);
    expect(ui).toMatch(/Use as Source for/);
  });

  it('the preview dialog offers every commit verb', () => {
    const dlg = readSource('layout/Assets/FootagePreviewDialog.tsx');
    expect(dlg).toMatch(/Add to Comp/);
    expect(dlg).toMatch(/Add at Playhead/);
    expect(dlg).toMatch(/createCompositionFromFootage/);
    expect(dlg).toMatch(/retargetLayerSource/);
  });
});
