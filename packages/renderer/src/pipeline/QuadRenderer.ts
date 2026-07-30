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

    // The pass knows its own target format + sample count; the pipeline must
    // agree with both (WebGPU validates them against the attachment). Falls back
    // to the surface format for the direct-to-surface passes, which do not set it.
    const colorFormat = encoder.format ?? this.colorFormat;

    for (const batch of batches) {
      const pipeline = this.materials.pipeline(batch.material, batch.blend, colorFormat, encoder.samples ?? 1);
      encoder.setPipeline(pipeline);
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
        if (item.maskTexture) entries.push({ binding: 3, texture: item.maskTexture });

        const bg = this.resources.bindGroup(
          `bindgroup:${batch.material.shader}:${item.texture?.id ?? 0}:${item.maskTexture?.id ?? 0}:${idx}`,
          { pipeline, entries },
        );
        encoder.setBindGroup(0, bg);

        if (item.vertexBuffer && item.indexBuffer && item.indexCount !== undefined) {
          encoder.setVertexBuffer(0, item.vertexBuffer);
          encoder.setIndexBuffer(item.indexBuffer, 'uint16');
          encoder.drawIndexed(item.indexCount);
        } else {
          encoder.setVertexBuffer(0, quad);
          encoder.draw(QUAD_VERTEX_COUNT);
        }
        draws += 1;
      }
    }

    return { draws, batches: batches.length, pipelineBinds: binds };
  }
}
