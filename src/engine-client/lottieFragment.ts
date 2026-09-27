/**
 * A Lottie import as an ENGINE CLIENT (docs/TS_ENGINE_REMOVAL.md "Importers …
 * become command-batch clients"): the importer's plan (lottieImport.ts
 * `planLottieImport`, pure) laid into a {@link FragmentBuilder} and sent as
 * ONE `pasteLayers` — no scene graph, no animation engine, no store.
 *
 * It builds exactly what `applyImportPlan` (lottieImportApply.ts) builds when
 * it runs off-document (offDocument.ts `buildLayerFragment`): the same rows,
 * components, fx paints / strokes / trim operators / mattes, keyframe tracks,
 * `path.points` data tracks, parent links and clip bars — pinned by
 * lottieFragment.test.ts against the off-document build of every bundled
 * Lottie. So the import works against either engine without the TypeScript
 * one's scratch state, and the off-document path can go with it.
 *
 * Order: `applyImportPlan` builds in DRAW order (the plan reversed: Lottie's
 * first layer is the top one) and reparents in that order too — a reparent
 * appends, which is what fixes each parent's child stacking. The builder's
 * `addChild` / `reparent` have the same append semantics, so the same walk
 * gives the same fragment.
 */

import type { DataPoint } from '@motion/animation';
import type { ImportPlan, PlannedFill, PlannedLayer, PlannedScalarTrack } from '@core/lottie/lottieImport';
import { makeStop, type FillPaint, type OpacityStop } from '@core/paint/fill';
import { defaultStroke } from '@core/paint/stroke';
import { defaultTrimOp, pathOpPropPath } from '@core/scene/pathOps';
import { FragmentBuilder, KIND_PROP, type BuiltFragment, type FragmentComponent, type FragmentKeyframe } from './fragmentBuilder';

export interface LottieFragmentOptions {
  /** Translate every ROOT layer (and its x / y tracks): where the design centre lands. */
  offset?: { x: number; y: number };
  /** The target composition's rate — clip bars are in its frames. */
  compFps: number;
  /** The target composition's length in seconds (a new layer's default bar is the whole comp). */
  compDurationSeconds: number;
  /** Scratch-id namespace. */
  idPrefix?: string;
}

export interface LottieFragment {
  built: BuiltFragment | null;
  warnings: string[];
}

interface BezierPoint {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
}

function toBezierPoints(pts: readonly DataPoint[]): BezierPoint[] {
  return pts.map((p) => ({ x: p.x, y: p.y, inX: p.inX ?? p.x, inY: p.inY ?? p.y, outX: p.outX ?? p.x, outY: p.outY ?? p.y }));
}

/** sceneInsert.ts outlineExtent: the box centred on the layer origin that holds every point and handle. */
function outlineExtent(points: readonly BezierPoint[]): { width: number; height: number } {
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx = Math.max(mx, Math.abs(p.x), Math.abs(p.inX), Math.abs(p.outX));
    my = Math.max(my, Math.abs(p.y), Math.abs(p.inY), Math.abs(p.outY));
  }
  return { width: mx * 2, height: my * 2 };
}

/** lottieImportApply.ts toFillPaint. */
function toFillPaint(f: PlannedFill): FillPaint {
  if (f.type === 'solid') return { type: 'solid', color: f.color };
  const stops = (f.stops ?? []).map((s) => makeStop(s.offset, s.color));
  const opacityStops: OpacityStop[] | undefined = f.opacityStops
    ? f.opacityStops.map((s, i) => ({ id: `lot_op_${i}`, offset: s.offset, opacity: s.opacity * f.opacity }))
    : f.opacity < 1
      ? [{ id: 'lot_op_0', offset: 0, opacity: f.opacity }, { id: 'lot_op_1', offset: 1, opacity: f.opacity }]
      : undefined;
  if (f.type === 'linear') {
    return { type: 'linear', angle: f.angle ?? 90, stops, ...(opacityStops ? { opacityStops } : {}) };
  }
  return { type: 'radial', cx: f.cx ?? 0.5, cy: f.cy ?? 0.5, radius: f.radius ?? 0.5, stops, ...(opacityStops ? { opacityStops } : {}) };
}

/** The Transform props every new layer starts with (makeNode / makeLegacyNode). */
function baseTransform(kind: string, x: number, y: number): Record<string, unknown> {
  return { [KIND_PROP]: kind, x, y, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0 };
}

/**
 * The components of a layer the facade's `create` makes (lottieDocumentContext.ts
 * makeLegacyNode) — or, for an outline, `insertPathNode`'s shape.
 */
function layerComponents(L: PlannedLayer, id: string, x: number, y: number): FragmentComponent[] {
  if (L.pointsTrack) {
    let width = 0;
    let height = 0;
    for (const kf of L.pointsTrack.keyframes) {
      const e = outlineExtent(toBezierPoints((kf.value as DataPoint[] | undefined) ?? []));
      width = Math.max(width, e.width);
      height = Math.max(height, e.height);
    }
    const first = toBezierPoints((L.pointsTrack.keyframes[0]?.value as DataPoint[] | undefined) ?? []);
    return [
      { id: `${id}_t`, type: 'Transform', props: { ...baseTransform('shape', x, y), width, height, shapeType: 'path' } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#3b8276' } },
      { id: `${id}_g`, type: 'Geometry', props: { points: first, ...(L.pointsTrack.closed === false ? { open: true } : {}) } },
    ];
  }
  if (L.kind === 'text') {
    return [
      { id: `${id}_t`, type: 'Transform', props: baseTransform('text', x, y) },
      { id: `${id}_c`, type: 'Text', props: { content: L.name, fontSize: 32, opacity: 100 } },
    ];
  }
  if (L.kind === 'group' || L.kind === 'null') {
    return [{ id: `${id}_t`, type: 'Transform', props: baseTransform(L.kind, x, y) }];
  }
  return [
    { id: `${id}_t`, type: 'Transform', props: { ...baseTransform(L.kind, x, y), width: 220, height: 220, shapeType: 'rect' } },
    { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
  ];
}

/** propOwner.ts ownerOf: the component a static write lands on. */
function ownerType(components: readonly FragmentComponent[], prop: string): string | undefined {
  const has = (t: string): boolean => components.some((c) => c.type === t);
  if (['content', 'fontSize', 'fontWeight', 'fontFamily', 'letterSpacing', 'lineHeight', 'align', 'paragraphSpacing'].includes(prop)) {
    return has('Text') ? 'Text' : undefined;
  }
  if (prop === 'fill') return has('Style') ? 'Style' : has('Text') ? 'Text' : undefined;
  if (prop === 'opacity') return has('Style') ? 'Style' : has('Transform') ? 'Transform' : undefined;
  return has('Transform') ? 'Transform' : undefined;
}

/** sceneInsert / continuousRaster: a new vector layer rasterizes continuously (a flat rect does not). */
function wantsContinuousRaster(components: readonly FragmentComponent[]): boolean {
  const kind = components.find((c) => c.type === 'Transform')?.props[KIND_PROP];
  if (kind === 'text' || kind === 'svg') return true;
  if (kind !== 'shape') return false;
  return components.some((c) => c.type === 'Geometry');
}

const round = (n: number): number => Math.round(n);

/** Lay the plan into a fragment (applyImportPlan with `updateComp: false`). */
export function buildLottieFragment(plan: ImportPlan, opts: LottieFragmentOptions): LottieFragment {
  const b = new FragmentBuilder({ idPrefix: opts.idPrefix ?? 'lottie' });
  const ox = opts.offset?.x ?? 0;
  const oy = opts.offset?.y ?? 0;
  const idByUid = new Map<string, string>();
  const drawOrder = [...plan.layers].reverse();

  const toKeyframes = (planned: ReadonlyArray<PlannedScalarTrack['keyframes'][number]>, shift: number): FragmentKeyframe[] =>
    planned.map((kf) => ({
      t: kf.t,
      value: kf.value + shift,
      easing: kf.easing,
      ...(kf.easing === 'bezier' && kf.bezier ? { bezier: kf.bezier } : {}),
    }));

  // Pass 1 — layers, static props, paints, tracks.
  for (const L of drawOrder) {
    const isRoot = L.parentUid === undefined;
    const lox = isRoot ? ox : 0;
    const loy = isRoot ? oy : 0;
    const id = b.newId(L.pointsTrack ? 'shape' : L.kind);
    const x = L.x + lox;
    const y = L.y + loy;
    const components = layerComponents(L, id, x, y);
    b.addChild(null, { id, name: L.name, components, visible: true, locked: false });
    idByUid.set(L.uid, id);
    if (L.pointsTrack && wantsContinuousRaster(components)) b.setFx(id, 'continuousRasterize', true);

    for (const [prop, value] of Object.entries(L.staticProps)) {
      const owner = ownerType(b.row(id).components, prop);
      if (owner) b.setProp(id, owner, prop, value);
    }
    if (L.fill) {
      b.setFx(id, 'fill', {
        ...toFillPaint(L.fill),
        ...(L.fill.blendMode ? { blendMode: L.fill.blendMode } : {}),
        ...(L.fill.composite === 'above' ? { composite: 'above' as const } : {}),
      });
    }
    if (L.stroke && L.stroke.width > 0) {
      const st = L.stroke;
      b.setFx(id, 'stroke', {
        ...defaultStroke(st.color),
        width: st.width,
        opacity: st.opacity,
        ...(st.cap ? { cap: st.cap } : {}),
        ...(st.join ? { join: st.join } : {}),
        ...(st.miterLimit !== undefined ? { miterLimit: st.miterLimit } : {}),
        ...(st.dash ? { dash: st.dash } : {}),
        ...(st.dashOffset !== undefined ? { dashOffset: st.dashOffset } : {}),
        ...(st.paint ? { paint: toFillPaint(st.paint) } : {}),
        ...(st.paint && st.gradient ? { gradient: st.gradient } : {}),
        ...(st.blendMode ? { blendMode: st.blendMode } : {}),
      });
    }
    for (const tr of L.scalarTracks) {
      const shift = tr.prop === 'x' ? lox : tr.prop === 'y' ? loy : 0;
      b.setKeyframes(id, tr.prop, toKeyframes(tr.keyframes, shift));
    }
    if (L.stroke && L.stroke.width > 0) {
      for (const tr of L.stroke.tracks ?? []) b.setKeyframes(id, tr.prop, toKeyframes(tr.keyframes, 0));
    }
    if (L.trim && L.kind === 'shape') {
      const op = { ...defaultTrimOp(), start: L.trim.start, end: L.trim.end, offset: L.trim.offset, trimMultipleShapes: L.trim.multiple };
      const fx = b.component(id, 'fx')?.props;
      const ops = Array.isArray(fx?.pathOps) ? (fx.pathOps as unknown[]) : [];
      b.setFx(id, 'pathOps', [...ops, op]);
      for (const tr of L.trim.tracks) {
        const param = tr.prop.slice('trim.'.length) as 'start' | 'end' | 'offset';
        b.setKeyframes(id, pathOpPropPath(op.id, param), toKeyframes(tr.keyframes, 0));
      }
    }
    if (L.pointsTrack && L.pointsTrack.keyframes.length > 1) {
      b.setDataTrack(id, 'path.points', 'points', L.pointsTrack.keyframes.map((k) => ({ ...k })));
    }
    // A new layer's bar is the whole comp; lottieLibrary.ts applyClipTimings
    // trims it to the layer's window (never to nothing — a window that ends
    // before it starts leaves the whole bar).
    const compFrames = round(opts.compDurationSeconds * opts.compFps);
    let start = 0;
    let end = compFrames;
    if (L.timing && L.timing.outSec > L.timing.inSec) {
      const s = Math.max(0, round(L.timing.inSec * opts.compFps));
      const e = Math.min(compFrames, round(L.timing.outSec * opts.compFps));
      if (e > s) {
        start = s;
        end = e;
      }
    }
    b.setBars(id, [{ start, duration: end - start, sourceIn: start, sourceDuration: null }]);
  }

  // Pass 2 — parent links (plan transforms are already parent-relative).
  for (const L of drawOrder) {
    if (L.parentUid === undefined) continue;
    const child = idByUid.get(L.uid);
    const parent = idByUid.get(L.parentUid);
    if (child && parent) b.reparent(child, parent);
  }

  // Pass 3 — track mattes and hidden matte sources.
  for (const L of plan.layers) {
    const id = idByUid.get(L.uid);
    if (!id) continue;
    if (L.matte) {
      const sourceId = idByUid.get(L.matte.sourceUid);
      if (sourceId) b.setFx(id, 'matte', { ...L.matte.matte, sourceId });
    }
    if (L.hidden) b.row(id).visible = false;
  }

  return { built: b.build(), warnings: plan.warnings };
}
