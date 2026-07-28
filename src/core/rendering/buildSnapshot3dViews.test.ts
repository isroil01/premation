/**
 * 3D views + near-plane clipping — the acceptance criteria from the 3D camera /
 * lights / views brief (see docs/3d-diagnosis.md).
 *
 * Two things are pinned here:
 *
 *   1. The six axis views really are six different views. Three layers spread
 *      in z separate along the axis each view carries z on, and 2D layers stay
 *      exactly where they are in every one of them (AE: a 2D layer ignores the
 *      camera entirely).
 *   2. A layer behind the camera's near plane is DROPPED, not clamped.
 *      `projectPoint` clamps camera-space z to NEAR so the divide stays finite,
 *      which used to leave a layer the camera had dollied past resolving to
 *      focalLength / 1 — a ~1111× scale for a 1920-wide comp, i.e. one layer
 *      smeared opaque over the whole frame instead of disappearing.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { Project3D } from '@motion/scene';

const COMP = { width: 800, height: 600, background: '#101014' };
const ORTHO_VIEWS = ['front', 'back', 'left', 'right', 'top', 'bottom'] as const;

/** A shape at the comp centre. `three` absent ⇒ a pure-2D layer. */
function node(id: string, three?: { z?: number }): SceneNode {
  const props: Record<string, unknown> = {
    [SCENE_KIND_PROP]: 'shape', x: 400, y: 300, rotation: 0, width: 200, height: 150,
  };
  if (three) {
    props.z = three.z ?? 0;
    props.rotationX = 0;
    props.rotationY = 0;
  }
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

function snap(nodes: SceneNode[], camera3dMode: string) {
  const graph = new SceneGraph();
  for (const n of nodes) graph.addNode(n);
  return buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, {
    ...COMP, camera3dMode,
  } as never);
}

const byId = (s: ReturnType<typeof snap>, id: string) => s.layers.find((l) => l.id === id);

describe('the six axis views are six different views', () => {
  const spread = [node('near', { z: -500 }), node('mid', { z: 0 }), node('far', { z: 500 })];

  it('Top view separates layers along screen Y by their z', () => {
    const s = snap(spread, 'top');
    // Top looks from −y; screen-down is −z, so +z moves UP the screen.
    expect(byId(s, 'near')!.y).toBeCloseTo(800, 6);
    expect(byId(s, 'mid')!.y).toBeCloseTo(300, 6);
    expect(byId(s, 'far')!.y).toBeCloseTo(-200, 6);
    // …and not along X, which Top view does not carry z on.
    for (const id of ['near', 'mid', 'far']) expect(byId(s, id)!.x).toBeCloseTo(400, 6);
  });

  it('Left view separates layers along screen X by their z', () => {
    const s = snap(spread, 'left');
    expect(byId(s, 'near')!.x).toBeCloseTo(900, 6);
    expect(byId(s, 'mid')!.x).toBeCloseTo(400, 6);
    expect(byId(s, 'far')!.x).toBeCloseTo(-100, 6);
  });

  it('Right and Bottom mirror Left and Top', () => {
    const left = snap(spread, 'left');
    const right = snap(spread, 'right');
    const top = snap(spread, 'top');
    const bottom = snap(spread, 'bottom');
    for (const id of ['near', 'mid', 'far']) {
      expect(byId(right, id)!.x).toBeCloseTo(800 - byId(left, id)!.x, 6);
      expect(byId(bottom, id)!.y).toBeCloseTo(600 - byId(top, id)!.y, 6);
    }
  });

  it('no two views produce the same placement + orientation for the spread', () => {
    const fingerprint = (mode: string): string =>
      snap(spread, mode)
        .layers.map((l) => `${l.id}:${l.x.toFixed(3)},${l.y.toFixed(3)},${(l.matrix ?? []).join('/')}`)
        .sort()
        .join('|');
    const seen = new Map<string, string>();
    for (const v of ORTHO_VIEWS) {
      const f = fingerprint(v);
      expect(seen.get(f)).toBeUndefined();
      seen.set(f, v);
    }
    // Front and Back agree on position but differ in handedness (mirrored X
    // basis), which is why the matrix has to be part of the fingerprint.
    expect(byId(snap(spread, 'front'), 'mid')!.matrix![0]).toBeCloseTo(1, 6);
    expect(byId(snap(spread, 'back'), 'mid')!.matrix![0]).toBeCloseTo(-1, 6);
  });

  it('a 2D layer does not move in ANY view (it ignores the camera)', () => {
    const nodes = [node('flat'), node('deep', { z: 500 })];
    for (const mode of ['active', ...ORTHO_VIEWS]) {
      const flat = byId(snap(nodes, mode), 'flat')!;
      expect(flat.x).toBeCloseTo(400, 6);
      expect(flat.y).toBeCloseTo(300, 6);
      expect(flat.matrix).toBeUndefined(); // 2D draw path untouched
    }
  });

  it('a 3D layer at z = 0 renders at the same scale as the same layer in 2D', () => {
    const s = snap([node('flat'), node('at-zero', { z: 0 })], 'active');
    const flat = byId(s, 'flat')!;
    const zero = byId(s, 'at-zero')!;
    expect(zero.scaleX).toBeCloseTo(flat.scaleX, 6);
    expect(zero.scaleY).toBeCloseTo(flat.scaleY, 6);
    expect(zero.x).toBeCloseTo(flat.x, 6);
  });
});

describe('near-plane rejection', () => {
  /** The default camera sits at z = −focalLength, so this is just behind it. */
  const eyeZ = -Project3D.defaultCamera(COMP.width, COMP.height).focalLength;

  it('drops a layer behind the camera instead of inflating it', () => {
    const s = snap([node('behind', { z: eyeZ - 900 })], 'active');
    expect(byId(s, 'behind')).toBeUndefined();
  });

  it('drops a layer exactly at the eye (the divide-by-zero case)', () => {
    expect(byId(snap([node('at-eye', { z: eyeZ })], 'active'), 'at-eye')).toBeUndefined();
  });

  it('keeps the layer just in FRONT of the near plane', () => {
    const s = snap([node('just-ahead', { z: eyeZ + 50 })], 'active');
    expect(byId(s, 'just-ahead')).toBeDefined();
  });

  it('every surviving layer is a REAL projection, never the near clamp', () => {
    // The distinction that matters: a layer 1px in front of the lens is
    // legitimately enormous (that is just perspective), but a layer BEHIND the
    // camera used to render at that same fixed focalLength/NEAR ≈ 1111× as
    // though it were 1px in front. So the assertion is not "scale is small" —
    // it is "scale is what the true distance says it should be".
    const focal = Project3D.defaultCamera(COMP.width, COMP.height).focalLength;
    for (const dz of [-5000, -2000, -900, -1, 0, 1, 50, 5000]) {
      const l = byId(snap([node('q', { z: eyeZ + dz })], 'active'), 'q');
      if (!l) {
        expect(dz).toBeLessThan(1); // only at/behind the near plane may drop out
        continue;
      }
      expect(l.scaleX).toBeCloseTo(focal / dz, 6);
    }
  });

  it('orthographic views never clip on the near plane (parallel projection)', () => {
    for (const v of ORTHO_VIEWS) {
      expect(byId(snap([node('deep-behind', { z: eyeZ - 900 })], v), 'deep-behind')).toBeDefined();
    }
  });

  it('a 2D layer is never near-clipped, whatever the camera is doing', () => {
    expect(byId(snap([node('flat')], 'active'), 'flat')).toBeDefined();
  });
});
