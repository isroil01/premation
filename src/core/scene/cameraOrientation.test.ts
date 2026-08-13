/**
 * Camera IN-PLACE rotation — `orientationX` / `orientationY`.
 *
 * `orbitYaw` / `orbitPitch` swing the EYE about a target. These two rotate the
 * camera where it stands: a tripod pan or tilt, which no combination of orbit
 * props can express because orbit always moves the eye along an arc.
 *
 * ## What these tests are really guarding
 *
 * A two-node camera re-aims at its Point of Interest through
 * `lookAtOrientation`. Add in-place rotation naively and the look-at simply
 * overwrites it: the inspector rows move, the keyframes record, and the
 * projection does not change by one pixel. That is the "declared at one end,
 * dropped at the other" failure this repo has now hit six times, so the FIRST
 * test below is the one that catches it, and it was confirmed RED before the
 * offset composition existed.
 *
 * The contract, copied from After Effects: the look-at establishes the BASE
 * orientation, and the rotation properties apply as OFFSETS on top of it. A
 * targeted camera can be nudged off its subject deliberately without losing
 * tracking.
 */

import { cameraFromNode } from './camera3d';
import { Project3D } from '@motion/scene';
import type { SceneNode } from '@core/types';

const W = 1920;
const H = 1080;

/** A camera node carrying exactly the Transform props under test. */
function cameraNode(props: Record<string, number>): SceneNode {
  return {
    id: 'cam',
    name: 'Camera 1',
    parent: 'comp_root',
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'cam_t', type: 'Transform', props: { ...props } }],
  } as unknown as SceneNode;
}

/** A one-node camera at the default framing. */
const oneNode = (extra: Record<string, number> = {}) =>
  cameraNode({ x: W / 2, y: H / 2, z: -Project3D.focalLengthForFov(W, 39.6), focalLength: Project3D.focalLengthForFov(W, 39.6), ...extra });

/** A two-node camera aimed at the comp centre, offset so the aim is non-trivial. */
const twoNode = (extra: Record<string, number> = {}) =>
  cameraNode({
    x: W / 2 + 400,
    y: H / 2 - 200,
    z: -Project3D.focalLengthForFov(W, 39.6),
    focalLength: Project3D.focalLengthForFov(W, 39.6),
    poiX: W / 2,
    poiY: H / 2,
    poiZ: 0,
    ...extra,
  });

/** A probe point out in the scene, off the optical axis. */
const PROBE = { x: W / 2 + 260, y: H / 2 + 140, z: 220 };

const projectThrough = (node: SceneNode) =>
  Project3D.projectPoint(PROBE, cameraFromNode(node, W, H));

describe('camera in-place rotation', () => {
  describe('two-node camera (the overwrite trap)', () => {
    it('a non-zero orientationX changes the projection', () => {
      const flat = projectThrough(twoNode());
      const tilted = projectThrough(twoNode({ orientationX: 25 }));
      expect(tilted.y).not.toBeCloseTo(flat.y, 3);
    });

    it('a non-zero orientationY changes the projection', () => {
      const flat = projectThrough(twoNode());
      const panned = projectThrough(twoNode({ orientationY: 25 }));
      expect(panned.x).not.toBeCloseTo(flat.x, 3);
    });

    it('still tracks: the aim is the look-at base PLUS the offset', () => {
      // The offset must compose with the tracked aim, not replace it. Moving
      // the eye must still re-aim, with the same offset carried along.
      const near = cameraFromNode(twoNode({ orientationY: 20 }), W, H);
      const far = cameraFromNode(
        cameraNode({ x: W / 2 + 900, y: H / 2 - 200, z: -1000, focalLength: 1000, poiX: W / 2, poiY: H / 2, poiZ: 0, orientationY: 20 }),
        W,
        H,
      );
      // Different eye ⇒ different look-at base ⇒ different final yaw. If the
      // offset had REPLACED the base, both would read exactly 20.
      expect(near.orientation?.yaw).toBeDefined();
      expect(far.orientation?.yaw).toBeDefined();
      expect(near.orientation!.yaw).not.toBeCloseTo(far.orientation!.yaw, 3);
      expect(near.orientation!.yaw).not.toBeCloseTo(20, 3);
    });

    it('offsets the tracked aim by exactly the property value', () => {
      const base = cameraFromNode(twoNode(), W, H);
      const offset = cameraFromNode(twoNode({ orientationX: 12, orientationY: -18 }), W, H);
      expect(offset.orientation!.pitch - (base.orientation?.pitch ?? 0)).toBeCloseTo(12, 6);
      expect(offset.orientation!.yaw - (base.orientation?.yaw ?? 0)).toBeCloseTo(-18, 6);
    });

    it('does not move the eye', () => {
      const flat = cameraFromNode(twoNode(), W, H);
      const rotated = cameraFromNode(twoNode({ orientationX: 30, orientationY: -40 }), W, H);
      expect(rotated.position).toEqual(flat.position);
    });
  });

  describe('one-node camera (the tripod pan)', () => {
    it('pans the view while the eye stays exactly put', () => {
      // The acceptance criterion: verify the EYE is stationary, not merely that
      // the view moved. Orbit moves the eye; this must not.
      const still = cameraFromNode(oneNode(), W, H);
      const panned = cameraFromNode(oneNode({ orientationY: 30 }), W, H);
      expect(panned.position).toEqual(still.position);
      expect(panned.orientation!.yaw).toBeCloseTo(30, 6);
      expect(projectThrough(oneNode({ orientationY: 30 })).x).not.toBeCloseTo(
        projectThrough(oneNode()).x,
        3,
      );
    });

    it('tilts on orientationX with the eye stationary', () => {
      const still = cameraFromNode(oneNode(), W, H);
      const tilted = cameraFromNode(oneNode({ orientationX: -22 }), W, H);
      expect(tilted.position).toEqual(still.position);
      expect(tilted.orientation!.pitch).toBeCloseTo(-22, 6);
    });

    it('composes with orbit rather than replacing it', () => {
      // Orbit sets the base; in-place rotation adds to it. Both must survive.
      const cam = cameraFromNode(oneNode({ orbitYaw: 15, orientationY: 10 }), W, H);
      expect(cam.orientation!.yaw).toBeCloseTo(25, 6);
      // …and orbit still moved the eye, which in-place rotation never does.
      const orbitOnly = cameraFromNode(oneNode({ orbitYaw: 15 }), W, H);
      expect(cam.position).toEqual(orbitOnly.position);
      expect(cam.position.x).not.toBeCloseTo(oneNode().components[0]!.props.x as number, 3);
    });
  });

  describe('byte-identity guarantee', () => {
    it('all three orientations at zero emits NO orientation key', () => {
      // §4.3: an unrotated camera must take projectPoint's simple path. The
      // `nonZero` gate is what keeps that true, and adding two axes must not
      // start emitting a zero orientation object.
      const cam = cameraFromNode(oneNode({ orientationX: 0, orientationY: 0, orientationZ: 0 }), W, H);
      expect(cam.orientation).toBeUndefined();
    });

    it('a camera with no orientation props at all is unchanged', () => {
      expect(cameraFromNode(oneNode(), W, H).orientation).toBeUndefined();
    });
  });

  describe('animation', () => {
    it('a sampled value beats the static prop', () => {
      // cameraFromNode reads `sample?.(id, prop) ?? staticProp`. Miss this and
      // the props keyframe but never animate.
      const sample = (_id: string, prop: string): number | undefined =>
        prop === 'orientationY' ? 45 : undefined;
      const cam = cameraFromNode(oneNode({ orientationY: 5 }), W, H, sample);
      expect(cam.orientation!.yaw).toBeCloseTo(45, 6);
    });

    it('an absent sample falls through to the static prop', () => {
      const cam = cameraFromNode(oneNode({ orientationX: 8 }), W, H, () => undefined);
      expect(cam.orientation!.pitch).toBeCloseTo(8, 6);
    });
  });
});
