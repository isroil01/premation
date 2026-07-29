/**
 * Material system. A material binds a shader to fixed pipeline state (blend,
 * topology, bind-group layout). `MaterialSystem.pipeline` compiles the shader
 * (cached) and builds the pipeline (deduped via ResourceManager) — so N objects
 * sharing a material share one pipeline. Custom materials register new shaders
 * and pass their own layout.
 */

import type { ResourceManager } from '../gpu/ResourceManager';
import type {
  BindGroupLayoutEntry,
  BlendMode,
  PipelineHandle,
  PrimitiveTopology,
  TextureFormat,
  VertexBufferLayout,
} from '../gpu/types';
import { makeKey } from '../utils/ids';
import { QUAD_LAYOUT } from '../resources/Geometry';
import type { ShaderCache } from './ShaderCache';
import type { ShaderRegistry } from './ShaderRegistry';

export interface MaterialDescriptor {
  /** Name of a shader in the registry. */
  shader: string;
  topology: PrimitiveTopology;
  layout: BindGroupLayoutEntry[];
  /** Optional custom vertex buffer layouts. If omitted, defaults to QUAD_LAYOUT. */
  buffers?: VertexBufferLayout[];
  /** Depth-tested material (3D layer path). Pipelines built from it carry
   *  depth state and are only valid inside passes with a depth attachment. */
  depth?: { test: boolean; write: boolean };
}

/** Built-in material: solid-colored quad. Uniform block at binding 0. */
export const SOLID_MATERIAL: MaterialDescriptor = {
  shader: 'solid',
  topology: 'triangle-list',
  layout: [{ binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] }],
};

/** Built-in material: textured quad. Uniform + texture + sampler. */
export const TEXTURED_MATERIAL: MaterialDescriptor = {
  shader: 'textured',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
  ],
};

/** Built-in material: masked textured quad. Uniform + texture + sampler + mask texture. */
export const MASKED_TEXTURED_MATERIAL: MaterialDescriptor = {
  shader: 'masked-textured',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
    { binding: 3, type: 'texture', stages: ['fragment'] },
  ],
};

/** Built-in material: textured quad with a colour LUT (Levels/Curves/Posterize).
 *  Uniform + layer texture + sampler + LUT texture (binding 3). */
export const LUT_TEXTURED_MATERIAL: MaterialDescriptor = {
  shader: 'lut-textured',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
    { binding: 3, type: 'texture', stages: ['fragment'] },
  ],
};

/** Built-in material: track-matte combine (matted layer + matte source texture). */
export const MATTE_COMBINE_MATERIAL: MaterialDescriptor = {
  shader: 'matte-combine',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
    { binding: 3, type: 'texture', stages: ['fragment'] },
  ],
};

/** Built-in material: advanced blend combine (layer src + backdrop dst). */
export const BLEND_COMBINE_MATERIAL: MaterialDescriptor = {
  shader: 'blend-combine',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
    { binding: 3, type: 'texture', stages: ['fragment'] },
  ],
};

/**
 * Built-in material: glass composite. Uniform + blurred-backdrop texture +
 * sampler + the layer texture (binding 3), whose ALPHA is the glass silhouette
 * and whose gradient drives refraction. See shaders/glass.ts.
 */
export const GLASS_MATERIAL: MaterialDescriptor = {
  shader: 'glass-composite',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
    { binding: 3, type: 'texture', stages: ['fragment'] },
  ],
};

/** Built-in material: blur pass. Uniform + texture + sampler. */
export const BLUR_MATERIAL: MaterialDescriptor = {
  shader: 'blur',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
  ],
};

export const GRADIENT_RAMP_MATERIAL: MaterialDescriptor = {
  shader: 'gradient-ramp',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
  ],
};

export const FRACTAL_NOISE_MATERIAL: MaterialDescriptor = {
  shader: 'fractal-noise',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
  ],
};

export const DISPLACEMENT_MAP_MATERIAL: MaterialDescriptor = {
  shader: 'displacement-map',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
    { binding: 3, type: 'texture', stages: ['fragment'] },
  ],
};

export const MOTION_TILE_MATERIAL: MaterialDescriptor = {
  shader: 'motion-tile',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
  ],
};

export const FILL_MATERIAL: MaterialDescriptor = {
  shader: 'fill',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
  ],
};

export const STROKE_MATERIAL: MaterialDescriptor = {
  shader: 'stroke',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
  ],
};

export const SHARPEN_MATERIAL: MaterialDescriptor = {
  shader: 'sharpen',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
  ],
};

export const NOISE_MATERIAL: MaterialDescriptor = {
  shader: 'noise',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
  ],
};

// ── Depth-tested 3D materials (Classic-3D GPU path) ─────────────────────────
// Same bindings as their 2D twins; mat4 MVP shaders + depth test/write so
// intersecting 3D planes composite per-pixel. Drawn back-to-front within a 3D
// render group (correct for opaque intersections; see CompositionPass).

/** 3D solid (SDF rounded-rect / ellipse) quad with depth test+write. */
export const SOLID3D_MATERIAL: MaterialDescriptor = {
  shader: 'solid3d',
  topology: 'triangle-list',
  layout: [{ binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] }],
  depth: { test: true, write: true },
};

/** 3D textured quad with depth test+write. */
export const TEXTURED3D_MATERIAL: MaterialDescriptor = {
  shader: 'textured3d',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
  ],
  depth: { test: true, write: true },
};

/** 3D masked textured quad with depth test+write. */
export const MASKED_TEXTURED3D_MATERIAL: MaterialDescriptor = {
  shader: 'masked-textured3d',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
    { binding: 3, type: 'texture', stages: ['fragment'] },
  ],
  depth: { test: true, write: true },
};

export const DEFORMED_MESH_LAYOUT: VertexBufferLayout = {
  strideBytes: 16,
  stepMode: 'vertex',
  attributes: [
    { shaderLocation: 0, offsetBytes: 0, format: 'float32x2' },
    { shaderLocation: 1, offsetBytes: 8, format: 'float32x2' },
  ],
};

export const DEFORMED_MESH_MATERIAL: MaterialDescriptor = {
  shader: 'deformed-mesh',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
  ],
  buffers: [DEFORMED_MESH_LAYOUT],
};

export class MaterialSystem {
  constructor(
    private readonly resources: ResourceManager,
    private readonly registry: ShaderRegistry,
    private readonly shaderCache: ShaderCache,
  ) {}

  /**
   * Get (or build) the pipeline for a material + blend + target format.
   *
   * `samples` is part of the identity, not a detail: on WebGPU a pipeline is
   * only valid in a pass whose attachments have the same sample count, so a
   * cache shared between the MSAA 3D target and the single-sample surface would
   * hand back a pipeline the next pass rejects.
   */
  pipeline(material: MaterialDescriptor, blend: BlendMode, colorFormat: TextureFormat, samples = 1): PipelineHandle {
    const source = this.registry.require(material.shader);
    const shader = this.shaderCache.get(source);
    const depth = material.depth;
    const key = makeKey(
      'pipeline',
      material.shader,
      this.shaderCache.keyOf(source),
      material.topology,
      blend,
      colorFormat,
      depth ? `d${depth.test ? 1 : 0}${depth.write ? 1 : 0}` : 'd00',
      `s${samples}`,
    );
    return this.resources.pipeline(key, {
      label: `${material.shader}/${blend}`,
      shader,
      buffers: material.buffers ?? [QUAD_LAYOUT],
      layout: material.layout,
      topology: material.topology,
      blend,
      colorFormat,
      ...(depth ? { depthTest: depth.test, depthWrite: depth.write, depthFormat: 'depth24plus' as const } : {}),
      ...(samples > 1 ? { samples } : {}),
    });
  }
}
