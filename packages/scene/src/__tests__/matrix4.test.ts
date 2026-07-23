import { Matrix, Matrix4Math, Project3D } from '../index';
import type { Matrix4 } from '../index';

describe('Matrix4 math', () => {
  it('identity leaves a point unchanged', () => {
    const p = Matrix4Math.transformPoint(Matrix4Math.identity(), { x: 3, y: 5, z: 7 });
    expect(p).toEqual({ x: 3, y: 5, z: 7 });
  });

  it('transformVector transforms direction vectors ignoring matrix translation', () => {
    const m = Matrix4Math.compose({
      position: { x: 500, y: 300, z: -100 },
      rotation: { x: 0, y: 0, z: Math.PI / 2 },
      scale: { x: 1, y: 1, z: 1 },
      anchor: { x: 0, y: 0, z: 0 },
    });
    const vec = Matrix4Math.transformVector(m, { x: 1, y: 0, z: 0 });
    expect(vec.x).toBeCloseTo(0);
    expect(vec.y).toBeCloseTo(1);
    expect(vec.z).toBeCloseTo(0);
  });

  it('anchor Z pivots rotation (not a no-op) — AE anchor-point depth', () => {
    // A 90° rotation about X, with the anchor pushed +100 in Z. The layer's
    // local origin sits at (0,0,-100) relative to the anchor, so after the X
    // rotation it swings out of the Z plane — proving anchorZ is consumed.
    const withZ = Matrix4Math.transformPoint(
      Matrix4Math.compose({
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: Math.PI / 2, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        anchor: { x: 0, y: 0, z: 100 },
      }),
      { x: 0, y: 0, z: 0 },
    );
    const withoutZ = Matrix4Math.transformPoint(
      Matrix4Math.compose({
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: Math.PI / 2, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        anchor: { x: 0, y: 0, z: 0 },
      }),
      { x: 0, y: 0, z: 0 },
    );
    // anchorZ=0 keeps the origin at world origin; anchorZ=100 swings it away.
    expect(withoutZ).toEqual({ x: 0, y: 0, z: 0 });
    expect(Math.abs(withZ.y) + Math.abs(withZ.z)).toBeGreaterThan(50);
  });

  it('multiply by identity is a no-op', () => {
    const m = Matrix4Math.compose({
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0.3, y: -0.2, z: 1.1 },
      scale: { x: 2, y: 0.5, z: 1.5 },
      anchor: { x: 0, y: 0, z: 0 },
    });
    expect(Matrix4Math.equals(Matrix4Math.multiply(m, Matrix4Math.identity()), m)).toBe(true);
    expect(Matrix4Math.equals(Matrix4Math.multiply(Matrix4Math.identity(), m), m)).toBe(true);
  });

  it('fromMatrix2D → toMatrix2D round-trips the affine part', () => {
    const m2 = Matrix.compose({
      position: { x: 12, y: -4 },
      rotation: 0.7,
      scale: { x: 1.3, y: 2.1 },
      skew: { x: 0, y: 0 },
      anchor: { x: 3, y: 3 },
    });
    const back = Matrix4Math.toMatrix2D(Matrix4Math.fromMatrix2D(m2));
    expect(Matrix.equals(back, m2)).toBe(true);
  });

  it('3D compose reduces EXACTLY to the 2D compose when 3D fields are default', () => {
    const parts2d = {
      position: { x: 10, y: 20 },
      rotation: Math.PI / 2,
      scale: { x: 2, y: 3 },
      skew: { x: 0, y: 0 },
      anchor: { x: 5, y: 5 },
    };
    const m2 = Matrix.compose(parts2d);
    const m4 = Matrix4Math.compose({
      position: { x: 10, y: 20, z: 0 },
      rotation: { x: 0, y: 0, z: Math.PI / 2 },
      scale: { x: 2, y: 3, z: 1 },
      anchor: { x: 5, y: 5, z: 0 },
    });
    expect(Matrix.equals(Matrix4Math.toMatrix2D(m4), m2, 1e-9)).toBe(true);
  });

  it('rotationX by 90° maps +y onto +z about the origin', () => {
    const m = Matrix4Math.compose({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: Math.PI / 2, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      anchor: { x: 0, y: 0, z: 0 },
    });
    const p = Matrix4Math.transformPoint(m, { x: 0, y: 1, z: 0 });
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(0, 6);
    expect(p.z).toBeCloseTo(1, 6);
  });

  it('rotationY by 90° maps +x onto -z about the origin', () => {
    const m = Matrix4Math.compose({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: Math.PI / 2, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      anchor: { x: 0, y: 0, z: 0 },
    });
    const p = Matrix4Math.transformPoint(m, { x: 1, y: 0, z: 0 });
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.z).toBeCloseTo(-1, 6);
  });
});

describe('Project3D (pinhole camera)', () => {
  const cam = Project3D.defaultCamera(1920, 1080);

  it('a point on the comp plane at the comp centre projects 1:1', () => {
    const proj = Project3D.projectPoint({ x: 960, y: 540, z: 0 }, cam);
    expect(proj.x).toBeCloseTo(960, 4);
    expect(proj.y).toBeCloseTo(540, 4);
    expect(proj.scale).toBeCloseTo(1, 6);
  });

  it('moving away (+z) shrinks; moving closer (-z) enlarges', () => {
    const near = Project3D.projectPoint({ x: 960, y: 540, z: -cam.focalLength / 2 }, cam);
    const far = Project3D.projectPoint({ x: 960, y: 540, z: cam.focalLength }, cam);
    expect(far.scale).toBeLessThan(1);
    expect(near.scale).toBeGreaterThan(1);
    expect(far.depth).toBeGreaterThan(near.depth);
  });

  it('off-centre points move toward the vanishing point as they recede', () => {
    const onPlane = Project3D.projectPoint({ x: 1920, y: 540, z: 0 }, cam);
    const receded = Project3D.projectPoint({ x: 1920, y: 540, z: cam.focalLength }, cam);
    // Both to the right of centre (960); the receded one is pulled back toward it.
    expect(onPlane.x).toBeCloseTo(1920, 4);
    expect(receded.x).toBeGreaterThan(960);
    expect(receded.x).toBeLessThan(onPlane.x);
  });
});

// Type-level: Matrix4 is a 16-tuple.
const _t: Matrix4 = Matrix4Math.identity();
void _t;
