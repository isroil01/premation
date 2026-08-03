/**
 * Per-layer blend modes.
 *
 * The blend mode lives on the node's `fx` component (sibling to the effect
 * stack), so History / autosave / export capture it for free.
 *
 * ── How a mode actually reaches pixels ───────────────────────────────
 * There is ONE rendering engine and it is GPU-backed (WebGPU -> WebGL2, see
 * createRenderBackend.ts). Every mode except Normal composites through the
 * BLEND_COMBINE shader, which samples the backdrop and implements the W3C
 * compositing formula in both WGSL and GLSL. `snapshotToFrameScene.advancedBlendId`
 * maps each mode here onto that shader's integer selector.
 *
 * This file used to say the app composited on Canvas 2D, and that the mode list
 * was therefore capped at what `globalCompositeOperation` renders natively. That
 * stopped being true when the engine was unified; the claim survived and was the
 * reason the remaining AE modes were estimated as far more expensive than they
 * are. `blendToComposite()` — which returned a GlobalCompositeOperation and was
 * called by nothing but its own test — is deleted along with the claim. So is
 * the `gpuSafe` flag, which described a Canvas2D-to-GPU fallback that no longer
 * exists.
 *
 * ── Coverage ─────────────────────────────────────────────────────────
 * 36 of AE's 38. Missing: Dissolve and Dancing Dissolve (stochastic, and the
 * cost is not the blend but a determinism contract between preview and
 * export — M5).
 *
 * The four Stencil/Silhouette modes (M8c) are now in. They were estimated as
 * needing "a compositing-group boundary" first; that boundary already existed.
 * The advanced-blend path renders the layer to one target, copies the
 * accumulated backdrop to another, and OVERWRITES the group's out target with a
 * function of the two — which is precisely the topology a stencil needs, and
 * precomps already isolate into their own target so the scope is right too.
 * Checking the renderer rather than the estimate turned an L into an M.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import type { SceneNode } from '@core/types';

export type LayerBlendMode =
  | 'normal'
  | 'add'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity'
  // ── M1 ──
  | 'classic-color-burn'
  | 'linear-burn'
  | 'darker-color'
  | 'classic-color-dodge'
  | 'linear-dodge'
  | 'lighter-color'
  | 'linear-light'
  | 'vivid-light'
  | 'pin-light'
  | 'hard-mix'
  | 'classic-difference'
  | 'subtract'
  | 'divide'
  // ── M4: the Utility family. These write ALPHA, not just colour. ──
  | 'alpha-add'
  | 'luminescent-premul'
  // ── M8c: the Matte family. These replace the backdrop with a SCALED copy of
  // itself and contribute no colour of their own — the layer is a matte, not a
  // participant in the blend. ──
  | 'stencil-alpha'
  | 'stencil-luma'
  | 'silhouette-alpha'
  | 'silhouette-luma';

/**
 * Blend modes in AE's own menu order and AE's own group names, so a user coming
 * from After Effects finds each one where they expect it. The groups are load
 * bearing for the picker's section headers; do not rename them to something
 * tidier.
 *
 * ── The three Classic modes are COMPATIBILITY ALIASES, not distinct maths ──
 * AE keeps `Classic Color Burn` / `Classic Color Dodge` / `Classic Difference`
 * for projects authored before its blend maths was revised. We keep the NAMES so
 * an imported project's mode survives a round trip and the picker matches AE's,
 * but they currently render identically to Color Burn / Color Dodge / Difference.
 *
 * This is stated rather than implied because measurement contradicted the
 * intent: the Classic branches were written as the unclamped forms, and the
 * output-clamp at the end of the channel function collapses them back onto the
 * modern ones — verified, not assumed, by rendering both and comparing. Shipping
 * them as "unclamped variants" would have been a parity claim the pixels do not
 * support. Logged as F9; closing it needs AE's actual pre-7.0 formulas, which we
 * do not have.
 */
export const BLEND_MODES: ReadonlyArray<{ mode: LayerBlendMode; label: string; group: string }> = [
  { mode: 'normal', label: 'Normal', group: 'Normal' },

  { mode: 'darken', label: 'Darken', group: 'Subtractive' },
  { mode: 'multiply', label: 'Multiply', group: 'Subtractive' },
  { mode: 'color-burn', label: 'Color Burn', group: 'Subtractive' },
  { mode: 'classic-color-burn', label: 'Classic Color Burn', group: 'Subtractive' },
  { mode: 'linear-burn', label: 'Linear Burn', group: 'Subtractive' },
  { mode: 'darker-color', label: 'Darker Color', group: 'Subtractive' },

  { mode: 'add', label: 'Add', group: 'Additive' },
  { mode: 'lighten', label: 'Lighten', group: 'Additive' },
  { mode: 'screen', label: 'Screen', group: 'Additive' },
  { mode: 'color-dodge', label: 'Color Dodge', group: 'Additive' },
  { mode: 'classic-color-dodge', label: 'Classic Color Dodge', group: 'Additive' },
  { mode: 'linear-dodge', label: 'Linear Dodge', group: 'Additive' },
  { mode: 'lighter-color', label: 'Lighter Color', group: 'Additive' },

  { mode: 'overlay', label: 'Overlay', group: 'Complex' },
  { mode: 'soft-light', label: 'Soft Light', group: 'Complex' },
  { mode: 'hard-light', label: 'Hard Light', group: 'Complex' },
  { mode: 'linear-light', label: 'Linear Light', group: 'Complex' },
  { mode: 'vivid-light', label: 'Vivid Light', group: 'Complex' },
  { mode: 'pin-light', label: 'Pin Light', group: 'Complex' },
  { mode: 'hard-mix', label: 'Hard Mix', group: 'Complex' },

  { mode: 'difference', label: 'Difference', group: 'Difference' },
  { mode: 'classic-difference', label: 'Classic Difference', group: 'Difference' },
  { mode: 'exclusion', label: 'Exclusion', group: 'Difference' },
  { mode: 'subtract', label: 'Subtract', group: 'Difference' },
  { mode: 'divide', label: 'Divide', group: 'Difference' },

  { mode: 'hue', label: 'Hue', group: 'HSL' },
  { mode: 'saturation', label: 'Saturation', group: 'HSL' },
  { mode: 'color', label: 'Color', group: 'HSL' },
  { mode: 'luminosity', label: 'Luminosity', group: 'HSL' },

  { mode: 'alpha-add', label: 'Alpha Add', group: 'Utility' },
  { mode: 'luminescent-premul', label: 'Luminescent Premul', group: 'Utility' },

  { mode: 'stencil-alpha', label: 'Stencil Alpha', group: 'Matte' },
  { mode: 'stencil-luma', label: 'Stencil Luma', group: 'Matte' },
  { mode: 'silhouette-alpha', label: 'Silhouette Alpha', group: 'Matte' },
  { mode: 'silhouette-luma', label: 'Silhouette Luma', group: 'Matte' },
];

/**
 * The Matte family, which behaves unlike every other mode: the layer draws no
 * colour at all and instead scales the alpha of the whole backdrop beneath it.
 * Callers that reason about "does this layer contribute pixels" need to tell
 * them apart from the rest.
 */
export const MATTE_BLEND_MODES: ReadonlySet<LayerBlendMode> = new Set<LayerBlendMode>([
  'stencil-alpha', 'stencil-luma', 'silhouette-alpha', 'silhouette-luma',
]);

export function isMatteBlend(mode: LayerBlendMode | undefined): boolean {
  return !!mode && MATTE_BLEND_MODES.has(mode);
}

const VALID = new Set<string>(BLEND_MODES.map((b) => b.mode));

export function isBlendMode(v: unknown): v is LayerBlendMode {
  return typeof v === 'string' && VALID.has(v);
}

/** Read a node's blend mode from its `fx` component (defaults to 'normal'). */
export function readNodeBlend(node: SceneNode): LayerBlendMode {
  const fx = node.components.find((c) => c.type === 'fx');
  const m = fx?.props.blendMode;
  return isBlendMode(m) ? m : 'normal';
}

export function getNodeBlend(nodeId: string): LayerBlendMode {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readNodeBlend(node) : 'normal';
}

export function setNodeBlend(nodeId: string, mode: LayerBlendMode): void {
  defaultSceneGraph.setBlendMode(nodeId, mode);
  // Compositing changed → same refresh signal as an effect/animation edit.
  getEventBus().emit('AnimationChanged', { nodeId });
}
