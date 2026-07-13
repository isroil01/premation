/**
 * Visual effects engine (spec: Focus Mode edits "animation, masks, effects,
 * expressions…"). Each layer carries a stack of effects stored on an `fx`
 * component so History, autosave, and export capture them for free. Effects
 * compile to a CSS `filter` string the Canvas 2D backend applies per layer.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import type { SceneNode } from '@core/types';

export type EffectType =
  | 'blur'
  | 'glow'
  | 'drop-shadow'
  | 'brightness'
  | 'contrast'
  | 'saturate'
  | 'grayscale'
  | 'sepia'
  | 'hue-rotate'
  | 'invert';

export interface Effect {
  id: string;
  type: EffectType;
  amount: number;
  /** When false the effect stays in the stack but contributes nothing. */
  enabled?: boolean;
}

export interface EffectDef {
  type: EffectType;
  label: string;
  unit: string;
  min: number;
  max: number;
  default: number;
  /** Build the CSS filter function for an amount. */
  css: (amount: number) => string;
}

export const EFFECT_DEFS: EffectDef[] = [
  { type: 'blur', label: 'Blur', unit: 'px', min: 0, max: 40, default: 6, css: (a) => `blur(${a}px)` },
  { type: 'glow', label: 'Glow', unit: 'px', min: 0, max: 60, default: 16, css: (a) => `drop-shadow(0 0 ${a}px rgba(120,180,255,0.9))` },
  // Drop Shadow — a cast shadow with offset that scales with the amount (softness
  // and distance grow together), distinct from Glow's 0-offset colored halo.
  { type: 'drop-shadow', label: 'Drop Shadow', unit: 'px', min: 0, max: 60, default: 12, css: (a) => `drop-shadow(${(a * 0.45).toFixed(1)}px ${(a * 0.45).toFixed(1)}px ${a}px rgba(0,0,0,0.55))` },
  { type: 'brightness', label: 'Brightness', unit: '%', min: 0, max: 300, default: 130, css: (a) => `brightness(${a / 100})` },
  { type: 'contrast', label: 'Contrast', unit: '%', min: 0, max: 300, default: 130, css: (a) => `contrast(${a / 100})` },
  { type: 'saturate', label: 'Saturate', unit: '%', min: 0, max: 300, default: 160, css: (a) => `saturate(${a / 100})` },
  { type: 'grayscale', label: 'Grayscale', unit: '%', min: 0, max: 100, default: 100, css: (a) => `grayscale(${a / 100})` },
  { type: 'sepia', label: 'Sepia', unit: '%', min: 0, max: 100, default: 80, css: (a) => `sepia(${a / 100})` },
  { type: 'hue-rotate', label: 'Hue', unit: '°', min: 0, max: 360, default: 90, css: (a) => `hue-rotate(${a}deg)` },
  { type: 'invert', label: 'Invert', unit: '%', min: 0, max: 100, default: 100, css: (a) => `invert(${a / 100})` },
];

const DEF = new Map(EFFECT_DEFS.map((d) => [d.type, d]));

/** Animation prop-path for an effect's keyframeable amount (e.g. `effect.fx_3`).
 *  buildSnapshot samples this per frame so effect parameters animate through the
 *  same reversible keyframe path as transforms (AE Effect Controls stopwatches). */
export function effectPropPath(effectId: string): string {
  return `effect.${effectId}`;
}

/**
 * Resolve each effect's amount at the current time: `sample(id)` returns the
 * animated value (or undefined when the amount isn't keyframed), falling back to
 * the stored static amount. Pure — the render/snapshot layer supplies `sample`.
 */
export function resolveEffectAmounts(
  effects: ReadonlyArray<Effect>,
  sample: (effectId: string) => number | undefined,
): Effect[] {
  return effects.map((e) => {
    const v = sample(e.id);
    return v === undefined ? e : { ...e, amount: v };
  });
}

/** Compile an effect stack to a CSS filter string (empty when none). Disabled
 *  effects (enabled === false) are skipped; stack order is preserved. */
export function effectsToFilter(effects: ReadonlyArray<Effect>): string {
  return effects
    .filter((e) => e.enabled !== false)
    .map((e) => DEF.get(e.type)?.css(e.amount) ?? '')
    .filter(Boolean)
    .join(' ');
}

/** Read the effect stack off a node (from its `fx` component). */
export function readNodeEffects(node: SceneNode): Effect[] {
  const fx = node.components.find((c) => c.type === 'fx');
  const list = fx?.props.effects;
  return Array.isArray(list) ? (list as Effect[]) : [];
}

export function getNodeEffects(nodeId: string): Effect[] {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readNodeEffects(node) : [];
}

let seq = 0;

function writeNodeEffects(nodeId: string, effects: Effect[]): void {
  // The `fx` component is a computed view over the engine node; store the stack
  // on the engine (surfaced back as `readNodeEffects`' fx component).
  defaultSceneGraph.setEffects(nodeId, effects);
  // Effects change the rendered frame → same signal as an animation edit
  // (invalidates the cache, marks dirty, records history, re-renders viewport).
  getEventBus().emit('AnimationChanged', { nodeId });
}

export function addEffect(nodeId: string, type: EffectType): void {
  const def = DEF.get(type);
  if (!def) return;
  const effects = getNodeEffects(nodeId);
  writeNodeEffects(nodeId, [...effects, { id: `fx_${(seq += 1)}`, type, amount: def.default }]);
}

export function updateEffect(nodeId: string, effectId: string, amount: number): void {
  writeNodeEffects(nodeId, getNodeEffects(nodeId).map((e) => (e.id === effectId ? { ...e, amount } : e)));
}

export function removeEffect(nodeId: string, effectId: string): void {
  writeNodeEffects(nodeId, getNodeEffects(nodeId).filter((e) => e.id !== effectId));
}

/** Toggle an effect's enabled state (keeps it in the stack). */
export function toggleEffect(nodeId: string, effectId: string): void {
  writeNodeEffects(
    nodeId,
    getNodeEffects(nodeId).map((e) => (e.id === effectId ? { ...e, enabled: e.enabled === false } : e)),
  );
}

/** Move an effect up (-1) or down (+1) in the stack — order changes the look
 *  because filters compose left-to-right. Pure reorder helper is exported too. */
export function moveEffect(nodeId: string, effectId: string, dir: -1 | 1): void {
  writeNodeEffects(nodeId, reorderEffects(getNodeEffects(nodeId), effectId, dir));
}

/** Pure: return a new stack with `effectId` moved by `dir`, clamped at the ends. */
export function reorderEffects(effects: ReadonlyArray<Effect>, effectId: string, dir: -1 | 1): Effect[] {
  const list = [...effects];
  const i = list.findIndex((e) => e.id === effectId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return list;
  [list[i], list[j]] = [list[j]!, list[i]!];
  return list;
}
