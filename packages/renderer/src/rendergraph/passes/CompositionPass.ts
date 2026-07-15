import { Color } from '../../core/math/Color';
import { Rect } from '../../core/math/geometry';
import type { RenderableSdf } from '../../scene/FrameScene';
import type { SolidShape } from '../../pipeline/uniforms';
import { RenderPass, SURFACE, type RenderPassContext } from '../RenderPass';
import { beginViewportPass, emitSolid, emitTextured, emitMaskedTextured, modelFromRect, mvpFor, writeAttachment } from './passUtils';
import { BLUR_MATERIAL, GRADIENT_RAMP_MATERIAL, FRACTAL_NOISE_MATERIAL, DISPLACEMENT_MAP_MATERIAL, MOTION_TILE_MATERIAL } from '../../shaders/Material';
import { packBlur, packGradientRamp, packFractalNoise, packDisplacementMap, packMotionTile } from '../../pipeline/uniforms';
import { CommandBuffer } from '../../commands/DrawCommand';
import { EffectPass } from './EffectPass';

export const LAYER_TARGET = 'layer-target';
export const BLUR_TARGET1 = 'blur-target1';
export const BLUR_TARGET2 = 'blur-target2';

function toSolidShape(sdf: RenderableSdf | undefined): SolidShape | undefined {
  if (!sdf) return undefined;
  if (sdf.shape === 'ellipse') return { kind: 2, radiusPx: 0, width: sdf.width, height: sdf.height };
  const r = Math.max(0, Math.min(sdf.radiusPx, Math.min(sdf.width, sdf.height) / 2));
  return { kind: 1, radiusPx: r, width: sdf.width, height: sdf.height };
}

export class CompositionPass extends RenderPass {
  readonly name = 'composition';
  override get writes() {
    return [EffectPass.activeColorTarget, LAYER_TARGET, BLUR_TARGET1, BLUR_TARGET2];
  }
  override readonly after = ['background'];

  execute(ctx: RenderPassContext): void {
    const { scene, viewport, services } = ctx;
    const visible = viewport.visibleWorldRect;
    
    // We maintain a buffer of commands for the main surface.
    const mainCmds = new CommandBuffer();

    const flushMain = () => {
      if (mainCmds.length === 0) return;
      const enc = beginViewportPass(ctx, this.name, writeAttachment(ctx, EffectPass.activeColorTarget));
      services.quad.execute(enc, mainCmds);
      enc.end();
      mainCmds.clear();
    };

    for (const r of scene.renderables) {
      if (!Rect.intersects(visible, r.bounds) || r.opacity <= 0) continue;

      const hasEffects = r.effects && r.effects.length > 0;
      
      const isSolid = r.kind === 'rect' || r.kind === 'path' || r.kind === 'group';
      const isTextured = r.kind === 'image' || r.kind === 'video' || r.kind === 'text';

      if (!hasEffects) {
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
            emitTextured(
              mainCmds,
              mvpFor(viewport, r.modelMatrix),
              r.color ?? Color.white(),
              r.opacity,
              r.blend,
              tex.texture,
              services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
              r.uvRect ?? { x: 0, y: 0, width: 1, height: 1 },
              r.colorMatrix
            );
          }
        }
        continue;
      }

      // Has effects! We must draw to offscreen target, process, and composite.
      flushMain();

      // 1. Draw layer to LAYER_TARGET
      const layerCmds = new CommandBuffer();
      if (r.maskTextureKey) {
        const maskTex = services.textures.get(r.maskTextureKey);
        if (maskTex) {
          let tex = isTextured && r.textureKey ? services.textures.get(r.textureKey) : undefined;
          if (isSolid && !tex) tex = services.textures.get('texture:white'); // Or placeholder
          if (tex) {
            emitMaskedTextured(
              layerCmds,
              mvpFor(viewport, r.modelMatrix),
              r.color ?? Color.white(),
              1,
              'normal',
              tex.texture,
              services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
              maskTex.texture,
              r.uvRect ?? { x: 0, y: 0, width: 1, height: 1 },
              r.colorMatrix
            );
          }
        }
      } else if (isSolid && r.color) {
        emitSolid(layerCmds, mvpFor(viewport, r.modelMatrix), r.color, 1, 'normal', toSolidShape(r.sdf));
      } else if (isTextured && r.textureKey) {
        const tex = services.textures.get(r.textureKey);
        if (tex) {
          emitTextured(
            layerCmds,
            mvpFor(viewport, r.modelMatrix),
            r.color ?? Color.white(),
            1,
            'normal',
            tex.texture,
            services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
            r.uvRect ?? { x: 0, y: 0, width: 1, height: 1 },
            r.colorMatrix
          );
        }
      }

      if (layerCmds.length === 0) continue;

      const encLayer = beginViewportPass(ctx, 'layer', writeAttachment(ctx, LAYER_TARGET, Color.transparent()));
      services.quad.execute(encLayer, layerCmds);
      encLayer.end();

      const layerTex = ctx.services.backend.renderTargetTexture(ctx.target(LAYER_TARGET)!);
      if (!layerTex) continue;

      // Now process each effect
      for (const effect of r.effects!) {
        if (effect.type === 'blur' || effect.type === 'glow' || effect.type === 'drop-shadow') {
          const rPx = effect.radiusPx;
          if (rPx <= 0) continue;

          // Horizontal blur (LAYER_TARGET -> BLUR_TARGET1)
          const blur1Cmds = new CommandBuffer();
          blur1Cmds.add({
            batchKey: 'blur|normal',
            material: BLUR_MATERIAL,
            blend: 'normal',
            uniforms: packBlur(
              mvpFor(viewport, modelFromRect({ x: 0, y: 0, width: viewport.pixelSize.width, height: viewport.pixelSize.height })),
              { x: 0, y: 0, width: 1, height: 1 },
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
              mvpFor(viewport, modelFromRect({ x: 0, y: 0, width: viewport.pixelSize.width, height: viewport.pixelSize.height })),
              { x: 0, y: 0, width: 1, height: 1 },
              0, 1.0 / viewport.pixelSize.height, rPx
            ),
            texture: blur1Tex,
            sampler: services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
          });
          const encBlur2 = beginViewportPass(ctx, 'blurV', writeAttachment(ctx, BLUR_TARGET2, Color.transparent()));
          services.quad.execute(encBlur2, blur2Cmds);
          encBlur2.end();

          const blur2Tex = ctx.services.backend.renderTargetTexture(ctx.target(BLUR_TARGET2)!);
          if (!blur2Tex) continue;

          // Composite to SURFACE
          if (effect.type === 'blur') {
            emitTextured(
              mainCmds,
              mvpFor(viewport, modelFromRect({ x: 0, y: 0, width: viewport.pixelSize.width, height: viewport.pixelSize.height })),
              Color.white(), r.opacity, r.blend, blur2Tex,
              services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
              { x: 0, y: 0, width: 1, height: 1 }
            );
          } else if (effect.type === 'glow') {
            // Add glow
            emitTextured(
              mainCmds,
              mvpFor(viewport, modelFromRect({ x: 0, y: 0, width: viewport.pixelSize.width, height: viewport.pixelSize.height })),
              effect.color ?? Color.fromHex('rgba(120,180,255,0.9)'), r.opacity, 'screen', blur2Tex,
              services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
              { x: 0, y: 0, width: 1, height: 1 }
            );
            // Add original layer
            emitTextured(
              mainCmds,
              mvpFor(viewport, modelFromRect({ x: 0, y: 0, width: viewport.pixelSize.width, height: viewport.pixelSize.height })),
              Color.white(), r.opacity, r.blend, layerTex,
              services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
              { x: 0, y: 0, width: 1, height: 1 }
            );
          } else if (effect.type === 'drop-shadow') {
            // Add shadow
            const offX = effect.offsetX;
            const offY = effect.offsetY;
            emitTextured(
              mainCmds,
              mvpFor(viewport, modelFromRect({ x: offX, y: offY, width: viewport.pixelSize.width, height: viewport.pixelSize.height })),
              effect.color ?? Color.fromHex('rgba(0,0,0,0.55)'), r.opacity, 'normal', blur2Tex,
              services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
              { x: 0, y: 0, width: 1, height: 1 }
            );
            // Add original layer
            emitTextured(
              mainCmds,
              mvpFor(viewport, modelFromRect({ x: 0, y: 0, width: viewport.pixelSize.width, height: viewport.pixelSize.height })),
              Color.white(), r.opacity, r.blend, layerTex,
              services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
              { x: 0, y: 0, width: 1, height: 1 }
            );
          }
        } else if (effect.type === 'gradient-ramp') {
            const rampCmds = new CommandBuffer();
            rampCmds.add({
              batchKey: 'ramp', material: GRADIENT_RAMP_MATERIAL, blend: r.blend,
              uniforms: packGradientRamp(mvpFor(viewport, modelFromRect({ x: 0, y: 0, width: viewport.pixelSize.width, height: viewport.pixelSize.height })), { x: 0, y: 0, width: 1, height: 1 }, [effect.colorA || Color.white(), effect.colorB || Color.black()], [0, 0, 1, 1], effect.blend),
              texture: layerTex, sampler: services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
            });
            const enc = beginViewportPass(ctx, 'ramp', writeAttachment(ctx, SURFACE));
            services.quad.execute(enc, rampCmds);
            enc.end();
          } else if (effect.type === 'fractal-noise') {
            const fnCmds = new CommandBuffer();
            fnCmds.add({
              batchKey: 'noise', material: FRACTAL_NOISE_MATERIAL, blend: r.blend,
              uniforms: packFractalNoise(mvpFor(viewport, modelFromRect({ x: 0, y: 0, width: viewport.pixelSize.width, height: viewport.pixelSize.height })), { x: 0, y: 0, width: 1, height: 1 }, effect.scale, 0, 0, 4),
              texture: layerTex, sampler: services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
            });
            const enc = beginViewportPass(ctx, 'noise', writeAttachment(ctx, SURFACE));
            services.quad.execute(enc, fnCmds);
            enc.end();
          } else if (effect.type === 'displacement-map') {
            const dmCmds = new CommandBuffer();
            dmCmds.add({
              batchKey: 'displace', material: DISPLACEMENT_MAP_MATERIAL, blend: r.blend,
              uniforms: packDisplacementMap(mvpFor(viewport, modelFromRect({ x: 0, y: 0, width: viewport.pixelSize.width, height: viewport.pixelSize.height })), { x: 0, y: 0, width: 1, height: 1 }, effect.amount / viewport.pixelSize.width, effect.amount / viewport.pixelSize.height),
              texture: layerTex, sampler: services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
              maskTexture: layerTex, // Ideally this would be the displacement map source texture
            });
            const enc = beginViewportPass(ctx, 'displace', writeAttachment(ctx, SURFACE));
            services.quad.execute(enc, dmCmds);
            enc.end();
          } else if (effect.type === 'motion-tile') {
            const mtCmds = new CommandBuffer();
            mtCmds.add({
              batchKey: 'motiontile', material: MOTION_TILE_MATERIAL, blend: r.blend,
              uniforms: packMotionTile(mvpFor(viewport, modelFromRect({ x: 0, y: 0, width: viewport.pixelSize.width, height: viewport.pixelSize.height })), { x: 0, y: 0, width: 1, height: 1 }, effect.scale, effect.scale, 0, 0),
              texture: layerTex, sampler: services.resources.sampler('linear-repeat', { min: 'linear', mag: 'linear', addressU: 'repeat', addressV: 'repeat' }),
            });
            const enc = beginViewportPass(ctx, 'motiontile', writeAttachment(ctx, SURFACE));
            services.quad.execute(enc, mtCmds);
            enc.end();
          }

      }
    }
    
    flushMain();
  }
}
