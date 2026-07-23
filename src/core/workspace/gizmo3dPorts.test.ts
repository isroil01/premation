/**
 * 3D gizmo transform I/O (ports.ts) — the read/write contract that fixes the
 * gizmo/object desync:
 *
 *   READ  — sampleTransform3DAtPlayhead returns the ANIMATED value when a
 *           track exists (what the renderer draws), base props otherwise.
 *   WRITE — applyGizmo3DTransforms keyframes props with a lit stopwatch at the
 *           current remapped playhead (base-only writes are invisible there,
 *           because the renderer samples the track first) and writes the base
 *           for static props. Props NOT in the update are never touched.
 */

import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { sampleTransform3DAtPlayhead, applyGizmo3DTransforms } from './ports';

beforeAll(() => {
  // runAnimEdit records through the command system (undo) — boot a bare one.
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

const NODE = 'gizmo3d-ports-node';
const TRANS = `${NODE}_t`;
const ALL_PROPS = ['x', 'y', 'z', 'rotationX', 'rotationY', 'rotation', 'scaleX', 'scaleY', 'scale'] as const;

function makeNode(): SceneNode {
  return {
    id: NODE, name: NODE, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 100, y: 200 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: TRANS,
        type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: 'shape',
          x: 100, y: 200, rotation: 0, scaleX: 1, scaleY: 1, opacity: 100,
          // 3D-enabled layer (depth props present)
          z: 0, rotationX: 0, rotationY: 0,
        },
      },
    ],
  } as unknown as SceneNode;
}

function readBase(prop: string): unknown {
  const n = defaultSceneGraph.getNode(NODE)!;
  return (n.components.find((c) => c.type === 'Transform')!.props as Record<string, unknown>)[prop];
}

beforeEach(() => {
  defaultSceneGraph.addNode(makeNode());
});

afterEach(() => {
  for (const p of ALL_PROPS) defaultAnimation.removeTrack(NODE, p);
  try { defaultSceneGraph.removeNode(NODE); } catch { /* already gone */ }
});

describe('sampleTransform3DAtPlayhead', () => {
  it('returns base transform props when nothing is animated', () => {
    const tv = sampleTransform3DAtPlayhead(defaultSceneGraph.getNode(NODE)!);
    expect(tv).toEqual({
      x: 100, y: 200, z: 0, rotationX: 0, rotationY: 0, rotation: 0, scaleX: 1, scaleY: 1,
    });
  });

  it('animated tracks win over base props (what the renderer draws)', () => {
    defaultAnimation.setKeyframe(NODE, 'x', 0, 555);
    defaultAnimation.setKeyframe(NODE, 'rotationY', 0, 45);
    const tv = sampleTransform3DAtPlayhead(defaultSceneGraph.getNode(NODE)!);
    expect(tv.x).toBe(555); // NOT the stale base 100 the old gizmo anchored on
    expect(tv.rotationY).toBe(45);
    expect(tv.y).toBe(200); // un-animated props still read the base
  });
});

describe('applyGizmo3DTransforms', () => {
  it('writes base props (no keyframes) for a fully static node', () => {
    applyGizmo3DTransforms([{ id: NODE, values: { x: 150, y: 250, z: -30 } }]);
    expect(readBase('x')).toBe(150);
    expect(readBase('y')).toBe(250);
    expect(readBase('z')).toBe(-30);
    expect(defaultAnimation.tracksFor(NODE)).toHaveLength(0);
  });

  it('keyframes a prop whose stopwatch is lit — at the playhead, with the new value', () => {
    defaultAnimation.setKeyframe(NODE, 'x', 0, 100);
    applyGizmo3DTransforms([{ id: NODE, values: { x: 400, y: 260 } }]);
    // x has a track → the write must land on the track or the renderer
    // (which samples tracks first) never shows it.
    expect(defaultAnimation.sample(NODE, 'x', 0)).toBe(400);
    // y shares the position stopwatch group (matches canvas moveNodes).
    expect(defaultAnimation.sample(NODE, 'y', 0)).toBe(260);
    // Base follows too, keeping the inspector in agreement.
    expect(readBase('x')).toBe(400);
  });

  it('does not touch (or keyframe) props absent from the update', () => {
    defaultAnimation.setKeyframe(NODE, 'scaleX', 0, 1);
    // Position-only gizmo drag on a node with an animated scale:
    applyGizmo3DTransforms([{ id: NODE, values: { x: 300 } }]);
    const scaleTracks = defaultAnimation.tracksFor(NODE).filter((t) => String(t.prop).startsWith('scale'));
    expect(scaleTracks).toHaveLength(1);
    expect(defaultAnimation.sample(NODE, 'scaleX', 0)).toBe(1); // unchanged
    expect(readBase('x')).toBe(300);
  });

  it('routes 3D props (z / rotationX) through their own stopwatch groups', () => {
    defaultAnimation.setKeyframe(NODE, 'z', 0, 0);
    applyGizmo3DTransforms([{ id: NODE, values: { z: -120, rotationX: 30 } }]);
    expect(defaultAnimation.sample(NODE, 'z', 0)).toBe(-120); // keyed (track exists)
    expect(defaultAnimation.tracksFor(NODE).some((t) => t.prop === 'rotationX')).toBe(false); // static → base only
    expect(readBase('rotationX')).toBe(30);
  });

  it('skips locked nodes', () => {
    try { defaultSceneGraph.removeNode(NODE); } catch { /* ignore */ }
    const locked = makeNode();
    (locked as { locked: boolean }).locked = true;
    defaultSceneGraph.addNode(locked);
    applyGizmo3DTransforms([{ id: NODE, values: { x: 999 } }]);
    expect(readBase('x')).toBe(100);
  });
});
