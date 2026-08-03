/**
 * Lottie import — apply layer. Realises a pure ImportPlan against the live
 * scene: creates nodes (path layers via insertPathNode, the rest via the AI
 * ToolContext facade), writes static props + transform keyframes, attaches
 * animated outlines as `path.points` data tracks, resolves paints (solid,
 * gradient, stroke), and wires parent links.
 *
 * Keyframe times are composition seconds; they're converted to layer time per
 * node (imported layers start at 0, so this is usually identity, but the
 * conversion keeps trimmed/retimed layers correct).
 *
 * **Keyframes are written in bulk.** `setKeyframe` re-sorts the track and fires
 * a synchronous app-wide change notification PER CALL, so a keyframe-dense rig —
 * the whole reason this importer exists — used to wedge the main thread for as
 * long as the import took. Times are computed through the facade (so the layer-
 * time conversion is unchanged), then each track is written once inside one
 * engine batch.
 */

import type { ToolContext } from '@motion/ai-tools';
import { defaultAnimation, type DataPoint, type EasingKind, type Keyframe } from '@motion/animation';
import { insertPathNode, outlineExtent } from '@core/scene/sceneInsert';
import { setNodeFill, makeStop, type FillPaint, type OpacityStop } from '@core/paint/fill';
import { setNodeStroke, defaultStroke } from '@core/paint/stroke';
import { setNodeMatte } from '@core/effects/matte';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { ImportPlan, PlannedFill, PlannedKind, PlannedLayer } from './lottieImport';

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
    // The path box is static while the outline morphs, so it has to cover EVERY
    // frame of the morph — sized to frame 0 alone, a shape that grows would get
    // clipped by its own texture partway through the animation.
    let width = 0;
    let height = 0;
    for (const kf of L.pointsTrack.keyframes) {
      const e = outlineExtent(toBezierPoints((kf.value as DataPoint[] | undefined) ?? []));
      width = Math.max(width, e.width);
      height = Math.max(height, e.height);
    }
    return insertPathNode(L.name, toBezierPoints(first), {
      closed: L.pointsTrack.closed,
      x: L.x + ox,
      y: L.y + oy,
      width,
      height,
    });
  }
  // 'group' is the precomp / shape-group container — a null-like node others
  // parent under. It draws nothing, which is why a multi-shape host becomes one.
  return ctx.scene.create(facadeKind(L.kind), L.name, { x: L.x + ox, y: L.y + oy });
}

/** A planned paint → the engine's FillPaint. */
function toFillPaint(f: PlannedFill): FillPaint {
  if (f.type === 'solid') return { type: 'solid', color: f.color };
  const stops = (f.stops ?? []).map((s) => makeStop(s.offset, s.color));
  // Lottie's paint opacity is a single multiplier; the engine expresses that as
  // a flat opacity ramp, which composes with any ramp the file carried.
  const opacityStops: OpacityStop[] | undefined = f.opacityStops
    ? f.opacityStops.map((s, i) => ({ id: `lot_op_${i}`, offset: s.offset, opacity: s.opacity * f.opacity }))
    : f.opacity < 1
      ? [{ id: 'lot_op_0', offset: 0, opacity: f.opacity }, { id: 'lot_op_1', offset: 1, opacity: f.opacity }]
      : undefined;
  if (f.type === 'linear') {
    return { type: 'linear', angle: f.angle ?? 90, stops, ...(opacityStops ? { opacityStops } : {}) };
  }
  return {
    type: 'radial',
    cx: f.cx ?? 0.5,
    cy: f.cy ?? 0.5,
    radius: f.radius ?? 0.5,
    stops,
    ...(opacityStops ? { opacityStops } : {}),
  };
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

/** A layer's Lottie `ip`/`op` window, resolved to a live node. */
export interface AppliedTiming {
  nodeId: string;
  inSec: number;
  outSec: number;
}

export interface ApplyImportResult {
  nodeIds: string[];
  warnings: string[];
  /** Visibility windows the caller should turn into timeline clip bars (the
   *  timeline is not this module's concern — see lottieLibrary). */
  timings: AppliedTiming[];
}

export function applyImportPlan(
  plan: ImportPlan,
  ctx: ToolContext,
  opts: ApplyImportOptions = {},
): ApplyImportResult {
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

  const idByUid = new Map<string, string>();
  const nodeIds: string[] = [];
  const timings: AppliedTiming[] = [];
  /** (nodeId, prop) → the whole track, written in one shot after pass 1. */
  const tracks = new Map<string, { nodeId: string; prop: string; keyframes: Keyframe[] }>();

  // ── Z-ORDER: the plan is in FILE order, the scene is built in DRAW order ──
  //
  // Lottie stacks like After Effects: `layers[0]` is the TOP layer, and inside a
  // shape tree the first `it[]` entry is the top one. The scene graph is the
  // opposite — later siblings paint over earlier ones. Building in plan order
  // therefore turned every file inside out: in the user's "Book a call" export,
  // `main button` (the LAST layer, i.e. the background pill) was created last and
  // painted over the label, the green button, the light and the arrow, so the
  // import opened as a bare dark pill.
  //
  // Reversing the flat plan fixes every level at once: reversal inverts relative
  // order within any subset, so each parent's children come out inverted too.
  // Sibling order is set by CREATE order at the root and by REPARENT order below
  // it, so both passes walk the same reversed list.
  const drawOrder = [...plan.layers].reverse();

  // Pass 1 — create nodes, write props + collect tracks.
  for (const L of drawOrder) {
    // Offsets shift top-level ROOT layers only — nested/parented layers are
    // parent-relative (their world position moves with the offset parent).
    const isRoot = L.parentUid === undefined;
    const lox = isRoot ? ox : 0;
    const loy = isRoot ? oy : 0;
    const nodeId = createLayer(L, ctx, lox, loy);
    if (!nodeId) continue; // facade could not create this kind — skip, keep going
    idByUid.set(L.uid, nodeId);
    nodeIds.push(nodeId);

    for (const [prop, value] of Object.entries(L.staticProps)) ctx.scene.setProp(nodeId, prop, value);

    // Paints. A gradient goes on as a real gradient rather than being dropped:
    // dropping it left the node on the scene facade's PLACEHOLDER colour, which
    // is how a green button imported as blue.
    if (L.fill) setNodeFill(nodeId, toFillPaint(L.fill));
    if (L.stroke && L.stroke.width > 0) {
      setNodeStroke(nodeId, { ...defaultStroke(L.stroke.color), width: L.stroke.width, opacity: L.stroke.opacity });
    }

    for (const tr of L.scalarTracks) {
      const shift = tr.prop === 'x' ? lox : tr.prop === 'y' ? loy : 0;
      const key = `${nodeId} ${tr.prop}`;
      const kfs: Keyframe[] = tr.keyframes.map((kf) => ({
        // The facade owns the comp→layer time conversion; going through it
        // keeps this identical to the per-keyframe path it replaces.
        t: ctx.time.toLayerTime(nodeId, kf.t),
        value: kf.value + shift,
        easing: kf.easing as EasingKind,
        ...(kf.easing === 'bezier' && kf.bezier ? { bezier: kf.bezier } : {}),
      }));
      tracks.set(key, { nodeId, prop: tr.prop, keyframes: kfs });
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

    if (L.timing) timings.push({ nodeId, inSec: L.timing.inSec, outSec: L.timing.outSec });
  }

  // One bulk write per track, one notification for the lot.
  defaultAnimation.batch(() => {
    for (const t of tracks.values()) defaultAnimation.setKeyframes(t.nodeId, t.prop, t.keyframes);
  });

  // Pass 2 — parent links (all ids now exist). Uses uid, so precomp children
  // parent under their expanded group even though their Lottie `ind`s collide
  // with layers in other scopes.
  //
  // preserveWorld: false — the plan's child transforms are already PARENT-
  // relative (Lottie locals). The default world-preserving reparent would
  // recompute them to cancel the parent's transform, collapsing nested
  // content back to raw Lottie coords (usually off-frame → invisible).
  //
  // Reversed like pass 1: a reparent APPENDS, so this call order is what fixes
  // each parent's own child stacking.
  for (const L of drawOrder) {
    if (L.parentUid === undefined) continue;
    const child = idByUid.get(L.uid);
    const parent = idByUid.get(L.parentUid);
    if (child && parent) ctx.scene.reparent(child, parent, { preserveWorld: false });
  }

  // Pass 3 — track mattes, once every node exists to point at. `resolveMatteSources`
  // reads the explicit `sourceId` and flags that node `isMatteSource`, which is
  // what stops the renderer painting it onto the canvas.
  for (const L of plan.layers) {
    const nodeId = idByUid.get(L.uid);
    if (!nodeId) continue;
    if (L.matte) {
      const sourceId = idByUid.get(L.matte.sourceUid);
      if (sourceId) setNodeMatte(nodeId, { ...L.matte.matte, sourceId });
    }
    // A matte the engine could not take on. Lottie never paints a matte source,
    // so hide it rather than let a raw slab land over the artwork; the layers
    // panel still lists it, so the user can switch it back on to see what it was.
    if (L.hidden) {
      const node = defaultSceneGraph.getNode(nodeId);
      if (node) node.visible = false;
    }
  }

  return { nodeIds, warnings: plan.warnings, timings };
}
