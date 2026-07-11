/** Shared helpers for passes: MVP assembly, quad models, surface attachments. */

import { Mat3 } from '../../core/math/Mat3';
import type { Color } from '../../core/math/Color';
import type { Rect } from '../../core/math/geometry';
import type { RenderPassEncoder } from '../../gpu/RenderBackend';
import type { BlendMode, ColorAttachment, SamplerHandle, TextureHandle } from '../../gpu/types';
import type { Viewport } from '../../viewport/Viewport';
import type { RenderPassContext } from '../RenderPass';
import type { CommandBuffer } from '../../commands/DrawCommand';
import { SOLID_MATERIAL, TEXTURED_MATERIAL } from '../../shaders/Material';
import { packSolid, packTextured } from '../../pipeline/uniforms';

const FULL_UV: Rect = { x: 0, y: 0, width: 1, height: 1 };

/** World → clip MVP for a renderable's model matrix. */
export function mvpFor(viewport: Viewport, model: Mat3): Mat3 {
  return Mat3.multiply(viewport.camera.viewProjectionMatrix(), model);
}

/** Model matrix mapping the unit quad [0,1]² onto a world-space rect. */
export function modelFromRect(rect: Rect): Mat3 {
  const m = Mat3.scaling(rect.width, rect.height);
  const t = Mat3.translation(rect.x, rect.y);
  return Mat3.multiply(t, m);
}

/** Resolve this pass's primary write target to a color attachment. */
export function writeAttachment(ctx: RenderPassContext, name: string, clear?: Color): ColorAttachment {
  const target = ctx.target(name);
  return target ? { target, clear } : { target: 'surface', clear };
}

/** Begin a render pass on the given attachment and set the full viewport. */
export function beginViewportPass(ctx: RenderPassContext, label: string, attachment: ColorAttachment): RenderPassEncoder {
  const enc = ctx.services.backend.beginRenderPass({ label, color: attachment });
  const { width, height } = ctx.viewport.pixelSize;
  enc.setViewport(0, 0, width, height);
  return enc;
}

/** Queue a solid-colored quad. Consecutive solids of one blend batch together. */
export function emitSolid(cmds: CommandBuffer, mvp: Mat3, color: Color, opacity: number, blend: BlendMode): void {
  cmds.add({
    batchKey: `solid|${blend}`,
    material: SOLID_MATERIAL,
    blend,
    uniforms: packSolid(mvp, color, opacity),
  });
}

/** Queue a textured quad. Batches per texture + blend. */
export function emitTextured(
  cmds: CommandBuffer,
  mvp: Mat3,
  tint: Color,
  opacity: number,
  blend: BlendMode,
  texture: TextureHandle,
  sampler: SamplerHandle,
  uvRect: Rect = FULL_UV,
): void {
  cmds.add({
    batchKey: `tex|${texture.id}|${blend}`,
    material: TEXTURED_MATERIAL,
    blend,
    uniforms: packTextured(mvp, uvRect, tint, opacity),
    texture,
    sampler,
  });
}
