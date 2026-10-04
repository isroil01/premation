import { documentMirror } from '@stores/documentMirror';
/**
 * Layer ▸ Mask and Shape Path on MASKS, Convert Mask to Shape Layer and the
 * Roto Brush's mask — through the engine API (B3, pathEdits.ts): one undo
 * entry per action, undo restores the document exactly, and the structural
 * verbs land in EVERY state of an animated mask.
 */

import { insertFragment } from '@/engine-client/insertFragment';
import type { SceneNode } from '@core/types';
import { DirectSelectionTool } from '@motion/workspace';
import { seekPlayhead } from '@core/timeline/timelineView';
import { readNodeMask, readNodeMaskAnim, type MaskPath, type MaskPoint } from '@core/effects/mask';
import { setupAppEngine, historyLabels, settleEdits } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { sec, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import type { BezierPath } from '@motion/engine-api';
import { createSceneGraphPort } from './ports';
import { holdCanvasGeometry, releaseCanvasGeometry } from './__testHelpers__/canvasGeometry';
import { getWorkspaceController } from './WorkspaceController';
import {
  clearPathClipboard,
  convertMasksToShapeLayers,
  copyPathFromSelection,
  keyframePathAtPlayhead,
  pastePathEdit,
  reversePathCommand,
  setFirstVertexCommand,
  toggleClosed,
} from './pathCommands';

const square = (s: number): BezierPath => ({
  vertices: [-s, -s, s, -s, s, s, -s, s], inTangents: [], outTangents: [], closed: true, featherPoints: [], vertexStates: [],
});
const tri = (s: number): BezierPath => ({
  vertices: [0, -s, s, s, -s, s], inTangents: [], outTangents: [], closed: false, featherPoints: [], vertexStates: [],
});

let h: Harness;
const ds = (): DirectSelectionTool => getWorkspaceController().ws.tools.get('direct-select') as DirectSelectionTool;

beforeEach(async () => {
  h = await setupAppEngine();
  seekPlayhead(0);
});
afterEach(async () => {
  ds().clearVertexSelection();
  clearPathClipboard();
  useSelectionStore.getState().set([]);
  useUIStore.getState().setActiveTool('select');
  seekPlayhead(0);
  await h.dispose();
});

/** A solid with one mask; returns the layer and the mask id. */
async function maskedSolid(path: BezierPath, name = 'A'): Promise<{ layer: string; mask: string }> {
  const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name, init: [] });
  const mask = await addMask(layer, path);
  return { layer, mask };
}

async function addMask(layer: string, path: BezierPath): Promise<string> {
  const { groups: [g] } = await h.run({ type: 'addMask', layer, path, mode: 'add', inverted: false });
  return g!.split('/')[1]!;
}

/** Key the mask at 0 s (its current shape) and at 1 s (`later`). */
async function animate(layer: string, mask: string, later: BezierPath): Promise<void> {
  const prop = { layer, path: `masks/${mask}/path` };
  await h.run({ type: 'setAnimated', prop, animated: true, time: 0 });
  await h.run({ type: 'setProperty', prop, value: { kind: 'path', value: later }, time: sec(1) });
}

const staticPath = async (layer: string, mask: string): Promise<MaskPath> =>
  readNodeMask((await docView()).getNode(layer)!)!.paths.find((p) => p.id === mask)!;
const keyPaths = async (layer: string, mask: string): Promise<MaskPath[]> =>
  readNodeMaskAnim((await docView()).getNode(layer)!).map((k) => k.mask.paths.find((p) => p.id === mask)!);

/** Run a verb, settle the engine, and pin: ONE entry named `label`, undo restores exactly. */
async function oneEntry(label: string, run: () => unknown, check: () => void | Promise<void>): Promise<void> {
  const before = (await h.doc());
  const entries = (await historyLabels()).length;
  run();
  await settleEdits();
  await settleEdits();
  expect((await historyLabels()).length).toBe(entries + 1);
  expect((await historyLabels()).at(-1)).toBe(label);
  await check();
  await h.run({ type: 'undo' });
  expect((await h.doc())).toEqual(before);
}

describe('Mask and Shape Path verbs on masks go through the engine', () => {
  it('Closed opens a static mask', async () => {
    const { layer, mask } = await maskedSolid(square(20));
    useSelectionStore.getState().set([layer]);
    await holdCanvasGeometry();
    await oneEntry('Closed', () => expect(toggleClosed()).toBe(true), async () => {
      expect((await staticPath(layer, mask)).closed).toBe(false);
    });
  });

  it('Reverse Path Direction reverses EVERY keyframe of an animated mask', async () => {
    const { layer, mask } = await maskedSolid(square(20));
    await animate(layer, mask, square(40));
    useSelectionStore.getState().set([layer]);
    await holdCanvasGeometry();
    await oneEntry('Reverse Path Direction', () => expect(reversePathCommand()).toBe(true), async () => {
      const keys = (await keyPaths(layer, mask));
      expect(keys).toHaveLength(2);
      // Reversed: the first vertex is the old last one (-s, s).
      expect(keys[0]!.points[0]).toMatchObject({ x: -20, y: 20 });
      expect(keys[1]!.points[0]).toMatchObject({ x: -40, y: 40 });
    });
  });

  it('Closed holds across every keyframe of an animated mask', async () => {
    const { layer, mask } = await maskedSolid(square(20));
    await animate(layer, mask, square(40));
    useSelectionStore.getState().set([layer]);
    await holdCanvasGeometry();
    await oneEntry('Closed', () => toggleClosed(), async () => {
      for (const p of (await keyPaths(layer, mask))) expect(p.closed).toBe(false);
    });
  });

  it('Set First Vertex rotates the mask and its per-vertex feathers move with the vertices', async () => {
    const { layer, mask } = await maskedSolid({ ...square(20), featherPoints: [{ segment: 2, t: 0, radius: 7, tension: 0 }] });
    useSelectionStore.getState().set([layer]);
    await holdCanvasGeometry();
    ds().selectVertices({ nodeId: layer as never, maskId: mask }, [2]);
    await oneEntry('Set First Vertex', () => expect(setFirstVertexCommand()).toBe(true), async () => {
      const pts = (await staticPath(layer, mask)).points;
      expect(pts[0]).toMatchObject({ x: 20, y: 20, feather: 7 });
      expect(pts.filter((p) => p.feather !== undefined)).toHaveLength(1);
    });
  });

  it('Alt+Shift+M keys every mask of the layer at the playhead, with the shape drawn there', async () => {
    const { layer, mask } = await maskedSolid(square(20));
    const other = await addMask(layer, square(5));
    await animate(layer, mask, square(40));
    seekPlayhead(0.5);
    useSelectionStore.getState().set([layer]);
    await holdCanvasGeometry();
    await oneEntry('Set Path Keyframe', () => expect(keyframePathAtPlayhead()).toBe(true), async () => {
      const view = await docView();
      const anim = readNodeMaskAnim(view.getNode(layer)!);
      expect(anim).toHaveLength(3);
      const mid = anim[1]!;
      // The interpolated shape halfway from 20 to 40.
      expect(mid.mask.paths.find((p) => p.id === mask)!.points[0]).toMatchObject({ x: -30, y: -30 });
      expect(mid.mask.paths.find((p) => p.id === other)!.points[0]).toMatchObject({ x: -5, y: -5 });
    });
  });

  it('a mask with split handles goes through the engine too: its handles stay split', async () => {
    const { layer, mask } = await maskedSolid({ ...square(20), vertexStates: [{ vertex: 1, broken: true }] });
    useSelectionStore.getState().set([layer]);
    await holdCanvasGeometry();
    await oneEntry('Closed', () => expect(toggleClosed()).toBe(true), async () => {
      expect((await staticPath(layer, mask)).closed).toBe(false);
      expect(((await staticPath(layer, mask)).points[1] as MaskPoint & { broken?: boolean }).broken).toBe(true);
    });
  });

  it('pastes a copied mask path onto an animated mask: a key at the playhead, closed everywhere', async () => {
    const src = await maskedSolid(tri(30), 'Src');
    const dst = await maskedSolid(square(20), 'Dst');
    await animate(dst.layer, dst.mask, square(40));
    useUIStore.getState().setActiveTool('direct-select');
    useSelectionStore.getState().set([src.layer]);
    await holdCanvasGeometry();
    ds().selectVertices({ nodeId: src.layer as never, maskId: src.mask }, [0]);
    expect(copyPathFromSelection()).toBe(true);
    ds().clearVertexSelection();
    useSelectionStore.getState().set([dst.layer]);
    seekPlayhead(1);
    await oneEntry('Paste Path', () => expect(pastePathEdit()).toBe(true), async () => {
      const keys = (await keyPaths(dst.layer, dst.mask));
      expect(keys).toHaveLength(2);
      for (const k of keys) expect(k.closed).toBe(false);
      expect(keys[1]!.points).toHaveLength(3);
      expect(keys[1]!.points[1]).toMatchObject({ x: 30, y: 30 });
      expect(keys[0]!.points).toHaveLength(4);
    });
  });
});

describe('Convert Mask to Shape Layer', () => {
  it('draws the mask outline where it was, as ONE entry that undo removes', async () => {
    const { layer } = await maskedSolid(square(10), 'Conv');
    useSelectionStore.getState().set([layer]);
    await holdCanvasGeometry();
    const before = (await h.doc());
    const entries = (await historyLabels()).length;
    const ids = await convertMasksToShapeLayers();
    await settleEdits();
    expect(ids).toHaveLength(1);
    expect((await historyLabels()).length).toBe(entries + 1);
    expect((await historyLabels()).at(-1)).toBe('Convert Mask to Shape Layer');
    expect(useSelectionStore.getState().ids).toEqual(ids);
    const wn = createSceneGraphPort().getNode(ids[0]!)!;
    const srcWorld = createSceneGraphPort().getNode(layer)!.worldMatrix;
    const expectTL = { x: srcWorld.a * -10 + srcWorld.c * -10 + srcWorld.e, y: srcWorld.b * -10 + srcWorld.d * -10 + srcWorld.f };
    const p = wn.pathPoints![0]!;
    const w = wn.worldMatrix;
    expect(w.a * p.x + w.c * p.y + w.e).toBeCloseTo(expectTL.x, 6);
    expect(w.b * p.x + w.d * p.y + w.f).toBeCloseTo(expectTL.y, 6);
    await h.run({ type: 'undo' });
    expect((await h.doc())).toEqual(before);
  });
});


// A DRAWN shape layer's own outline is `layer/path.points` (a path value):
// its verbs are engine edits too — ONE entry each that undo restores exactly
// and redo reapplies.
describe('drawn shape paths go through the engine', () => {
  const pt = (x: number, y: number): MaskPoint => ({ x, y, inX: x, inY: y, outX: x, outY: y });
  const outline = (s: number): MaskPoint[] => [pt(0, -s), pt(s, s), pt(-s, s)];

  async function drawnPath(s: number): Promise<string> {
    // A drawn shape as the pen tool lays it: a path primitive with stored points.
    const ids = await insertFragment('Fixture', (b) => b.addChild('comp_root', {
      id: 'drawn', name: 'Drawn', parent: 'comp_root', children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        { id: 'drawn_t', type: 'Transform', props: { __kind: 'shape', x: 0, y: 0, rotation: 0, shapeType: 'path' } },
        { id: 'drawn_g', type: 'Geometry', props: { points: outline(s) } },
      ],
    } as unknown as SceneNode), { comp: 'comp_root', noSelect: true });
    const layer = ids![0]!;
    await settleEdits();
    await documentMirror().loadTree(layer);
    return layer;
  }
  const geomOf = async (id: string): Promise<Record<string, unknown>> =>
    (await docView()).getNode(id)!.components.find((c) => c.type === 'Geometry')!.props as Record<string, unknown>;

  /** ONE entry named `label`; undo restores exactly; redo reapplies. */
  async function engineEntry(label: string, run: () => unknown, check: () => void | Promise<void>): Promise<void> {
    await settleEdits();
    const before = (await h.doc());
    const entries = (await historyLabels()).length;
    run();
    await settleEdits();
    await settleEdits();
    expect((await historyLabels()).length).toBe(entries + 1);
    expect((await historyLabels()).at(-1)).toBe(label);
    await check();
    const after = (await h.doc());
    await h.run({ type: 'undo' });
    expect((await h.doc())).toEqual(before);
    await h.run({ type: 'redo' });
    expect((await h.doc())).toEqual(after);
  }

  it('Closed on a drawn path', async () => {
    const layer = await drawnPath(30);
    useSelectionStore.getState().set([layer]);
    await holdCanvasGeometry();
    await engineEntry('Closed', () => expect(toggleClosed()).toBe(true), async () => {
      expect((await geomOf(layer)).open).toBe(true);
    });
  });

  it('Reverse Path Direction on a drawn path', async () => {
    const layer = await drawnPath(30);
    useSelectionStore.getState().set([layer]);
    await holdCanvasGeometry();
    await engineEntry('Reverse Path Direction', () => expect(reversePathCommand()).toBe(true), async () => {
      expect(((await geomOf(layer)).points as MaskPoint[])[0]).toMatchObject({ x: -30, y: 30 });
    });
  });

  it('Alt+Shift+M on a drawn path, unanimated then animated', async () => {
    // (The Path row's stopwatch is the generic property stopwatch: layout/Menu/appEdits.test.ts.)
    const layer = await drawnPath(30);
    useSelectionStore.getState().set([layer]);
    await holdCanvasGeometry();
    await engineEntry('Set Path Keyframe', () => expect(keyframePathAtPlayhead()).toBe(true), async () => {
      const view = await docView();
      expect(view.getDataTrack(layer, 'path.points')!.keyframes).toHaveLength(1);
    });
    seekPlayhead(1);
    await engineEntry('Set Path Keyframe', () => expect(keyframePathAtPlayhead()).toBe(true), async () => {
      const view = await docView();
      expect(view.getDataTrack(layer, 'path.points')!.keyframes).toHaveLength(2);
    });
  });
});

afterEach(() => releaseCanvasGeometry());
