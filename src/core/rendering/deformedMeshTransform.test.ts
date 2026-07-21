/**
 * Deformed-mesh GPU placement: puppet/skeleton mesh vertices are authored in
 * centered LOCAL PIXELS, but the GPU draws them through the layer's model matrix
 * (which maps a [0,1] unit quad → comp). snapshotToFrameScene must normalize the
 * mesh to unit-quad space so the SAME matrix places each vertex where the CPU
 * mesh sits — otherwise the deformed shape flies off-screen and the layer shows
 * no deformation (the bug this guards). We transform the emitted mesh by the
 * renderable's model matrix and assert vertices land at their comp positions.
 */

import { layerToRenderable } from './snapshotToFrameScene';
import type { RenderLayer } from './RenderBackend';

/** Apply a column-major Mat3 to a 2D point exactly as the mesh shader does. */
function apply(m: ArrayLike<number>, x: number, y: number): { x: number; y: number } {
  return { x: m[0]! * x + m[3]! * y + m[6]!, y: m[1]! * x + m[4]! * y + m[7]! };
}

function shapeLayer(deformPixels: number[]): RenderLayer {
  // A 200×160 solid at comp (400,300), no stroke/pad, identity scale/rotation.
  return {
    id: 'm', kind: 'shape', x: 400, y: 300, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, width: 200, height: 160, fill: '#2b7eff', visible: true, primitive: 'rect',
    deformedMesh: {
      // [x, y, u, v] per vertex, XY in centered local pixels.
      vertices: new Float32Array(deformPixels),
      triangles: new Uint16Array([0, 1, 2]),
    },
  } as unknown as RenderLayer;
}

describe('deformed-mesh unit-quad placement', () => {
  it('rest-mesh corners map to the layer rect under the model matrix', () => {
    // Top-left corner, centre, bottom-right corner (rest positions).
    const layer = shapeLayer([
      -100, -80, 0, 0,
      0, 0, 0.5, 0.5,
      100, 80, 1, 1,
    ]);
    const r = layerToRenderable(layer);
    expect(r.deformedMesh).toBeDefined();
    const v = r.deformedMesh!.vertices;

    const p0 = apply(r.modelMatrix, v[0]!, v[1]!);   // was (-100,-80)
    const p1 = apply(r.modelMatrix, v[4]!, v[5]!);   // was (0,0)
    const p2 = apply(r.modelMatrix, v[8]!, v[9]!);   // was (100,80)

    // Must land on the layer rect (top-left, centre, bottom-right), NOT off-screen.
    expect(p0.x).toBeCloseTo(300, 3); expect(p0.y).toBeCloseTo(220, 3);
    expect(p1.x).toBeCloseTo(400, 3); expect(p1.y).toBeCloseTo(300, 3);
    expect(p2.x).toBeCloseTo(500, 3); expect(p2.y).toBeCloseTo(380, 3);
  });

  it('a displaced pin vertex follows to its new comp position', () => {
    // Centre vertex dragged +40x/+30y in local space → comp (440,330).
    const layer = shapeLayer([40, 30, 0.5, 0.5, -100, -80, 0, 0, 100, 80, 1, 1]);
    const r = layerToRenderable(layer);
    const moved = apply(r.modelMatrix, r.deformedMesh!.vertices[0]!, r.deformedMesh!.vertices[1]!);
    expect(moved.x).toBeCloseTo(440, 3);
    expect(moved.y).toBeCloseTo(330, 3);
  });
});
