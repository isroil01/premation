/**
 * On-canvas handles for a plugin effect's `point` parameters.
 *
 * ## Why this is separate from `effectHandles.ts`
 *
 * That file's `EFFECT_HANDLES` is keyed on `EffectType` — a closed union known
 * at build time — and its specs carry `xKey`/`yKey`, two SCALAR params holding
 * an OFFSET from a rest position in layer-local space. Every assumption there
 * is wrong for a plugin:
 *
 *   • The set of plugin effects is whatever is installed, so it cannot be a
 *     typed record.
 *   • A `point` is ONE param holding `{ x, y }`, not two scalars.
 *   • Its value is an absolute position in COMPOSITION pixels, not an offset.
 *
 * Bending the built-in specs to cover all three would have made `xKey` mean
 * "or a point key, in which case ignore yKey and rest and read a different
 * space" — a shape where every reader has to know which kind it is holding.
 * Two small collectors that each mean one thing beat one that means two.
 *
 * ## Why comp space, and why that makes this short
 *
 * A plugin's point reaches the shader as raw pixels, and the shader's target on
 * the 2D route is comp-sized — one comp pixel is one texel — so `uv *
 * targetSize` and the parameter are in the same units. Keeping the handle in
 * that space means the drag is an identity: screen → comp → the value. No layer
 * transform, no half-box offset, no inverse to get wrong.
 *
 * The cost, stated so it is a choice rather than an oversight: a handle does
 * NOT follow its layer when the layer is moved or rotated, because the value it
 * edits is not expressed relative to the layer. That is the right trade for a
 * light position or a vignette centre — which is what points are for — and the
 * wrong one for a corner pin, which is exactly why corner pin is a built-in
 * with layer-local handles rather than four point parameters.
 */

import type { EffectContribution } from '@core/plugins/effectSchema';
import type { LayerPropSchema } from '@core/plugins/layerKindSchema';

export interface PointHandle {
  /** The parameter this handle edits. Also the React key and aria-label stem. */
  param: string;
  label: string;
  /** Live position, in composition pixels. */
  pos: { x: number; y: number };
}

/** A `{x, y}` if the value is one, else null. */
function asPoint(v: unknown): { x: number; y: number } | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = v as { x?: unknown; y?: unknown };
  if (typeof p.x !== 'number' || !Number.isFinite(p.x)) return null;
  if (typeof p.y !== 'number' || !Number.isFinite(p.y)) return null;
  return { x: p.x, y: p.y };
}

/**
 * Every point parameter of this effect, at its current value.
 *
 * `params` is the resolved bag — whatever the inspector and the renderer are
 * reading this frame. A handle drawn from the DECLARED value on an effect the
 * user has already adjusted would sit where the parameter used to be, and
 * invite a drag that jumps.
 *
 * Falls back to the declared default when the value is missing or malformed,
 * for the same reason `packParameters` does: an effect the user has never
 * touched still has a position, and a handle at (0,0) — the composition's
 * top-left corner — looks like a bug rather than a default.
 */
export function collectPluginPointHandles(
  effect: EffectContribution,
  params: Readonly<Record<string, unknown>>,
): PointHandle[] {
  const out: PointHandle[] = [];
  for (const [name, schema] of Object.entries(effect.params)) {
    if ((schema as LayerPropSchema).type !== 'point') continue;
    const live = asPoint(params[name]);
    const fallback = asPoint((schema as LayerPropSchema).default);
    out.push({
      param: name,
      // The author's label if they gave one, else the parameter name. Never
      // blank: this string is the handle's accessible name, and an unnamed
      // control on a canvas is unreachable rather than merely unlabelled.
      label: (schema as LayerPropSchema).label?.trim() || name,
      pos: live ?? fallback ?? { x: 0, y: 0 },
    });
  }
  return out;
}

/** Whether this effect has any point parameter at all — the cheap pre-check. */
export function hasPluginPointHandles(effect: EffectContribution): boolean {
  return Object.values(effect.params).some((s) => (s as LayerPropSchema).type === 'point');
}

/**
 * Which handle a screen press grabbed, or null.
 *
 * Hit-tested in SCREEN pixels at a constant radius, the way every other handle
 * in this editor is: sizing the target in composition units would make it
 * unhittable zoomed out and enormous zoomed in.
 *
 * Nearest wins on a tie rather than first-declared. Two points at the same
 * place is a real state — a plugin whose two defaults coincide until the user
 * separates them — and "whichever was declared first, forever" makes the second
 * one impossible to grab.
 */
export function hitTestPointHandle(
  handles: readonly PointHandle[],
  screen: { x: number; y: number },
  toScreen: (p: { x: number; y: number }) => { x: number; y: number },
  radiusPx: number,
): PointHandle | null {
  let best: PointHandle | null = null;
  let bestDist = Infinity;
  for (const h of handles) {
    const s = toScreen(h.pos);
    const d = Math.hypot(s.x - screen.x, s.y - screen.y);
    if (d <= radiusPx && d < bestDist) { best = h; bestDist = d; }
  }
  return best;
}

/**
 * The value a drag should write.
 *
 * A function rather than two lines at the call site because it is the one place
 * the grab OFFSET is applied. Without it a handle jumps so its centre lands
 * under the cursor on the first move — which is a fraction of a pixel when you
 * grab dead centre and very obvious when you grab the edge of the target.
 */
export function pointDragValue(
  grabbedAt: { x: number; y: number },
  startValue: { x: number; y: number },
  now: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: startValue.x + (now.x - grabbedAt.x),
    y: startValue.y + (now.y - grabbedAt.y),
  };
}
