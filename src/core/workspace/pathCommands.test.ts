/**
 * Layer ▸ Mask and Shape Path, the path payload switches, the Path timeline
 * row and the mask ⇄ shape path clipboard — through the real binding.
 *
 * The structural verbs (Closed, Set First Vertex, Reverse, RotoBezier) must
 * land in EVERY state of an animated outline: a keyframe left with the old
 * vertex order or closed-ness makes the outline morph through itself.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { seedDefaultScene, SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { activeCompRootId } from '@core/scene/activeComp';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { defaultAnimation } from '@motion/animation';
import { commands, DirectSelectionTool, type BezierPoint } from '@motion/workspace';
import { getTimelineController } from '@core/timeline/TimelineController';
import { readNodeMask, readNodeMaskAnim, type LayerMask, type MaskPoint } from '@core/effects/mask';
import { buildStaticPropertyTree } from '@core/timeline/propertyTree';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import type { SceneNode, ID } from '@core/types';
import { createCommandPort, createSceneGraphPort } from './ports';
import { getWorkspaceController } from './WorkspaceController';
import {
  clearPathClipboard,
  copyPathFromSelection,
  keyframePathAtPlayhead,
  pastePathOntoSelection,
  reversePathCommand,
  setFirstVertexCommand,
  toggleClosed,
  togglePathAnimation,
  toggleRotoBezier,
} from './pathCommands';

const corner = (x: number, y: number): MaskPoint => ({ x, y, inX: x, inY: y, outX: x, outY: y });
const tri = (s: number): MaskPoint[] => [corner(0, -s), corner(s, s), corner(-s, s)];
const square = (s: number): MaskPoint[] => [corner(-s, -s), corner(s, -s), corner(s, s), corner(-s, s)];
const maskOf = (s: number): LayerMask => ({
  paths: [{ id: 'm1', mode: 'add', closed: true, feather: 0, opacity: 1, expansion: 0, inverted: false, points: square(s) }],
});

function layer(id: string, extra: SceneNode['components']): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 300, y: 200 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', shapeType: 'path', x: 300, y: 200, rotation: 0, width: 200, height: 200 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ffffff' } },
      ...extra,
    ],
  } as unknown as SceneNode;
}

const made: string[] = [];
function add(node: SceneNode): void {
  defaultSceneGraph.addNode(node);
  defaultSceneGraph.addChild(activeCompRootId() as ID, node);
  made.push(node.id as string);
}
const geomOf = (id: string): Record<string, unknown> =>
  defaultSceneGraph.getNode(id as ID)!.components.find((c) => c.type === 'Geometry')!.props as Record<string, unknown>;
const pathLayer = (id: string, points: MaskPoint[], open = false): void =>
  add(layer(id, [{ id: `${id}_g`, type: 'Geometry', props: { points, ...(open ? { open: true } : {}) } }] as SceneNode['components']));
const ds = (): DirectSelectionTool => getWorkspaceController().ws.tools.get('direct-select') as DirectSelectionTool;

beforeAll(() => {
  seedDefaultScene();
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

afterEach(() => {
  ds().clearVertexSelection();
  clearPathClipboard();
  useSelectionStore.getState().set([]);
  for (const id of made.splice(0)) defaultSceneGraph.removeNode(id as ID);
  defaultAnimation.clear();
  getTimelineController().seekSeconds(0);
});

describe('path payload switches reach the document', () => {
  it('closed / rotoBezier on a shape path write Geometry and show on the port', () => {
    pathLayer('pp_flags', tri(40));
    createCommandPort().execute(commands.updateNodePath('pp_flags' as never, tri(40), undefined, { closed: false, rotoBezier: true }));
    expect(geomOf('pp_flags').open).toBe(true);
    expect(geomOf('pp_flags').rotoBezier).toBe(true);
    const wn = createSceneGraphPort().getNode('pp_flags')!;
    expect(wn.pathClosed).toBe(false);
    expect(wn.pathRotoBezier).toBe(true);
  });

  it('a Continue (extend) lands in every keyframe of an animated path', () => {
    pathLayer('pp_extend', tri(10), true);
    defaultAnimation.setDataKeyframe('pp_extend', 'path.points', 'points', 0, tri(10));
    defaultAnimation.setDataKeyframe('pp_extend', 'path.points', 'points', 2, tri(50));
    createCommandPort().execute(
      commands.updateNodePath('pp_extend' as never, [...tri(10), corner(90, 90)], { op: 'extend', points: [corner(90, 90)], atStart: false }),
    );
    const keys = defaultAnimation.getDataTrack('pp_extend', 'path.points')!.keyframes;
    expect(keys).toHaveLength(2);
    for (const k of keys) expect((k.value as MaskPoint[])[3]).toMatchObject({ x: 90, y: 90 });
  });

  it('an animated path keeps its vertices\' broken flags when read between keyframes', () => {
    pathLayer('pp_broken', tri(10));
    defaultAnimation.setDataKeyframe('pp_broken', 'path.points', 'points', 0, tri(10).map((p, i) => (i === 1 ? { ...p, broken: true } : p)));
    defaultAnimation.setDataKeyframe('pp_broken', 'path.points', 'points', 2, tri(50).map((p, i) => (i === 1 ? { ...p, broken: true } : p)));
    getTimelineController().seekSeconds(1);
    const pts = createSceneGraphPort().getNode('pp_broken')!.pathPoints!;
    expect(pts[1]!.broken).toBe(true);
    expect(pts[0]!.broken).toBeUndefined();
  });

  it('a mask closed switch edits the static mask AND every keyframe', () => {
    add(layer('pp_mask', [
      { id: 'pp_mask_fx', type: 'fx', props: { mask: maskOf(10), maskAnim: [{ t: 0, mask: maskOf(10) }, { t: 4, mask: maskOf(50) }] } },
    ] as SceneNode['components']));
    createCommandPort().execute(commands.updateMaskPath('pp_mask' as never, 'm1', square(10), { op: 'reverse' }, { closed: false }));
    const node = defaultSceneGraph.getNode('pp_mask' as ID)!;
    expect(readNodeMask(node)!.paths[0]!.closed).toBe(false);
    for (const k of readNodeMaskAnim(node)) {
      expect(k.mask.paths[0]!.closed).toBe(false);
      expect(k.mask.paths[0]!.points[0]!.y).toBeGreaterThan(0); // reversed: starts at the last vertex
    }
  });
});

describe('Layer ▸ Mask and Shape Path', () => {
  it('Closed toggles the selected layer\'s path', () => {
    pathLayer('pc_closed', tri(40));
    useSelectionStore.getState().set(['pc_closed']);
    expect(toggleClosed()).toBe(true);
    expect(geomOf('pc_closed').open).toBe(true);
    expect(toggleClosed()).toBe(true);
    expect(geomOf('pc_closed').open).toBeUndefined();
  });

  it('Reverse Path Direction reverses the static path and every keyframe', () => {
    pathLayer('pc_rev', tri(40));
    defaultAnimation.setDataKeyframe('pc_rev', 'path.points', 'points', 0, tri(10));
    defaultAnimation.setDataKeyframe('pc_rev', 'path.points', 'points', 1, tri(20));
    useSelectionStore.getState().set(['pc_rev']);
    reversePathCommand();
    expect((geomOf('pc_rev').points as MaskPoint[])[0]).toMatchObject({ x: -40, y: 40 });
    for (const k of defaultAnimation.getDataTrack('pc_rev', 'path.points')!.keyframes) {
      expect((k.value as MaskPoint[])[0]!.x).toBeLessThan(0);
    }
  });

  it('Set First Vertex rotates the outline to the ONE selected vertex, everywhere', () => {
    pathLayer('pc_first', square(40));
    defaultAnimation.setDataKeyframe('pc_first', 'path.points', 'points', 1, square(20));
    useSelectionStore.getState().set(['pc_first']);
    ds().selectVertices({ nodeId: 'pc_first', maskId: null }, [2]);
    expect(setFirstVertexCommand()).toBe(true);
    expect((geomOf('pc_first').points as MaskPoint[])[0]).toMatchObject({ x: 40, y: 40 });
    const key = defaultAnimation.getDataTrack('pc_first', 'path.points')!.keyframes[0]!;
    expect((key.value as MaskPoint[])[0]).toMatchObject({ x: 20, y: 20 });
  });

  it('Set First Vertex refuses without exactly one selected vertex', () => {
    pathLayer('pc_first_none', square(40));
    useSelectionStore.getState().set(['pc_first_none']);
    expect(setFirstVertexCommand()).toBe(false);
  });

  it('RotoBezier on computes handles and sets the switch', () => {
    pathLayer('pc_roto', square(30));
    useSelectionStore.getState().set(['pc_roto']);
    toggleRotoBezier();
    expect(geomOf('pc_roto').rotoBezier).toBe(true);
    const v = (geomOf('pc_roto').points as BezierPoint[])[0]!;
    expect(v.outX === v.x && v.outY === v.y).toBe(false);
  });

  it('Alt+Shift+M keys the path at the playhead; the Path row stopwatch turns animation off again', () => {
    pathLayer('pc_key', tri(30));
    useSelectionStore.getState().set(['pc_key']);
    expect(keyframePathAtPlayhead()).toBe(true);
    expect(defaultAnimation.isDataAnimated('pc_key', 'path.points')).toBe(true);
    togglePathAnimation('pc_key');
    expect(defaultAnimation.isDataAnimated('pc_key', 'path.points')).toBe(false);
    togglePathAnimation('pc_key');
    expect(defaultAnimation.isDataAnimated('pc_key', 'path.points')).toBe(true);
  });

  it('a drawn shape path has a keyframeable Path row under Contents', () => {
    pathLayer('pc_row', tri(30));
    const row = buildStaticPropertyTree('pc_row').find((r) => r.prop === 'path.points');
    expect(row).toMatchObject({ label: 'Path', group: 'contents', members: ['path.points'] });
  });
});

// Convert Mask to Shape Layer (one engine entry) is pinned in pathEdits.test.ts.
describe('mask ⇄ shape path clipboard', () => {
  it('copies a mask path and pastes it onto a shape layer\'s path', () => {
    add(layer('pk_src', [{ id: 'pk_src_fx', type: 'fx', props: { mask: maskOf(25) } }] as SceneNode['components']));
    pathLayer('pk_dst', tri(40), true);
    useUIStore.getState().setActiveTool('direct-select');
    useSelectionStore.getState().set(['pk_src']);
    ds().selectVertices({ nodeId: 'pk_src', maskId: 'm1' }, [0]);
    expect(copyPathFromSelection()).toBe(true);

    ds().clearVertexSelection();
    useSelectionStore.getState().set(['pk_dst']);
    expect(pastePathOntoSelection()).toBe(true);
    const pts = geomOf('pk_dst').points as MaskPoint[];
    expect(pts).toHaveLength(4);
    expect(pts[2]).toMatchObject({ x: 25, y: 25 });
    expect(geomOf('pk_dst').open).toBeUndefined(); // the mask was closed
    useUIStore.getState().setActiveTool('select');
  });

});
