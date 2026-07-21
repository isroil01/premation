import { Color } from '../../core/math/Color';
import { Rect } from '../../core/math/geometry';
import type { Renderable, RenderableEffect, RenderableSdf } from '../../scene/FrameScene';
import type { SolidShape } from '../../pipeline/uniforms';
import type { TextureHandle } from '../../gpu/types';
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

/** Offscreen targets for isolated precomps, one per nesting depth. A precomp's
 *  subtree renders into its depth's target and is composited (as one unit)
 *  before any sibling can reuse the slot, so one target per depth suffices.
 *  Deeper nesting degrades gracefully to the inline-collapse fast path. */
export const PRECOMP_TARGETS = ['precomp-target-0', 'precomp-target-1', 'precomp-target-2', 'precomp-target-3'] as const;
export const MAX_PRECOMP_DEPTH = PRECOMP_TARGETS.length;

function toSolidShape(sdf: RenderableSdf | undefined): SolidShape | undefined {
  if (!sdf) return undefined;
  if (sdf.shape === 'ellipse') return { kind: 2, radiusPx: 0, width: sdf.width, height: sdf.height };
  const r = Math.max(0, Math.min(sdf.radiusPx, Math.min(sdf.width, sdf.height) / 2));
  return { kind: 1, radiusPx: r, width: sdf.width, height: sdf.height };
}

/** Per-list rendering state: which colour target composites land in (the scene
 *  target at the top level, a precomp target inside an isolated group), plus
 *  the batched main command buffer and the sibling lookup for mattes /
 *  displacement maps. */
interface ListState {
  out: string;
  depth: number;
  mainCmds: CommandBuffer;
  flushMain: () => void;
  byId: ReadonlyMap<string, Renderable>;
}

export class CompositionPass extends RenderPass {
  readonly name = 'composition';
  override get writes() {
    return [EffectPass.activeColorTarget, LAYER_TARGET, BLUR_TARGET1, BLUR_TARGET2, MATTE_TARGET, ...PRECOMP_TARGETS];
  }
  override readonly after = ['background'];

  /** Offscreen textures of isolated precomps rendered THIS frame, keyed by the
   *  renderable's `precomp:<id>` textureKey. Registered by
   *  prepareIsolatedPrecomp and resolved by texFor, so a prepared container
   *  flows through the ordinary textured-layer machinery (blend / matte /
   *  effects) with no special cases. Cleared every execute. */
  private readonly precompTex = new Map<string, TextureHandle>();

  /** Resolve a renderable's colour texture: frame-local precomp targets first,
   *  then the app texture provider. */
  private texFor(ctx: RenderPassContext, key: string | undefined): { texture: TextureHandle } | null {
    if (!key) return null;
    const pre = this.precompTex.get(key);
    if (pre) return { texture: pre };
    return ctx.services.textures.get(key);
  }

  /** Build the draw commands for one renderable (solid / textured / masked / LUT)
   *  at the given opacity. Used to render a matte source and matted layer to
   *  offscreen targets, and (with model/blend overrides) to accumulate
   *  motion-blur sub-frame samples additively. */
  private renderableCmds(
    ctx: RenderPassContext,
    r: Renderable,
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
      let tex = isTextured && r.textureKey ? this.texFor(ctx, r.textureKey) : undefined;
      if (isSolid && !tex) tex = services.textures.get('texture:white');
      if (maskTex && tex) emitMaskedTextured(cmds, mvp, r.color ?? Color.white(), opacity, blend, tex.texture, smp(), maskTex.texture, uv, r.colorMatrix);
    } else if (isSolid && r.color) {
      emitSolid(cmds, mvp, r.color, opacity, blend, toSolidShape(r.sdf));
    } else if (isTextured && r.textureKey) {
      const tex = this.texFor(ctx, r.textureKey);
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
    byId: ReadonlyMap<string, Renderable>,
    mapLayerId: string | undefined,
    selfId: string,
  ): TextureHandle | null {
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

  /**
   * Run a spatial-effects chain over `inputTex`, ping-ponging between the pool
   * of offscreen targets (`pool[0]` must be the target `inputTex` lives in).
   * Returns the final texture and the target it lives in. Shared by the
   * adjustment-layer branch and layerIntoTarget (matte / advanced-blend
   * processing), so a matted or advanced-blended layer runs the SAME effect
   * pipeline as an ordinary one.
   */
  private runEffectsChain(
    ctx: RenderPassContext,
    effects: readonly RenderableEffect[],
    inputTex: TextureHandle,
    pool: readonly [string, string, string],
    byId: ReadonlyMap<string, Renderable>,
    selfId: string,
  ): { tex: TextureHandle; name: string } {
    const { viewport, services } = ctx;
    const targetUv = targetSampleUv(ctx);
    const mvp = screenMvp();
    const clampSampler = () => services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' });
    const texOf = (name: string): TextureHandle | null =>
      ctx.services.backend.renderTargetTexture(ctx.target(name)!) ?? null;

    let curTex = inputTex;
    let curName = pool[0];

    for (const effect of effects) {
      const free = pool.filter((n) => n !== curName) as [string, string];
      const f0 = free[0];
      const f1 = free[1];

      if (effect.type === 'blur' || effect.type === 'glow' || effect.type === 'drop-shadow') {
        const rPx = effect.radiusPx;
        // Zero radius/softness: the un-blurred layer IS the source (a hard glow
        // ring / hard-edged shadow) — never skip the composite.
        let blurredTex = curTex;
        if (rPx > 0) {
          // Horizontal (cur → f1)
          const blur1Cmds = new CommandBuffer();
          blur1Cmds.add({
            batchKey: 'blur|normal', material: BLUR_MATERIAL, blend: 'normal',
            uniforms: packBlur(mvp, targetUv, 1.0 / viewport.pixelSize.width, 0, rPx),
            texture: curTex, sampler: clampSampler(),
          });
          const encH = beginViewportPass(ctx, 'blurH', writeAttachment(ctx, f1, Color.transparent()));
          services.quad.execute(encH, blur1Cmds);
          encH.end();
          const hTex = texOf(f1);
          if (hTex) {
            // Vertical (f1 → f0). The composite below then writes f1 while
            // sampling the blurred result (f0) and the original (curName) —
            // all three distinct, so no target is read while written.
            const blur2Cmds = new CommandBuffer();
            blur2Cmds.add({
              batchKey: 'blur|normal', material: BLUR_MATERIAL, blend: 'normal',
              uniforms: packBlur(mvp, targetUv, 0, 1.0 / viewport.pixelSize.height, rPx),
              texture: hTex, sampler: clampSampler(),
            });
            const encV = beginViewportPass(ctx, 'blurV', writeAttachment(ctx, f0, Color.transparent()));
            services.quad.execute(encV, blur2Cmds);
            encV.end();
            const vTex = texOf(f0);
            if (vTex) blurredTex = vTex;
          }
        }
        // Composite into f1 (distinct from the blurred result in f0 and — for
        // rPx = 0 — from the original in curName, since f1 ≠ curName).
        const compCmds = new CommandBuffer();
        if (effect.type === 'blur') {
          emitTextured(compCmds, mvp, Color.white(), 1, 'normal', blurredTex, clampSampler(), targetUv);
        } else if (effect.type === 'glow') {
          emitTextured(compCmds, mvp, effect.color ?? Color.fromHex('rgba(120,180,255,0.9)'), 1, 'screen', blurredTex, clampSampler(), targetUv);
          emitTextured(compCmds, mvp, Color.white(), 1, 'normal', curTex, clampSampler(), targetUv);
        } else {
          const rect = {
            x: viewport.visibleWorldRect.x + effect.offsetX,
            y: viewport.visibleWorldRect.y + effect.offsetY,
            width: viewport.visibleWorldRect.width,
            height: viewport.visibleWorldRect.height,
          };
          emitTextured(compCmds, mvpFor(viewport, modelFromRect(rect)), effect.color ?? Color.fromHex('rgba(0,0,0,0.55)'), 1, 'normal', blurredTex, clampSampler(), targetUv);
          emitTextured(compCmds, mvp, Color.white(), 1, 'normal', curTex, clampSampler(), targetUv);
        }
        const encC = beginViewportPass(ctx, 'fx-comp', writeAttachment(ctx, f1, Color.transparent()));
        services.quad.execute(encC, compCmds);
        encC.end();
        const outTex = texOf(f1);
        if (outTex) { curTex = outTex; curName = f1; }
        continue;
      }

      // Single-pass effects: cur → f0.
      const cmds = new CommandBuffer();
      if (effect.type === 'gradient-ramp') {
        cmds.add({
          batchKey: 'ramp', material: GRADIENT_RAMP_MATERIAL, blend: 'normal',
          uniforms: packGradientRamp(mvp, targetUv, [effect.colorA || Color.white(), effect.colorB || Color.black()], [0, 0, 1, 1], effect.blend),
          texture: curTex, sampler: clampSampler(),
        });
      } else if (effect.type === 'fractal-noise') {
        cmds.add({
          batchKey: 'noise', material: FRACTAL_NOISE_MATERIAL, blend: 'normal',
          uniforms: packFractalNoise(mvp, targetUv, effect.scale, 0, 0, 4),
          texture: curTex, sampler: clampSampler(),
        });
      } else if (effect.type === 'displacement-map') {
        // The on-demand map render borrows MATTE_TARGET — only safe when the
        // matte target is not part of this chain's pool (it is during matte-
        // source processing, which then falls back to self-displacement).
        const canUseMap = !pool.includes(MATTE_TARGET);
        const mapTex = (canUseMap ? this.displacementMapTexture(ctx, byId, effect.mapLayerId, selfId) : null) ?? curTex;
        cmds.add({
          batchKey: 'displace', material: DISPLACEMENT_MAP_MATERIAL, blend: 'normal',
          uniforms: packDisplacementMap(mvp, targetUv, effect.amount / viewport.pixelSize.width, effect.amount / viewport.pixelSize.height),
          texture: curTex, sampler: clampSampler(),
          maskTexture: mapTex,
        });
      } else if (effect.type === 'motion-tile') {
        cmds.add({
          batchKey: 'motiontile', material: MOTION_TILE_MATERIAL, blend: 'normal',
          uniforms: packMotionTile(mvp, targetUv, effect.scale, effect.scale, 0, 0),
          texture: curTex, sampler: services.resources.sampler('linear-repeat', { min: 'linear', mag: 'linear', addressU: 'repeat', addressV: 'repeat' }),
        });
      } else if (effect.type === 'fill') {
        cmds.add({
          batchKey: 'fill', material: FILL_MATERIAL, blend: 'normal',
          uniforms: packFill(mvp, targetUv, effect.color),
          texture: curTex, sampler: clampSampler(),
        });
      } else if (effect.type === 'stroke') {
        cmds.add({
          batchKey: 'stroke', material: STROKE_MATERIAL, blend: 'normal',
          uniforms: packStroke(mvp, targetUv, effect.color, effect.widthPx, 1 / viewport.pixelSize.width, 1 / viewport.pixelSize.height),
          texture: curTex, sampler: clampSampler(),
        });
      } else if (effect.type === 'sharpen') {
        cmds.add({
          batchKey: 'sharpen', material: SHARPEN_MATERIAL, blend: 'normal',
          uniforms: packSharpen(mvp, targetUv, 1 / viewport.pixelSize.width, 1 / viewport.pixelSize.height, effect.amount),
          texture: curTex, sampler: clampSampler(),
        });
      } else if (effect.type === 'noise') {
        cmds.add({
          batchKey: 'noise', material: NOISE_MATERIAL, blend: 'normal',
          uniforms: packNoise(mvp, targetUv, effect.amount, effect.evolution, effect.monochrome),
          texture: curTex, sampler: clampSampler(),
        });
      }
      if (cmds.length === 0) continue;
      const enc = beginViewportPass(ctx, 'fx', writeAttachment(ctx, f0, Color.transparent()));
      services.quad.execute(enc, cmds);
      enc.end();
      const outTex = texOf(f0);
      if (outTex) { curTex = outTex; curName = f0; }
    }

    return { tex: curTex, name: curName };
  }

  /**
   * Render one layer — content, motion-blur sub-frame accumulation, AND its
   * full spatial-effects chain — into `dest`, returning the final texture
   * (always living in `dest`). This is what the matte and advanced-blend
   * branches route through, so a track-matted or advanced-blended layer keeps
   * its effects and motion blur instead of dropping them.
   */
  private layerIntoTarget(
    ctx: RenderPassContext,
    r: Renderable,
    opacity: number,
    dest: string,
    byId: ReadonlyMap<string, Renderable>,
  ): TextureHandle | null {
    const { services } = ctx;
    const cmds = new CommandBuffer();
    const hasMotion = !!(r.motionSamples && r.motionSamples.length > 1);
    if (hasMotion) {
      // Sub-frame samples accumulate ADDITIVELY at 1/n weight — the shutter-
      // interval mean, exactly the pattern the main (unmatted) branch uses.
      // Per-sample opacity is time-sampled and REPLACES the layer opacity.
      const samples = r.motionSamples!;
      const n = samples.length;
      for (const s of samples) this.renderableCmds(ctx, r, s.opacity / n, cmds, s.modelMatrix, 'add');
    } else {
      this.renderableCmds(ctx, r, opacity, cmds);
    }
    if (cmds.length === 0) return null;
    const enc = beginViewportPass(ctx, 'layer-src', writeAttachment(ctx, dest, Color.transparent()));
    services.quad.execute(enc, cmds);
    enc.end();
    let tex = ctx.services.backend.renderTargetTexture(ctx.target(dest)!);
    if (!tex) return null;

    if (r.effects && r.effects.length > 0) {
      const res = this.runEffectsChain(ctx, r.effects, tex, [dest, BLUR_TARGET1, BLUR_TARGET2], byId, r.id);
      if (res.name !== dest) {
        // Settle the result into `dest` so the caller's target contract holds
        // (scratch targets are reused immediately after).
        const clampSampler = services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' });
        const copy = new CommandBuffer();
        emitTextured(copy, screenMvp(), Color.white(), 1, 'none', res.tex, clampSampler, targetSampleUv(ctx));
        const encC = beginViewportPass(ctx, 'layer-settle', writeAttachment(ctx, dest, Color.transparent()));
        services.quad.execute(encC, copy);
        encC.end();
        tex = ctx.services.backend.renderTargetTexture(ctx.target(dest)!);
        if (!tex) return null;
      } else {
        tex = res.tex;
      }
    }
    return tex;
  }

  /**
   * Render an isolated precomp's subtree into its depth's offscreen target,
   * bake the container's own vector mask (when present), register the texture
   * under the container's `precomp:<id>` key, and return the container as a
   * plain full-viewport textured renderable — which then flows through the
   * ordinary per-layer machinery (blend / advanced blend / effects / matte),
   * compositing the whole group exactly like a single layer. FBO sampling uses
   * targetSampleUv, so the V-flip is per-backend correct.
   *
   * Beyond the depth cap: with `inlineFallback` the subtree collapses inline
   * (children × container opacity — the legacy behaviour), else null.
   */
  private prepareIsolatedPrecomp(
    ctx: RenderPassContext,
    r: Renderable,
    st: ListState,
    slot: number,
    inlineFallback: boolean,
  ): Renderable | null {
    const { services } = ctx;
    if (slot >= PRECOMP_TARGETS.length) {
      if (!inlineFallback) return null;
      st.flushMain();
      const folded = r.precomp!.renderables.map((c) => ({ ...c, opacity: c.opacity * r.opacity }));
      this.renderList(ctx, folded, st.out, st.depth);
      return null;
    }
    st.flushMain();
    const targetName = PRECOMP_TARGETS[slot]!;
    const targetUv = targetSampleUv(ctx);
    const clampSampler = () => services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' });

    // Clear, then render the subtree (nested precomps recurse into deeper slots).
    beginViewportPass(ctx, 'precomp-clear', writeAttachment(ctx, targetName, Color.transparent())).end();
    this.renderList(ctx, r.precomp!.renderables, targetName, slot + 1);
    let tex = ctx.services.backend.renderTargetTexture(ctx.target(targetName)!);
    if (!tex) return null;

    // Container mask: bake it into the offscreen (content × mask alpha) so the
    // composite — and any matte / blend / effects applied to it — sees
    // pre-masked pixels. The mask raster is placed at the container's box in
    // screen space, matte-combined, then settled back into the precomp target.
    if (r.maskTextureKey) {
      const maskRes = services.textures.get(r.maskTextureKey);
      if (maskRes) {
        const maskCmds = new CommandBuffer();
        emitTextured(maskCmds, mvpFor(ctx.viewport, r.modelMatrix), Color.white(), 1, 'normal', maskRes.texture, clampSampler());
        const encM = beginViewportPass(ctx, 'precomp-mask', writeAttachment(ctx, BLUR_TARGET1, Color.transparent()));
        services.quad.execute(encM, maskCmds);
        encM.end();
        const maskTex = ctx.services.backend.renderTargetTexture(ctx.target(BLUR_TARGET1)!);
        if (maskTex) {
          const combineCmds = new CommandBuffer();
          const alphaMode = { m: [0, 0, 0, 0, 0, 0, 0, 0, 0], offset: [0, 0, 0] };
          emitMatteCombine(combineCmds, screenMvp(), 'none', tex, clampSampler(), maskTex, alphaMode, targetUv);
          const encX = beginViewportPass(ctx, 'precomp-masked', writeAttachment(ctx, BLUR_TARGET2, Color.transparent()));
          services.quad.execute(encX, combineCmds);
          encX.end();
          const masked = ctx.services.backend.renderTargetTexture(ctx.target(BLUR_TARGET2)!);
          if (masked) {
            const copyCmds = new CommandBuffer();
            emitTextured(copyCmds, screenMvp(), Color.white(), 1, 'none', masked, clampSampler(), targetUv);
            const encC = beginViewportPass(ctx, 'precomp-settle', writeAttachment(ctx, targetName, Color.transparent()));
            services.quad.execute(encC, copyCmds);
            encC.end();
            tex = ctx.services.backend.renderTargetTexture(ctx.target(targetName)!) ?? tex;
          }
        }
      }
    }

    if (r.textureKey) this.precompTex.set(r.textureKey, tex);

    // The offscreen holds the subtree in SCREEN space (rendered with this
    // viewport's camera), so the composite quad covers the visible world rect
    // and samples the whole target with the backend-correct UV.
    const fullModel = modelFromRect(ctx.viewport.visibleWorldRect);
    const { maskTextureKey: _mask, precomp: _pre, sdf: _sdf, deformedMesh: _mesh, ...rest } = r;
    void _mask; void _pre; void _sdf; void _mesh;
    return {
      ...rest,
      kind: 'image',
      modelMatrix: fullModel,
      bounds: ctx.viewport.visibleWorldRect,
      uvRect: targetUv,
      color: Color.white(),
    };
  }

  execute(ctx: RenderPassContext): void {
    this.precompTex.clear();
    this.renderList(ctx, ctx.scene.renderables, EffectPass.activeColorTarget, 0);
  }

  /** Render a paint-ordered renderable list into `out` (the scene colour target
   *  at depth 0, a precomp target when isolating a nested comp). */
  private renderList(ctx: RenderPassContext, renderables: ReadonlyArray<Renderable>, out: string, depth: number): void {
    const { services } = ctx;
    const mainCmds = new CommandBuffer();
    const flushMain = () => {
      if (mainCmds.length === 0) return;
      const enc = beginViewportPass(ctx, this.name, writeAttachment(ctx, out));
      services.quad.execute(enc, mainCmds);
      enc.end();
      mainCmds.clear();
    };
    const st: ListState = {
      out,
      depth,
      mainCmds,
      flushMain,
      byId: new Map(renderables.map((r) => [r.id, r] as const)),
    };
    for (const r of renderables) this.processRenderable(ctx, r, st);
    flushMain();
  }

  private processRenderable(ctx: RenderPassContext, r0: Renderable, st: ListState): void {
    const { viewport, services } = ctx;
    const visible = viewport.visibleWorldRect;
    // Backend-correct UV for sampling offscreen targets (V-flip on WebGL2 only).
    const targetUv = targetSampleUv(ctx);
    const { mainCmds, flushMain, byId } = st;
    const clampSampler = () => services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' });

    // A matte source is consumed by its matted layer (rendered on demand into
    // MATTE_TARGET below) — never drawn to the scene directly.
    if (r0.matteSource) return;

    // Isolated precomp: render its subtree offscreen and continue as a plain
    // textured renderable — every branch below (matte, advanced blend, effects,
    // motion blur, direct draw) then composites the group as one unit.
    let r = r0;
    if (r0.precomp) {
      if (!Rect.intersects(visible, r0.bounds) || r0.opacity <= 0) return;
      const prepared = this.prepareIsolatedPrecomp(ctx, r0, st, st.depth, true);
      if (!prepared) return;
      r = prepared;
    }

    if (r.matte) {
      // Track matte: render the matted layer and its matte source to full-comp
      // targets — through the FULL layer pipeline (motion-blur accumulation +
      // spatial effects), so a matted layer keeps its blur/glow/shadow — then
      // combine (source alpha/luma → matted alpha). Composited over the scene
      // with the matted layer's own blend.
      const rawSource = byId.get(r.matte.sourceId);
      if (rawSource) {
        flushMain();
        // Matted layer first: its displacement-map (if any) borrows
        // MATTE_TARGET, which the source render below then overwrites.
        const mattedTex = this.layerIntoTarget(ctx, r, r.opacity, LAYER_TARGET, byId);
        // The source renders through the same pipeline (its own effects and
        // motion blur shape the matte, matching a real comp's pixels). A
        // precomp source is isolated into the NEXT depth slot — the current
        // one may already hold this very layer's texture.
        const source = rawSource.precomp
          ? this.prepareIsolatedPrecomp(ctx, rawSource, st, st.depth + 1, false)
          : rawSource;
        const matteTex = source ? this.layerIntoTarget(ctx, source, 1, MATTE_TARGET, byId) : null;
        if (matteTex && mattedTex) {
          const luma = r.matte.mode === 'luma' ? 1 : 0;
          const inv = r.matte.inverted ? 1 : 0;
          const mode = { m: [luma, inv, 0, 0, 0, 0, 0, 0, 0], offset: [0, 0, 0] };
          emitMatteCombine(mainCmds, screenMvp(), r.blend, mattedTex, clampSampler(), matteTex, mode, targetUv);
        }
        return;
      }
      // No source resolved — fall through and draw the layer normally.
    }

    if (r.adjustment) {
      // Adjustment layer: re-composite everything drawn so far through the
      // grade. Only works when the current out target is samplable (the scene
      // colour target at depth 0 — snapshotToFrameScene sets hasEffects so it
      // is — or a precomp target inside an isolated group, always samplable).
      flushMain();
      const sceneTarget = ctx.target(st.out);
      const sceneTex = sceneTarget ? ctx.services.backend.renderTargetTexture(sceneTarget) : null;
      if (!sceneTex) return; // target is the SURFACE (not samplable) — skip
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
      if (!belowTex) return;

      // 2. If there are spatial effects, run the shared effects chain over the
      //    graded copy, then write the result back as the new scene.
      const effects = r.effects;
      let finalTex = belowTex;
      if (effects && effects.length > 0) {
        const res = this.runEffectsChain(ctx, effects, belowTex, [LAYER_TARGET, BLUR_TARGET1, BLUR_TARGET2], byId, r.id);
        finalTex = res.tex;
      }
      const applyCmds = new CommandBuffer();
      // finalTex is an offscreen target — sample with the backend-correct UV.
      // (An identity UV here vertically flipped the whole scene on WebGL
      // whenever a grade-only adjustment layer took this branch.)
      emitTextured(applyCmds, mvp, Color.white(), 1, 'normal', finalTex, clampSampler(), targetUv);
      const encGrade = beginViewportPass(ctx, 'adjust-apply', writeAttachment(ctx, st.out, Color.transparent()));
      services.quad.execute(encGrade, applyCmds);
      encGrade.end();
      return;
    }

    if (!Rect.intersects(visible, r.bounds) || r.opacity <= 0) return;

    if (r.advancedBlend && r.advancedBlend > 0) {
      // Advanced blend (overlay/hard-light/HSL/…): fixed-function GL can't do
      // these — composite the layer against the accumulated backdrop through
      // the BLEND_COMBINE shader. Needs a samplable out target
      // (snapshotToFrameScene forces hasEffects when any advanced blend exists;
      // precomp targets are always samplable).
      flushMain();
      const sceneTarget = ctx.target(st.out);
      const sceneTex = sceneTarget ? ctx.services.backend.renderTargetTexture(sceneTarget) : null;
      if (sceneTex) {
        const full = targetUv;
        const fullMvp = screenMvp();
        // 1. render the layer — WITH motion-blur accumulation and its effect
        //    chain (both were dropped here before) — to LAYER_TARGET.
        //    (Done before the backdrop copy: the effect chain's displacement-
        //    map render borrows MATTE_TARGET, where the backdrop lives.)
        const layerTex = this.layerIntoTarget(ctx, r, r.opacity, LAYER_TARGET, byId);
        // 2. copy backdrop out (can't sample a target while writing it).
        const copyCmds = new CommandBuffer();
        emitTextured(copyCmds, fullMvp, Color.white(), 1, 'normal', sceneTex, clampSampler(), full);
        const encCopy = beginViewportPass(ctx, 'blend-backdrop', writeAttachment(ctx, MATTE_TARGET, Color.transparent()));
        services.quad.execute(encCopy, copyCmds);
        encCopy.end();
        const backdropTex = ctx.services.backend.renderTargetTexture(ctx.target(MATTE_TARGET)!);
        // 3. combine (src=layer, dst=backdrop) → OVERWRITE the out target.
        if (backdropTex && layerTex) {
          const mode = { m: [r.advancedBlend, 0, 0, 0, 0, 0, 0, 0, 0], offset: [0, 0, 0] };
          const combineCmds = new CommandBuffer();
          emitBlendCombine(combineCmds, fullMvp, 'none', layerTex, clampSampler(), backdropTex, mode, full);
          const encOut = beginViewportPass(ctx, 'blend-combine', writeAttachment(ctx, st.out));
          services.quad.execute(encOut, combineCmds);
          encOut.end();
        }
        return;
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
      // Direct to the out target
      if (r.maskTextureKey) {
        const maskTex = services.textures.get(r.maskTextureKey);
        if (maskTex) {
          let tex = isTextured && r.textureKey ? this.texFor(ctx, r.textureKey) : undefined;
          if (isSolid && !tex) tex = services.textures.get('texture:white'); // Or placeholder
          if (tex) {
            emitMaskedTextured(
              mainCmds,
              mvpFor(viewport, r.modelMatrix),
              r.color ?? Color.white(),
              r.opacity,
              r.blend,
              tex.texture,
              clampSampler(),
              maskTex.texture,
              r.uvRect ?? { x: 0, y: 0, width: 1, height: 1 },
              r.colorMatrix
            );
          }
        }
      } else if (isSolid && r.color) {
        emitSolid(mainCmds, mvpFor(viewport, r.modelMatrix), r.color, r.opacity, r.blend, toSolidShape(r.sdf));
      } else if (isTextured && r.textureKey) {
        const tex = this.texFor(ctx, r.textureKey);
        if (tex) {
          const smp = clampSampler();
          const uv = r.uvRect ?? { x: 0, y: 0, width: 1, height: 1 };
          const lut = r.lutTextureKey ? services.textures.get(r.lutTextureKey) : undefined;
          if (lut) {
            // Levels/Curves/Posterize on the GPU: remap through the LUT texture
            // after the affine grade (the second sampler the binding fix enabled).
            emitLutTextured(mainCmds, mvpFor(viewport, r.modelMatrix), r.color ?? Color.white(), r.opacity, r.blend, tex.texture, smp, lut.texture, uv, r.colorMatrix);
          } else {
            emitLayerTexture(ctx, r, { texture: tex.texture, sampler: smp, uv }, r.opacity, mainCmds);
          }
        }
      }
      return;
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

    if (layerCmds.length === 0) return;

    const encLayer = beginViewportPass(ctx, 'layer', writeAttachment(ctx, LAYER_TARGET, Color.transparent()));
    services.quad.execute(encLayer, layerCmds);
    encLayer.end();

    const layerTex = ctx.services.backend.renderTargetTexture(ctx.target(LAYER_TARGET)!);
    if (!layerTex) return;

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
      return;
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
            sampler: clampSampler(),
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
            sampler: clampSampler(),
          });
          const encBlur2 = beginViewportPass(ctx, 'blurV', writeAttachment(ctx, BLUR_TARGET2, Color.transparent()));
          services.quad.execute(encBlur2, blur2Cmds);
          encBlur2.end();

          const blurred = ctx.services.backend.renderTargetTexture(ctx.target(BLUR_TARGET2)!);
          if (!blurred) continue;
          blur2Tex = blurred;
        }

        // Composite to the out target
        if (effect.type === 'blur') {
          emitTextured(
            mainCmds,
            screenMvp(),
            Color.white(), r.opacity, r.blend, blur2Tex,
            clampSampler(),
            targetUv
          );
        } else if (effect.type === 'glow') {
          // Add glow
          emitTextured(
            mainCmds,
            screenMvp(),
            effect.color ?? Color.fromHex('rgba(120,180,255,0.9)'), r.opacity, 'screen', blur2Tex,
            clampSampler(),
            targetUv
          );
          // Add original layer
          emitTextured(
            mainCmds,
            screenMvp(),
            Color.white(), r.opacity, r.blend, layerTex,
            clampSampler(),
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
            clampSampler(),
            targetUv
          );
          // Add original layer
          emitTextured(
            mainCmds,
            screenMvp(),
            Color.white(), r.opacity, r.blend, layerTex,
            clampSampler(),
            targetUv
          );
        }
      } else if (effect.type === 'gradient-ramp') {
        const rampCmds = new CommandBuffer();
        rampCmds.add({
          batchKey: 'ramp', material: GRADIENT_RAMP_MATERIAL, blend: r.blend,
          uniforms: packGradientRamp(screenMvp(), targetUv, [effect.colorA || Color.white(), effect.colorB || Color.black()], [0, 0, 1, 1], effect.blend),
          texture: layerTex, sampler: clampSampler(),
        });
        const enc = beginViewportPass(ctx, 'ramp', writeAttachment(ctx, st.out));
        services.quad.execute(enc, rampCmds);
        enc.end();
      } else if (effect.type === 'fractal-noise') {
        const fnCmds = new CommandBuffer();
        fnCmds.add({
          batchKey: 'noise', material: FRACTAL_NOISE_MATERIAL, blend: r.blend,
          uniforms: packFractalNoise(screenMvp(), targetUv, effect.scale, 0, 0, 4),
          texture: layerTex, sampler: clampSampler(),
        });
        const enc = beginViewportPass(ctx, 'noise', writeAttachment(ctx, st.out));
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
          texture: layerTex, sampler: clampSampler(),
          maskTexture: mapTex,
        });
        const enc = beginViewportPass(ctx, 'displace', writeAttachment(ctx, st.out));
        services.quad.execute(enc, dmCmds);
        enc.end();
      } else if (effect.type === 'motion-tile') {
        const mtCmds = new CommandBuffer();
        mtCmds.add({
          batchKey: 'motiontile', material: MOTION_TILE_MATERIAL, blend: r.blend,
          uniforms: packMotionTile(screenMvp(), targetUv, effect.scale, effect.scale, 0, 0),
          texture: layerTex, sampler: services.resources.sampler('linear-repeat', { min: 'linear', mag: 'linear', addressU: 'repeat', addressV: 'repeat' }),
        });
        const enc = beginViewportPass(ctx, 'motiontile', writeAttachment(ctx, st.out));
        services.quad.execute(enc, mtCmds);
        enc.end();
      } else if (effect.type === 'fill') {
        const fillCmds = new CommandBuffer();
        fillCmds.add({
          batchKey: 'fill', material: FILL_MATERIAL, blend: r.blend,
          uniforms: packFill(screenMvp(), targetUv, effect.color),
          texture: layerTex, sampler: clampSampler(),
        });
        const enc = beginViewportPass(ctx, 'fill', writeAttachment(ctx, st.out));
        services.quad.execute(enc, fillCmds);
        enc.end();
      } else if (effect.type === 'stroke') {
        const strokeCmds = new CommandBuffer();
        strokeCmds.add({
          batchKey: 'stroke', material: STROKE_MATERIAL, blend: r.blend,
          uniforms: packStroke(screenMvp(), targetUv, effect.color, effect.widthPx, 1 / viewport.pixelSize.width, 1 / viewport.pixelSize.height),
          texture: layerTex, sampler: clampSampler(),
        });
        const enc = beginViewportPass(ctx, 'stroke', writeAttachment(ctx, st.out));
        services.quad.execute(enc, strokeCmds);
        enc.end();
      } else if (effect.type === 'sharpen') {
        const sharpCmds = new CommandBuffer();
        sharpCmds.add({
          batchKey: 'sharpen', material: SHARPEN_MATERIAL, blend: r.blend,
          uniforms: packSharpen(screenMvp(), targetUv, 1 / viewport.pixelSize.width, 1 / viewport.pixelSize.height, effect.amount),
          texture: layerTex, sampler: clampSampler(),
        });
        const enc = beginViewportPass(ctx, 'sharpen', writeAttachment(ctx, st.out));
        services.quad.execute(enc, sharpCmds);
        enc.end();
      } else if (effect.type === 'noise') {
        const noiseCmds = new CommandBuffer();
        noiseCmds.add({
          batchKey: 'noise', material: NOISE_MATERIAL, blend: r.blend,
          uniforms: packNoise(screenMvp(), targetUv, effect.amount, effect.evolution, effect.monochrome),
          texture: layerTex, sampler: clampSampler(),
        });
        const enc = beginViewportPass(ctx, 'noise', writeAttachment(ctx, st.out));
        services.quad.execute(enc, noiseCmds);
        enc.end();
      }
    }
  }
}
