/**
 * Pen / Direct Selection edits reach the geometry the renderer actually draws.
 *
 * Driven through `createCommandPort` — the way the tools commit — so the whole
 * binding is covered:
 *   1. an ANIMATED shape path is read from, and written to, its `path.points`
 *      track (the static Geometry points were edited and never rendered);
 *   2. adding / deleting a vertex is replayed on EVERY keyframe of an animated
 *      path or mask (one keyframe with a different count froze the morph);
 *   3. a Pen outline closed on its first vertex becomes a closed, filled shape;
 *   4. a Mask Pen outline is mapped through the SAME matrix the viewport uses —
 *      anchor included (`worldMatrixOf` had no anchor term).
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { seedDefaultScene, SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { activeCompRootId } from '@core/scene/activeComp';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { defaultAnimation } from '@motion/animation';
import { commands, Mat } from '@motion/workspace';
import { compToKeyframeTime, getTimelineController } from '@core/timeline/TimelineController';
import { readNodeMask, readNodeMaskAnim, type LayerMask, type MaskPoint } from '@core/effects/mask';
import { useSelectionStore } from '@stores/selectionStore';
import type { SceneNode, ID } from '@core/types';
import { createCommandPort, createSceneGraphPort } from './ports';
import { engineIdle } from '@core/engine/engineInstance';
import { settleToolEdits } from './viewportGesture';

const corner = (x: number, y: number): MaskPoint => ({ x, y, inX: x, inY: y, outX: x, outY: y });
const tri = (s: number): MaskPoint[] => [corner(0, -s), corner(s, s), corner(-s, s)];
const square = (s: number): MaskPoint[] => [corner(-s, -s), corner(s, -s), corner(s, s), corner(-s, s)];
const maskOf = (s: number): LayerMask => ({
  paths: [{ id: 'm1', mode: 'add', closed: true, feather: 0, opacity: 1, expansion: 0, inverted: false, points: square(s) }],
});

function layer(id: string, extra: SceneNode['components'], transform: Record<string, unknown> = {}): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 300, y: 200 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`, type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'shape', shapeType: 'path', x: 300, y: 200, rotation: 0, width: 200, height: 200, ...transform },
      },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ffffff' } },
      ...extra,
    ],
  } as unknown as SceneNode;
}

/** Every tool action closed and the engine idle (the port's writes are engine edits). */
const settle = async (): Promise<void> => {
  await settleToolEdits();
  await engineIdle();
  await engineIdle();
};

const made: string[] = [];
function add(node: SceneNode): void {
  defaultSceneGraph.addNode(node);
  defaultSceneGraph.addChild(activeCompRootId() as ID, node);
  made.push(node.id as string);
}

beforeAll(() => {
  seedDefaultScene();
  // Animated writes record through the anim-edit history; it needs the singleton.
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

afterEach(() => {
  for (const id of made.splice(0)) defaultSceneGraph.removeNode(id as ID);
  defaultAnimation.clear();
  getTimelineController().seekSeconds(0);
});

describe('an ANIMATED shape path', () => {
  const ID_ = 'pen_anim_path';
  const setup = (): void => {
    // The static points are deliberately a DIFFERENT shape from the track, so
    // reading or writing the wrong one is visible.
    add(layer(ID_, [{ id: `${ID_}_g`, type: 'Geometry', props: { points: tri(90) } }] as SceneNode['components']));
    defaultAnimation.setDataKeyframe(ID_, 'path.points', 'points', 0, tri(10));
    defaultAnimation.setDataKeyframe(ID_, 'path.points', 'points', 2, tri(50));
  };

  it('shows Direct Selection the vertices the renderer draws, not the static ones', () => {
    setup();
    const pts = createSceneGraphPort().getNode(ID_)!.pathPoints!;
    expect(pts[0]).toMatchObject({ x: 0, y: -10 });
  });

  it('a reshape keys the track at the playhead and leaves the static points alone', async () => {
    setup();
    getTimelineController().seekSeconds(1);
    const t = compToKeyframeTime(ID_, 1);
    createCommandPort().execute(commands.updateNodePath(ID_ as never, tri(33)));
    await settle();

    const track = defaultAnimation.getDataTrack(ID_, 'path.points')!;
    const key = track.keyframes.find((k) => Math.abs(k.t - t) < 1e-6);
    expect(key).toBeDefined();
    expect((key!.value as MaskPoint[])[1]).toMatchObject({ x: 33, y: 33 });
    const geom = defaultSceneGraph.getNode(ID_)!.components.find((c) => c.type === 'Geometry')!;
    expect((geom.props.points as MaskPoint[])[1]).toMatchObject({ x: 90, y: 90 });
  });

  it('adding a vertex replays on EVERY keyframe, so they keep one count', async () => {
    setup();
    createCommandPort().execute(
      commands.updateNodePath(ID_ as never, tri(10), { op: 'insert', segment: 0, u: 0.5 }),
    );
    await settle();
    const keys = defaultAnimation.getDataTrack(ID_, 'path.points')!.keyframes;
    expect(keys).toHaveLength(2); // no stray keyframe at the playhead
    for (const k of keys) expect(k.value as MaskPoint[]).toHaveLength(4);
    // Midpoint of the first edge of each keyframe's own triangle.
    expect((keys[0]!.value as MaskPoint[])[1]).toMatchObject({ x: 5, y: 0 });
    expect((keys[1]!.value as MaskPoint[])[1]).toMatchObject({ x: 25, y: 0 });
  });
});

describe('a vertex added / deleted on an ANIMATED mask', () => {
  const ID_ = 'pen_anim_mask';
  const setup = (): void => {
    add(layer(ID_, [
      { id: `${ID_}_fx`, type: 'fx', props: { mask: maskOf(10), maskAnim: [{ t: 0, mask: maskOf(10) }, { t: 4, mask: maskOf(50) }] } },
    ] as SceneNode['components']));
  };

  it('insert lands in every keyframe (and the static mask), not only at the playhead', async () => {
    setup();
    getTimelineController().seekSeconds(2);
    createCommandPort().execute(
      commands.updateMaskPath(ID_ as never, 'm1', square(30), { op: 'insert', segment: 0, u: 0.5 }),
    );
    await settle();
    const node = defaultSceneGraph.getNode(ID_)!;
    const anim = readNodeMaskAnim(node);
    expect(anim.map((k) => k.t)).toEqual([0, 4]);
    for (const k of anim) expect(k.mask.paths[0]!.points).toHaveLength(5);
    expect(anim[1]!.mask.paths[0]!.points[1]).toMatchObject({ x: 0, y: -50 });
    expect(readNodeMask(node)!.paths[0]!.points).toHaveLength(5);
  });

  it('delete removes the same index everywhere', async () => {
    setup();
    createCommandPort().execute(
      commands.updateMaskPath(ID_ as never, 'm1', square(30).slice(1), { op: 'delete', index: 0 }),
    );
    await settle();
    for (const k of readNodeMaskAnim(defaultSceneGraph.getNode(ID_)!)) {
      expect(k.mask.paths[0]!.points).toHaveLength(3);
      expect(k.mask.paths[0]!.points[0]!.y).toBeLessThan(0); // was vertex 1 (top-right)
      expect(k.mask.paths[0]!.points[0]!.x).toBeGreaterThan(0);
    }
  });
});

describe('a Pen outline closed on its first vertex', () => {
  const OUTLINE = [corner(-50, 40), corner(0, -40), corner(50, 40)];
  /** Every tool action closed and the engine idle. */
  const drawn = async (): Promise<void> => {
    await settleToolEdits();
    await engineIdle();
  };
  const created = (): SceneNode => {
    const ids = useSelectionStore.getState().ids;
    const node = defaultSceneGraph.getNode(ids[ids.length - 1] as ID)!;
    made.push(node.id as string);
    return node;
  };

  it('becomes a closed, FILLED shape', async () => {
    createCommandPort().execute(commands.createNode('Path', { x: 0, y: 0, width: 100, height: 80 }, OUTLINE, undefined, true));
    await drawn(); // a drawn layer is an engine insert (B3)
    const node = created();
    const geom = node.components.find((c) => c.type === 'Geometry')!;
    expect(geom.props.open).toBeUndefined();
    const fill = node.components.find((c) => c.type === 'Style')!.props.fill;
    expect(fill).not.toBe('rgba(0,0,0,0)');
    expect(createSceneGraphPort().getNode(node.id as string)!.pathClosed).toBe(true);
  });

  it('CONTROL: an unclosed Pen outline is still an open stroke', async () => {
    createCommandPort().execute(commands.createNode('Path', { x: 0, y: 0, width: 100, height: 80 }, OUTLINE));
    await drawn();
    const node = created();
    expect(node.components.find((c) => c.type === 'Geometry')!.props.open).toBe(true);
    expect(createSceneGraphPort().getNode(node.id as string)!.pathClosed).toBe(false);
  });
});

describe('a Mask Pen outline on an anchored layer', () => {
  it('lands where it was clicked — through the viewport\'s own matrix, anchor included', async () => {
    const ID_ = 'pen_mask_anchor';
    add(layer(ID_, [], { anchorX: 50, anchorY: -20 }));
    const wm = createSceneGraphPort().getNode(ID_)!.worldMatrix;
    // Guard: the anchor really moves the layer's content, or this proves nothing.
    expect(Mat.apply(wm, { x: 0, y: 0 }).x).toBeCloseTo(250);

    // Three WORLD clicks, handed over the way the pen does: relative to the
    // centre of their bounds.
    const world = [{ x: 280, y: 200 }, { x: 340, y: 200 }, { x: 310, y: 260 }];
    const bounds = { x: 280, y: 200, width: 60, height: 60 };
    const local = world.map((p) => corner(p.x - 310, p.y - 230));
    createCommandPort().execute(commands.createNode('Path', bounds, local, ID_));
    await engineIdle(); // New Mask is an engine command (B3)

    const pts = readNodeMask(defaultSceneGraph.getNode(ID_)!)!.paths[0]!.points;
    pts.forEach((p, i) => {
      const back = Mat.apply(wm, { x: p.x, y: p.y });
      expect(back.x).toBeCloseTo(world[i]!.x, 6);
      expect(back.y).toBeCloseTo(world[i]!.y, 6);
    });
    // The first click is (280,200) = content (−20, 0) from the layer origin,
    // which is local (30, −20) once the anchor is added back. The old matrix
    // stored (−20, 0).
    expect(pts[0]).toMatchObject({ x: 30, y: -20 });
  });
});
