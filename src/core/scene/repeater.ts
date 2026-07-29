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
}

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

export const REPEATER_PARAMS = [
  'copies',
  'offsetX',
  'offsetY',
  'offsetRotation',
  'offsetScale',
  'offsetOpacity',
] as const;
export type RepeaterParam = (typeof REPEATER_PARAMS)[number];

export function repeaterPropPath(param: RepeaterParam): string {
  return `rep.${param}`;
}

export function defaultRepeater(): Repeater {
  return { copies: 6, offsetX: 80, offsetY: 0, offsetRotation: 0, offsetScale: 1, offsetOpacity: 1 };
}

const DEG = Math.PI / 180;

/**
 * Cumulative per-copy transforms. Copy 0 is the original (zero offset); each
 * subsequent copy adds the offset *in its accumulated rotation frame*, so a
 * pure rotation offset traces a regular polygon / circle. Pure.
 */
export function repeaterCopies(rep: Repeater): RepeaterCopy[] {
  const n = Math.max(1, Math.floor(rep.copies));
  const out: RepeaterCopy[] = [{ index: 0, dx: 0, dy: 0, drot: 0, scaleMul: 1, opacityMul: 1 }];
  let x = 0;
  let y = 0;
  let rot = 0;
  let scale = 1;
  let op = 1;
  for (let i = 1; i < n; i++) {
    rot += rep.offsetRotation;
    const rad = rot * DEG;
    x += rep.offsetX * Math.cos(rad) - rep.offsetY * Math.sin(rad);
    y += rep.offsetX * Math.sin(rad) + rep.offsetY * Math.cos(rad);
    scale *= rep.offsetScale;
    op *= rep.offsetOpacity;
    out.push({ index: i, dx: x, dy: y, drot: rot, scaleMul: scale, opacityMul: op });
  }
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
