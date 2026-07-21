/**
 * Lottie import — apply layer. Realises a pure ImportPlan against the live
 * scene: creates nodes (path layers via insertPathNode, the rest via the AI
 * ToolContext facade), writes static props + transform keyframes, attaches
 * animated outlines as `path.points` data tracks, and wires parent links.
 *
 * Keyframe times are composition seconds; they're converted to layer time per
 * node (imported layers start at 0, so this is usually identity, but the
 * conversion keeps trimmed/retimed layers correct).
 */

import type { ToolContext } from '@motion/ai-tools';
import { defaultAnimation, type DataPoint } from '@motion/animation';
import { insertPathNode } from '@core/scene/sceneInsert';
import type { ImportPlan, PlannedKind, PlannedLayer } from './lottieImport';

/** Facade `create` accepts these kind strings; map plan kinds onto them. */
function facadeKind(kind: PlannedKind): string {
  return kind; // 'shape' | 'text' | 'image' | 'null' | 'solid' align with makeNode/SPECIAL_INSERTERS
}

function toBezierPoints(pts: DataPoint[]): Array<{ x: number; y: number; inX: number; inY: number; outX: number; outY: number }> {
  return pts.map((p) => ({
    x: p.x,
    y: p.y,
    inX: p.inX ?? p.x,
    inY: p.inY ?? p.y,
    outX: p.outX ?? p.x,
    outY: p.outY ?? p.y,
  }));
}

function createLayer(L: PlannedLayer, ctx: ToolContext, ox: number, oy: number): string {
  if (L.pointsTrack) {
    const first = (L.pointsTrack.keyframes[0]?.value as DataPoint[] | undefined) ?? [];
    return insertPathNode(L.name, toBezierPoints(first), { closed: L.pointsTrack.closed, x: L.x + ox, y: L.y + oy });
  }
  return ctx.scene.create(facadeKind(L.kind), L.name, { x: L.x + ox, y: L.y + oy });
}

export interface ApplyImportOptions {
  /** Resize the active comp to the Lottie's size/fps/duration (default true —
   *  a full-file import IS the comp). Library drop-ins pass false to leave the
   *  user's comp untouched. */
  updateComp?: boolean;
  /** Translate every imported layer (root layers + their x/y tracks) — lets a
   *  small bundled animation land centred in a larger comp. */
  offset?: { x: number; y: number };
}

export function applyImportPlan(
  plan: ImportPlan,
  ctx: ToolContext,
  opts: ApplyImportOptions = {},
): { nodeIds: string[]; warnings: string[] } {
  if (opts.updateComp !== false) {
    ctx.comp.update({
      width: plan.comp.width,
      height: plan.comp.height,
      fps: plan.comp.fps,
      durationSeconds: plan.comp.durationSeconds,
    });
  }
  const ox = opts.offset?.x ?? 0;
  const oy = opts.offset?.y ?? 0;

  const idByInd = new Map<number, string>();
  const nodeIds: string[] = [];

  // Pass 1 — create nodes, write props + tracks.
  for (const L of plan.layers) {
    // Offsets shift ROOT layers only — parented layers are parent-relative
    // (their world position moves with the offset parent).
    const isRoot = L.parentInd === undefined;
    const lox = isRoot ? ox : 0;
    const loy = isRoot ? oy : 0;
    const nodeId = createLayer(L, ctx, lox, loy);
    if (!nodeId) continue; // facade could not create this kind — skip, keep going
    idByInd.set(L.ind, nodeId);
    nodeIds.push(nodeId);

    for (const [prop, value] of Object.entries(L.staticProps)) ctx.scene.setProp(nodeId, prop, value);

    for (const tr of L.scalarTracks) {
      const shift = tr.prop === 'x' ? lox : tr.prop === 'y' ? loy : 0;
      for (const kf of tr.keyframes) {
        const lt = ctx.time.toLayerTime(nodeId, kf.t);
        ctx.anim.setKeyframe(nodeId, tr.prop, lt, kf.value + shift, kf.easing);
        if (kf.easing === 'bezier' && kf.bezier) ctx.anim.setBezier(nodeId, tr.prop, lt, kf.bezier);
      }
    }

    if (L.pointsTrack && L.pointsTrack.keyframes.length > 1) {
      // Animated outline — the renderer samples this via `path.points`
      // (buildSnapshot's animated-outline hook). Times are layer time; imported
      // layers begin at 0 so comp time == layer time here.
      defaultAnimation.setDataTrack(nodeId, 'path.points', {
        nodeId,
        prop: 'path.points',
        kind: 'points',
        keyframes: L.pointsTrack.keyframes,
      });
    }
  }

  // Pass 2 — parent links (all ids now exist).
  for (const L of plan.layers) {
    if (L.parentInd === undefined) continue;
    const child = idByInd.get(L.ind);
    const parent = idByInd.get(L.parentInd);
    if (child && parent) ctx.scene.reparent(child, parent);
  }

  return { nodeIds, warnings: plan.warnings };
}
