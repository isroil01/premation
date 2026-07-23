/** Shared helpers for passes: MVP assembly, quad models, surface attachments. */

import { Mat3 } from '../../core/math/Mat3';
import { Mat4 } from '../../core/math/Mat4';
import { Color } from '../../core/math/Color';
import type { Rect } from '../../core/math/geometry';
import type { RenderPassEncoder } from '../../gpu/RenderBackend';
import type { BlendMode, ColorAttachment, SamplerHandle, TextureHandle, BufferHandle } from '../../gpu/types';
import type { Viewport } from '../../viewport/Viewport';
import type { RenderPassContext } from '../RenderPass';
import type { CommandBuffer } from '../../commands/DrawCommand';
import { SOLID_MATERIAL, TEXTURED_MATERIAL, MASKED_TEXTURED_MATERIAL, LUT_TEXTURED_MATERIAL, MATTE_COMBINE_MATERIAL, BLEND_COMBINE_MATERIAL, DEFORMED_MESH_MATERIAL, SOLID3D_MATERIAL, TEXTURED3D_MATERIAL, MASKED_TEXTURED3D_MATERIAL } from '../../shaders/Material';
import { packSolid, packTextured, packDeformedMesh, packSolid3D, packTextured3D, type SolidShape, type ColorTransform, type Shade3D } from '../../pipeline/uniforms';

const FULL_UV: Rect = { x: 0, y: 0, width: 1, height: 1 };

/** Matrix for full-screen viewport quads (maps [0,1]² -> clip [-1,1]² with top-left at (-1,+1)). */
export function screenMvp(): Mat3 {
  return Mat3.ortho(0, 1, 1, 0);
}

/** UV rect for full-screen FBO blits under the GL convention (flips V so top of
 *  FBO V=1 maps to top of quad V=0). Do NOT use directly in passes — the flip is
 *  only correct on backends that write render targets bottom-up (WebGL2). Use
 *  `targetSampleUv(ctx)` instead, which is a no-op flip on WebGPU. */
export const SCREEN_FLIP_UV: Rect = { x: 0, y: 1, width: 1, height: -1 };

/** UV rect for sampling an offscreen render target as a quad, resolved per
 *  backend: WebGL2 writes targets bottom-up so V must flip; WebGPU writes them
 *  top-down so the identity UV is correct. Hardcoding SCREEN_FLIP_UV vertically
 *  mirrors every FBO round-trip (effects, motion blur, mattes, adjustments,
 *  final scene blit) on WebGPU. */
export function targetSampleUv(ctx: RenderPassContext): Rect {
  return ctx.services.backend.renderTargetFlipV ? SCREEN_FLIP_UV : FULL_UV;
}

/** World → clip MVP for a renderable's model matrix. */
export function mvpFor(viewport: Viewport, model: Mat3): Mat3 {
  return Mat3.multiply(viewport.camera.viewProjectionMatrix(), model);
}

/**
 * Full mat4 MVP for a 3D renderable:
 *   clip = lift(camera2D VP) · projection3d · view3d · model
 * The 3D projection outputs homogeneous COMP-space coordinates (divide by w =
 * camera-space z happens in hardware); the 2D pan/zoom camera is an affine map
 * of comp space, so its lifted mat4 composes on top without disturbing w or z.
 */
export function mvp3dFor(
  viewport: Viewport,
  camera3d: { view: readonly number[]; projection: readonly number[] },
  model: readonly number[],
): Mat4 {
  const cam2d = Mat4.fromMat3(viewport.camera.viewProjectionMatrix());
  const pv = Mat4.multiply(Mat4.fromArray(camera3d.projection), Mat4.fromArray(camera3d.view));
  return Mat4.multiply(cam2d, Mat4.multiply(pv, Mat4.fromArray(model)));
}

/** Queue a depth-tested 3D solid quad (no cross-item batching by design —
 *  paint order within a 3D group is the back-to-front transparency order). */
export function emitSolid3D(
  cmds: CommandBuffer,
  mvp: Mat4,
  color: Color,
  opacity: number,
  blend: BlendMode,
  shape?: SolidShape,
  shade?: Shade3D,
): void {
  cmds.add({
    batchKey: `solid3d|${blend}`,
    material: SOLID3D_MATERIAL,
    blend,
    uniforms: packSolid3D(mvp, color, opacity, shape, shade),
  });
}

/** Queue a depth-tested 3D textured quad. */
export function emitTextured3D(
  cmds: CommandBuffer,
  mvp: Mat4,
  tint: Color,
  opacity: number,
  blend: BlendMode,
  texture: TextureHandle,
  sampler: SamplerHandle,
  uvRect: Rect = FULL_UV,
  color?: ColorTransform,
  shade?: Shade3D,
): void {
  cmds.add({
    batchKey: `tex3d|${texture.id}|${blend}`,
    material: TEXTURED3D_MATERIAL,
    blend,
    uniforms: packTextured3D(mvp, uvRect, tint, opacity, color, shade),
    texture,
    sampler,
  });
}

/** Queue a depth-tested 3D masked textured quad. */
export function emitMaskedTextured3D(
  cmds: CommandBuffer,
  mvp: Mat4,
  tint: Color,
  opacity: number,
  blend: BlendMode,
  texture: TextureHandle,
  sampler: SamplerHandle,
  maskTexture: TextureHandle,
  uvRect: Rect = FULL_UV,
  color?: ColorTransform,
  shade?: Shade3D,
): void {
  cmds.add({
    batchKey: `tex3d_mask|${texture.id}|${maskTexture.id}|${blend}`,
    material: MASKED_TEXTURED3D_MATERIAL,
    blend,
    uniforms: packTextured3D(mvp, uvRect, tint, opacity, color, shade),
    texture,
    sampler,
    maskTexture,
  });
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

/** Begin a render pass on the given attachment and set the full viewport.
 *  `depth` opts the pass into the target's depth attachment (3D groups); the
 *  target must have been created with `depth: true`. */
export function beginViewportPass(
  ctx: RenderPassContext,
  label: string,
  attachment: ColorAttachment,
  depth?: { clearDepth?: number },
): RenderPassEncoder {
  const enc = ctx.services.backend.beginRenderPass({ label, color: attachment, ...(depth ? { depth } : {}) });
  const { width, height } = ctx.viewport.pixelSize;
  enc.setViewport(0, 0, width, height);
  return enc;
}

/** Queue a solid-colored quad, optionally SDF-masked to a rounded-rect/ellipse.
 *  Consecutive solids of one blend batch together. */
export function emitSolid(
  cmds: CommandBuffer,
  mvp: Mat3,
  color: Color,
  opacity: number,
  blend: BlendMode,
  shape?: SolidShape,
): void {
  cmds.add({
    batchKey: `solid|${blend}`,
    material: SOLID_MATERIAL,
    blend,
    uniforms: packSolid(mvp, color, opacity, shape),
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
  color?: ColorTransform,
): void {
  cmds.add({
    batchKey: `tex|${texture.id}|${blend}`,
    material: TEXTURED_MATERIAL,
    blend,
    uniforms: packTextured(mvp, uvRect, tint, opacity, color),
    texture,
    sampler,
  });
}

/** Queue a deformed mesh draw command. */
export function emitDeformedMesh(
  cmds: CommandBuffer,
  mvp: Mat3,
  tint: Color,
  opacity: number,
  blend: BlendMode,
  texture: TextureHandle,
  sampler: SamplerHandle,
  vertexBuffer: BufferHandle,
  indexBuffer: BufferHandle,
  indexCount: number,
  color?: ColorTransform,
): void {
  cmds.add({
    batchKey: `mesh|${texture.id}|${blend}`,
    material: DEFORMED_MESH_MATERIAL,
    blend,
    uniforms: packDeformedMesh(mvp, tint, opacity, color),
    texture,
    sampler,
    vertexBuffer,
    indexBuffer,
    indexCount,
  });
}

/** Emit a textured layer command, using a deformed mesh if present, else a standard quad. */
export function emitLayerTexture(
  ctx: RenderPassContext,
  r: import('../../scene/FrameScene').Renderable,
  tex: { texture: TextureHandle; sampler: SamplerHandle; uv: Rect },
  opacity: number,
  cmds: CommandBuffer = ctx.services.commands,
  modelOverride?: Mat3,
  blendOverride?: BlendMode,
): void {
  const viewport = ctx.viewport;
  const blend = blendOverride ?? r.blend;
  const mvp = mvpFor(viewport, modelOverride ?? r.modelMatrix);
  if (r.deformedMesh) {
    const vertexCount = r.deformedMesh.vertices.length;
    const indexCount = r.deformedMesh.triangles.length;
    const vertexBuffer = ctx.services.resources.buffer(
      `geometry:mesh-vertex:${r.id}:${vertexCount}`,
      { label: `mesh-vertex:${r.id}`, sizeBytes: vertexCount * 4, usage: ['vertex', 'copy'] }
    );
    ctx.services.backend.writeBuffer(vertexBuffer, 0, r.deformedMesh.vertices);

    const indexBuffer = ctx.services.resources.buffer(
      `geometry:mesh-index:${r.id}:${indexCount}`,
      { label: `mesh-index:${r.id}`, sizeBytes: indexCount * 2, usage: ['index', 'copy'] }
    );
    ctx.services.backend.writeBuffer(indexBuffer, 0, r.deformedMesh.triangles);

    emitDeformedMesh(
      cmds,
      mvp,
      r.color ?? Color.white(),
      opacity,
      blend,
      tex.texture,
      tex.sampler,
      vertexBuffer,
      indexBuffer,
      indexCount,
      r.colorMatrix
    );
  } else {
    emitTextured(
      cmds,
      mvp,
      r.color ?? Color.white(),
      opacity,
      blend,
      tex.texture,
      tex.sampler,
      r.uvRect ?? tex.uv,
      r.colorMatrix
    );
  }
}

/** Queue a textured quad remapped through a colour LUT (Levels/Curves/Posterize).
 *  The LUT rides the maskTexture slot (binding 3), which the backend routes to
 *  the shader's `uLutTex` sampler. Batches per texture + lut + blend. */
export function emitLutTextured(
  cmds: CommandBuffer,
  mvp: Mat3,
  tint: Color,
  opacity: number,
  blend: BlendMode,
  texture: TextureHandle,
  sampler: SamplerHandle,
  lutTexture: TextureHandle,
  uvRect: Rect = FULL_UV,
  color?: ColorTransform,
): void {
  cmds.add({
    batchKey: `tex_lut|${texture.id}|${lutTexture.id}|${blend}`,
    material: LUT_TEXTURED_MATERIAL,
    blend,
    uniforms: packTextured(mvp, uvRect, tint, opacity, color),
    texture,
    sampler,
    maskTexture: lutTexture,
  });
}

/** Queue a track-matte combine: the matted layer texture (`texture`) masked by
 *  the matte source texture (`matteTexture`, binding 3). Mode is carried in the
 *  colour rows — `color.m[0]` = luma flag, `color.m[1]` = invert flag. */
export function emitMatteCombine(
  cmds: CommandBuffer,
  mvp: Mat3,
  blend: BlendMode,
  texture: TextureHandle,
  sampler: SamplerHandle,
  matteTexture: TextureHandle,
  mode: ColorTransform,
  uvRect: Rect = FULL_UV,
): void {
  cmds.add({
    batchKey: `tex_matte|${texture.id}|${matteTexture.id}|${blend}`,
    material: MATTE_COMBINE_MATERIAL,
    blend,
    uniforms: packTextured(mvp, uvRect, Color.white(), 1, mode),
    texture,
    sampler,
    maskTexture: matteTexture,
  });
}

/** Queue an advanced-blend combine: the layer texture (`texture`, src) blended
 *  against the backdrop (`backdropTexture`, binding 3, dst) via the W3C blend
 *  math. Mode id rides `mode.m[0]` (→ cr0.x in the shader). The shader outputs
 *  the full composite, so draw it with blend `'none'` (replace). */
export function emitBlendCombine(
  cmds: CommandBuffer,
  mvp: Mat3,
  blend: BlendMode,
  texture: TextureHandle,
  sampler: SamplerHandle,
  backdropTexture: TextureHandle,
  mode: ColorTransform,
  uvRect: Rect = FULL_UV,
): void {
  cmds.add({
    batchKey: `blend_combine|${texture.id}|${backdropTexture.id}|${blend}`,
    material: BLEND_COMBINE_MATERIAL,
    blend,
    uniforms: packTextured(mvp, uvRect, Color.white(), 1, mode),
    texture,
    sampler,
    maskTexture: backdropTexture,
  });
}

/** Queue a masked textured quad. Batches per texture + mask + blend. */
export function emitMaskedTextured(
  cmds: CommandBuffer,
  mvp: Mat3,
  tint: Color,
  opacity: number,
  blend: BlendMode,
  texture: TextureHandle,
  sampler: SamplerHandle,
  maskTexture: TextureHandle,
  uvRect: Rect = FULL_UV,
  color?: ColorTransform,
): void {
  cmds.add({
    batchKey: `tex_mask|${texture.id}|${maskTexture.id}|${blend}`,
    material: MASKED_TEXTURED_MATERIAL,
    blend,
    uniforms: packTextured(mvp, uvRect, tint, opacity, color),
    texture,
    sampler,
    maskTexture,
  });
}
