import { Color } from '../../core/math/Color';
import { Mat3 } from '../../core/math/Mat3';
import { Rect } from '../../core/math/geometry';
import { depthEligible3D, type Renderable, type RenderableEffect, type RenderableSdf } from '../../scene/FrameScene';
import type { SolidShape, Shade3D } from '../../pipeline/uniforms';
import type { TextureHandle } from '../../gpu/types';
import { RenderPass, type RenderPassContext } from '../RenderPass';
import { beginViewportPass, beginSizedPass, emitSolid, emitTextured, emitSilhouette, emitMaskedTextured, emitLutTextured, emitMatteCombine, emitBlendCombine, modelFromRect, mvpFor, writeAttachment, emitLayerTexture, screenMvp, targetSampleUv, mvp3dFor, emitSolid3D, emitTextured3D, emitMaskedTextured3D } from './passUtils';
import { BLUR_MATERIAL, GLASS_MATERIAL, GRADIENT_RAMP_MATERIAL, FRACTAL_NOISE_MATERIAL, DISPLACEMENT_MAP_MATERIAL, COMPOUND_BLUR_MATERIAL, APPLY_COLOR_LUT_MATERIAL, SET_MATTE_MATERIAL, MOTION_TILE_MATERIAL, FILL_MATERIAL, STROKE_MATERIAL, SHARPEN_MATERIAL, NOISE_MATERIAL, BEAM_MATERIAL, BEND_MATERIAL, BEVEL_ALPHA_MATERIAL, BEVEL_EDGES_MATERIAL, SPOTLIGHT_MATERIAL, SPHERE_MATERIAL, CYLINDER_MATERIAL, ARITHMETIC_MATERIAL } from '../../shaders/Material';
import { packBlur, packGlass, packGradientRamp, packFractalNoise, packDisplacementMap, packCompoundBlur, packApplyColorLut, packSetMatte, packMotionTile, packFill, packStroke, packSharpen, packNoise, packBeam, packBend, packPerspective, packSpotlight, packArithmetic, packPluginEffect } from '../../pipeline/uniforms';
import { CommandBuffer } from '../../commands/DrawCommand';
import type { MaterialDescriptor } from '../../shaders/Material';
import { EffectPass } from './EffectPass';

/**
 * ── PER-LAYER ORDER OF OPERATIONS ────────────────────────────────────
 *
 * Written down here because it was never stated anywhere and is not what most
 * people assume. For ONE layer, in this order:
 *
 *   1. content — the layer's own pixels (solid SDF, or its texture)
 *   2. mask — baked into the texture (CPU) or applied as a mask
 *                         sample during the content draw
 *   3. TRANSFORM — `renderableCmds` draws through `r.modelMatrix`, so
 *                         the layer lands in SCREEN space here
 *   4. motion blur — sub-frame samples accumulate additively, each with
 *                         its own transform
 *   5. effects — `applyLayerEffects` → `runEffectsChain`, operating on
 *                         the SCREEN-SPACE texture from step 3
 *   6. layer styles — appended to the same effects list by buildSnapshot,
 *                         so they run at the end of step 5
 *   7. matte / blend — composited against the layers beneath
 *
 * The consequence worth knowing: EFFECTS RUN AFTER TRANSFORM, not before. A
 * blur radius, a glow size and a drop-shadow distance are all in SCREEN pixels
 * (`RenderableEffect.radiusPx`), so they do NOT scale or rotate with the layer.
 * Scaling a layer to 200% does not double its shadow's blur.
 *
 * The one exception is the CPU-bake path: effects with no GPU shader form
 * (`isCanvas2dOnlyEffect` — Beam, Keylight, warps, interior styles, …) are
 * baked into the layer's texture in LOCAL space, i.e. before transform, and
 * therefore DO scale with it. Fill / Stroke / Sharpen / Noise have GPU
 * materials and run after transform like blur/glow. That split is intentional.
 */
export const LAYER_TARGET = 'layer-target';
export const BLUR_TARGET1 = 'blur-target1';
export const BLUR_TARGET2 = 'blur-target2';
/** Extra ping-pong slot for multi-lobe optical bloom (glow core / wide). */
export const BLUR_TARGET3 = 'blur-target3';
export const MATTE_TARGET = 'matte-target';
/**
 * Half-resolution ping-pong targets for the backdrop blur behind frosted glass.
 *
 * The blur is a fixed 61-tap kernel whose spacing widens with the radius, so
 * its cost is per-PIXEL, not per-radius: blurring at half resolution is four
 * times cheaper for exactly the same visual radius. Nobody can tell — the
 * output of a large-radius blur has no high-frequency content left to lose,
 * which is precisely why every real-time implementation downsamples first.
 *
 * The copy-down and the blurs happen here; the upsample is free, because the
 * composite samples this texture through a linear sampler at full size.
 */
export const BACKDROP_HALF1 = 'backdrop-half1';
export const BACKDROP_HALF2 = 'backdrop-half2';

/** Downsample factor for the backdrop blur chain. */
export const BACKDROP_DOWNSCALE = 2;

/**
 * Ping-pong targets for DOWNSAMPLED plugin effect passes.
 *
 * A plugin pass may declare `scale: 0.5` or `0.25`, which is what makes a bloom
 * affordable: the expensive blur runs on a quarter or a sixteenth of the
 * pixels, and the upsample costs nothing because whatever samples the result
 * next reads the smaller texture through a linear sampler. Exactly the trick
 * the backdrop blur above already uses, generalised so a plugin can ask for it.
 *
 * Two per scale, because consecutive passes at the SAME scale must ping-pong —
 * a separable blur at quarter scale is two draws and they cannot share one
 * target. Full scale keeps using the existing `BLUR_TARGET*` pool, so only the
 * fractional sizes are new here.
 */
export const PLUGIN_HALF1 = 'plugin-half1';
export const PLUGIN_HALF2 = 'plugin-half2';
export const PLUGIN_QUARTER1 = 'plugin-quarter1';
export const PLUGIN_QUARTER2 = 'plugin-quarter2';

/** Every scaled plugin target, for the graph's declaration list. */
export const PLUGIN_SCALED_TARGETS = [
  PLUGIN_HALF1, PLUGIN_HALF2, PLUGIN_QUARTER1, PLUGIN_QUARTER2,
] as const;

/**
 * A copy of a plugin chain's pass-0 input, held for the whole chain.
 *
 * `reads: "origin"` is what every composite effect needs — a bloom's last pass
 * adds the blurred copy back over the ORIGINAL, and by then the original is
 * three ping-pongs ago and overwritten.
 *
 * Its own target rather than a reservation out of the effect pool, which is
 * what made this look expensive before. Borrowing from the pool would contend
 * with the slot glow takes for its wide lobe, and would mean a chain's legal
 * length depended on which other effects were on the layer — a plugin that
 * worked alone and broke when a user added a glow beneath it.
 *
 * Written only when a chain actually asks. Declared always, because the graph
 * resolves targets once per frame and a target that appeared on demand would
 * allocate mid-frame.
 */
export const PLUGIN_ORIGIN = 'plugin-origin';

/**
 * The ping-pong pair for a pass scale, or null at full scale.
 *
 * Null rather than "the full-size pair", so the caller has to notice which
 * case it is in. A full-scale pass picks from the CHAIN's own pool — which
 * differs between the ordinary route, the matte-borrowing one and the
 * adjustment-layer one — and handing back a fixed pair here would quietly take
 * that choice away from it.
 */
export function scaledPluginTargets(scale: number): readonly [string, string] | null {
  if (scale === 0.5) return [PLUGIN_HALF1, PLUGIN_HALF2];
  if (scale === 0.25) return [PLUGIN_QUARTER1, PLUGIN_QUARTER2];
  return null;
}

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

/**
 * The buffer an effect chain is running in, when it is NOT screen space.
 *
 * Effect sizes (blur radius, shadow offset, stroke width) are comp px, and the
 * chain converts them to texels. In the 2D route the buffer IS the screen, so
 * the conversion is the identity and no space is passed. The 3D route resolves
 * a layer's chain in the LAYER's own space, where the scale depends on the
 * layer's size — see resolveEffect3DTexture.
 */
interface FxSpace {
  /** Texels per comp px, horizontally. */
  pxToTexelX: number;
  /** Texels per comp px, vertically. */
  pxToTexelY: number;
  /** Where the layer sits in the buffer, [0,1] — the 3D route insets it by the
   *  effect margin, so it is not the whole buffer. */
  box: Rect;
}

/**
 * How far outside its own rectangle a layer's effect chain reaches, in comp px.
 *
 * Drives the margin reserved around a 3D layer's effect resolve. Deliberately
 * generous for blur-like effects: the shader treats the radius as a Gaussian
 * SIGMA and samples to ±2.5σ, so a margin of one radius would clip the tail
 * into a visible straight edge.
 */
function effectSpreadPx(effects: readonly RenderableEffect[]): number {
  let max = 0;
  for (const e of effects) {
    let s = 0;
    if (e.type === 'blur') s = e.radiusPx * BLUR_TAIL;
    else if (e.type === 'glow') s = e.radiusPx * BLUR_TAIL;
    else if (e.type === 'drop-shadow') s = Math.hypot(e.offsetX, e.offsetY) + e.radiusPx * BLUR_TAIL;
    else if (e.type === 'stroke') s = e.widthPx;
    else if (e.type === 'displacement-map') s = e.amount;
    // The MAX, because the margin has to hold wherever the map happens to be
    // bright. Reserving the average would clip exactly the pixels the effect
    // was pointed at.
    else if (e.type === 'compound-blur') s = e.maxRadiusPx * BLUR_TAIL;
    /*
      A plugin effect answers for itself, or asks for nothing.

      Without this branch every plugin fell through to 0, so a plugin glow on a
      3D layer was clipped flat at the layer's edge while the built-in one
      beside it bled correctly — and only on 3D layers, because the 2D route
      runs its chain over a viewport-sized buffer and has room to spare.

      The number is computed app-side from the effect's live parameters (see
      `effectSpreadFor`), which is what makes an animated radius reserve the
      margin it needs on the frame it needs it. This package still learns
      nothing about plugins: it receives pixels of reach, like every branch
      above.
    */
    else if (e.type === 'plugin') s = e.spreadPx ?? 0;
    if (s > max) max = s;
  }
  return max;
}

/** Gaussian extent the blur shader actually samples, in radii. */
/**
 * Material descriptors for plugin effects, memoised by shader name.
 *
 * Built lazily rather than declared, because unlike every other material in
 * this file the SET of them is not known until plugins are installed. Memoised
 * because a descriptor is compared by identity downstream when deciding whether
 * a pipeline can be reused — a fresh object per frame would rebuild the
 * pipeline on every frame, for every plugin effect in the document.
 *
 * The layout is the standard effect one: uniform, texture, sampler. A plugin
 * effect is not a new kind of pass.
 */
const pluginMaterials = new Map<string, MaterialDescriptor>();
function pluginMaterial(shader: string, readsMap: boolean, readsOrigin: boolean): MaterialDescriptor {
  let m = pluginMaterials.get(shader);
  if (!m) {
    m = {
      shader,
      topology: 'triangle-list',
      layout: [
        { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
        { binding: 1, type: 'texture', stages: ['fragment'] },
        { binding: 2, type: 'sampler', stages: ['fragment'] },
        /*
          The fourth binding, for effects that sample a second texture.

          Declared from what the SHADER asks for, never from whether a map
          layer happens to be chosen: the generated WGSL contains
          `@binding(3)` as soon as the effect declares a layer parameter, and a
          layout that omits it is an invalid pipeline for every such effect in
          its default state.

          Safe to cache by `shader` alone even though this now takes a second
          argument — `readsMap` is a property of the effect, fixed by its
          manifest, so the same shader name cannot arrive both ways. It changes
          only when the plugin is updated, which re-registers the shader.
        */
        ...(readsMap
          ? [{ binding: 3, type: 'texture' as const, stages: ['fragment' as const] }]
          : []),
        /*
          Binding 4: the pass-0 input, for a pass declaring `reads: origin`.

          Fixed at 4 whether or not 3 is in use, matching what
          `composeEffectShader` emits. Sliding it down when no layer parameter
          is declared would make the binding number depend on an unrelated part
          of the manifest, and this side and the shader generator would each
          have to reach that conclusion separately — two derivations of one
          number is how a bind group points a shader at the wrong texture.
          WebGPU numbers bindings; it does not require them contiguous.
        */
        ...(readsOrigin
          ? [{ binding: 4, type: 'texture' as const, stages: ['fragment' as const] }]
          : []),
      ],
    };
    pluginMaterials.set(shader, m);
  }
  return m;
}

const BLUR_TAIL = 2.5;

/** Margin ceiling, as a fraction of the layer's own size per side. Past this
 *  the content would be squeezed into too few texels to stay sharp; a huge glow
 *  on a tiny layer gets a clipped tail rather than a mushy layer. */
const MAX_FX_MARGIN = 1.5;

/**
 * Grow a unit-quad model matrix about the quad's CENTRE by (ex, ey).
 *
 * The matrix maps [0,1]² onto the layer's plane, so the centre is (0.5, 0.5)
 * in its own space and the scale has to be conjugated by that translation —
 * scaling in place would slide the plane by half the growth.
 */
function expandUnitQuadModel(model: readonly number[], ex: number, ey: number): readonly number[] {
  const m = Array.from(model);
  // Columns 0 and 1 are the width and height edges; scale them, then pull the
  // origin (column 3) back by the half-edge each one gained.
  for (let i = 0; i < 3; i++) {
    const cx = m[i]! * ex;
    const cy = m[4 + i]! * ey;
    m[12 + i] = m[12 + i]! - (cx - m[i]!) * 0.5 - (cy - m[4 + i]!) * 0.5;
    m[i] = cx;
    m[4 + i] = cy;
  }
  return m;
}

/**
 * Ramp endpoints for the gradient shader, from an angle in degrees.
 *
 * The shader parameterises by `dot(uv − p0, p1 − p0)`, so the two points are
 * the ends of the ramp in the SAMPLED UV space. They were hardcoded to
 * `[0,0,1,1]` — the box diagonal — which meant the Gradient Ramp effect's Angle
 * control, and the Gradient Overlay layer style that compiles to it, moved
 * nothing at all.
 *
 * Convention matches a gradient FILL (0° = left→right, 90° = top→bottom) so the
 * same number means the same direction wherever a user types it. The span is
 * `(|dx| + |dy|)/2` about the centre, again matching `makeCanvasGradient`, so
 * the ramp covers the whole box at every angle instead of running short on the
 * diagonals.
 *
 * `uv` carries the backend's V orientation: WebGL2 samples render targets
 * bottom-up, so its V axis runs opposite to the screen's and a "downward" ramp
 * has to flip with it, or the two backends disagree by a mirror.
 */
function rampPoints(
  angleDeg: number | undefined,
  uv: Rect,
  /** Where the LAYER sits in the buffer, [0,1], screen-oriented (V down). */
  box: Rect,
  /** Buffer size in px — the ramp's span is an angled projection of the box, so
   *  the two axes have to be compared in the same units. */
  size: { width: number; height: number },
): [number, number, number, number] {
  const a = ((angleDeg ?? 90) * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  // Project the box onto the axis so the ramp spans it fully at any angle —
  // the same rule makeCanvasGradient uses, in px.
  const wPx = box.width * size.width;
  const hPx = box.height * size.height;
  const half = (Math.abs(dx) * wPx + Math.abs(dy) * hPx) / 2;
  const cx = (box.x + box.width / 2) * size.width;
  const cy = (box.y + box.height / 2) * size.height;
  const toUv = (px: number, py: number): [number, number] => {
    const u = px / size.width;
    const v = py / size.height;
    // WebGL2 samples render targets bottom-up, so its V axis runs opposite to
    // the screen's; without this the two backends mirror each other.
    return [u, uv.height < 0 ? 1 - v : v];
  };
  const [u0, v0] = toUv(cx - dx * half, cy - dy * half);
  const [u1, v1] = toUv(cx + dx * half, cy + dy * half);
  return [u0, v0, u1, v1];
}

/**
 * Where a renderable sits in the viewport, as a [0,1] rect.
 *
 * A layer effect is a function of the LAYER's box — a Gradient Ramp runs from
 * one edge of the layer to the other. The chain runs in a viewport-sized
 * buffer, though, so without this the ramp spanned the whole SCREEN and the
 * layer showed whatever slice of it happened to fall behind it. Falls back to
 * the full buffer when there is nothing to measure, which is the old behaviour.
 */
/** Fraction of the path the beam's tail trails behind its head. Mirrors
 *  `applyBeam`'s `tailLen` — the two must agree or the CPU and GPU beams are
 *  different lengths, which no tolerance would forgive. */
const BEAM_TAIL = 0.35;

function renderableBox(ctx: RenderPassContext, r: Renderable | undefined): Rect {
  const vwr = ctx.viewport.visibleWorldRect;
  if (!r || vwr.width <= 0 || vwr.height <= 0) return { x: 0, y: 0, width: 1, height: 1 };
  return {
    x: (r.bounds.x - vwr.x) / vwr.width,
    y: (r.bounds.y - vwr.y) / vwr.height,
    width: r.bounds.width / vwr.width,
    height: r.bounds.height / vwr.height,
  };
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
    return [EffectPass.activeColorTarget, LAYER_TARGET, BLUR_TARGET1, BLUR_TARGET2, BLUR_TARGET3, MATTE_TARGET, ...PRECOMP_TARGETS];
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
    // AE's per-layer Quality switch. 'draft' samples NEAREST — being visibly
    // rougher and cheaper IS the feature. Cached under its own resource key so
    // the two samplers coexist instead of thrashing one slot.
    const smp = () => (r.sampling === 'nearest'
      ? services.resources.sampler('nearest-clamp', { min: 'nearest', mag: 'nearest', addressU: 'clamp', addressV: 'clamp' })
      : services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }));
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
    /** Ping-pong targets. Need ≥3 (cur + 2 scratch); a 4th enables optical
     *  bloom's wide lobe (BLUR_TARGET3). */
    pool: readonly [string, string, string, ...string[]],
    byId: ReadonlyMap<string, Renderable>,
    selfId: string,
    space?: FxSpace,
  ): { tex: TextureHandle; name: string } {
    const { viewport, services } = ctx;
    const targetUv = targetSampleUv(ctx);
    const mvp = screenMvp();
    // Comp px → target texels. The 2D route feeds the chain a SCREEN-space
    // buffer where one comp px is one texel, so it passes no space and every
    // formula below stays byte-for-byte what it was. The 3D route feeds it a
    // LAYER-space buffer whose scale is set by the layer's own size, so its
    // radii and offsets have to be converted or a shadow comes out a fraction
    // of the size it was asked for.
    const kx = space?.pxToTexelX ?? 1;
    const ky = space?.pxToTexelY ?? 1;
    // Box-relative effects (the gradient ramp) need the LAYER's extent, not the
    // buffer's. The 3D route states it (its buffer is layer space plus a
    // margin); the 2D route measures the renderable against the viewport.
    const fxBox = space?.box ?? renderableBox(ctx, byId.get(selfId));
    const clampSampler = () => services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' });
    const texOf = (name: string): TextureHandle | null =>
      ctx.services.backend.renderTargetTexture(ctx.target(name)!) ?? null;

    let curTex = inputTex;
    let curName = pool[0];

    for (const effect of effects) {
      const free = pool.filter((n) => n !== curName);
      const f0 = free[0];
      const f1 = free[1];
      // Need two scratch targets to blur; without them skip the spatial pass.
      if (!f0 || !f1) continue;

      /*
        The scale this draw runs at. 1 for everything except a plugin pass that
        declared otherwise.

        Read once, here, because three places downstream need to agree about
        it: the uniform's `texelSize`, which target the draw lands in, and the
        viewport that draw is given. Recomputing it at each would be three
        chances to disagree, and disagreeing produces a quarter-size image in a
        full-size target rather than an error.
      */
      const pluginPassScale = effect.type === 'plugin' ? (effect.passScale ?? 1) : 1;

      /*
        Snapshot the chain's input, for a chain that will want it back.

        `capturesOrigin` is set by the app on pass 0 of any chain whose later
        passes declare `reads: origin` — decided there because only that side
        knows how the flat list of scene entries groups into chains. Copying
        unconditionally would cost a full-screen blit per plugin effect on
        every frame, for the majority of chains that never look at it.

        A blit rather than remembering the target name: `curTex` at this moment
        belongs to the ping-pong pool and will be drawn over within two passes.
        A reference to it would be a reference to whatever the chain last
        wrote — the "random picture" this feature was refused for.
      */
      if (effect.type === 'plugin' && effect.capturesOrigin) {
        const originCmds = new CommandBuffer();
        emitTextured(originCmds, mvp, Color.white(), 1, 'normal', curTex, clampSampler(), targetUv);
        const encO = beginViewportPass(
          ctx, 'fx-origin', writeAttachment(ctx, PLUGIN_ORIGIN, Color.transparent()),
        );
        services.quad.execute(encO, originCmds);
        encO.end();
      }
      // Optional third slot (BLUR_TARGET3) for optical bloom's wide lobe.

      if (effect.type === 'blur' || effect.type === 'glow' || effect.type === 'drop-shadow') {
        // Glow gets a slightly wider mid kernel; the wide lobe (below) is a
        // separate pass into BLUR_TARGET3 so optical bloom has real falloff.
        const rPx = effect.type === 'glow' ? effect.radiusPx * 1.15 : effect.radiusPx;
        // Zero radius/softness: the un-blurred layer IS the source (a hard glow
        // ring / hard-edged shadow) — never skip the composite.
        let blurredTex = curTex;
        let wideTex: TextureHandle | null = null;
        if (rPx > 0) {
          // Horizontal (cur → f1)
          const blur1Cmds = new CommandBuffer();
          blur1Cmds.add({
            batchKey: 'blur|normal', material: BLUR_MATERIAL, blend: 'normal',
            uniforms: packBlur(mvp, targetUv, 1.0 / viewport.pixelSize.width, 0, rPx * kx),
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
              uniforms: packBlur(mvp, targetUv, 0, 1.0 / viewport.pixelSize.height, rPx * ky),
              texture: hTex, sampler: clampSampler(),
            });
            const encV = beginViewportPass(ctx, 'blurV', writeAttachment(ctx, f0, Color.transparent()));
            services.quad.execute(encV, blur2Cmds);
            encV.end();
            const vTex = texOf(f0);
            if (vTex) blurredTex = vTex;
          }

          // Optical wide lobe: second separable blur at ~2.2× into the third
          // free target (BLUR_TARGET3). Only when the pool has it and the glow
          // is large enough to read the difference.
          const f2 = free[2] as string | undefined;
          if (effect.type === 'glow' && f2 && rPx >= 6) {
            const wideR = rPx * 2.2;
            const wH = new CommandBuffer();
            wH.add({
              batchKey: 'blur|normal', material: BLUR_MATERIAL, blend: 'normal',
              uniforms: packBlur(mvp, targetUv, 1.0 / viewport.pixelSize.width, 0, wideR * kx),
              texture: curTex, sampler: clampSampler(),
            });
            const encWH = beginViewportPass(ctx, 'glowWideH', writeAttachment(ctx, f1, Color.transparent()));
            services.quad.execute(encWH, wH);
            encWH.end();
            const whTex = texOf(f1);
            if (whTex) {
              const wV = new CommandBuffer();
              wV.add({
                batchKey: 'blur|normal', material: BLUR_MATERIAL, blend: 'normal',
                uniforms: packBlur(mvp, targetUv, 0, 1.0 / viewport.pixelSize.height, wideR * ky),
                texture: whTex, sampler: clampSampler(),
              });
              const encWV = beginViewportPass(ctx, 'glowWideV', writeAttachment(ctx, f2, Color.transparent()));
              services.quad.execute(encWV, wV);
              encWV.end();
              wideTex = texOf(f2);
            }
          }
        }
        // Composite into f1 (distinct from the blurred result in f0 and — for
        // rPx = 0 — from the original in curName, since f1 ≠ curName).
        const compCmds = new CommandBuffer();
        if (effect.type === 'blur') {
          emitTextured(compCmds, mvp, Color.white(), 1, 'normal', blurredTex, clampSampler(), targetUv);
        } else if (effect.type === 'glow') {
          // emitSilhouette, not emitTextured: the glow is the blurred ALPHA
          // filled with the glow colour. Tinting instead returned
          // layerRGB × glowRGB — see silhouetteOf in shaders/builtin.ts.
          //
          // Two-lobe optical bloom: a wide soft pedestal (when the pool has a
          // third slot) under the mid halo. Reads as light rather than as a
          // CSS ring.
          //
          // The mid lobe is emitted ONCE. It used to go out twice, at 0.7 and
          // then 1.0, described as "mid halo + bright core" — but both draws
          // sampled the SAME blurred texture, so it was not a core, just the
          // one halo screened over itself. Screen is not idempotent, so that
          // roughly doubled the strength of every glow in every existing
          // project. A real core would need a third, tighter blur.
          const glowColor = effect.color ?? Color.fromHex('rgba(120,180,255,0.9)');
          if (wideTex) {
            emitSilhouette(compCmds, mvp, glowColor, 0.4, 'screen', wideTex, clampSampler(), targetUv);
          }
          emitSilhouette(compCmds, mvp, glowColor, 1, 'screen', blurredTex, clampSampler(), targetUv);
          emitTextured(compCmds, mvp, Color.white(), 1, 'normal', curTex, clampSampler(), targetUv);
        } else {
          // The shadow copy is the whole buffer shifted. In screen space that
          // is the visible world rect translated by the offset; in layer space
          // there is no world rect to translate, so the same shift is expressed
          // as a fraction of the buffer (offset in texels ÷ buffer size).
          const shadowMvp = space
            ? Mat3.multiply(mvp, modelFromRect({
                x: (effect.offsetX * kx) / viewport.pixelSize.width,
                y: (effect.offsetY * ky) / viewport.pixelSize.height,
                width: 1,
                height: 1,
              }))
            : mvpFor(viewport, modelFromRect({
                x: viewport.visibleWorldRect.x + effect.offsetX,
                y: viewport.visibleWorldRect.y + effect.offsetY,
                width: viewport.visibleWorldRect.width,
                height: viewport.visibleWorldRect.height,
              }));
          // Silhouette fill, for the same reason as the glow above. This one
          // LOOKED correct because the default shadow colour is black and black
          // is the absorbing element of a multiply — every non-black shadow
          // colour was returning layerRGB × shadowRGB.
          emitSilhouette(compCmds, shadowMvp, effect.color ?? Color.fromHex('rgba(0,0,0,0.55)'), 1, 'normal', blurredTex, clampSampler(), targetUv);
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
          uniforms: packGradientRamp(mvp, targetUv, [effect.colorA || Color.white(), effect.colorB || Color.black()], rampPoints(effect.angle, targetUv, fxBox, viewport.pixelSize), effect.blend),
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
          uniforms: packDisplacementMap(mvp, targetUv, (effect.amount * kx) / viewport.pixelSize.width, (effect.amount * ky) / viewport.pixelSize.height),
          texture: curTex, sampler: clampSampler(),
          maskTexture: mapTex,
        });
      } else if (effect.type === 'apply-color-lut') {
        /*
          The LUT strip comes from the texture PROVIDER, not from a renderable —
          so unlike its three siblings there is no map layer to resolve and no
          MATTE_TARGET to borrow.

          A missing strip SKIPS the effect rather than falling back. The others
          self-sample because a layer displaced or blurred by itself is visibly
          wrong and debuggable; there is no equivalent here. A LUT with no table
          is not a degraded grade, it is no grade — and the layer drawn unchanged
          is exactly what no grade looks like.
        */
        const strip = services.textures.get(effect.lutTextureKey);
        if (strip) {
          cmds.add({
            batchKey: `colorlut:${effect.lutTextureKey}`,
            material: APPLY_COLOR_LUT_MATERIAL,
            blend: 'normal',
            uniforms: packApplyColorLut(
              mvp, targetUv, effect.size, effect.is1d, effect.intensity,
              effect.domainMin, effect.domainMax,
            ),
            texture: curTex, sampler: clampSampler(),
            maskTexture: strip.texture,
          });
        }
      } else if (effect.type === 'compound-blur') {
        // Same borrow-MATTE_TARGET constraint and the same self-fallback as
        // displacement-map above — this is that family's third member.
        const canUseMap = !pool.includes(MATTE_TARGET);
        const mapTex = (canUseMap ? this.displacementMapTexture(ctx, byId, effect.mapLayerId, selfId) : null) ?? curTex;
        cmds.add({
          batchKey: 'compoundblur', material: COMPOUND_BLUR_MATERIAL, blend: 'normal',
          uniforms: packCompoundBlur(
            mvp, targetUv,
            // Comp px → texels of THIS buffer, the same `kx` conversion every
            // radius in this function makes. A 3D layer's buffer is scaled by
            // its own size, so an unconverted radius would blur a fraction of
            // what was asked for — the defect the DOF radii once had.
            effect.maxRadiusPx * kx,
            effect.invert,
            1 / viewport.pixelSize.width,
            1 / viewport.pixelSize.height,
          ),
          texture: curTex, sampler: clampSampler(),
          maskTexture: mapTex,
        });
      } else if (effect.type === 'set-matte') {
        // Same borrow-MATTE_TARGET constraint as displacement-map: the source
        // render needs a target, and MATTE_TARGET is only free when it is not
        // already part of this chain's pool. Unlike displacement-map there is no
        // sensible fallback — matting a layer by its own alpha is not a degraded
        // Set Matte, it is a different and wrong picture — so the effect is
        // SKIPPED when the source cannot be resolved, leaving the layer as it
        // was. That is also what an unset Matte Layer does.
        const matteTex = pool.includes(MATTE_TARGET)
          ? null
          : this.displacementMapTexture(ctx, byId, effect.matteLayerId, selfId);
        if (matteTex) {
          cmds.add({
            batchKey: 'setmatte', material: SET_MATTE_MATERIAL, blend: 'normal',
            uniforms: packSetMatte(mvp, targetUv, effect.useLuminance, effect.invert),
            texture: curTex, sampler: clampSampler(),
            maskTexture: matteTex,
          });
        }
      } else if (effect.type === 'bevel-alpha' || effect.type === 'bevel-edges') {
        // One branch for both: they differ only in WHICH edge they chisel, and
        // that lives in the shader. `p1.xy` is the texel size the alpha
        // gradient is sampled across — meaningless to Bevel Edges, which reads
        // no neighbours, and harmless to pack for it.
        cmds.add({
          batchKey: effect.type, blend: 'normal',
          material: effect.type === 'bevel-alpha' ? BEVEL_ALPHA_MATERIAL : BEVEL_EDGES_MATERIAL,
          uniforms: packPerspective(
            mvp, targetUv,
            [effect.thickness, Math.cos(effect.lightRad), Math.sin(effect.lightRad), effect.intensity],
            [1 / viewport.pixelSize.width, 1 / viewport.pixelSize.height, 0, 0],
            fxBox,
            effect.color,
          ),
          texture: curTex, sampler: clampSampler(),
        });
      } else if (effect.type === 'sphere') {
        cmds.add({
          batchKey: 'sphere', material: SPHERE_MATERIAL, blend: 'normal',
          uniforms: packPerspective(
            mvp, targetUv,
            [effect.radius, effect.rotXRad, effect.rotYRad, effect.shading],
            [effect.aspect, effect.rotZRad, 0, 0],
            fxBox,
            effect.color,
          ),
          // Clamped, not repeated: the shader wraps its own longitude with
          // `fract`, so the sampled u never leaves [0,1) and the address mode
          // is never reached. Repeating here would MASK a wrap bug instead of
          // letting it show as a seam.
          texture: curTex, sampler: clampSampler(),
        });
      } else if (effect.type === 'cylinder') {
        cmds.add({
          batchKey: 'cylinder', material: CYLINDER_MATERIAL, blend: 'normal',
          uniforms: packPerspective(
            mvp, targetUv,
            [effect.radius, effect.rotRad, effect.shading, 0],
            [0, 0, 0, 0],
            fxBox,
            effect.color,
          ),
          texture: curTex, sampler: clampSampler(),
        });
      } else if (effect.type === 'spotlight') {
        cmds.add({
          batchKey: 'spotlight', material: SPOTLIGHT_MATERIAL, blend: 'normal',
          uniforms: packSpotlight(
            mvp, targetUv,
            effect.fromX, effect.fromY, effect.toX, effect.toY,
            effect.coneHalfRad, effect.softness, effect.intensity, effect.ambient,
            effect.aspect, effect.lightOnly,
            fxBox,
            effect.color,
          ),
          texture: curTex, sampler: clampSampler(),
        });
      } else if (effect.type === 'arithmetic') {
        cmds.add({
          batchKey: 'arithmetic', material: ARITHMETIC_MATERIAL, blend: 'normal',
          uniforms: packArithmetic(mvp, targetUv, effect.operator, effect.r, effect.g, effect.b, effect.clip),
          texture: curTex, sampler: clampSampler(),
        });
      } else if (effect.type === 'bend') {
        cmds.add({
          batchKey: 'bend', material: BEND_MATERIAL, blend: 'normal',
          uniforms: packBend(
            mvp, targetUv,
            effect.angleRad, effect.style, effect.aspect, effect.holdOutside ? 1 : 0,
            effect.topX, effect.topY, effect.baseX, effect.baseY,
            // The LAYER's box within the chain buffer. On the 2D route that
            // buffer is SCREEN SPACE and the layer is a sub-rect of it, so
            // bending against `targetUv` bends the whole screen — which is
            // what it did. Same quantity the Beam branch resolves against,
            // for the same reason.
            fxBox,
          ),
          // Clamped, not repeated: the shader already returns transparent for
          // samples off the layer, so the address mode never comes into play —
          // and a repeat here would tile the layer into the empty region if the
          // bounds check were ever relaxed.
          texture: curTex, sampler: clampSampler(),
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
          uniforms: packStroke(mvp, targetUv, effect.color, effect.widthPx, kx / viewport.pixelSize.width, ky / viewport.pixelSize.height),
          texture: curTex, sampler: clampSampler(),
        });
      } else if (effect.type === 'sharpen') {
        cmds.add({
          batchKey: 'sharpen', material: SHARPEN_MATERIAL, blend: 'normal',
          uniforms: packSharpen(mvp, targetUv, 1 / viewport.pixelSize.width, 1 / viewport.pixelSize.height, effect.amount),
          texture: curTex, sampler: clampSampler(),
        });
      } else if (effect.type === 'beam') {
        /*
          Endpoints are fractions of the LAYER's box, so they resolve against
          `fxBox` — the same quantity the gradient ramp uses, and for the same
          reason: on the 2D route the chain's buffer is screen space and the
          layer is a sub-rect of it, so a fraction of the BUFFER would put the
          beam somewhere else entirely.

          Radii are comp px and convert through kx/ky. Non-square scaling would
          make a round cap elliptical, so the shader measures one distance and
          takes the mean scale — a beam at 45 degrees on a stretched buffer is
          a fraction of a texel off, which is invisible, where an elliptical
          cap is not.
        */
        const bx0 = fxBox.x + effect.startX * fxBox.width;
        const by0 = fxBox.y + effect.startY * fxBox.height;
        const bx1 = fxBox.x + effect.endX * fxBox.width;
        const by1 = fxBox.y + effect.endY * fxBox.height;
        // The head, and the tail trailing 35% of the path behind it — the
        // travelling pulse `applyBeam` draws.
        const t0 = Math.max(0, effect.length - BEAM_TAIL);
        const k = (kx / viewport.pixelSize.width + ky / viewport.pixelSize.height) / 2;
        const coreR = Math.max(0.5, effect.thickness) * 0.5 * k;
        cmds.add({
          batchKey: 'beam', material: BEAM_MATERIAL, blend: 'normal',
          uniforms: packBeam(
            mvp, targetUv,
            bx0 + (bx1 - bx0) * t0, by0 + (by1 - by0) * t0,
            bx0 + (bx1 - bx0) * effect.length, by0 + (by1 - by0) * effect.length,
            coreR, coreR * (1 + effect.softness * 3),
            k, // one comp px of antialiasing, in target UV
            effect.color,
          ),
          texture: curTex, sampler: clampSampler(),
        });
      } else if (effect.type === 'noise') {
        cmds.add({
          batchKey: 'noise', material: NOISE_MATERIAL, blend: 'normal',
          uniforms: packNoise(mvp, targetUv, effect.amount, effect.evolution, effect.monochrome),
          texture: curTex, sampler: clampSampler(),
        });
      } else if (effect.type === 'plugin') {
        /*
          A plugin effect is just another material, and this branch knows
          nothing about plugins: it takes a registered shader name and a
          pre-packed parameter block, and writes the transform header underneath.

          `batchKey` carries the shader NAME rather than a literal. Every other
          branch here names ONE material, so a constant is correct for them;
          this one names a family, and a shared key would batch two different
          plugin effects into one draw with one pipeline.
        */
        /*
          The optional second texture, resolved exactly as displacement-map's
          is: same helper, same borrow of MATTE_TARGET, same fallback.

          Falling back to `curTex` rather than to nothing matters. The material
          for an effect that DECLARED a layer parameter carries a fourth
          binding, and a declared binding with nothing bound is an invalid
          pipeline — a dead viewport, not a missing map. Self-sampling is the
          honest degradation and it is what the author sees before they have
          chosen a layer.
        */
        const canUseMap = !pool.includes(MATTE_TARGET);
        const pluginMapTex =
          (canUseMap ? this.displacementMapTexture(ctx, byId, effect.mapLayerId, selfId) : null)
          ?? curTex;
        /*
          The pass-0 input, for a pass that composites against it.

          Falls back to `curTex` if the snapshot is somehow unavailable, for
          exactly the reason the map binding does: the layout declares binding
          4 as soon as the shader asks for it, and a declared binding with
          nothing bound is an invalid pipeline — a dead viewport rather than a
          wrong picture. Self-sampling is the honest degradation.
        */
        const originTex = effect.readsOrigin ? (texOf(PLUGIN_ORIGIN) ?? curTex) : null;
        cmds.add({
          batchKey: `plugin:${effect.shader}`,
          material: pluginMaterial(effect.shader, effect.readsMap === true, effect.readsOrigin === true),
          blend: 'normal',
          /*
            The host pass block, written per draw.

            A multi-pass effect arrives as several of these entries in order and
            this loop already ping-pongs them, so nothing above needs to know a
            chain exists. What each pass DOES need is its own texel size — and
            for a downsampled pass that is the size of the SCALED target it is
            about to be drawn into, not the viewport.

            Getting this wrong is the quiet failure the whole feature turns on:
            a quarter-scale blur handed full-size texels steps a quarter as far
            as it should in target space, so it renders a blur a quarter the
            requested radius and looks merely "a bit soft" rather than broken.
          */
          uniforms: packPluginEffect(
            mvp,
            targetUv,
            effect.params,
            Math.max(1, Math.floor(viewport.pixelSize.width * pluginPassScale)),
            Math.max(1, Math.floor(viewport.pixelSize.height * pluginPassScale)),
            pluginPassScale,
            effect.passIndex ?? 0,
          ),
          texture: curTex, sampler: clampSampler(),
          // Keyed off `readsMap`, the SAME predicate the layout uses — never
          // off `mapLayerId`. Binding 3 is declared as soon as the shader asks
          // for it, so it must be filled then too, even with no layer chosen
          // (self-sampling via the `?? curTex` above).
          ...(effect.readsMap ? { maskTexture: pluginMapTex } : {}),
          // Same rule as `maskTexture`: keyed off what the SHADER declared, so
          // a declared binding is never left unfilled.
          ...(originTex ? { originTexture: originTex } : {}),
        });
      }
      if (cmds.length === 0) continue;
      /*
        Bracket the submit for device-loss attribution.

        This is the only place that knows a plugin effect is about to be drawn,
        and `onDraw` is injected by the app so this package still does not have
        to know what a plugin is. If the GPU dies inside `execute`, the handler
        the app registered names the effect that was in flight.

        `end` runs in a `finally`: a throw that skipped it would leave the marker
        set, and the NEXT device loss — possibly minutes later and caused by
        something else entirely — would be blamed on this effect.
      */
      /*
        FAIL-SAFE: an effect that produced no draw must not erase the layer.

        Every branch above ends in `cmds.add(...)`, and the pass below CLEARS
        its destination before executing them — so a step that added nothing
        leaves a transparent target, `curTex` becomes that, and the layer is
        gone. Not hypothetical; it has happened twice. Once when a duplicate
        effects chain did not recognise a type (a plugin effect erased the
        layer on both backends), and once when a WGSL validation error stopped
        the pipeline being created at all (Bend / Sphere / Cylinder sampling in
        non-uniform control flow — see wgslUniformControlFlow.test.ts).

        Skipping the pass leaves `curTex` on the previous step's output, so a
        broken effect degrades to a NO-OP. That is the right failure: the user
        sees an effect that does nothing and can remove it, rather than watching
        their artwork vanish with no clue which of ten stacked effects ate it.
        The cost is one integer compare per effect per frame.

        A backstop, not a licence — reaching here with no draw is still a bug,
        and the guards above exist to catch the known causes before they ship.
      */
      if (cmds.length === 0) continue;

      const marker = effect.type === 'plugin' ? effect.onDraw : undefined;
      marker?.begin();

      /*
        Where this draw lands, and how big it is.

        A plugin pass declaring `scale` renders into its own smaller pool
        instead of the chain's full-size one. `beginSizedPass` sets the
        viewport to the target's real dimensions — without it the draw would
        cover a quarter of a quarter-size target and the rest would stay
        transparent, which reads as the effect having eaten the layer.

        `dest` avoids the texture being READ this draw. Within a scaled pair
        that is the only constraint; the pair is two targets precisely so
        consecutive passes at one scale can alternate.
      */
      const pair = scaledPluginTargets(pluginPassScale);
      const dest = pair ? (pair[0] === curName ? pair[1] : pair[0]) : f0;
      const enc = pair
        ? beginSizedPass(
          ctx, 'fx', writeAttachment(ctx, dest, Color.transparent()),
          Math.max(1, Math.floor(viewport.pixelSize.width * pluginPassScale)),
          Math.max(1, Math.floor(viewport.pixelSize.height * pluginPassScale)),
        )
        : beginViewportPass(ctx, 'fx', writeAttachment(ctx, dest, Color.transparent()));
      try {
        services.quad.execute(enc, cmds);
      } finally {
        enc.end();
        marker?.end();
      }
      /*
        The upsample is free and this is where it happens — by not happening.

        `curTex` becomes the smaller texture, and the next draw samples it
        through `clampSampler`, which is linear. A full-scale pass reading a
        quarter-scale one therefore magnifies it on the way in, at no extra
        pass and no extra bandwidth. The same reason the backdrop blur can
        composite its half-size result straight over the scene.
      */
      const outTex = texOf(dest);
      if (outTex) { curTex = outTex; curName = dest; }
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
    const tex = ctx.services.backend.renderTargetTexture(ctx.target(dest)!);
    if (!tex) return null;
    return this.applyLayerEffects(ctx, r, tex, dest, byId);
  }

  /**
   * Run a layer's spatial-effects chain over `srcTex` (which must live in
   * `dest`) and SETTLE the result back into `dest`, returning its texture — so
   * the caller's "final texture lives in dest" contract holds and scratch
   * targets are free to reuse immediately after. A no-op (returns `srcTex`) when
   * the layer has no effects. Shared by layerIntoTarget (matte / advanced-blend
   * routing) and resolveEffect3DTexture (the depth-tested 3D group path), so a
   * matted, advanced-blended, OR 3D layer runs the identical effect pipeline.
   */
  private applyLayerEffects(
    ctx: RenderPassContext,
    r: Renderable,
    srcTex: TextureHandle,
    dest: string,
    byId: ReadonlyMap<string, Renderable>,
    space?: FxSpace,
  ): TextureHandle | null {
    if (!r.effects || r.effects.length === 0) return srcTex;
    const { services } = ctx;
    const res = this.runEffectsChain(ctx, r.effects, srcTex, [dest, BLUR_TARGET1, BLUR_TARGET2, BLUR_TARGET3], byId, r.id, space);
    if (res.name === dest) return res.tex;
    // Settle the result into `dest` (scratch targets are reused immediately after).
    const clampSampler = services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' });
    const copy = new CommandBuffer();
    emitTextured(copy, screenMvp(), Color.white(), 1, 'none', res.tex, clampSampler, targetSampleUv(ctx));
    const encC = beginViewportPass(ctx, 'layer-settle', writeAttachment(ctx, dest, Color.transparent()));
    services.quad.execute(encC, copy);
    encC.end();
    return ctx.services.backend.renderTargetTexture(ctx.target(dest)!) ?? null;
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

  // Depth-group eligibility lives in FrameScene.depthEligible3D — SHARED with
  // the snapshot adapter so the "who folds the light gain" decision and the
  // partitioning below can never disagree.

  /**
   * Draw a 3D layer's CONTENT (solid fill / texture / masked texture) FLAT into
   * the whole of the current target — the unit quad mapped to the full target
   * via screenMvp, so the layer occupies [0,1]² in "layer space" — at opacity 1,
   * blend normal, with its colour grade. This is the input the effect chain runs
   * over; the resolved texture is then sampled 1:1 by the depth-tested quad.
   * (No lighting/shade here — that is applied per-fragment on the resolved quad.)
   */
  private fill3DContentCmds(ctx: RenderPassContext, r: Renderable, inset?: Rect): CommandBuffer {
    const { services } = ctx;
    const cmds = new CommandBuffer();
    // `inset` places the content inside a MARGIN when the effect chain needs
    // room to spread outside the layer (see resolveEffect3DTexture). Absent =
    // the whole buffer, which is the effect-free geometry of this function.
    const mvp = inset ? Mat3.multiply(screenMvp(), modelFromRect(inset)) : screenMvp();
    const smp = () => services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' });
    const uv = r.uvRect ?? { x: 0, y: 0, width: 1, height: 1 };
    const isSolid = r.kind === 'rect' || r.kind === 'path' || r.kind === 'group';
    const isTextured = r.kind === 'image' || r.kind === 'video' || r.kind === 'text';
    if (r.maskTextureKey) {
      const maskTex = services.textures.get(r.maskTextureKey);
      let tex = isTextured && r.textureKey ? this.texFor(ctx, r.textureKey) : undefined;
      if (isSolid && !tex) tex = services.textures.get('texture:white');
      if (maskTex && tex) emitMaskedTextured(cmds, mvp, r.color ?? Color.white(), 1, 'normal', tex.texture, smp(), maskTex.texture, uv, r.colorMatrix);
    } else if (isSolid && r.color) {
      emitSolid(cmds, mvp, r.color, 1, 'normal', toSolidShape(r.sdf));
    } else if (isTextured && r.textureKey) {
      const tex = this.texFor(ctx, r.textureKey);
      const lut = r.lutTextureKey ? services.textures.get(r.lutTextureKey) : undefined;
      if (tex && lut) emitLutTextured(cmds, mvp, r.color ?? Color.white(), 1, 'normal', tex.texture, smp(), lut.texture, uv, r.colorMatrix);
      else if (tex) emitTextured(cmds, mvp, r.color ?? Color.white(), 1, 'normal', tex.texture, smp(), uv, r.colorMatrix);
    }
    return cmds;
  }

  /**
   * Pre-resolve an effect-laden 3D layer's effect chain into a single texture
   * (living in LAYER_TARGET), returning it together with the model matrix the
   * caller must draw it with. MUST run BEFORE (and outside) the depth pass —
   * you cannot sample a target you are writing. Null when there is no content.
   *
   * ── The margin, and why the result carries its own matrix ────────────
   *
   * The layer content used to be drawn across the WHOLE buffer, and the quad
   * then sampled that buffer 1:1. Both halves of that are wrong for any effect
   * that reaches OUTSIDE the layer's own rectangle — which is most of them:
   *
   *   • Nothing outside the rectangle survives. A drop shadow is the layer
   *     shifted and darkened; shifted within a buffer the layer already fills
   *     edge to edge, every pixel of it lands outside and is clipped, then the
   *     layer is drawn back over the rest. Outer glow blooms outward from the
   *     alpha edge, and a solid has no alpha edge inside the buffer to bloom
   *     from. So both rendered NOTHING on a 3D layer while rendering correctly
   *     on the same layer in 2D — flipping the 3D switch silently deleted them.
   *   • The radii were wrong even where something did survive. Blur, glow and
   *     shadow sizes are comp px, and the chain applies them in texels; with
   *     the layer stretched across the buffer a 140px-wide layer on a 1920px
   *     buffer shrank every radius by ~14×. Depth of field on a 3D layer is a
   *     `blur` effect and was under-blurred by the same factor.
   *
   * So: reserve a margin wide enough for the chain's outward spread, draw the
   * content inset by it, run the chain in that space with the px→texel scale it
   * implies, and hand the caller a model matrix EXPANDED by the same margin so
   * the wider texture lands on a correspondingly wider plane. The effect then
   * lives on the layer's own plane — it tilts, foreshortens, depth-tests and
   * lights with the layer, which is what a layer style on a 3D layer should do
   * (and what After Effects does: styles resolve in layer space, then the whole
   * result is transformed into 3D).
   */
  private resolveEffect3DTexture(
    ctx: RenderPassContext,
    r: Renderable,
    byId: ReadonlyMap<string, Renderable>,
  ): { tex: TextureHandle; model: readonly number[] } | null {
    const model = r.threeD!.model;
    // The layer's size in comp px: the model maps the unit quad onto its plane,
    // so its first two column vectors ARE the width and height edges.
    const worldW = Math.hypot(model[0]!, model[1]!, model[2]!) || 1;
    const worldH = Math.hypot(model[4]!, model[5]!, model[6]!) || 1;
    const spread = effectSpreadPx(r.effects!);

    // Margin as a fraction of the layer, per axis, capped so a small layer
    // under a large glow degrades to a soft-edged result instead of shrinking
    // its own content to a handful of texels.
    const fx = Math.min(spread / worldW, MAX_FX_MARGIN);
    const fy = Math.min(spread / worldH, MAX_FX_MARGIN);
    const ex = 1 + 2 * fx;
    const ey = 1 + 2 * fy;

    const cmds = this.fill3DContentCmds(ctx, r, { x: fx / ex, y: fy / ey, width: 1 / ex, height: 1 / ey });
    if (cmds.length === 0) return null;
    const enc = beginViewportPass(ctx, 'threed-fx-src', writeAttachment(ctx, LAYER_TARGET, Color.transparent()));
    ctx.services.quad.execute(enc, cmds);
    enc.end();
    const tex = ctx.services.backend.renderTargetTexture(ctx.target(LAYER_TARGET)!);
    if (!tex) return null;

    // One comp px spans this many texels of the padded buffer.
    const space: FxSpace = {
      pxToTexelX: ctx.viewport.pixelSize.width / (worldW * ex),
      pxToTexelY: ctx.viewport.pixelSize.height / (worldH * ey),
      // The content was drawn into this inset; the margin around it is the room
      // the effects spread into, and is not part of the layer.
      box: { x: fx / ex, y: fy / ey, width: 1 / ex, height: 1 / ey },
    };
    const out = this.applyLayerEffects(ctx, r, tex, LAYER_TARGET, byId, space);
    if (!out) return null;
    return { tex: out, model: expandUnitQuadModel(model, ex, ey) };
  }

  /**
   * Render a contiguous run of 3D renderables as depth-tested pass(es) into
   * `out` (which must be an offscreen target created with a depth buffer).
   * The run arrives back-to-front (buildSnapshot's painter sort), and we ALSO
   * depth-test/write — correct for the dominant case of intersecting opaque
   * planes, and the standard pragmatic compromise for semi-transparent ones
   * (documented limitation: mutually-overlapping semi-transparent planes
   * resolve per-pixel by depth, not by true per-fragment sorting).
   *
   * Effect-laden members (blur/glow/drop-shadow/…) are PRE-RESOLVED to a texture
   * in 2D layer space (resolveEffect3DTexture) and drawn as a textured3d quad,
   * so the effect result plane depth-tests / intersects / lights with its 3D
   * siblings. The resolve settles into LAYER_TARGET, so as soon as a queued draw
   * samples it we must flush the depth pass before the NEXT resolve overwrites
   * it; those extra flushes reuse the SAME depth buffer (cleared only on the
   * first sub-pass), so per-pixel intersection is preserved across them.
   */
  private render3DGroup(
    ctx: RenderPassContext,
    group: ReadonlyArray<Renderable>,
    out: string,
    byId: ReadonlyMap<string, Renderable>,
  ): void {
    const { viewport, services } = ctx;
    const camera3d = ctx.scene.camera3d!;
    const lights = ctx.scene.lights3d;
    const targetUv = targetSampleUv(ctx);
    const clampSampler = () => services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' });
    // Per-fragment Accepts-Lights shading: build the shade tail for renderables
    // that carry shade data, when the scene delivered lights. No eye (ortho
    // view) → specular is skipped but diffuse still runs per-fragment. No
    // scene lights at all → fall back to multiplying the CPU per-quad gain
    // into the tint, so lighting is never silently lost.
    const shadeFor = (r: Renderable): Shade3D | undefined => {
      const s = r.threeD?.shade;
      if (!s || !lights || lights.length === 0) return undefined;
      return {
        model: r.threeD!.model,
        eye: camera3d.eye ?? [0, 0, -1e6],
        specular: camera3d.eye ? s.specular : 0,
        shininess: s.shininess,
        ...(s.metal ? { metal: s.metal } : {}),
        // Carried explicitly, like `metal` above. This object is built
        // field-by-field from `r.threeD.shade`, so a field added to that type
        // and not named here is silently dropped — and for a depth-eligible
        // face the SHADER does the lighting, so dropping it means the layer
        // renders exactly as it did before, with the CPU-side gain that is
        // only a fallback still showing the new value. That is precisely how
        // `oneSided` came to be plumbed end-to-end, asserted at the snapshot,
        // and visible in no pixel.
        ...(s.oneSided ? { oneSided: true } : {}),
        lights,
      };
    };
    const litColor = (r: Renderable, c: Color, shaded: Shade3D | undefined): Color => {
      const g = r.threeD?.shade?.quadGain;
      if (shaded || !g) return c;
      return { r: c.r * g[0], g: c.g * g[1], b: c.b * g[2], a: c.a };
    };

    let cmds = new CommandBuffer();
    let depthCleared = false;
    // True when `cmds` holds a queued draw sampling the resolved-effect texture
    // in LAYER_TARGET — that draw must execute before LAYER_TARGET is reused.
    let pendingResolved = false;
    const flush = (): void => {
      if (cmds.length === 0) return;
      const enc = beginViewportPass(ctx, 'composition-3d', writeAttachment(ctx, out), depthCleared ? {} : { clearDepth: 1 });
      services.quad.execute(enc, cmds);
      enc.end();
      cmds = new CommandBuffer();
      depthCleared = true;
      pendingResolved = false;
    };

    for (const r of group) {
      if (r.opacity <= 0) continue;
      const mvp = mvp3dFor(viewport, camera3d, r.threeD!.model);
      const uv = r.uvRect ?? { x: 0, y: 0, width: 1, height: 1 };
      const isSolid = r.kind === 'rect' || r.kind === 'path' || r.kind === 'group';
      const isTextured = r.kind === 'image' || r.kind === 'video' || r.kind === 'text';
      const shade = shadeFor(r);

      if (r.effects && r.effects.length > 0) {
        // Free LAYER_TARGET first if a prior resolved draw still samples it.
        if (pendingResolved) flush();
        const resolved = this.resolveEffect3DTexture(ctx, r, byId);
        if (resolved) {
          // Drawn on the MARGIN-EXPANDED plane, not the layer's own — the
          // resolved texture is wider than the layer by whatever room its
          // effects needed, and sampling it onto the bare layer quad would
          // squeeze the shadow back inside the silhouette it just escaped.
          const fxMvp = mvp3dFor(viewport, camera3d, resolved.model);
          // Colour is baked into the resolved texture; the quad's tint is white
          // (or the per-quad light gain when no scene lights were delivered),
          // and shade lights the effect result per-fragment. The shade's own
          // model follows the expanded quad so its world positions match the
          // geometry actually being drawn.
          const fxShade = shade ? { ...shade, model: resolved.model } : undefined;
          const tint = litColor(r, Color.white(), fxShade);
          // Depth WRITE off: the quad is wider than the layer and its margin is
          // transparent, so writing depth there would punch a rectangular hole
          // through anything behind it — an extruded object's own side walls,
          // most visibly. It still depth-tests, so it is occluded correctly.
          emitTextured3D(cmds, fxMvp, tint, r.opacity, r.blend, resolved.tex, clampSampler(), targetUv, undefined, fxShade, false);
          pendingResolved = true;
        }
        continue;
      }

      const tint = litColor(r, r.color ?? Color.white(), shade);
      if (r.maskTextureKey) {
        const maskTex = services.textures.get(r.maskTextureKey);
        let tex = isTextured && r.textureKey ? this.texFor(ctx, r.textureKey) : undefined;
        if (isSolid && !tex) tex = services.textures.get('texture:white');
        if (maskTex && tex) {
          emitMaskedTextured3D(cmds, mvp, tint, r.opacity, r.blend, tex.texture, clampSampler(), maskTex.texture, uv, r.colorMatrix, shade);
        }
      } else if (isSolid && r.color) {
        emitSolid3D(cmds, mvp, tint, r.opacity, r.blend, toSolidShape(r.sdf), shade);
      } else if (isTextured && r.textureKey) {
        const tex = this.texFor(ctx, r.textureKey);
        // Known limitation: no LUT variant in the 3D material set — a 3D layer
        // carrying a colour LUT keeps its affine grade rows but skips the LUT
        // remap inside a depth group (rare combination).
        if (tex) emitTextured3D(cmds, mvp, tint, r.opacity, r.blend, tex.texture, clampSampler(), uv, r.colorMatrix, shade);
      }
    }
    flush();
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
    // 3D render groups need (a) the scene camera matrices and (b) an offscreen
    // out target (created with a depth buffer). On the raw surface there is no
    // guaranteed depth attachment — fall back to the CPU-affine path there
    // (the adapter routes 3D frames through the scene colour target anyway).
    const canDepthGroup = !!ctx.scene.camera3d && ctx.target(out) !== null;
    const visible = ctx.viewport.visibleWorldRect;
    let i = 0;
    while (i < renderables.length) {
      const r = renderables[i]!;
      if (canDepthGroup && depthEligible3D(r)) {
        // Contiguous run of depth-eligible 3D renderables → one depth pass.
        // (2D layers, mattes, adjustments, effect layers break the run —
        // exactly the barriers buildSnapshot's painter sort respects.)
        const group: Renderable[] = [];
        while (i < renderables.length && depthEligible3D(renderables[i]!)) {
          const g = renderables[i]!;
          if (Rect.intersects(visible, g.bounds) && g.opacity > 0) group.push(g);
          i += 1;
        }
        if (group.length > 0) {
          st.flushMain();
          this.render3DGroup(ctx, group, out, st.byId);
        }
        continue;
      }
      this.processRenderable(ctx, r, st);
      i += 1;
    }
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

    // Safety net: a depth-eligible lit 3D renderable normally never reaches
    // this 2D path (renderList routes it to render3DGroup), but when the run
    // can't depth-group (no camera3d / non-samplable target) it falls through
    // here with its light gain UNfolded — fold the per-quad fallback in so the
    // layer doesn't lose its lighting.
    let r = r0;
    const quadGain = r0.threeD?.shade?.quadGain;
    if (quadGain && r0.color) {
      const c = r0.color;
      r = { ...r0, color: { r: c.r * quadGain[0], g: c.g * quadGain[1], b: c.b * quadGain[2], a: c.a } };
    }

    // Isolated precomp: render its subtree offscreen and continue as a plain
    // textured renderable — every branch below (matte, advanced blend, effects,
    // motion blur, direct draw) then composites the group as one unit.
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
        } else {
          // The matte could not be built. Almost always: the source is a precomp
          // and prepareIsolatedPrecomp refused because nesting exceeded
          // MAX_PRECOMP_DEPTH.
          //
          // The layer still draws — never silently vanish authored work — but it
          // draws UNMATTED, which is a materially different picture: a layer
          // that should be cut to a shape renders whole. That used to happen with
          // no signal at all, which is the worst available outcome, because the
          // result looks finished. Now it is stated and the host decides:
          // preview warns and keeps the frame, export refuses it.
          ctx.services.diagnostics.push({
            code: 'matte-source-unavailable',
            layerId: r.id,
            detail:
              `Track matte on "${r.id}" could not be built from source "${r.matte.sourceId}" — `
              + `the layer rendered WITHOUT its matte. A precomp matte source nested deeper `
              + `than ${MAX_PRECOMP_DEPTH} levels cannot be isolated.`,
          });
        }
        return;
      }
      // Source id present but no such renderable in this frame. Same class, same
      // reporting: draw the layer, and say what was lost.
      ctx.services.diagnostics.push({
        code: 'matte-source-unavailable',
        layerId: r.id,
        detail:
          `Track matte on "${r.id}" references source "${r.matte.sourceId}", which is not `
          + `present in this composition — the layer rendered WITHOUT its matte.`,
      });
      // Fall through and draw the layer normally.
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
        const res = this.runEffectsChain(ctx, effects, belowTex, [LAYER_TARGET, BLUR_TARGET1, BLUR_TARGET2, BLUR_TARGET3], byId, r.id);
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

    if ((r.backdropBlur && r.backdropBlur > 0) || r.glass) {
      // Frosted glass: blur what is BEHIND the layer and show it through the
      // layer's own alpha. Same preconditions and ordering hazards as the
      // advanced-blend branch below — needs a samplable out target, and the
      // layer render must happen FIRST because its effect chain borrows the
      // blur pool this then uses for the backdrop.
      flushMain();
      const sceneTarget = ctx.target(st.out);
      const sceneTex = sceneTarget ? ctx.services.backend.renderTargetTexture(sceneTarget) : null;
      if (sceneTex) {
        const full = targetUv;
        const fullMvp = screenMvp();
        // 1. The layer itself → MATTE_TARGET. Its ALPHA is the glass silhouette
        //    (so a rounded card, text, or a masked shape all cut correctly) and
        //    its COLOUR is the tint drawn over the blur.
        const layerTex = this.layerIntoTarget(ctx, r, r.opacity, MATTE_TARGET, byId);
        // 2. Copy the backdrop out — a target cannot be sampled while written.
        //    Radius 0 skips the blur chain entirely and keeps the copy at full
        //    resolution; that is a legitimate Glass setting, not a degenerate
        //    one, because clear glass refracts without frosting and must not
        //    lose sharpness to a downsample it never asked for.
        //
        // ── Why there is no blurred-backdrop CACHE here ──────────────────
        //
        // The obvious optimisation is "cache the blurred backdrop, invalidate
        // when a layer beneath changes or the playhead moves". That rule
        // describes exactly the frames this renderer never draws.
        //
        // The viewport is invalidation-driven, not a loop: WorkspaceController
        //.scheduleRender queues ONE coalesced rAF and only when markDirty
        // fires, so with nothing changing and the playhead parked, zero frames
        // are rendered and there is nothing for a cache to serve. While
        // PLAYING, usePlaybackClock advances the playhead every frame — which
        // is the other half of the invalidation rule. So the cache would be
        // consulted only on frames it had already declared stale.
        //
        // A cache that DID pay would need a stricter rule than the playhead:
        // "reuse unless something beneath this layer actually moved", which
        // covers a glass panel animating over a static background during
        // playback. That needs per-glass-layer dedicated targets (these two are
        // shared ping-pong buffers, reused by the next glass layer in the same
        // frame) plus a change hash over every preceding renderable — and it
        // buys a new failure mode, a stale backdrop, which is invisible in a
        // still and obvious in motion.
        //
        // The unconditional win was the downsample below. The next one, if this
        // ever shows up in a profile, is scissoring the chain to the layer's
        // bounds: a glass card covering a tenth of the frame currently pays the
        // full-viewport blur cost.
        const blurRadius = r.backdropBlur ?? 0;
        const half = blurRadius > 0;
        const bw = half
          ? Math.max(1, Math.floor(viewport.pixelSize.width / BACKDROP_DOWNSCALE))
          : viewport.pixelSize.width;
        const bh = half
          ? Math.max(1, Math.floor(viewport.pixelSize.height / BACKDROP_DOWNSCALE))
          : viewport.pixelSize.height;
        const t1 = half ? BACKDROP_HALF1 : BLUR_TARGET1;
        const t2 = half ? BACKDROP_HALF2 : BLUR_TARGET2;

        const copyCmds = new CommandBuffer();
        emitTextured(copyCmds, fullMvp, Color.white(), 1, 'normal', sceneTex, clampSampler(), full);
        // The copy IS the downsample: the same full-screen quad drawn into a
        // half-size target, filtered down by the sampler on the way in.
        const encCopy = half
          ? beginSizedPass(ctx, 'backdrop-copy', writeAttachment(ctx, t1, Color.transparent()), bw, bh)
          : beginViewportPass(ctx, 'backdrop-copy', writeAttachment(ctx, t1, Color.transparent()));
        services.quad.execute(encCopy, copyCmds);
        encCopy.end();
        const copyTex = ctx.services.backend.renderTargetTexture(ctx.target(t1)!);

        // 3. Separable blur, ping-ponging t1 → t2 (H) → t1 (V).
        //    Both the texel step and the radius are in TARGET pixels, so at half
        //    resolution the step doubles and the radius halves — the visual
        //    sigma in composition pixels is unchanged, at a quarter of the
        //    fragment cost.
        const scale = half ? BACKDROP_DOWNSCALE : 1;
        let blurredTex = copyTex;
        if (copyTex && blurRadius > 0) {
          const hCmds = new CommandBuffer();
          hCmds.add({
            batchKey: 'blur|normal', material: BLUR_MATERIAL, blend: 'normal',
            uniforms: packBlur(fullMvp, full, 1 / bw, 0, blurRadius / scale),
            texture: copyTex, sampler: clampSampler(),
          });
          const encH = beginSizedPass(ctx, 'backdrop-blurH', writeAttachment(ctx, t2, Color.transparent()), bw, bh);
          services.quad.execute(encH, hCmds);
          encH.end();
          const hTex = ctx.services.backend.renderTargetTexture(ctx.target(t2)!);
          if (hTex) {
            const vCmds = new CommandBuffer();
            vCmds.add({
              batchKey: 'blur|normal', material: BLUR_MATERIAL, blend: 'normal',
              uniforms: packBlur(fullMvp, full, 0, 1 / bh, blurRadius / scale),
              texture: hTex, sampler: clampSampler(),
            });
            const encV = beginSizedPass(ctx, 'backdrop-blurV', writeAttachment(ctx, t1, Color.transparent()), bw, bh);
            services.quad.execute(encV, vCmds);
            encV.end();
            blurredTex = ctx.services.backend.renderTargetTexture(ctx.target(t1)!);
          }
        }
        // 4. Composite over the scene: blurred backdrop clipped to the layer's
        //    alpha, then the layer's own colour on top. Both are full-screen
        //    textures sampled with the SAME targetUv, so there is no new
        //    coordinate or per-backend V-flip maths to get wrong.
        if (blurredTex && layerTex) {
          if (r.glass) {
            // The Glass style replaces the plain masked composite: refraction,
            // chromatic aberration, tint, rim, specular and grain in ONE pass
            // over the blurred backdrop (shaders/glass.ts explains why this is
            // a shader rather than the effect pile AE forces on people).
            //
            // It also replaces the layer's own COLOUR draw below, which is why
            // that is skipped for glass. A shape layer's default fill is opaque,
            // so drawing it over the composite painted a plain card on top of
            // the glass and hid it completely — the feature looked like it did
            // nothing at all. Glass is a MATERIAL: what you see through it is
            // the backdrop, and what tints it is `tintColor`/`tintOpacity`,
            // not the layer's fill.
            mainCmds.add({
              batchKey: 'glass|normal',
              material: GLASS_MATERIAL,
              blend: 'normal',
              uniforms: packGlass(
                fullMvp,
                full,
                r.glass,
                1 / viewport.pixelSize.width,
                1 / viewport.pixelSize.height,
              ),
              texture: blurredTex,
              sampler: clampSampler(),
              maskTexture: layerTex,
            });
          } else {
            emitMaskedTextured(mainCmds, fullMvp, Color.white(), 1, 'normal', blurredTex, clampSampler(), layerTex, full);
            // Plain backdrop blur keeps the layer's own colour on top — that is
            // how a translucent frosted panel gets its fill. Glass supplies its
            // own tint, so it skips this (see above).
            emitTextured(mainCmds, fullMvp, Color.white(), 1, r.blend, layerTex, clampSampler(), full);
          }
        }
        return;
      }
      // Not samplable (drawing straight to the surface) — fall through and draw
      // the layer normally; it simply will not frost.
    }

    // Preserve Underlying Transparency needs the same backdrop-sampling route,
    // and needs it even when the blend mode is Normal (advancedBlend 0) — which
    // is the common case for it. `bChan` falls through to `return cs` for mode
    // 0, so Normal composites correctly through the combine.
    if ((r.advancedBlend && r.advancedBlend > 0) || r.preserveTransparency) {
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
          // m[0] -> cr0.x = blend id; m[1] -> cr0.y = preserve-transparency flag.
          // Two independent inputs, because the two features compose.
          const mode = {
            m: [r.advancedBlend ?? 0, r.preserveTransparency ? 1 : 0, 0, 0, 0, 0, 0, 0, 0],
            offset: [0, 0, 0],
          };
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

    /*
      One effects chain, not two.

      This route — an ordinary 2D layer with effects and/or motion blur — used
      to carry its OWN copy of the effect switch: a second `for (const effect of
      r.effects)` with its own branch per effect type, its own compositing
      conventions, and its own set of supported types. `runEffectsChain` was
      the other copy, reached only from the matte, advanced-blend and 3D routes.

      Two consequences, both of which shipped:

        1. **An effect type the duplicate did not know about ERASED the layer.**
           The branch chain matched nothing, so nothing was ever composited back
           out of LAYER_TARGET and the layer simply vanished — not "the effect
           did nothing", which is what a skipped effect should look like. That
           is what a plugin effect did on every 2D layer, on BOTH backends,
           while `runEffectsChain` had a correct `plugin` branch that no 2D
           layer ever reached. `set-matte` was in the same position.
        2. **Effects did not chain.** Every branch here sampled `layerTex` — the
           layer as drawn, never the previous effect's output — so a blur under
           a fill applied the fill to the UNBLURRED layer, and each pass writing
           straight to `st.out` overwrote the one before it.

      Both are properties of the duplicate rather than of the effects, and
      neither can be fixed twice. `applyLayerEffects` ping-pongs the same four
      targets this code used, settles the result back into LAYER_TARGET, and is
      already the path a matted or 3D copy of this same layer takes.
    */
    /*
      `runEffectsChain` directly, not `applyLayerEffects`.

      The difference is one full-screen blit. `applyLayerEffects` SETTLES the
      result back into the target it was handed, because its callers (the matte
      and 3D routes) promise "the final texture lives in `dest`" and hand the
      scratch targets straight on to the next thing. This route makes no such
      promise: it composites once and is done, so it can read the chain's own
      output wherever it landed.

      Measured: dropping it changes no pixel in any scene in the suite, which is
      what a settle blit should do and is the reason it is safe to skip rather
      than a reason to keep it.
    */
    const effectTex = this.runEffectsChain(
      ctx, r.effects!, layerTex,
      [LAYER_TARGET, BLUR_TARGET1, BLUR_TARGET2, BLUR_TARGET3],
      byId, r.id,
    ).tex;
    /*
      Composited ONCE, here, at the layer's own opacity and blend.

      The chain runs in a neutral space — every pass writes `normal` into a
      scratch target — because an intermediate result blended against the scene
      is not an intermediate result. `r.opacity` rather than 1 even when the
      layer is motion-blurred: the per-sample opacity baked into the buffer is
      the SHUTTER weighting, and the layer's own opacity is a separate factor
      that the duplicate applied here too.
    */
    emitTextured(
      mainCmds,
      screenMvp(),
      Color.white(), r.opacity, r.blend, effectTex,
      clampSampler(),
      targetUv,
    );
  }
}
