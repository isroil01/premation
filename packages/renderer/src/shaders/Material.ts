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

/** Final scene-color → surface blit (optional linear→sRGB encode). */
export const SCENE_BLIT_MATERIAL: MaterialDescriptor = {
  shader: 'scene-blit',
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

/** Built-in material: a 3D .cube LUT lookup. Same four bindings as compound
 *  blur — the second texture is the LUT strip rather than another layer. */
export const APPLY_COLOR_LUT_MATERIAL: MaterialDescriptor = {
  shader: 'apply-color-lut',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
    { binding: 3, type: 'texture', stages: ['fragment'] },
  ],
};

/** Built-in material: compound blur. Same four bindings as displacement-map —
 *  it is the same read-a-second-layer shape, with different arithmetic. */
export const COMPOUND_BLUR_MATERIAL: MaterialDescriptor = {
  shader: 'compound-blur',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
    { binding: 3, type: 'texture', stages: ['fragment'] },
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

/** Binding 3 is the matte layer's texture — the same layout as displacement-map,
 *  which is the established shape for an effect that samples another layer. */
export const SET_MATTE_MATERIAL: MaterialDescriptor = {
  shader: 'set-matte',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
    { binding: 3, type: 'texture', stages: ['fragment'] },
  ],
};

/**
 * The Perspective family all take one source texture and differ only in their
 * uniform block, so they share a descriptor shape — declared once and named
 * three times rather than copied, so a binding change cannot land on two of
 * them and miss the third.
 */
const perspectiveMaterial = (shader: string): MaterialDescriptor => ({
  shader,
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
  ],
});

export const BEVEL_ALPHA_MATERIAL = perspectiveMaterial('bevel-alpha');
export const BEVEL_EDGES_MATERIAL = perspectiveMaterial('bevel-edges');
export const SPOTLIGHT_MATERIAL = perspectiveMaterial('spotlight');
export const SPHERE_MATERIAL = perspectiveMaterial('sphere');
/** Same one-texture binding shape; only the uniform block differs. */
export const ARITHMETIC_MATERIAL = perspectiveMaterial('arithmetic');
export const CYLINDER_MATERIAL = perspectiveMaterial('cylinder');

/** Same binding shape as motion-tile: one source texture, warped in place. */
export const BEND_MATERIAL: MaterialDescriptor = {
  shader: 'bend',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
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

/** Built-in material: Beam. Same three bindings as every other single-input
 *  effect — it reads the layer and adds light to it. */
export const BEAM_MATERIAL: MaterialDescriptor = {
  shader: 'beam',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
  ],
};

/** Built-in material: Light Sweep. Same three bindings as Beam. */
export const LIGHT_SWEEP_MATERIAL: MaterialDescriptor = {
  shader: 'light-sweep',
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

/**
 * 3D textured quad that depth-TESTS but does not depth-WRITE.
 *
 * For a layer whose effect chain was resolved into a texture: that texture is
 * WIDER than the layer, because a drop shadow or glow has to have somewhere to
 * spread (see CompositionPass.resolveEffect3DTexture). The extra margin is
 * transparent, and a transparent fragment still writes depth — so with the
 * ordinary material an extruded object's own front face punched a rectangular
 * hole through its side walls wherever that margin covered them.
 *
 * Not writing depth is also the honest description of what the quad is: a
 * composited RESULT on the layer's plane, not new occluding geometry. It is
 * still occluded by anything already in the depth buffer, and the group draws
 * back-to-front, so the ordering that matters is preserved.
 */
export const TEXTURED3D_NO_DEPTH_WRITE_MATERIAL: MaterialDescriptor = {
  shader: 'textured3d',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
  ],
  depth: { test: true, write: false },
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

// The premultiplied-source TWINS are gone, along with the flag that selected
// them. Under the alpha invariant (see `TextureSource` in ../gpu/types.ts) every
// texture is premultiplied, so every textured shader un-premultiplies at the
// sample — there is no second behaviour left to name a material for. What used
// to live here was `premulMaterial` plus seven `*_PREMUL_MATERIAL` constants;
// the note that used to sit above them warned that a SECOND fragment-stage flag
// should trigger extending the std140 block instead of doubling the set again.
// That warning is now moot for this axis: the count went to zero, not to twelve.

/**
 * Fill a texture's ALPHA with a solid colour, discarding its RGB.
 *
 * What an outward layer style actually is — see the long note on
 * `silhouetteOf` in builtin.ts for the multiply-instead-of-fill bug this
 * replaces, and for why black drop shadows appeared to work while every other
 * colour did not.
 *
 * Deliberately NOT one of the variant families the note above warns about: it
 * adds no uniform, reinterprets the `tint` already in the block, and needs no
 * premultiplied twin because it reads only alpha — which is the same value in
 * either alpha space.
 */
export const TEXTURED_SILHOUETTE_MATERIAL: MaterialDescriptor = {
  ...TEXTURED_MATERIAL,
  shader: `${TEXTURED_MATERIAL.shader}-silhouette`,
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
