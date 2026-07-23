/**
 * Mat4 math + the 3D MVP assembly (mvp3dFor). The keystone assertion: for a
 * z = 0, unrotated layer the mat4 path must land on EXACTLY the same clip-space
 * corners as the legacy mat3 path — that is what keeps the depth-tested 3D
 * pipeline and the CPU-affine fallback pixel-aligned.
 */

import { Mat3 } from '../core/math/Mat3';
import { Mat4 } from '../core/math/Mat4';
import { Viewport } from '../viewport/Viewport';
import { mvpFor, mvp3dFor } from '../rendergraph/passes/passUtils';

describe('Mat4 basics', () => {
  it('multiply against identity is a no-op', () => {
    const m = Mat4.fromArray([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1]);
    const r = Mat4.multiply(Mat4.create(), m);
    expect(Array.from(r)).toEqual(Array.from(m));
  });

  it('fromMat3 lifts a 2D affine: x/y transform, z and w pass through', () => {
    const affine = Mat3.multiply(Mat3.compose(10, 20, 0, 2, 3), Mat3.translation(0, 0));
    const lifted = Mat4.fromMat3(affine);
    const [x, y, z, w] = Mat4.transform(lifted, 1, 1, 5, 1);
    expect(x).toBeCloseTo(12); // 1·2 + 10
    expect(y).toBeCloseTo(23); // 1·3 + 20
    expect(z).toBeCloseTo(5);
    expect(w).toBeCloseTo(1);
    // Homogeneous: translation scales with w.
    const [x2, , , w2] = Mat4.transform(lifted, 1, 1, 0, 2);
    expect(x2).toBeCloseTo(2 + 20);
    expect(w2).toBeCloseTo(2);
  });

  it('project applies the perspective divide', () => {
    // Pinhole: w = z; x' = f·x / z.
    const f = 100;
    const proj = Mat4.fromArray([f, 0, 0, 0, 0, f, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0]);
    const p = Mat4.project(proj, 4, 2, 200);
    expect(p.x).toBeCloseTo((f * 4) / 200);
    expect(p.y).toBeCloseTo((f * 2) / 200);
    expect(p.w).toBeCloseTo(200);
  });
});

/** Pinhole projection matrix identical to the scene package's camera form. */
function pinholeProjection(f: number, px: number, py: number): readonly number[] {
  const n = 1;
  const fr = 100000;
  const a = fr / (fr - n);
  const b = (-fr * n) / (fr - n);
  return [f, 0, 0, 0, 0, f, 0, 0, px, py, a, 1, 0, 0, b, 0];
}

describe('mvp3dFor — clip-space corners', () => {
  const f = 800;
  // Default-style camera: eye at (400, 300, −f) (view translates by −eye),
  // principal at the comp centre — so the z = 0 plane renders 1:1.
  const camera3d = {
    view: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -400, -300, f, 1] as readonly number[],
    projection: pinholeProjection(f, 400, 300),
  };

  function makeViewport(): Viewport {
    const vp = new Viewport({ width: 800, height: 600 });
    vp.camera.setState({ center: { x: 400, y: 300 }, zoom: 1 });
    return vp;
  }

  /** Legacy mat3 model: translate(x,y)·scale(w,h)·translate(−½,−½). */
  function model2d(x: number, y: number, w: number, h: number): Mat3 {
    return Mat3.multiply(Mat3.compose(x, y, 0, w, h), Mat3.translation(-0.5, -0.5));
  }

  /** mat4 model: same placement on the z = 0 plane. */
  function model3d(x: number, y: number, w: number, h: number): readonly number[] {
    return [w, 0, 0, 0, 0, h, 0, 0, 0, 0, 1, 0, x - w / 2, y - h / 2, 0, 1];
  }

  it('a z = 0 unrotated layer projects to the same clip corners as the mat3 path', () => {
    const vp = makeViewport();
    const m2 = mvpFor(vp, model2d(400, 300, 200, 100));
    const m3 = mvp3dFor(vp, camera3d, model3d(400, 300, 200, 100));
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      // mat3: clip = M·(u,v,1)
      const cx = m2[0]! * u + m2[3]! * v + m2[6]!;
      const cy = m2[1]! * u + m2[4]! * v + m2[7]!;
      const p = Mat4.project(m3, u, v, 0);
      expect(p.x).toBeCloseTo(cx, 5);
      expect(p.y).toBeCloseTo(cy, 5);
      expect(p.z).toBeGreaterThanOrEqual(0);
      expect(p.z).toBeLessThanOrEqual(1);
      expect(p.w).toBeCloseTo(f, 5); // camera-space z of the comp plane
    }
  });

  it('a nearer layer (negative z) projects larger (perspective scale in clip space)', () => {
    const vp = makeViewport();
    const model = (z: number): readonly number[] => [200, 0, 0, 0, 0, 100, 0, 0, 0, 0, 1, 0, 300, 250, z, 1];
    const at = (z: number) => {
      const m = mvp3dFor(vp, camera3d, model(z));
      const a = Mat4.project(m, 0, 0.5, 0);
      const b = Mat4.project(m, 1, 0.5, 0);
      return Math.abs(b.x - a.x); // projected width in clip units
    };
    expect(at(-f / 2)).toBeGreaterThan(at(0));
    expect(at(f)).toBeLessThan(at(0));
  });

  it('depth (clip z) increases with layer z', () => {
    const vp = makeViewport();
    const model = (z: number): readonly number[] => [200, 0, 0, 0, 0, 100, 0, 0, 0, 0, 1, 0, 300, 250, z, 1];
    const zOf = (z: number) => Mat4.project(mvp3dFor(vp, camera3d, model(z)), 0.5, 0.5, 0).z;
    expect(zOf(-200)).toBeLessThan(zOf(0));
    expect(zOf(0)).toBeLessThan(zOf(500));
  });
});
