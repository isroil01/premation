/**
 * Shared geometry. All 2D primitives (rects, images, text glyph-quads) draw a
 * transformed **unit quad** in [0,1]²; the per-object transform lives in a
 * uniform. This keeps one vertex buffer hot for the whole scene (batching).
 */

import type { ResourceManager } from '../gpu/ResourceManager';
import type { BufferHandle, VertexBufferLayout } from '../gpu/types';

/** Two triangles covering [0,1]², as float32x2 positions. */
const UNIT_QUAD = new Float32Array([
  0, 0, 1, 0, 0, 1, // tri 1
  0, 1, 1, 0, 1, 1, // tri 2
]);

export const QUAD_VERTEX_COUNT = 6;

export const QUAD_LAYOUT: VertexBufferLayout = {
  strideBytes: 8,
  stepMode: 'vertex',
  attributes: [{ shaderLocation: 0, offsetBytes: 0, format: 'float32x2' }],
};

/** Acquire the shared, pinned unit-quad vertex buffer (created once). */
export function unitQuadBuffer(resources: ResourceManager): BufferHandle {
  return resources.buffer(
    'geometry:unit-quad',
    { label: 'unit-quad', sizeBytes: UNIT_QUAD.byteLength, usage: ['vertex'], data: UNIT_QUAD },
    /* pinned */ true,
  );
}
