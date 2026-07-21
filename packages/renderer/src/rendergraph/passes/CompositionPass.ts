import { Color } from '../../core/math/Color';
import { Rect } from '../../core/math/geometry';
import type { RenderableSdf } from '../../scene/FrameScene';
import type { SolidShape } from '../../pipeline/uniforms';
import { RenderPass, type RenderPassContext } from '../RenderPass';
import { beginViewportPass, emitSolid, emitTextured, emitMaskedTextured, emitLutTextured, emitMatteCombine, emitBlendCombine, modelFromRect, mvpFor, writeAttachment, emitLayerTexture, screenMvp, targetSampleUv } from './passUtils';
import { BLUR_MATERIAL, GRADIENT_RAMP_MATERIAL, FRACTAL_NOISE_MATERIAL, DISPLACEMENT_MAP_MATERIAL, MOTION_TILE_MATERIAL, FILL_MATERIAL, STROKE_MATERIAL, SHARPEN_MATERIAL, NOISE_MATERIAL } from '../../shaders/Material';
import { packBlur, packGradientRamp, packFractalNoise, packDisplacementMap, packMotionTile, packFill, packStroke, packSharpen, packNoise } from '../../pipeline/uniforms';
import { CommandBuffer } from '../../commands/DrawCommand';
import { EffectPass } from './EffectPass';

export const LAYER_TARGET = 'layer-target';
export const BLUR_TARGET1 = 'blur-target1';
export const BLUR_TARGET2 = 'blur-target2';
export const MATTE_TARGET = 'matte-target';

function toSolidShape(sdf: RenderableSdf | undefined): SolidShape | undefined {
  if (!sdf) return undefined;
  if (sdf.shape === 'ellipse') return { kind: 2, radiusPx: 0, width: sdf.width, height: sdf.height };
  const r = Math.max(0, Math.min(sdf.radiusPx, Math.min(sdf.width, sdf.height) / 2));
  return { kind: 1, radiusPx: r, width: sdf.width, height: sdf.height };
}

export class CompositionPass extends RenderPass {
  readonly name = 'composition';
  override get writes() {
    return [EffectPass.activeColorTarget, LAYER_TARGET, BLUR_TARGET1, BLUR_TARGET2, MATTE_TARGET];
  }
  override readonly after = ['background'];

  /** Build the draw commands for one renderable (solid / textured / masked / LUT)
   *  at the given opacity. Used to render a matte source and matted layer to
   *  offscreen targets, and (with model/blend overrides) to accumulate
   *  motion-blur sub-frame samples additively. */
  private renderableCmds(
    ctx: RenderPassContext,
    r: import('../../scene/FrameScene').Renderable,
    opacity: number,
    into?: CommandBuffer,
    modelOverride?: import('../../core/math/Mat3').Mat3,
    blendOverride?: import('../../gpu/types').BlendMode,
  ): CommandBuffer {
    const { viewport, services } = ctx;
    const cmds = into ?? new CommandBuffer();
    const blend = blendOverride ?? 'normal';
    const smp = () => services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' });
    const uv = r.uvRect ?? { x: 0, y: 0, width: 1, height: 1 };
    const mvp = mvpFor(viewport, modelOverride ?? r.modelMatrix);
    const isSolid = r.kind === 'rect' || r.kind === 'path' || r.kind === 'group';
    const isTextured = r.kind === 'image' || r.kind === 'video' || r.kind === 'text';
    if (r.maskTextureKey) {
      const maskTex = services.textures.get(r.maskTextureKey);
      let tex = isTextured && r.textureKey ? services.textures.get(r.textureKey) : undefined;
      if (isSolid && !tex) tex = services.textures.get('texture:white');
      if (maskTex && tex) emitMaskedTextured(cmds, mvp, r.color ?? Color.white(), opacity, blend, tex.texture, smp(), maskTex.texture, uv, r.colorMatrix);
    } else if (isSolid && r.color) {
      emitSolid(cmds, mvp, r.color, opacity, blend, toSolidShape(r.sdf));
    } else if (isTextured && r.textureKey) {
      const tex = services.textures.get(r.textureKey);
      const lut = r.lutTextureKey ? services.textures.get(r.lutTextureKey) : undefined;
      if (tex && lut) emitLutTextured(cmds, mvp, r.color ?? Color.white(), opacity, blend, tex.texture, smp(), lut.texture, uv, r.colorMatrix);
      else if (tex) emitLayerTexture(ctx, r, { texture: tex.texture, sampler: smp(), uv }, opacity, cmds, modelOverride, blendOverride);
    }
    return cmds;
  }

  /** Resolve a displacement-map effect's source texture: render the referenced
   *  layer into MATTE_TARGET (same on-demand pattern as the track-matte branch)
   *  and return its texture. Null when the id is unset, self-referential, or
   *  unresolvable — the caller then falls back to self-displacement (the legacy
   *  behavior). The offscreen map is later sampled with the SAME backend-correct
   *  target UV as the layer texture, so orientation matches on both backends. */
  private displacementMapTexture(
    ctx: RenderPassContext,
    byId: ReadonlyMap<string, import('../../scene/FrameScene').Renderable>,
    mapLayerId: string | undefined,
    selfId: string,
  ): import('../../gpu/types').TextureHandle | null {
    if (!mapLayerId || mapLayerId === selfId) return null;
    const source = byId.get(mapLayerId);
    if (!source) return null;
    const mapCmds = this.renderableCmds(ctx, source, 1);
    if (mapCmds.length === 0) return null;
    const enc = beginViewportPass(ctx, 'displace-map', writeAttachment(ctx, MATTE_TARGET, Color.transparent()));
    ctx.services.quad.execute(enc, mapCmds);
    enc.end();
    return ctx.services.backend.renderTargetTexture(ctx.target(MATTE_TARGET)!) ?? null;
  }

  execute(ctx: RenderPassContext): void {
    const { scene, viewport, services } = ctx;
    const visible = viewport.visibleWorldRect;
    // Backend-correct UV for sampling offscreen targets (V-flip on WebGL2 only).
    const targetUv = targetSampleUv(ctx);
    
    // We maintain a buffer of commands for the main surface.
    const mainCmds = new CommandBuffer();

    const flushMain = () => {
      if (mainCmds.length === 0) return;
      const enc = beginViewportPass(ctx, this.name, writeAttachment(ctx, EffectPass.activeColorTarget));
      services.quad.execute(enc, mainCmds);
      enc.end();
      mainCmds.clear();
    };

    const clampSampler = () => services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' });
    const byId = new Map(scene.renderables.map((r) => [r.id, r] as const));

    for (const r of scene.renderables) {
      // A matte source is consumed by its matted layer (rendered on demand into
      // MATTE_TARGET below) — never drawn to the scene directly.
      if (r.matteSource) continue;

      if (r.matte) {
        // Track matte: render the matted layer and its matte source to full-comp
        // targets, then combine (source alpha/luma → matted alpha). Composited
        // over the scene with the matted layer's own blend.
        const source = byId.get(r.matte.sourceId);
        if (source) {
          flushMain();
          // matte source → MATTE_TARGET
          const encS = beginViewportPass(ctx, 'matte-src', writeAttachment(ctx, MATTE_TARGET, Color.transparent()));
          services.quad.execute(encS, this.renderableCmds(ctx, source, 1));
          encS.end();
          const matteTex = ctx.services.backend.renderTargetTexture(ctx.target(MATTE_TARGET)!);
          // matted layer → LAYER_TARGET (its opacity baked in)
          const encM = beginViewportPass(ctx, 'matte-layer', writeAttachment(ctx, LAYER_TARGET, Color.transparent()));
          services.quad.execute(encM, this.renderableCmds(ctx, r, r.opacity));
          encM.end();
          const mattedTex = ctx.services.backend.renderTargetTexture(ctx.target(LAYER_TARGET)!);
          if (matteTex && mattedTex) {
            const luma = r.matte.mode === 'luma' ? 1 : 0;
            const inv = r.matte.inverted ? 1 : 0;
            const mode = { m: [luma, inv, 0, 0, 0, 0, 0, 0, 0], offset: [0, 0, 0] };
            emitMatteCombine(mainCmds, screenMvp(), r.blend, mattedTex, clampSampler(), matteTex, mode, targetUv);
          }
          continue;
        }
        // No source resolved — fall through and draw the layer normally.
      }

      if (r.adjustment) {
        // Adjustment layer: re-composite everything drawn so far through the
        // grade. Only works when the scene renders to a samplable colour target
        // (SCENE_COLOR_TARGET) — snapshotToFrameScene sets hasEffects so it does.
        flushMain();
        const sceneTarget = ctx.target(EffectPass.activeColorTarget);
        const sceneTex = sceneTarget ? ctx.services.backend.renderTargetTexture(sceneTarget) : null;
        if (!sceneTex) continue; // target is the SURFACE (not samplable) — skip
        // 1. copy the accumulated scene into LAYER_TARGET (ping — can't sample a
        //    target while writing it) applying the grade first.
        const copyCmds = new CommandBuffer();
        const lut = r.adjustment.lutTextureKey ? services.textures.get(r.adjustment.lutTextureKey) : undefined;
        const mvp = screenMvp();
        if (lut) {
          emitLutTextured(copyCmds, mvp, Color.white(), 1, 'normal', sceneTex, clampSampler(), lut.texture, targetUv, r.adjustment.colorMatrix);
        } else {
          emitTextured(copyCmds, mvp, Color.white(), 1, 'normal', sceneTex, clampSampler(), targetUv, r.adjustment.colorMatrix);
        }
        const encCopy = beginViewportPass(ctx, 'adjust-copy', writeAttachment(ctx, LAYER_TARGET, Color.transparent()));
        services.quad.execute(encCopy, copyCmds);
        encCopy.end();
        const belowTex = ctx.services.backend.renderTargetTexture(ctx.target(LAYER_TARGET)!);
        if (!belowTex) continue;

        // 2. If there are spatial effects, run the effects chain.
        const effects = r.effects;
        if (effects && effects.length > 0) {
          let currentInputTex = belowTex;
          let currentInputTargetName = LAYER_TARGET;

          for (let i = 0; i < effects.length; i++) {
            const effect = effects[i]!;
            const isLast = i === effects.length - 1;
            const outTargetName = isLast
              ? EffectPass.activeColorTarget
              : (currentInputTargetName === LAYER_TARGET ? BLUR_TARGET2 : LAYER_TARGET);

            if (effect.type === 'blur' || effect.type === 'glow' || effect.type === 'drop-shadow') {
              const rPx = effect.radiusPx;
              let blur2Tex = currentInputTex;
              if (rPx > 0) {
                // Horizontal blur (currentInputTex -> BLUR_TARGET1)
                const blur1Cmds = new CommandBuffer();
                blur1Cmds.add({
                  batchKey: 'blur|normal', material: BLUR_MATERIAL, blend: 'normal',
                  uniforms: packBlur(mvp, targetUv, 1.0 / viewport.pixelSize.width, 0, rPx),
                  texture: currentInputTex, sampler: clampSampler(),
                });
                const encBlur1 = beginViewportPass(ctx, 'blurH', writeAttachment(ctx, BLUR_TARGET1, Color.transparent()));
                services.quad.execute(encBlur1, blur1Cmds);
                encBlur1.end();

                const blur1Tex = ctx.services.backend.renderTargetTexture(ctx.target(BLUR_TARGET1)!);
                if (blur1Tex) {
                  // Vertical blur (BLUR_TARGET1 -> BLUR_TARGET2)
                  const blur2Cmds = new CommandBuffer();
                  blur2Cmds.add({
                    batchKey: 'blur|normal', material: BLUR_MATERIAL, blend: 'normal',
                    uniforms: packBlur(mvp, targetUv, 0, 1.0 / viewport.pixelSize.height, rPx),
                    texture: blur1Tex, sampler: clampSampler(),
                  });
                  const encBlur2 = beginViewportPass(ctx, 'blurV', writeAttachment(ctx, BLUR_TARGET2, Color.transparent()));
                  services.quad.execute(encBlur2, blur2Cmds);
                  encBlur2.end();
                  const blurred = ctx.services.backend.renderTargetTexture(ctx.target(BLUR_TARGET2)!);
                  if (blurred) blur2Tex = blurred;
                }
              }

              const compCmds = new CommandBuffer();
              if (effect.type === 'blur') {
                emitTextured(compCmds, mvp, Color.white(), 1, 'normal', blur2Tex, clampSampler(), targetUv);
              } else if (effect.type === 'glow') {
                emitTextured(compCmds, mvp, effect.color ?? Color.fromHex('rgba(120,180,255,0.9)'), 1, 'screen', blur2Tex, clampSampler(), targetUv);
                emitTextured(compCmds, mvp, Color.white(), 1, 'normal', currentInputTex, clampSampler(), targetUv);
              } else if (effect.type === 'drop-shadow') {
                const offX = effect.offsetX;
                const offY = effect.offsetY;
                const rect = {
                  x: viewport.visibleWorldRect.x + offX,
                  y: viewport.visibleWorldRect.y + offY,
                  width: viewport.visibleWorldRect.width,
                  height: viewport.visibleWorldRect.height,
                };
                emitTextured(compCmds, mvpFor(viewport, modelFromRect(rect)), effect.color ?? Color.fromHex('rgba(0,0,0,0.55)'), 1, 'normal', blur2Tex, clampSampler(), targetUv);
                emitTextured(compCmds, mvp, Color.white(), 1, 'normal', currentInputTex, clampSampler(), targetUv);
              }
              const encComp = beginViewportPass(ctx, 'adjust-comp', writeAttachment(ctx, outTargetName, Color.transparent()));
              services.quad.execute(encComp, compCmds);
              encComp.end();

            } else if (effect.type === 'gradient-ramp') {
              const rampCmds = new CommandBuffer();
              rampCmds.add({
                batchKey: 'ramp', material: GRADIENT_RAMP_MATERIAL, blend: 'normal',
                uniforms: packGradientRamp(mvp, targetUv, [effect.colorA || Color.white(), effect.colorB || Color.black()], [0, 0, 1, 1], effect.blend),
                texture: currentInputTex, sampler: clampSampler(),
              });
              const enc = beginViewportPass(ctx, 'ramp', writeAttachment(ctx, outTargetName, Color.transparent()));
              services.quad.execute(enc, rampCmds);
              enc.end();

            } else if (effect.type === 'fractal-noise') {
              const fnCmds = new CommandBuffer();
              fnCmds.add({
                batchKey: 'noise', material: FRACTAL_NOISE_MATERIAL, blend: 'normal',
                uniforms: packFractalNoise(mvp, targetUv, effect.scale, 0, 0, 4),
                texture: currentInputTex, sampler: clampSampler(),
              });
              const enc = beginViewportPass(ctx, 'noise', writeAttachment(ctx, outTargetName, Color.transparent()));
              services.quad.execute(enc, fnCmds);
              enc.end();

            } else if (effect.type === 'displacement-map') {
              // Map source: the referenced layer's rendered content when set,
              // else the input displaces by itself (legacy self-displacement).
              const mapTex = this.displacementMapTexture(ctx, byId, effect.mapLayerId, r.id) ?? currentInputTex;
              const dmCmds = new CommandBuffer();
              dmCmds.add({
                batchKey: 'displace', material: DISPLACEMENT_MAP_MATERIAL, blend: 'normal',
                uniforms: packDisplacementMap(mvp, targetUv, effect.amount / viewport.pixelSize.width, effect.amount / viewport.pixelSize.height),
                texture: currentInputTex, sampler: clampSampler(),
                maskTexture: mapTex,
              });
              const enc = beginViewportPass(ctx, 'displace', writeAttachment(ctx, outTargetName, Color.transparent()));
              services.quad.execute(enc, dmCmds);
              enc.end();

            } else if (effect.type === 'motion-tile') {
              const mtCmds = new CommandBuffer();
              mtCmds.add({
                batchKey: 'motiontile', material: MOTION_TILE_MATERIAL, blend: 'normal',
                uniforms: packMotionTile(mvp, targetUv, effect.scale, effect.scale, 0, 0),
                texture: currentInputTex, sampler: services.resources.sampler('linear-repeat', { min: 'linear', mag: 'linear', addressU: 'repeat', addressV: 'repeat' }),
              });
              const enc = beginViewportPass(ctx, 'motiontile', writeAttachment(ctx, outTargetName, Color.transparent()));
              services.quad.execute(enc, mtCmds);
              enc.end();

            } else if (effect.type === 'fill') {
              const fillCmds = new CommandBuffer();
              fillCmds.add({
                batchKey: 'fill', material: FILL_MATERIAL, blend: 'normal',
                uniforms: packFill(mvp, targetUv, effect.color),
                texture: currentInputTex, sampler: clampSampler(),
              });
              const enc = beginViewportPass(ctx, 'fill', writeAttachment(ctx, outTargetName, Color.transparent()));
              services.quad.execute(enc, fillCmds);
              enc.end();

            } else if (effect.type === 'stroke') {
              const strokeCmds = new CommandBuffer();
              strokeCmds.add({
                batchKey: 'stroke', material: STROKE_MATERIAL, blend: 'normal',
                uniforms: packStroke(mvp, targetUv, effect.color, effect.widthPx, 1 / viewport.pixelSize.width, 1 / viewport.pixelSize.height),
                texture: currentInputTex, sampler: clampSampler(),
              });
              const enc = beginViewportPass(ctx, 'stroke', writeAttachment(ctx, outTargetName, Color.transparent()));
              services.quad.execute(enc, strokeCmds);
              enc.end();

            } else if (effect.type === 'sharpen') {
              const sharpCmds = new CommandBuffer();
              sharpCmds.add({
                batchKey: 'sharpen', material: SHARPEN_MATERIAL, blend: 'normal',
                uniforms: packSharpen(mvp, targetUv, 1 / viewport.pixelSize.width, 1 / viewport.pixelSize.height, effect.amount),
                texture: currentInputTex, sampler: clampSampler(),
              });
              const enc = beginViewportPass(ctx, 'sharpen', writeAttachment(ctx, outTargetName, Color.transparent()));
              services.quad.execute(enc, sharpCmds);
              enc.end();

            } else if (effect.type === 'noise') {
              const noiseCmds = new CommandBuffer();
              noiseCmds.add({
                batchKey: 'noise', material: NOISE_MATERIAL, blend: 'normal',
                uniforms: packNoise(mvp, targetUv, effect.amount, effect.evolution, effect.monochrome),
                texture: currentInputTex, sampler: clampSampler(),
              });
              const enc = beginViewportPass(ctx, 'noise', writeAttachment(ctx, outTargetName, Color.transparent()));
              services.quad.execute(enc, noiseCmds);
              enc.end();
            }

            if (!isLast) {
              const nextInputTex = ctx.services.backend.renderTargetTexture(ctx.target(outTargetName)!);
              if (nextInputTex) {
                currentInputTex = nextInputTex;
                currentInputTargetName = outTargetName as string;
              }
            }
          }
        } else {
          const gradeCmds = new CommandBuffer();
          // belowTex is an offscreen target — sample with the backend-correct
          // UV. The previous identity UV vertically flipped the whole scene on
          // WebGL whenever a grade-only adjustment layer (e.g. hue-rotate)
          // took this branch.
          emitTextured(gradeCmds, mvp, Color.white(), 1, 'normal', belowTex, clampSampler(), targetUv);
          const encGrade = beginViewportPass(ctx, 'adjust-grade', writeAttachment(ctx, EffectPass.activeColorTarget, Color.transparent()));
          services.quad.execute(encGrade, gradeCmds);
          encGrade.end();
        }
        continue;
      }

      if (!Rect.intersects(visible, r.bounds) || r.opacity <= 0) continue;

      if (r.advancedBlend && r.advancedBlend > 0) {
        // Advanced blend (overlay/hard-light/HSL/…): fixed-function GL can't do
        // these — composite the layer against the accumulated backdrop through
        // the BLEND_COMBINE shader. Needs a samplable scene target
        // (snapshotToFrameScene forces hasEffects when any advanced blend exists).
        flushMain();
        const sceneTarget = ctx.target(EffectPass.activeColorTarget);
        const sceneTex = sceneTarget ? ctx.services.backend.renderTargetTexture(sceneTarget) : null;
        if (sceneTex) {
          const full = targetUv;
          const fullMvp = screenMvp();
          // 1. copy backdrop out (can't sample a target while writing it).
          const copyCmds = new CommandBuffer();
          emitTextured(copyCmds, fullMvp, Color.white(), 1, 'normal', sceneTex, clampSampler(), full);
          const encCopy = beginViewportPass(ctx, 'blend-backdrop', writeAttachment(ctx, MATTE_TARGET, Color.transparent()));
          services.quad.execute(encCopy, copyCmds);
          encCopy.end();
          const backdropTex = ctx.services.backend.renderTargetTexture(ctx.target(MATTE_TARGET)!);
          // 2. render the layer (its own opacity baked in) to LAYER_TARGET.
          const encLayer = beginViewportPass(ctx, 'blend-layer', writeAttachment(ctx, LAYER_TARGET, Color.transparent()));
          services.quad.execute(encLayer, this.renderableCmds(ctx, r, r.opacity));
          encLayer.end();
          const layerTex = ctx.services.backend.renderTargetTexture(ctx.target(LAYER_TARGET)!);
          // 3. combine (src=layer, dst=backdrop) → OVERWRITE the scene target.
          if (backdropTex && layerTex) {
            const mode = { m: [r.advancedBlend, 0, 0, 0, 0, 0, 0, 0, 0], offset: [0, 0, 0] };
            const combineCmds = new CommandBuffer();
            emitBlendCombine(combineCmds, fullMvp, 'none', layerTex, clampSampler(), backdropTex, mode, full);
            const encOut = beginViewportPass(ctx, 'blend-combine', writeAttachment(ctx, EffectPass.activeColorTarget));
            services.quad.execute(encOut, combineCmds);
            encOut.end();
          }
          continue;
        }
        // sceneTex null (SURFACE, not samplable) — fall through to a normal draw.
      }

      const hasEffects = r.effects && r.effects.length > 0;
      // Motion blur: sub-frame samples accumulate ADDITIVELY at 1/n weight into
      // LAYER_TARGET (the shutter-interval mean), then composite once — so it
      // routes through the offscreen branch even without effects.
      const hasMotion = !!(r.motionSamples && r.motionSamples.length > 1);

      const isSolid = r.kind === 'rect' || r.kind === 'path' || r.kind === 'group';
      const isTextured = r.kind === 'image' || r.kind === 'video' || r.kind === 'text';

      if (!hasEffects && !hasMotion) {
        // Direct to surface
        if (r.maskTextureKey) {
          const maskTex = services.textures.get(r.maskTextureKey);
          if (maskTex) {
            let tex = isTextured && r.textureKey ? services.textures.get(r.textureKey) : undefined;
            if (isSolid && !tex) tex = services.textures.get('texture:white'); // Or placeholder
            if (tex) {
              emitMaskedTextured(
                mainCmds,
                mvpFor(viewport, r.modelMatrix),
                r.color ?? Color.white(),
                r.opacity,
                r.blend,
                tex.texture,
                services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
                maskTex.texture,
                r.uvRect ?? { x: 0, y: 0, width: 1, height: 1 },
                r.colorMatrix
              );
            }
          }
        } else if (isSolid && r.color) {
          emitSolid(mainCmds, mvpFor(viewport, r.modelMatrix), r.color, r.opacity, r.blend, toSolidShape(r.sdf));
        } else if (isTextured && r.textureKey) {
          const tex = services.textures.get(r.textureKey);
          if (tex) {
            const smp = services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' });
            const uv = r.uvRect ?? { x: 0, y: 0, width: 1, height: 1 };
            const lut = r.lutTextureKey ? services.textures.get(r.lutTextureKey) : undefined;
            if (lut) {
              // Levels/Curves/Posterize on the GPU: remap through the LUT texture
              // after the affine grade (the second sampler the binding fix enabled).
              emitLutTextured(mainCmds, mvpFor(viewport, r.modelMatrix), r.color ?? Color.white(), r.opacity, r.blend, tex.texture, smp, lut.texture, uv, r.colorMatrix);
            } else {
              emitTextured(mainCmds, mvpFor(viewport, r.modelMatrix), r.color ?? Color.white(), r.opacity, r.blend, tex.texture, smp, uv, r.colorMatrix);
            }
          }
        }
        continue;
      }

      // Offscreen route (effects and/or motion blur): draw to LAYER_TARGET,
      // process, and composite.
      flushMain();

      // 1. Draw layer to LAYER_TARGET — one draw normally, or the sub-frame
      // sample accumulation (each sample at its own transform, additive, at
      // sampledOpacity/n) when the layer is motion-blurred.
      const layerCmds = new CommandBuffer();
      if (hasMotion) {
        const samples = r.motionSamples!;
        const n = samples.length;
        for (const s of samples) {
          this.renderableCmds(ctx, r, s.opacity / n, layerCmds, s.modelMatrix, 'add');
        }
      } else {
        this.renderableCmds(ctx, r, 1, layerCmds);
      }

      if (layerCmds.length === 0) continue;

      const encLayer = beginViewportPass(ctx, 'layer', writeAttachment(ctx, LAYER_TARGET, Color.transparent()));
      services.quad.execute(encLayer, layerCmds);
      encLayer.end();

      const layerTex = ctx.services.backend.renderTargetTexture(ctx.target(LAYER_TARGET)!);
      if (!layerTex) continue;

      // Motion blur without effects: composite the accumulated mean once at
      // the layer's blend. Sample opacity is already baked into the buffer.
      if (!hasEffects) {
        emitTextured(
          mainCmds,
          screenMvp(),
          Color.white(), 1, r.blend, layerTex,
          clampSampler(),
          targetUv,
        );
        continue;
      }

      // Now process each effect
      for (const effect of r.effects!) {
        if (effect.type === 'blur' || effect.type === 'glow' || effect.type === 'drop-shadow') {
          const rPx = effect.radiusPx;
          // Zero radius/softness: the un-blurred layer IS the source (a hard
          // glow ring / hard-edged shadow). `continue`-ing here skipped the
          // WHOLE composite, so a layer whose only effect had softness 0
          // disappeared entirely on the GPU backend.
          let blur2Tex = layerTex;
          if (rPx > 0) {
            // Horizontal blur (LAYER_TARGET -> BLUR_TARGET1)
            const blur1Cmds = new CommandBuffer();
            blur1Cmds.add({
              batchKey: 'blur|normal',
              material: BLUR_MATERIAL,
              blend: 'normal',
              uniforms: packBlur(
                screenMvp(),
                targetUv,
                1.0 / viewport.pixelSize.width, 0, rPx
              ),
              texture: layerTex,
              sampler: services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
            });
            const encBlur1 = beginViewportPass(ctx, 'blurH', writeAttachment(ctx, BLUR_TARGET1, Color.transparent()));
            services.quad.execute(encBlur1, blur1Cmds);
            encBlur1.end();

            const blur1Tex = ctx.services.backend.renderTargetTexture(ctx.target(BLUR_TARGET1)!);
            if (!blur1Tex) continue;

            // Vertical blur (BLUR_TARGET1 -> BLUR_TARGET2)
            const blur2Cmds = new CommandBuffer();
            blur2Cmds.add({
              batchKey: 'blur|normal',
              material: BLUR_MATERIAL,
              blend: 'normal',
              uniforms: packBlur(
                screenMvp(),
                targetUv,
                0, 1.0 / viewport.pixelSize.height, rPx
              ),
              texture: blur1Tex,
              sampler: services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
            });
            const encBlur2 = beginViewportPass(ctx, 'blurV', writeAttachment(ctx, BLUR_TARGET2, Color.transparent()));
            services.quad.execute(encBlur2, blur2Cmds);
            encBlur2.end();

            const blurred = ctx.services.backend.renderTargetTexture(ctx.target(BLUR_TARGET2)!);
            if (!blurred) continue;
            blur2Tex = blurred;
          }

          // Composite to SURFACE
          if (effect.type === 'blur') {
            emitTextured(
              mainCmds,
              screenMvp(),
              Color.white(), r.opacity, r.blend, blur2Tex,
              services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
              targetUv
            );
          } else if (effect.type === 'glow') {
            // Add glow
            emitTextured(
              mainCmds,
              screenMvp(),
              effect.color ?? Color.fromHex('rgba(120,180,255,0.9)'), r.opacity, 'screen', blur2Tex,
              services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
              targetUv
            );
            // Add original layer
            emitTextured(
              mainCmds,
              screenMvp(),
              Color.white(), r.opacity, r.blend, layerTex,
              services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
              targetUv
            );
          } else if (effect.type === 'drop-shadow') {
            // Add shadow
            const offX = effect.offsetX;
            const offY = effect.offsetY;
            const rect = {
              x: viewport.visibleWorldRect.x + offX,
              y: viewport.visibleWorldRect.y + offY,
              width: viewport.visibleWorldRect.width,
              height: viewport.visibleWorldRect.height,
            };
            emitTextured(
              mainCmds,
              mvpFor(viewport, modelFromRect(rect)),
              effect.color ?? Color.fromHex('rgba(0,0,0,0.55)'), r.opacity, 'normal', blur2Tex,
              services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
              targetUv
            );
            // Add original layer
            emitTextured(
              mainCmds,
              screenMvp(),
              Color.white(), r.opacity, r.blend, layerTex,
              services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
              targetUv
            );
          }
        } else if (effect.type === 'gradient-ramp') {
          const rampCmds = new CommandBuffer();
          rampCmds.add({
            batchKey: 'ramp', material: GRADIENT_RAMP_MATERIAL, blend: r.blend,
            uniforms: packGradientRamp(screenMvp(), targetUv, [effect.colorA || Color.white(), effect.colorB || Color.black()], [0, 0, 1, 1], effect.blend),
            texture: layerTex, sampler: services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
          });
          const enc = beginViewportPass(ctx, 'ramp', writeAttachment(ctx, EffectPass.activeColorTarget));
          services.quad.execute(enc, rampCmds);
          enc.end();
        } else if (effect.type === 'fractal-noise') {
          const fnCmds = new CommandBuffer();
          fnCmds.add({
            batchKey: 'noise', material: FRACTAL_NOISE_MATERIAL, blend: r.blend,
            uniforms: packFractalNoise(screenMvp(), targetUv, effect.scale, 0, 0, 4),
            texture: layerTex, sampler: services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
          });
          const enc = beginViewportPass(ctx, 'noise', writeAttachment(ctx, EffectPass.activeColorTarget));
          services.quad.execute(enc, fnCmds);
          enc.end();
        } else if (effect.type === 'displacement-map') {
          // Displacement source: the referenced layer's content rendered into
          // MATTE_TARGET (both it and layerTex are offscreen targets, so both
          // sample through the same backend-correct targetUv). Falls back to
          // self-displacement when mapLayerId is unset or unresolvable.
          const mapTex = this.displacementMapTexture(ctx, byId, effect.mapLayerId, r.id) ?? layerTex;
          const dmCmds = new CommandBuffer();
          dmCmds.add({
            batchKey: 'displace', material: DISPLACEMENT_MAP_MATERIAL, blend: r.blend,
            uniforms: packDisplacementMap(screenMvp(), targetUv, effect.amount / viewport.pixelSize.width, effect.amount / viewport.pixelSize.height),
            texture: layerTex, sampler: services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
            maskTexture: mapTex,
          });
          const enc = beginViewportPass(ctx, 'displace', writeAttachment(ctx, EffectPass.activeColorTarget));
          services.quad.execute(enc, dmCmds);
          enc.end();
        } else if (effect.type === 'motion-tile') {
          const mtCmds = new CommandBuffer();
          mtCmds.add({
            batchKey: 'motiontile', material: MOTION_TILE_MATERIAL, blend: r.blend,
            uniforms: packMotionTile(screenMvp(), targetUv, effect.scale, effect.scale, 0, 0),
            texture: layerTex, sampler: services.resources.sampler('linear-repeat', { min: 'linear', mag: 'linear', addressU: 'repeat', addressV: 'repeat' }),
          });
          const enc = beginViewportPass(ctx, 'motiontile', writeAttachment(ctx, EffectPass.activeColorTarget));
          services.quad.execute(enc, mtCmds);
          enc.end();
        } else if (effect.type === 'fill') {
          const fillCmds = new CommandBuffer();
          fillCmds.add({
            batchKey: 'fill', material: FILL_MATERIAL, blend: r.blend,
            uniforms: packFill(screenMvp(), targetUv, effect.color),
            texture: layerTex, sampler: clampSampler(),
          });
          const enc = beginViewportPass(ctx, 'fill', writeAttachment(ctx, EffectPass.activeColorTarget));
          services.quad.execute(enc, fillCmds);
          enc.end();
        } else if (effect.type === 'stroke') {
          const strokeCmds = new CommandBuffer();
          strokeCmds.add({
            batchKey: 'stroke', material: STROKE_MATERIAL, blend: r.blend,
            uniforms: packStroke(screenMvp(), targetUv, effect.color, effect.widthPx, 1 / viewport.pixelSize.width, 1 / viewport.pixelSize.height),
            texture: layerTex, sampler: clampSampler(),
          });
          const enc = beginViewportPass(ctx, 'stroke', writeAttachment(ctx, EffectPass.activeColorTarget));
          services.quad.execute(enc, strokeCmds);
          enc.end();
        } else if (effect.type === 'sharpen') {
          const sharpCmds = new CommandBuffer();
          sharpCmds.add({
            batchKey: 'sharpen', material: SHARPEN_MATERIAL, blend: r.blend,
            uniforms: packSharpen(screenMvp(), targetUv, 1 / viewport.pixelSize.width, 1 / viewport.pixelSize.height, effect.amount),
            texture: layerTex, sampler: clampSampler(),
          });
          const enc = beginViewportPass(ctx, 'sharpen', writeAttachment(ctx, EffectPass.activeColorTarget));
          services.quad.execute(enc, sharpCmds);
          enc.end();
        } else if (effect.type === 'noise') {
          const noiseCmds = new CommandBuffer();
          noiseCmds.add({
            batchKey: 'noise', material: NOISE_MATERIAL, blend: r.blend,
            uniforms: packNoise(screenMvp(), targetUv, effect.amount, effect.evolution, effect.monochrome),
            texture: layerTex, sampler: clampSampler(),
          });
          const enc = beginViewportPass(ctx, 'noise', writeAttachment(ctx, EffectPass.activeColorTarget));
          services.quad.execute(enc, noiseCmds);
          enc.end();
        }

      }
    }
    
    flushMain();
  }
}
