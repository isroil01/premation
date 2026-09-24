/**
 * Layer ▸ Mask and Shape Path on MASKS, Convert Mask to Shape Layer and the
 * Roto Brush's mask — through the engine API (B3, pathEdits.ts): one undo
 * entry per action, undo restores the document exactly, and the structural
 * verbs land in EVERY state of an animated mask.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { DirectSelectionTool } from '@motion/workspace';
import { getTimelineController } from '@core/timeline/TimelineController';
import { readNodeMask, readNodeMaskAnim, type MaskPath, type MaskPoint } from '@core/effects/mask';
import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { sec, type Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import type { BezierPath } from '@motion/engine-api';
import * as documentEdit from '@core/commands/documentEdit';
import { createSceneGraphPort } from './ports';
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
import { segmentStrokesToMask, ROTO_PATH_NAME } from './rotoBrushTool';

const square = (s: number): BezierPath => ({
  vertices: [-s, -s, s, -s, s, s, -s, s], inTangents: [], outTangents: [], closed: true, featherPoints: [], vertexStates: [],
});
const tri = (s: number): BezierPath => ({
  vertices: [0, -s, s, s, -s, s], inTangents: [], outTangents: [], closed: false, featherPoints: [], vertexStates: [],
});

let h: Harness & { engine: LocalEngine };
const ds = (): DirectSelectionTool => getWorkspaceController().ws.tools.get('direct-select') as DirectSelectionTool;

beforeEach(async () => {
  h = await setupAppEngine();
  getTimelineController().seekSeconds(0);
});
afterEach(async () => {
  ds().clearVertexSelection();
  clearPathClipboard();
  useSelectionStore.getState().set([]);
  useUIStore.getState().setActiveTool('select');
  getTimelineController().seekSeconds(0);
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

const staticPath = (layer: string, mask: string): MaskPath =>
  readNodeMask(defaultSceneGraph.getNode(layer)!)!.paths.find((p) => p.id === mask)!;
const keyPaths = (layer: string, mask: string): MaskPath[] =>
  readNodeMaskAnim(defaultSceneGraph.getNode(layer)!).map((k) => k.mask.paths.find((p) => p.id === mask)!);

/** Run a verb, settle the engine, and pin: ONE entry named `label`, undo restores exactly. */
async function oneEntry(label: string, run: () => unknown, check: () => void): Promise<void> {
  const before = h.doc();
  const entries = historyLabels().length;
  const legacy = jest.spyOn(documentEdit, 'runDocumentEdit');
  run();
  await engineIdle();
  await engineIdle();
  expect(legacy).not.toHaveBeenCalled();
  legacy.mockRestore();
  expect(historyLabels().length).toBe(entries + 1);
  expect(historyLabels().at(-1)).toBe(label);
  check();
  await h.run({ type: 'undo' });
  expect(h.doc()).toEqual(before);
}

describe('Mask and Shape Path verbs on masks go through the engine', () => {
  it('Closed opens a static mask', async () => {
    const { layer, mask } = await maskedSolid(square(20));
    useSelectionStore.getState().set([layer]);
    await oneEntry('Closed', () => expect(toggleClosed()).toBe(true), () => {
      expect(staticPath(layer, mask).closed).toBe(false);
    });
  });

  it('Reverse Path Direction reverses EVERY keyframe of an animated mask', async () => {
    const { layer, mask } = await maskedSolid(square(20));
    await animate(layer, mask, square(40));
    useSelectionStore.getState().set([layer]);
    await oneEntry('Reverse Path Direction', () => expect(reversePathCommand()).toBe(true), () => {
      const keys = keyPaths(layer, mask);
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
    await oneEntry('Closed', () => toggleClosed(), () => {
      for (const p of keyPaths(layer, mask)) expect(p.closed).toBe(false);
    });
  });

  it('Set First Vertex rotates the mask and its per-vertex feathers move with the vertices', async () => {
    const { layer, mask } = await maskedSolid({ ...square(20), featherPoints: [{ segment: 2, t: 0, radius: 7, tension: 0 }] });
    useSelectionStore.getState().set([layer]);
    ds().selectVertices({ nodeId: layer as never, maskId: mask }, [2]);
    await oneEntry('Set First Vertex', () => expect(setFirstVertexCommand()).toBe(true), () => {
      const pts = staticPath(layer, mask).points;
      expect(pts[0]).toMatchObject({ x: 20, y: 20, feather: 7 });
      expect(pts.filter((p) => p.feather !== undefined)).toHaveLength(1);
    });
  });

  it('Alt+Shift+M keys every mask of the layer at the playhead, with the shape drawn there', async () => {
    const { layer, mask } = await maskedSolid(square(20));
    const other = await addMask(layer, square(5));
    await animate(layer, mask, square(40));
    getTimelineController().seekSeconds(0.5);
    useSelectionStore.getState().set([layer]);
    await oneEntry('Set Path Keyframe', () => expect(keyframePathAtPlayhead()).toBe(true), () => {
      const anim = readNodeMaskAnim(defaultSceneGraph.getNode(layer)!);
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
    await oneEntry('Closed', () => expect(toggleClosed()).toBe(true), () => {
      expect(staticPath(layer, mask).closed).toBe(false);
      expect((staticPath(layer, mask).points[1] as MaskPoint & { broken?: boolean }).broken).toBe(true);
    });
  });

  it('pastes a copied mask path onto an animated mask: a key at the playhead, closed everywhere', async () => {
    const src = await maskedSolid(tri(30), 'Src');
    const dst = await maskedSolid(square(20), 'Dst');
    await animate(dst.layer, dst.mask, square(40));
    useUIStore.getState().setActiveTool('direct-select');
    useSelectionStore.getState().set([src.layer]);
    ds().selectVertices({ nodeId: src.layer as never, maskId: src.mask }, [0]);
    expect(copyPathFromSelection()).toBe(true);
    ds().clearVertexSelection();
    useSelectionStore.getState().set([dst.layer]);
    getTimelineController().seekSeconds(1);
    await oneEntry('Paste Path', () => expect(pastePathEdit()).toBe(true), () => {
      const keys = keyPaths(dst.layer, dst.mask);
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
    const before = h.doc();
    const entries = historyLabels().length;
    const ids = await convertMasksToShapeLayers();
    await engineIdle();
    expect(ids).toHaveLength(1);
    expect(historyLabels().length).toBe(entries + 1);
    expect(historyLabels().at(-1)).toBe('Convert Mask to Shape Layer');
    expect(useSelectionStore.getState().ids).toEqual(ids);
    const wn = createSceneGraphPort().getNode(ids[0]!)!;
    const srcWorld = createSceneGraphPort().getNode(layer)!.worldMatrix;
    const expectTL = { x: srcWorld.a * -10 + srcWorld.c * -10 + srcWorld.e, y: srcWorld.b * -10 + srcWorld.d * -10 + srcWorld.f };
    const p = wn.pathPoints![0]!;
    const w = wn.worldMatrix;
    expect(w.a * p.x + w.c * p.y + w.e).toBeCloseTo(expectTL.x, 6);
    expect(w.b * p.x + w.d * p.y + w.f).toBeCloseTo(expectTL.y, 6);
    await h.run({ type: 'undo' });
    expect(h.doc()).toEqual(before);
  });
});

describe('Roto Brush mask', () => {
  const W = 64;
  const readPixels = async (): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> =>
    ({ rgba: new Uint8ClampedArray(W * W * 4), width: W, height: W });
  // A filled square in the middle of the source.
  const segment = async (): Promise<{ mask: Uint8Array }> => {
    const mask = new Uint8Array(W * W);
    for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) mask[y * W + x] = 255;
    return { mask } as never;
  };
  const strokes = [{ kind: 'fg' as const, points: [{ x: 0, y: 0 }] }] as never;

  it('writes the matte as a named, feathered mask and a re-segment replaces it — one entry each', async () => {
    const { layer, mask: keep } = await maskedSolid(square(10), 'Roto');
    const before = h.doc();
    const entries = historyLabels().length;
    const first = await segmentStrokesToMask(layer, strokes, 0, { featherPx: 3, readPixels, segment: segment as never });
    expect(first).not.toBeNull();
    expect(historyLabels().length).toBe(entries + 1);
    let paths = readNodeMask(defaultSceneGraph.getNode(layer)!)!.paths;
    expect(paths.map((p) => p.id)).toEqual([keep, first]);
    const roto = paths[1]!;
    expect(roto).toMatchObject({ name: ROTO_PATH_NAME, mode: 'add', closed: true, feather: 3, inverted: false });
    expect(roto.points.length).toBeGreaterThanOrEqual(3);

    const second = await segmentStrokesToMask(layer, strokes, 0, { featherPx: 5, replacePathId: first, readPixels, segment: segment as never });
    expect(second).not.toBeNull();
    expect(historyLabels().length).toBe(entries + 2);
    paths = readNodeMask(defaultSceneGraph.getNode(layer)!)!.paths;
    expect(paths.map((p) => p.id)).toEqual([keep, second]);
    expect(paths[1]!.feather).toBe(5);

    await h.run({ type: 'undo' });
    await h.run({ type: 'undo' });
    expect(h.doc()).toEqual(before);
  });
});

// A DRAWN shape layer's own outline is `layer/path.points` (a path value):
// its verbs are engine edits too — ONE entry each that undo restores exactly
// and redo reapplies.
describe('drawn shape paths go through the engine', () => {
  const pt = (x: number, y: number): MaskPoint => ({ x, y, inX: x, inY: y, outX: x, outY: y });
  const outline = (s: number): MaskPoint[] => [pt(0, -s), pt(s, s), pt(-s, s)];

  async function drawnPath(s: number): Promise<string> {
    const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'path', name: 'Drawn', init: [] });
    const node = defaultSceneGraph.getNode(layer)!;
    const geom = node.components.find((c) => c.type === 'Geometry')!;
    defaultSceneGraph.writeProp(node.id, geom.id, 'points', outline(s));
    await h.run({ type: 'renameLayer', layer, name: 'Drawn' });
    return layer;
  }
  const geomOf = (id: string): Record<string, unknown> =>
    defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Geometry')!.props as Record<string, unknown>;

  /** ONE entry named `label`, no legacy writer; undo restores exactly; redo reapplies. */
  async function engineEntry(label: string, run: () => unknown, check: () => void): Promise<void> {
    await engineIdle();
    const before = h.doc();
    const entries = historyLabels().length;
    const legacy = jest.spyOn(documentEdit, 'runDocumentEdit');
    run();
    await engineIdle();
    await engineIdle();
    expect(legacy).not.toHaveBeenCalled();
    legacy.mockRestore();
    expect(historyLabels().length).toBe(entries + 1);
    expect(historyLabels().at(-1)).toBe(label);
    check();
    const after = h.doc();
    await h.run({ type: 'undo' });
    expect(h.doc()).toEqual(before);
    await h.run({ type: 'redo' });
    expect(h.doc()).toEqual(after);
  }

  it('Closed on a drawn path', async () => {
    const layer = await drawnPath(30);
    useSelectionStore.getState().set([layer]);
    await engineEntry('Closed', () => expect(toggleClosed()).toBe(true), () => {
      expect(geomOf(layer).open).toBe(true);
    });
  });

  it('Reverse Path Direction on a drawn path', async () => {
    const layer = await drawnPath(30);
    useSelectionStore.getState().set([layer]);
    await engineEntry('Reverse Path Direction', () => expect(reversePathCommand()).toBe(true), () => {
      expect((geomOf(layer).points as MaskPoint[])[0]).toMatchObject({ x: -30, y: 30 });
    });
  });

  it('Alt+Shift+M on a drawn path, unanimated then animated', async () => {
    // (The Path row's stopwatch is the generic property stopwatch: layout/Menu/appEdits.test.ts.)
    const layer = await drawnPath(30);
    useSelectionStore.getState().set([layer]);
    await engineEntry('Set Path Keyframe', () => expect(keyframePathAtPlayhead()).toBe(true), () => {
      expect(defaultAnimation.getDataTrack(layer, 'path.points')!.keyframes).toHaveLength(1);
    });
    getTimelineController().seekSeconds(1);
    await engineEntry('Set Path Keyframe', () => expect(keyframePathAtPlayhead()).toBe(true), () => {
      expect(defaultAnimation.getDataTrack(layer, 'path.points')!.keyframes).toHaveLength(2);
    });
  });
});
