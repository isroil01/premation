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
  /** Optional custom geometry for mesh rendering. */
  vertexBuffer?: BufferHandle;
  indexBuffer?: BufferHandle;
  indexCount?: number;
}

export interface CommandBatch {
  batchKey: string;
  material: MaterialDescriptor;
  blend: BlendMode;
  items: DrawItem[];
}

export class CommandBuffer {
  private readonly items: DrawItem[] = [];

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
