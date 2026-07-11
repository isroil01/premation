/**
 * Executes a `CommandBuffer` against a render pass. For each *batch* (run of
 * items sharing a pipeline) it binds the pipeline once, then draws each item
 * with its per-object uniform buffer + bind group. All GPU resources come from
 * the ResourceManager (deduped, GC'd), and the vertex buffer is the shared unit
 * quad — so a whole scene reuses one vertex buffer and a handful of pipelines.
 */

import type { CommandBuffer } from '../commands/DrawCommand';
import type { RenderBackend, RenderPassEncoder } from '../gpu/RenderBackend';
import type { ResourceManager } from '../gpu/ResourceManager';
import type { TextureFormat } from '../gpu/types';
import { QUAD_VERTEX_COUNT, unitQuadBuffer } from '../resources/Geometry';
import type { MaterialSystem } from '../shaders/Material';

export interface DrawStats {
  draws: number;
  batches: number;
  pipelineBinds: number;
}

export class QuadRenderer {
  private uniformSeq = 0;

  constructor(
    private readonly backend: RenderBackend,
    private readonly resources: ResourceManager,
    private readonly materials: MaterialSystem,
    private readonly colorFormat: TextureFormat,
  ) {}

  /** Reset the per-frame uniform ring index. Call once per frame. */
  beginFrame(): void {
    this.uniformSeq = 0;
  }

  execute(encoder: RenderPassEncoder, buffer: CommandBuffer): DrawStats {
    const quad = unitQuadBuffer(this.resources);
    const batches = buffer.batches();
    let draws = 0;
    let binds = 0;

    for (const batch of batches) {
      const pipeline = this.materials.pipeline(batch.material, batch.blend, this.colorFormat);
      encoder.setPipeline(pipeline);
      encoder.setVertexBuffer(0, quad);
      binds += 1;

      for (const item of batch.items) {
        const idx = this.uniformSeq++;
        const bytes = item.uniforms.byteLength;
        const ub = this.resources.buffer(`uniform-ring:${bytes}:${idx}`, {
          label: 'object-uniform',
          sizeBytes: bytes,
          usage: ['uniform', 'copy'],
        });
        this.backend.writeBuffer(ub, 0, item.uniforms);

        const entries: import('../gpu/types').BindGroupResource[] = [{ binding: 0, buffer: ub }];
        if (item.texture) entries.push({ binding: 1, texture: item.texture });
        if (item.sampler) entries.push({ binding: 2, sampler: item.sampler });

        const bg = this.resources.bindGroup(
          `bindgroup:${batch.material.shader}:${item.texture?.id ?? 0}:${idx}`,
          { pipeline, entries },
        );
        encoder.setBindGroup(0, bg);
        encoder.draw(QUAD_VERTEX_COUNT);
        draws += 1;
      }
    }

    return { draws, batches: batches.length, pipelineBinds: binds };
  }
}
