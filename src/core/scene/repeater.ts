/**
 * Shape Repeater — duplicate a layer into N copies,
 * each offset from the previous by a transform. Composed iteratively (AE-style)
 * so a rotation offset makes the copies sweep an arc/circle/spiral rather than
 * a straight line — the core of generative motion graphics.
 *
 * Config lives on the layer's `fx` component, but every numeric parameter is
 * also keyframeable under `rep.<param>` (buildSnapshot reads `av.get(path) ??
 * static`), so an ANIMATED repeater (growing copies, spinning spiral…) is one
 * keyframe away.
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';

export interface Repeater {
  /** Number of copies (includes the original). */
  copies: number;
  /** Per-copy position offset, comp px. */
  offsetX: number;
  offsetY: number;
  /** Per-copy rotation offset, degrees (drives arcs/spirals). */
  offsetRotation: number;
  /** Per-copy scale multiplier (1 = no change). */
  offsetScale: number;
  /** Per-copy opacity multiplier (1 = no change). */
  offsetOpacity: number;
  /**
   * AE's Repeater "Offset" — shift the whole transform ladder by this many
   * copies, so copy 0 starts part-way along it. Fractional and negative values
   * are allowed (a fractional offset interpolates between rungs), which is what
   * lets a repeater be animated to march along its own path.
   */
  offset?: number;
  /**
   * Pivot for the per-copy rotation and scale, in layer-local px. Zero (the
   * default, and everything authored before this existed) pivots each copy
   * about its own origin — which is why a rotation offset used to trace a
   * circle of one fixed radius and nothing else.
   */
  anchorX?: number;
  anchorY?: number;
  /**
   * Whether the copies stack above or below the original.
   *
   * Defaults to `'above'`, which is what this renderer has always done — NOT
   * AE's default of `'below'`. Matching AE here would silently restack every
   * existing repeater, so the AE default is offered, not imposed.
   */
  composite?: RepeaterComposite;
}

export type RepeaterComposite = 'above' | 'below';

export interface RepeaterCopy {
  index: number;
  /** Cumulative offset from the base layer, comp space. */
  dx: number;
  dy: number;
  /** Cumulative rotation offset, degrees. */
  drot: number;
  /** Cumulative scale / opacity multipliers. */
  scaleMul: number;
  opacityMul: number;
}

/**
 * The keyframeable parameters. `composite` is absent on purpose — it is a
 * discrete stacking choice, and interpolating it would mean a frame where the
 * copies are halfway between in front of and behind the original.
 */
export const REPEATER_PARAMS = [
  'copies',
  'offsetX',
  'offsetY',
  'offsetRotation',
  'offsetScale',
  'offsetOpacity',
  'offset',
  'anchorX',
  'anchorY',
] as const;
export type RepeaterParam = (typeof REPEATER_PARAMS)[number];

export function repeaterPropPath(param: RepeaterParam): string {
  return `rep.${param}`;
}

export function defaultRepeater(): Repeater {
  return {
    copies: 6, offsetX: 80, offsetY: 0, offsetRotation: 0, offsetScale: 1, offsetOpacity: 1,
    offset: 0, anchorX: 0, anchorY: 0, composite: 'above',
  };
}

const DEG = Math.PI / 180;

/**
 * One rung of the transform ladder, at an INTEGER rung number (which may be
 * negative — a negative Offset walks the ladder backwards). Each step adds the
 * offset *in its accumulated rotation frame*, so a pure rotation offset traces
 * a regular polygon / circle. Pure.
 */
function ladderAtInteger(rep: Repeater, k: number): RepeaterCopy {
  let x = 0;
  let y = 0;
  let rot = 0;
  let scale = 1;
  let op = 1;
  const steps = Math.abs(k);
  const dir = k < 0 ? -1 : 1;
  for (let i = 0; i < steps; i++) {
    if (dir > 0) {
      rot += rep.offsetRotation;
      const rad = rot * DEG;
      x += rep.offsetX * Math.cos(rad) - rep.offsetY * Math.sin(rad);
      y += rep.offsetX * Math.sin(rad) + rep.offsetY * Math.cos(rad);
      scale *= rep.offsetScale;
      op *= rep.offsetOpacity;
    } else {
      // Exact inverse of a forward step, so ladderAtInteger(-1) undoes
      // ladderAtInteger(1) rather than approximating it.
      const rad = rot * DEG;
      x -= rep.offsetX * Math.cos(rad) - rep.offsetY * Math.sin(rad);
      y -= rep.offsetX * Math.sin(rad) + rep.offsetY * Math.cos(rad);
      rot -= rep.offsetRotation;
      scale = rep.offsetScale === 0 ? 0 : scale / rep.offsetScale;
      op = rep.offsetOpacity === 0 ? 0 : op / rep.offsetOpacity;
    }
  }
  return { index: k, dx: x, dy: y, drot: rot, scaleMul: scale, opacityMul: op };
}

/**
 * The ladder at any real rung. Between rungs it interpolates, so an animated
 * Offset slides the copies smoothly along the ladder instead of stepping.
 */
function ladderAt(rep: Repeater, k: number): RepeaterCopy {
  const lo = Math.floor(k);
  const f = k - lo;
  const a = ladderAtInteger(rep, lo);
  if (f === 0) return a;
  const b = ladderAtInteger(rep, lo + 1);
  const mix = (u: number, v: number): number => u + (v - u) * f;
  return {
    index: k,
    dx: mix(a.dx, b.dx),
    dy: mix(a.dy, b.dy),
    drot: mix(a.drot, b.drot),
    scaleMul: mix(a.scaleMul, b.scaleMul),
    opacityMul: mix(a.opacityMul, b.opacityMul),
  };
}

/**
 * Cumulative per-copy transforms, in PAINT ORDER — index 0 first.
 *
 * With `composite: 'below'` the list is reversed, so the ladder still runs
 * 0..n-1 but the original ends up painted last (on top). The caller emits in
 * list order and does not need to know which mode is active: one reader.
 */
export function repeaterCopies(rep: Repeater): RepeaterCopy[] {
  const n = Math.max(1, Math.floor(rep.copies));
  const start = rep.offset ?? 0;
  const ax = rep.anchorX ?? 0;
  const ay = rep.anchorY ?? 0;
  const out: RepeaterCopy[] = [];
  for (let i = 0; i < n; i++) {
    const rung = ladderAt(rep, i + start);
    // Pivot the copy's rotation/scale about the repeater anchor instead of the
    // layer origin. Rotating a point about A is A + R(p − A); the layer origin
    // is p = 0, so the whole correction is the translation A − R·s·A. It
    // vanishes at A = 0, which is why an existing repeater is untouched.
    if (ax !== 0 || ay !== 0) {
      const rad = rung.drot * DEG;
      const c = Math.cos(rad) * rung.scaleMul;
      const s = Math.sin(rad) * rung.scaleMul;
      rung.dx += ax - (c * ax - s * ay);
      rung.dy += ay - (s * ax + c * ay);
    }
    rung.index = i;
    out.push(rung);
  }
  if (rep.composite === 'below') out.reverse();
  return out;
}

// ── Scene integration ────────────────────────────────────────────────

function fxProps(node: SceneNode): Record<string, unknown> | undefined {
  return node.components.find((c) => c.type === 'fx')?.props as Record<string, unknown> | undefined;
}

const num = (v: unknown, fb: number): number => (typeof v === 'number' ? v : fb);

/** The static repeater config on a node, or null when none. */
export function readRepeaterConfig(node: SceneNode): Repeater | null {
  const raw = fxProps(node)?.repeater;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Repeater>;
  const d = defaultRepeater();
  return {
    copies: num(r.copies, d.copies),
    offsetX: num(r.offsetX, d.offsetX),
    offsetY: num(r.offsetY, d.offsetY),
    offsetRotation: num(r.offsetRotation, d.offsetRotation),
    offsetScale: num(r.offsetScale, d.offsetScale),
    offsetOpacity: num(r.offsetOpacity, d.offsetOpacity),
    // All four default to the no-op value, so a repeater authored before these
    // existed reads back as the identical arrangement it always drew. That is
    // what keeps this additive instead of a schema migration.
    offset: num(r.offset, 0),
    anchorX: num(r.anchorX, 0),
    anchorY: num(r.anchorY, 0),
    composite: r.composite === 'below' ? 'below' : 'above',
  };
}

/** True when the layer has an active repeater (2+ copies). */
export function hasRepeater(node: SceneNode): boolean {
  const r = readRepeaterConfig(node);
  return !!r && r.copies > 1;
}

/** Resolve the repeater for a frame, overriding params with animated values. */
export function resolveRepeater(node: SceneNode, av: Map<string, number> | undefined): Repeater | null {
  const base = readRepeaterConfig(node);
  if (!base) return null;
  const v = (p: RepeaterParam, fb: number): number => av?.get(repeaterPropPath(p)) ?? fb;
  return {
    copies: v('copies', base.copies),
    offsetX: v('offsetX', base.offsetX),
    offsetY: v('offsetY', base.offsetY),
    offsetRotation: v('offsetRotation', base.offsetRotation),
    offsetScale: v('offsetScale', base.offsetScale),
    offsetOpacity: v('offsetOpacity', base.offsetOpacity),
    offset: v('offset', base.offset ?? 0),
    anchorX: v('anchorX', base.anchorX ?? 0),
    anchorY: v('anchorY', base.anchorY ?? 0),
    // Discrete, so it is read straight from the config and never sampled.
    composite: base.composite ?? 'above',
  };
}

/** Add / update / clear the repeater config on a layer. */
export function setRepeater(nodeId: string, rep: Repeater | null): void {
  defaultSceneGraph.setRepeater(nodeId, rep ?? undefined);
  bumpScene();
}

/** Patch fields of a layer's repeater (creating a default one if absent). */
export function updateRepeater(nodeId: string, patch: Partial<Repeater>): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const base = readRepeaterConfig(node) ?? defaultRepeater();
  setRepeater(nodeId, { ...base, ...patch });
}
