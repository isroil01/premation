/**
 * Which of a layer's effects reach the faces an extrusion synthesizes.
 *
 * ── What this replaces, and why the thing it replaces was half right ────────
 *
 * `buildSnapshot` used to hand every synthesized face `effects: undefined`. The
 * reason was real: a bare `...layer` spread carried the whole stack onto all of
 * them, and `castsShadows` defaults ON, so one shadow-casting light stacked up
 * to 45 copies of the same 45%-black drop shadow inside the object's own
 * bounds — a dark blob — and forced 45 full-viewport offscreen effect resolves
 * per frame. Scrubbing the list fixed that.
 *
 * It also deleted every other effect from thirteen of fourteen renderables. An
 * `invert` reached the front face and stopped; so did `blur`, `mosaic`,
 * `vignette` and `inner-glow`; and so did depth of field, which is appended to
 * `layer.effects` as an ordinary `blur` entry fourteen lines before the
 * extrusion block discarded it. A rect extruded 400 px with DOF on rendered
 * BYTE-IDENTICAL to the same rect with DOF off, because the only face carrying
 * the blur was the one the diagnostic's subject did not show.
 *
 * So the decision is per effect, not per list. Three buckets:
 *
 *   EXTERIOR   drawn OUTSIDE the source alpha, so N faces paint N copies of it
 *              across the body's own interior. Denied on synthesized faces; the
 *              front face keeps them, which is the object's silhouette seen
 *              head-on and the least wrong of the available pictures.
 *   CPU-BAKED  no shader form, so each carrying face is a separate full CPU
 *              rasterization every frame. Denied — see the cost note below.
 *   EVERYTHING carried to every face. Colour and tonal effects cost nothing to
 *   ELSE       do this (they fold into the face's fill colour or into a shader
 *              uniform); spatial ones cost a GPU pass each, which is what
 *              {@link SPATIAL_FACE_BUDGET} bounds.
 *
 * ── Why EXTERIOR is exactly this set, and not a judgement call ──────────────
 *
 * `buildSnapshot` already makes this decision for LAYER STYLES, in
 * `FACE_SURFACE_IDS`: interior styles (inner shadow, inner glow, satin, bevel,
 * stroke) go to the faces, and the comment beside it says the exterior ones —
 * drop shadow and outer glow — "belong to the object's silhouette and would
 * stack N times". Those two styles compile to the effect types `drop-shadow`
 * and `glow` (layerStyles.ts, STYLE_EFFECT_TYPE). Deny-listing those types here
 * is therefore the SAME decision already made one screen away, not a new one —
 * and had it been decided differently, one control would have behaved two ways
 * depending on whether the user reached it through Effects or Layer Styles.
 * `radial-shadow` joins them because it is the same class of thing.
 *
 * ── Spatial effects that are allowed, and the seam ──────────────────────────
 *
 * `blur`, `mosaic`, `vignette` and `inner-glow` reach every face. Each face is
 * a separate quad, so a blur does NOT bleed across the seam between the front
 * face and a wall: the blurred front face and the blurred wall meet at a join
 * that is soft on both sides but not continuous across it.
 *
 * That is accepted, because the alternative is what shipped: the front face
 * smeared while the walls stayed razor-sharp, which is a hard discontinuity at
 * exactly the same seam and a much larger one. A blur that is slightly wrong at
 * the join beats a blur that is absent from five sixths of the object. Making
 * it continuous needs the faces resolved as ONE silhouette rather than as
 * fourteen independent quads, which is a renderer change, not a snapshot one.
 *
 * ── Cost, and why the CPU-baked bucket is a hard exclusion ──────────────────
 *
 * A face carrying an effect the GPU can draw costs one full-viewport resolve
 * (`CompositionPass.resolveEffect3DTexture`) plus a flush of the depth pass.
 * That is the same price the renderer already pays for any effect-laden 3D
 * layer, so a handful of faces is in budget and a great many are not — hence
 * {@link SPATIAL_FACE_BUDGET}, a bound on faces rather than a ban.
 *
 * A face carrying a CPU-baked effect costs a Canvas2D rasterization of that
 * face, every frame. For 45 text slices that is 45 text rasterizations per
 * frame — a different order of magnitude, and not something a budget makes
 * safe. So those are excluded outright. This is the one bucket whose reasoning
 * is expected to expire: it is exactly the 112-of-145 CPU effect population,
 * and as those move onto the GPU they graduate into the budgeted bucket without
 * this file changing.
 */

import { effectsNeedCpuBake } from '@core/effects/effectBake';
import { styleKeyFromEffectId } from '@core/effects/layerStyles';
import { isColorEffect } from '@core/effects/effectColorMatrix';
import { isLutEffect } from '@core/effects/colorLut';
import type { Effect, EffectType } from '@core/effects/effects';

/**
 * Effects that draw outside the source alpha and therefore belong to the
 * object's silhouette rather than to any one of its faces.
 *
 * `glow` is AE's outer glow; the inner one is a separate type (`inner-glow`)
 * and is not here, because it hugs the contour of the face it is applied to,
 * which is the interior-style reasoning `FACE_SURFACE_IDS` already encodes.
 */
export const EXTERIOR_FACE_EFFECTS: ReadonlySet<EffectType> = new Set<EffectType>([
  'drop-shadow',
  'radial-shadow',
  'glow',
]);

/**
 * How many synthesized faces may carry effects that need their own GPU pass.
 *
 * ── The measurement this comes from ─────────────────────────────────────────
 *
 * Four extrusions differing only in face count, rendered with depth of field
 * and again with none. Single frame including readback, so the absolute numbers
 * are not preview frame times; the SCALING is the point. (`--scene` cost probes,
 * 480×360, this machine, 2026-08-12.)
 *
 *      faces          WebGL2            WebGPU
 *                  none    +DOF      none    +DOF
 *      5 (box)      291    1677        —      109
 *     13 (bevel)    378    5318       88      126
 *     21 (ellipse)  387    8265       98      141
 *     45 (slices)   473   16413      123      192
 *
 * Face count on its own is nearly free — 5 → 45 faces costs ~180 ms more on
 * WebGL2 and ~35 ms on WebGPU. What costs is the per-face effect RESOLVE: the
 * marginal price of one more effect-laden face is ~368 ms on WebGL2 and ~2 ms
 * on WebGPU, a ~180× gap. Both are linear in face count, which is what makes a
 * simple bound the right instrument.
 *
 * ── Why one number, set by the slower backend ───────────────────────────────
 *
 * WebGPU could afford all 45. The budget is nonetheless a single constant
 * because the snapshot is backend-agnostic by design: one `buildSnapshot` feeds
 * preview and export on WebGPU, WebGL2 and Null alike, and a face list that
 * varied by backend would be a path that runs in one and not the other — the
 * exact thing that invariant exists to prevent. So it is set where WebGL2 can
 * still pay, and WebGPU simply has headroom.
 *
 * ── Where 16 falls ──────────────────────────────────────────────────────────
 *
 * Between the bevelled box (13) and the ellipse (21). It admits both rect
 * forms — an extruded card or title is what people actually build, and the
 * unbevelled box is the shape the acceptance criterion for per-face DOF is
 * written against — and excludes every population that is large by
 * construction: a text/complex extrusion (up to 45 depth slices), a
 * gradient-filled box (20 strips per wall, 81 faces), and the curved outlines.
 *
 * All-or-nothing per layer, deliberately. Applying a blur to the first twelve
 * faces and not the thirteenth does not degrade, it STRIPES — and a striped
 * solid reads as a rendering fault, where a uniformly unblurred body reads as
 * the (documented) limit of the approximation.
 *
 * This bound is a consequence of the per-renderable resolve, not of anything
 * essential: resolving an extrusion's faces into ONE offscreen would remove it
 * entirely, and would also fix the blur seam described at the top of this file.
 */
export const SPATIAL_FACE_BUDGET = 16;

/** True when this effect costs nothing to carry onto an extra face: it folds
 *  into the face's fill colour (solid faces) or into a shader uniform / small
 *  lookup texture (textured faces), rather than into a pass of its own. */
function isFreePerFace(e: Effect): boolean {
  return isColorEffect(e.type) || isLutEffect(e.type);
}

export interface FaceEffectOptions {
  /**
   * How many faces this extrusion synthesized. Compared against
   * {@link SPATIAL_FACE_BUDGET} to decide whether effects needing a GPU pass
   * are carried. Counts the synthesized faces only — the front face is the
   * layer itself and always keeps its whole stack.
   */
  faceCount: number;
  /**
   * Effects to carry onto this face regardless of the rules above — the
   * interior layer styles `buildSnapshot` resolves per face (`FACE_SURFACE_IDS`
   * filtered through `faceFxFor`). They are already scoped to the faces that
   * should have them, so they are appended rather than re-decided here.
   */
  extra?: ReadonlyArray<Effect>;
}

/**
 * The effect list for ONE synthesized extrusion face.
 *
 * Returns `undefined` rather than `[]` when nothing survives: a `RenderLayer`
 * with an empty effects array and one with none are treated identically
 * downstream, and `undefined` is what the field's other writers use.
 */
export function faceEffectsFor(
  effects: ReadonlyArray<Effect> | undefined,
  opts: FaceEffectOptions,
): Effect[] | undefined {
  const paidAllowed = opts.faceCount <= SPATIAL_FACE_BUDGET;
  const kept: Effect[] = [];
  for (const e of effects ?? []) {
    if (e.enabled === false) continue;
    // Layer styles are NOT decided here. They arrive in `layer.effects`
    // alongside the layer's own effects (buildSnapshot compiles them in), but
    // the extrusion block has already decided them per face — twice over, and
    // for reasons this function does not have the information to reproduce:
    //
    //   • the interior ones are picked by `FACE_SURFACE_IDS` and then scoped by
    //     `faceFxFor`, which admits only faces that are a whole SURFACE of the
    //     object. A cylinder's twenty chord facets and a bevel's chamfer rings
    //     are excluded on purpose — an inner shadow hugs the contour of
    //     whatever carries it, so per-facet it draws the tessellation instead
    //     of the body. Passing them through here would undo that.
    //   • the colour and gradient overlays reach the faces a completely
    //     different way, through `styledSurfaceFill`/`wallFillAt`, which is
    //     what makes a gradient run continuously down a wall. Carrying them as
    //     effects as well would apply them TWICE.
    //
    // So the caller's decision arrives as `extra` and is appended verbatim.
    if (styleKeyFromEffectId(e.id) !== null) continue;
    if (EXTERIOR_FACE_EFFECTS.has(e.type)) continue;
    // `effectsNeedCpuBake` is asked about this ONE effect rather than the whole
    // stack, so a single CPU-only effect does not evict the GPU-drawable ones
    // beside it. It also covers `maskId`: a mask-scoped effect is honoured only
    // in the bake, and the face has no bake.
    if (effectsNeedCpuBake([e])) continue;
    if (!paidAllowed && !isFreePerFace(e)) continue;
    kept.push(e);
  }
  if (opts.extra) kept.push(...opts.extra);
  return kept.length > 0 ? kept : undefined;
}
