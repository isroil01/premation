/**
 * Track Motion — the actions: everything the section's buttons DO, moved out
 * of `TrackMotionSection.tsx` verbatim (2026-09-04) so the component is the
 * view and this is the work.
 *
 * A plain function, not a hook: every handler closes over the same bag of
 * values the component used to hold in scope, handed in as `ctx`, and reads
 * the tracker store through `getState()` exactly as before. Nothing here
 * renders, so nothing here needs React.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { LayerInfo } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { useTrackerStore, type AutoPhase, type TrackerMode, type TrackerResult } from '@stores/trackerStore';
import { uiKindOf } from '@core/mirror/layerKinds';
import { canParentTo } from '@core/mirror/tracking';
import { trackVideoLayerPoints } from '@core/tracking/trackVideoLayer';
import { runAutoTrack } from '@core/tracking/autoTrackCommand';
import { smoothStabilizeVideoLayer } from '@core/tracking/smoothStabilize';
import {
  planCameraSolveTrack,
  planCornerPinTrack,
  planMeshWarpTrack,
  planStabilize,
  planTrackToCamera,
  planTrackToLayer,
  planTransformTrack,
  type TrackPlan,
} from '@core/tracking/applyTrack';
import { matteToPath } from '@core/tracking/rotoMatte';
import { grabCutMatte } from '@core/tracking/grabCut';
import { segmentSamSync } from '@core/tracking/samSegment';
import { edit } from '@core/engine/uiEdits';
import { isLayer } from '@core/engine/doc';
import { values } from '@core/engine/propRefs';
import {
  applyTrackPlanEdit,
  createNullAndApplyEdit,
  createNullsForPlanesEdit,
  solveCameraEdit,
} from './trackApplyEdits';
import { inOneEntry } from '../keySpliceEdits';
import { runRotoBrush } from '@core/tracking/rotoBrush';
import { runContentAwareFill } from '@core/effects/contentAwareFillVideo';
import { trackLayerMask } from '@core/tracking/maskTrack';
import { densifyQuad } from '@core/tracking/planarFit';
import { readGeometry } from '@core/workspace/geometry';
import { customConfirm } from '@components/Modal';
import { needsSelfApplyConfirm, selfApplyConfirmCopy } from './applyTargetGuard';

export type StabVariant = 'similarity' | 'subspace' | 'rolling-shutter';

/** A layer offered as the track's target (a mirror layer header). */
export type TrackTarget = Pick<LayerInfo, 'id' | 'name'>;

/** The composition the plans map into (its size; no root id — the plans then search the whole document, as they always have). */
export interface TrackComp {
  width: number;
  height: number;
  rootId?: string;
}

/** What the section knows when a button is pressed — the old closure scope. */
export interface TrackMotionContext {
  nodeId: string;
  targetId: string;
  setTargetId: (id: string) => void;
  mode: TrackerMode;
  points: ReadonlyArray<{ x: number; y: number }>;
  featureHalf: number;
  searchHalf: number;
  tracking: boolean;
  result: TrackerResult | null;
  autoPhase: AutoPhase;
  time: number;
  endCompTime: number;
  fps: number;
  durationSeconds: number;
  comp: TrackComp;
  src: { width: number; height: number } | null;
  stabVariant: StabVariant;
  /** Layers offered as the track's target, this layer among them. */
  targets: ReadonlyArray<TrackTarget>;
  /** Reported when "Create null & apply" lands, so the section can offer the
   *  follow-up (attach a layer) instead of a note asking the user to do it. */
  onNullCreated?: (nullId: string) => void;
}

export type TrackMotionActions = ReturnType<typeof trackMotionActions>;

 
export function trackMotionActions(ctx: TrackMotionContext) {
  const {
    nodeId, targetId, setTargetId, mode, points, featureHalf, searchHalf, tracking, result, autoPhase,
    time, endCompTime, fps, durationSeconds, comp, src, stabVariant, targets,
  } = ctx;
  const store = useTrackerStore;

  const targetName = (id: string): string =>
    targets.find((t) => t.id === id)?.name || (id === nodeId ? 'this layer' : id);

  const summarize = (tracks: { length: number }[], status: string, extra = ''): string => {
    const n = tracks[0]?.length ?? 0;
    const outcome =
      status === 'lost'
        ? 'lost — samples up to the loss are kept'
        : status === 'cancelled'
          ? 'cancelled'
          : 'completed';
    return `Tracked ${tracks.length} point${tracks.length === 1 ? '' : 's'} × ${n} frames (${outcome})${extra}`;
  };

  // ── One click ─────────────────────────────────────────────────────────

  const onArmPick = (): void => {
    store.getState().setAutoPhase(autoPhase === 'picking' ? 'idle' : 'picking');
  };

  /** Re-run on the feature already chosen — no second trip to the canvas. */
  const onTrackAgain = (): void => {
    const plan = store.getState().autoPlan;
    void runAutoTrack({ nodeId, ...(plan ? { hint: { x: plan.x, y: plan.y } } : {}) });
  };

  // Cancel works by clearing the flag the walk polls each frame; the command
  // then finishes normally and KEEPS what it measured.
  const onCancel = (): void => {
    store.getState().finishTracking(null, 'Stopping…');
  };

  /**
   * The canonical follow-up: a null carrying the motion, ready to parent to.
   *
   * `asTransform` uses the companion feature the analysis tracked alongside
   * the primary, so rotation and scale come from a walk that already happened
   * rather than a second pass over the clip.
   */
  const onCreateNullAndApply = async (asTransform = false): Promise<void> => {
    if (!result) return;
    const applyMode = asTransform ? 'transform' : mode;
    if (applyMode !== 'follow' && applyMode !== 'transform' && applyMode !== 'corner') return;
    if (applyMode === 'transform' && result.tracks.length < 2) return;
    const out = await createNullAndApplyEdit({
      videoNodeId: nodeId,
      mode: applyMode,
      samples: result.tracks[0] ?? [],
      tracks: result.tracks,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      comp,
    });
    if (!out) {
      store.getState().finishTracking(result, 'Could not create null.');
      return;
    }
    useSelectionStore.getState().set([out.nullId]);
    setTargetId(out.nullId);
    ctx.onNullCreated?.(out.nullId);
    store.getState().finishTracking(
      result,
      `Created a tracked null with ${out.keyframes} ${asTransform ? 'position, rotation & scale' : 'position'} keyframes.`,
    );
  };

  /**
   * The step the note used to ASK the user to do: parent a layer to the
   * tracked null. `setParent{keepWorldTransform}` preserves the child's world
   * pose (AE's default Parent & Link), so attaching never jumps the layer — it
   * simply starts following.
   */
  const onAttachToNull = async (childId: string, nullId: string): Promise<void> => {
    const m = documentMirror();
    const nullName = m.layer(nullId)?.name || nullId;
    const ok = isLayer(childId) && isLayer(nullId) && canParentTo(m, childId, nullId)
      && (await edit('Parent', { type: 'setParent', layers: [childId], parent: nullId, keepWorldTransform: true }, { quiet: true })).ok;
    store.getState().finishTracking(
      result,
      ok
        ? `Parented ${targetName(childId)} to ${nullName} — it now follows the track.`
        : 'Could not parent that layer — the move would create a loop.',
    );
  };

  // ── Manual track / apply ──────────────────────────────────────────────

  const onTrack = async (): Promise<void> => {
    if (tracking) return;
    store.getState().beginTracking();
    try {
      if (mode === 'mask') {
        // Mask mode tracks AND applies in one action — its points come from
        // the mask, and the result has nowhere else to go.
        const r = await trackLayerMask({
          nodeId,
          startCompTime: time,
          endCompTime,
          fps,
          featureHalf,
          searchHalf,
          onProgress: (f) => {
            store.getState().setProgress(f);
            return store.getState().tracking;
          },
        });
        store.getState().finishTracking(
          null,
          r.sampled < r.vertices
            ? `Tracked ${r.sampled} of ${r.vertices} mask vertices (the rest follow their neighbours), wrote ${r.keyframes} mask keyframes (${r.status}).`
            : `Tracked ${r.vertices} mask vertices, wrote ${r.keyframes} mask keyframes (${r.status}).`,
        );
        return;
      }
      if (mode === 'smooth') {
        // Like mask mode, smooth tracks AND applies in one action — its
        // "points" are the whole flow grid, and the result is keyframes.
        const r = await smoothStabilizeVideoLayer({
          nodeId,
          startCompTime: time,
          endCompTime,
          fps,
          comp,
          variant: stabVariant,
          onProgress: (f: number) => store.getState().setProgress(f),
        });
        store.getState().finishTracking(
          null,
          `Stabilized (${stabVariant}): fitted ${r.fittedPairs}/${r.totalPairs} frame pairs, wrote ${r.keyframes} keyframes.`,
        );
        return;
      }
      // Dense planar grid: the user's handles define the quad; the lattice of
      // derived features inside it is what makes the RANSAC fit in
      // applyCornerPinTrack overdetermined enough to outvote occlusion.
      const stored = store.getState().points;
      const pts = mode === 'corner' && store.getState().dense ? densifyQuad(stored) : stored;
      const r = await trackVideoLayerPoints({
        nodeId,
        startCompTime: time,
        endCompTime,
        fps,
        points: pts,
        featureHalf,
        searchHalf,
        onProgress: (f) => {
          store.getState().setProgress(f);
          return store.getState().tracking; // cleared store = cancelled
        },
      });
      const coasted = r.tracks.flat().filter((s) => s.coasted).length;
      store.getState().finishTracking(
        { tracks: r.tracks, sourceWidth: r.sourceWidth, sourceHeight: r.sourceHeight, status: r.status },
        summarize(r.tracks, r.status, coasted > 0 ? ` · ${coasted} coasted` : ''),
      );
    } catch (e) {
      store.getState().finishTracking(null, e instanceof Error ? e.message : String(e));
    }
  };

  const onApply = async (): Promise<void> => {
    if (!result) return;
    // Applying the forward track to the FOOTAGE itself moves the footage
    // under its own track — the accident applyTargetGuard.ts describes. One
    // confirm, offering the null; every other target applies as before.
    if (needsSelfApplyConfirm({ mode, targetId, sourceId: nodeId })) {
      const copy = selfApplyConfirmCopy({ mode, layerName: targetName(targetId) });
      const makeNull = await customConfirm(copy.title, copy.message, { confirmLabel: copy.confirmLabel });
      if (makeNull) await onCreateNullAndApply();
      else store.getState().finishTracking(result, 'Not applied — choose another layer to receive the track.');
      return;
    }
    let plan: TrackPlan | null = null;
    let what = '';
    const targetIsCamera = uiKindOf(documentMirror().layer(targetId)) === 'camera';
    if (mode === 'follow') {
      if (targetIsCamera) {
        plan = planTrackToCamera({
          videoNodeId: nodeId,
          targetNodeId: targetId,
          samples: result.tracks[0] ?? [],
          sourceWidth: result.sourceWidth,
          sourceHeight: result.sourceHeight,
          comp,
        });
        what = `camera position + look-at to “${targetName(targetId)}”`;
      } else {
        plan = planTrackToLayer({
          videoNodeId: nodeId,
          targetNodeId: targetId,
          samples: result.tracks[0] ?? [],
          sourceWidth: result.sourceWidth,
          sourceHeight: result.sourceHeight,
          comp,
        });
        what = `position keyframes to “${targetName(targetId)}”`;
      }
    } else if (mode === 'transform') {
      if (targetIsCamera) {
        plan = planCameraSolveTrack({
          videoNodeId: nodeId,
          targetNodeId: targetId,
          tracks: result.tracks,
          sourceWidth: result.sourceWidth,
          sourceHeight: result.sourceHeight,
          comp,
        });
        what = `camera solve (position + orientation) to “${targetName(targetId)}”`;
      } else {
        plan = planTransformTrack({
          videoNodeId: nodeId,
          targetNodeId: targetId,
          tracks: result.tracks,
          sourceWidth: result.sourceWidth,
          sourceHeight: result.sourceHeight,
          comp,
        });
        what = `position/rotation/scale keyframes to “${targetName(targetId)}”`;
      }
    } else if (mode === 'stabilize') {
      plan = planStabilize({
        videoNodeId: nodeId,
        samples: result.tracks[0] ?? [],
        sourceWidth: result.sourceWidth,
        sourceHeight: result.sourceHeight,
        comp,
      });
      what = 'stabilizing keyframes to this layer';
    } else if (mode === 'corner') {
      plan = planCornerPinTrack({
        videoNodeId: nodeId,
        targetNodeId: targetId,
        tracks: result.tracks,
        sourceWidth: result.sourceWidth,
        sourceHeight: result.sourceHeight,
        comp,
      });
      what = `corner-pin keyframes to “${targetName(targetId)}”`;
    }
    const n = await applyTrackPlanEdit(plan);
    store.getState().finishTracking(result, n > 0 ? `Applied ${n} ${what}.` : 'Nothing to apply.');
  };

  const onApplyMesh = async (): Promise<void> => {
    if (!result || mode !== 'corner') return;
    const n = await applyTrackPlanEdit(planMeshWarpTrack({
      videoNodeId: nodeId,
      targetNodeId: targetId,
      tracks: result.tracks,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      comp,
    }));
    store.getState().finishTracking(
      result,
      n > 0 ? `Applied ${n} mesh-warp keyframes to “${targetName(targetId)}”.` : 'Nothing to apply.',
    );
  };

  const onSolveCamera = async (): Promise<void> => {
    if (!result || mode !== 'corner') return;
    const out = await solveCameraEdit({
      videoNodeId: nodeId,
      tracks: result.tracks,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      comp,
    });
    if (out) useSelectionStore.getState().set([out.cameraId]);
    store.getState().finishTracking(
      result,
      out
        ? `3D Camera Tracker: ${out.solvedFrames}/${out.totalFrames} frames, mean error ${out.meanRmsPx.toFixed(2)} px. Enable 3D on layers to see it.`
        : 'Camera solve failed — the plane is degenerate over this range.',
    );
  };

  const onRotoBrush = async (): Promise<void> => {
    if (!src) return;
    store.getState().beginTracking();
    try {
      const rotoEnd = durationSeconds ?? time + 2;
      const r = await runRotoBrush({
        nodeId,
        seed: { x: points[0]?.x ?? src.width / 2, y: points[0]?.y ?? src.height / 2, tolerance: 40 },
        startCompTime: time,
        endCompTime: Math.max(time + 1 / fps, rotoEnd),
        fps,
        featherPx: 2,
        onProgress: (f) => {
          store.getState().setProgress(f);
          return store.getState().tracking;
        },
      });
      store.getState().finishTracking(
        null,
        `Roto Brush: ${r.keyframes} mask keyframes over ${r.frames} frames (${r.status}). Refine with Track mask.`,
      );
    } catch (e) {
      store.getState().finishTracking(null, e instanceof Error ? e.message : String(e));
    }
  };

  const onContentAwareFill = async (): Promise<void> => {
    store.getState().beginTracking();
    try {
      const fillEnd = durationSeconds ?? time + 1;
      const r = await runContentAwareFill({
        nodeId,
        startCompTime: time,
        endCompTime: Math.max(time + 1 / fps, Math.min(time + 2, fillEnd)),
        fps,
        onProgress: (f) => {
          store.getState().setProgress(f);
          return store.getState().tracking;
        },
      });
      store.getState().finishTracking(
        null,
        `Content-Aware Fill: ${r.frames} frames, ${r.filledPixels} px (${r.status}). Mask the hole first.`,
      );
    } catch (e) {
      store.getState().finishTracking(null, e instanceof Error ? e.message : String(e));
    }
  };

  const onCreateNullsForPlanes = async (): Promise<void> => {
    if (!result || mode !== 'corner' || result.tracks.length < 8) return;
    const out = await createNullsForPlanesEdit({
      videoNodeId: nodeId,
      tracks: result.tracks,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      comp,
    });
    store.getState().finishTracking(
      result,
      out.nullIds.length > 0
        ? `Created ${out.nullIds.length} plane nulls (${out.keyframes} keyframes).`
        : 'Need at least two quads (8 tracks) for multi-plane nulls.',
    );
  };

  const onSeedMatte = (): void => {
    // GrabCut-class foothold from the layer centre (or first track point).
    const w = src?.width ?? 64;
    const h = src?.height ?? 64;
    const rgba = new Uint8ClampedArray(w * h * 4);
    // Synthetic seed: without a decoded frame in the inspector we only demonstrate
    // path wiring; Roto Brush uses exact frames. Centre blob vs darker BG.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const inside = Math.hypot(x - w / 2, y - h / 2) < Math.min(w, h) * 0.28;
        rgba[i] = inside ? 200 : 40;
        rgba[i + 1] = inside ? 60 : 40;
        rgba[i + 2] = inside ? 60 : 120;
        rgba[i + 3] = 255;
      }
    }
    const sx = points[0]?.x ?? w / 2;
    const sy = points[0]?.y ?? h / 2;
    const mask = grabCutMatte(rgba, w, h, [{ x: sx, y: sy, tolerance: 40 }], {
      unknownRadius: 6,
      iterations: 4,
      featherPx: 2,
    });
    const path = matteToPath(mask, w, h);
    store.getState().finishTracking(
      null,
      path.length > 0
        ? `Roto foothold: ${path.length} contour points (GrabCut-class). Place a real mask, then Track mask / Roto Brush.`
        : 'Roto foothold: empty matte — paint a mask or use Keylight for keyed mattes.',
    );
  };

  /** SAM-class click segment → an Add mask on this layer (`addMask` + its 2 px feather, one entry). */
  const onSegmentSam = async (): Promise<void> => {
    // Engine-side until C-phase: the layer's DRAWN box (readGeometry resolves
    // it from the render components), which the mask vertices scale into.
    const target = defaultSceneGraph.getNode(nodeId);
    const g = target ? readGeometry(target) : null;
    const w = src?.width ?? 64;
    const h = src?.height ?? 64;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const inside = Math.hypot(x - w / 2, y - h / 2) < Math.min(w, h) * 0.28;
        rgba[i] = inside ? 200 : 40;
        rgba[i + 1] = inside ? 60 : 40;
        rgba[i + 2] = inside ? 60 : 120;
        rgba[i + 3] = 255;
      }
    }
    const sx = points[0]?.x ?? w / 2;
    const sy = points[0]?.y ?? h / 2;
    const box = points.length >= 2
      ? {
          x0: Math.min(points[0]!.x, points[1]!.x),
          y0: Math.min(points[0]!.y, points[1]!.y),
          x1: Math.max(points[0]!.x, points[1]!.x),
          y1: Math.max(points[0]!.y, points[1]!.y),
        }
      : undefined;
    const segment = segmentSamSync({
      rgba,
      width: w,
      height: h,
      points: [{ x: sx, y: sy, label: 1, tolerance: 40 }],
      box,
      featherPx: 2,
    });
    const pts = matteToPath(segment.mask, w, h);
    if (pts.length >= 3 && g && isLayer(nodeId)) {
      const layerW = g.width;
      const layerH = g.height;
      const vertices: number[] = [];
      for (const p of pts) vertices.push((p.x / w - 0.5) * layerW, (p.y / h - 0.5) * layerH);
      // Corner vertices (no tangents); the engine mints the mask id.
      // ONE entry: the mask, then its 2 px feather (the id comes back from addMask).
      await inOneEntry('New Mask', [
        () => [{
          type: 'addMask', layer: nodeId, mode: 'add', name: 'Segment (SAM-class)', inverted: false,
          path: { vertices, inTangents: vertices.map(() => 0), outTangents: vertices.map(() => 0), closed: true, featherPoints: [], vertexStates: [] },
        }],
        (earlier) => {
          const group = (earlier[0]?.[0] as { groups?: string[] } | undefined)?.groups?.[0];
          return group ? [{ type: 'setProperty', prop: { layer: nodeId, path: `${group}/feather` }, value: values.scalar(2) }] : [];
        },
      ]);
    }
    store.getState().finishTracking(
      null,
      pts.length > 0
        ? `Segment (${segment.engine}): ${pts.length} contour points → mask path. Use Track mask / Roto Brush to propagate.`
        : 'Segment: empty matte — place a track point on the subject, or use two points as a box.',
    );
  };

  return {
    onAttachToNull,
    onArmPick,
    onTrackAgain,
    onCancel,
    onCreateNullAndApply,
    onTrack,
    onApply,
    onApplyMesh,
    onSolveCamera,
    onRotoBrush,
    onContentAwareFill,
    onCreateNullsForPlanes,
    onSeedMatte,
    onSegmentSam,
  };
}
