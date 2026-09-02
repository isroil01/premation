/**
 * Command buffer. Passes translate renderables into backend-independent
 * `DrawItem`s and push them here; the executor (QuadRenderer) consumes the
 * buffer, groups by `batchKey` to minimize pipeline/state changes, and issues
 * backend draws. Separating *what to draw* (here) from *how to submit it*
 * (executor) is what makes batching, sorting, and instancing pluggable.
 */

import type { BlendMode, SamplerHandle, TextureHandle, BufferHandle } from '../gpu/types';
import type { MaterialDescriptor } from '../shaders/Material';

export interface DrawItem {
  /** Consecutive items with an equal key are batched (one pipeline bind). */
  batchKey: string;
  material: MaterialDescriptor;
  blend: BlendMode;
  /** Packed, std140-aligned uniform bytes for this object. */
  uniforms: Float32Array;
  /** Optional bound texture + sampler (textured materials). */
  texture?: TextureHandle;
  sampler?: SamplerHandle;
  maskTexture?: TextureHandle;
  /**
   * A second auxiliary texture, at binding 4.
   *
   * Used by a plugin effect pass that composites against its chain's pass-0
   * input — a bloom adding its blurred copy back over the original. Distinct
   * from `maskTexture` rather than a list, because the two bindings mean
   * different things to the shader and the material declares them
   * independently; a positional array would make "which one is missing" a
   * question the renderer has to answer by counting.
   */
  originTexture?: TextureHandle;
  /**
   * The glTF PBR map set, at bindings 3–6 of the `mesh3d-pbr` material.
   *
   * Named rather than positional for the same reason `originTexture` is: the
   * shader means something different by each, and the slots overlap by NUMBER
   * with `maskTexture`/`originTexture` only because no material ever declares
   * both sets — the mesh path has no mask and no plugin origin. Every field is
   * required once the group is present; a material missing one binds the shared
   * white texture, whose value is the identity for all three multiplicative
   * maps (see the `mesh3d-pbr` shader note).
   */
  pbrTextures?: {
    normal: TextureHandle;
    metallicRoughness: TextureHandle;
    occlusion: TextureHandle;
    emissive: TextureHandle;
  };
  /**
   * The scene's prefiltered specular environment map, at bindings 7/8.
   *
   * Bound on EVERY lit-3d draw, not only the reflective ones: the shader
   * skips it on a zero `envParams.x`, and a per-draw binding difference would
   * mean a second pipeline for every 3d material to express what one uniform
   * already expresses. A comp with no environment light binds the shared 1x1
   * fallback, which is never sampled.
   */
  envTexture?: TextureHandle;
  /** Sampler for {@link envTexture} — REPEAT in u so the equirect's longitude
   *  seam blends instead of clamping, which is why it cannot be the layer's. */
  envSampler?: SamplerHandle;
  /**
   * The run's shadow map, at bindings 9/10.
   *
   * Bound on EVERY lit-3d draw for exactly the reason {@link envTexture} is: the
   * shader skips it on a zero `shadowParams.x`, and making the BINDING the
   * switch would mean a second pipeline per 3d material to say what one uniform
   * already says. A run with no shadow-mapped light binds the shared 1x1
   * far-depth texel, which is never sampled.
   */
  shadowTexture?: TextureHandle;
  /** Sampler for {@link shadowTexture} — NEAREST, because the map's texels are
   *  a 24-bit depth packed across rgb and a filtered blend of two of them is not
   *  a depth. That is why it cannot be the layer's sampler. */
  shadowSampler?: SamplerHandle;
  /**
   * The run's ambient-occlusion buffer, at bindings 11/12.
   *
   * Bound on EVERY lit-3d draw for the same reason {@link envTexture} and
   * {@link shadowTexture} are: the shader skips it on a zero `aoParams.x`, and
   * making the BINDING the switch would mean a second pipeline per 3d material
   * to say what one uniform already says. A run without SSAO binds the shared
   * 1x1 white texel — "nothing occludes anything" — which is never sampled.
   */
  aoTexture?: TextureHandle;
  /** Sampler for {@link aoTexture} — LINEAR-clamp, because the buffer is
   *  usually half resolution and is being magnified. It cannot be the layer's:
   *  `solid3d` has no layer sampler for the backend to broadcast. */
  aoSampler?: SamplerHandle;
  /** Optional custom geometry for mesh rendering. */
  vertexBuffer?: BufferHandle;
  indexBuffer?: BufferHandle;
  indexCount?: number;
  /** First index of the range to draw (default 0) — lets one shared index
   *  buffer serve several material groups of the same mesh. */
  firstIndex?: number;
  /** Index element type (default 'uint16'). A mesh past 65535 vertices needs 32-bit. */
  indexFormat?: 'uint16' | 'uint32';
}

export interface CommandBatch {
  batchKey: string;
  material: MaterialDescriptor;
  blend: BlendMode;
  items: DrawItem[];
}

export class CommandBuffer {
  private readonly items: DrawItem[] = [];

  /**
   * The specular environment map every lit-3d draw in this buffer binds.
   *
   * A property of the PASS, not of the draw: one comp has one environment, and
   * threading it through four `emit*3D` signatures that are already ten
   * parameters long would say the opposite. The `emit*3D` helpers stamp it
   * onto their items; nothing else reads it, so a 2D draw never acquires a
   * binding its material does not declare.
   *
   * Every lit-3d material DECLARES bindings 7/8, so this must be set before a
   * 3d group is queued — a comp with no environment light sets the shared 1x1
   * fallback, which the shader's zero `envParams.x` never samples.
   */
  env?: { texture: TextureHandle; sampler: SamplerHandle };

  /**
   * The shadow map every lit-3d draw in this buffer binds.
   *
   * A property of the PASS for the same reason `env` is: a depth RUN renders one
   * map, from one light, and every receiver in the run reads that same texture.
   * The `emit*3D` helpers stamp it onto their items, so a 2D draw never acquires
   * a binding its material does not declare.
   */
  shadow?: { texture: TextureHandle; sampler: SamplerHandle };

  /**
   * The ambient-occlusion buffer every lit-3d draw in this buffer binds.
   *
   * A property of the PASS, like `env` and `shadow`: a depth run renders one
   * screen-space AO image and every receiver in the run reads that same
   * texture. The `emit*3D` helpers stamp it onto their items, so a 2D draw
   * never acquires a binding its material does not declare.
   */
  ao?: { texture: TextureHandle; sampler: SamplerHandle };

  add(item: DrawItem): void {
    this.items.push(item);
  }

  get length(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
  }

  all(): readonly DrawItem[] {
    return this.items;
  }

  /**
   * Group *consecutive* items sharing a batchKey. Consecutive (not global) so
   * paint order / z-order is never violated by batching.
   */
  batches(): CommandBatch[] {
    const out: CommandBatch[] = [];
    let current: CommandBatch | null = null;
    for (const item of this.items) {
      if (!current || current.batchKey !== item.batchKey) {
        current = { batchKey: item.batchKey, material: item.material, blend: item.blend, items: [] };
        out.push(current);
      }
      current.items.push(item);
    }
    return out;
  }
}
