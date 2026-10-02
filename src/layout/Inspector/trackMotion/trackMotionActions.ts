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

import { secondsToFlicks, type LayerInfo, type TrackApplyMode, type TrackKind, type TrackSeries } from '@motion/engine-api';
import { requireEngineJob, runEngineJob, startEngineJob } from '@core/engine/engineJobs';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { useTrackerStore, type AutoPhase, type TrackerMode, type TrackerResult } from '@stores/trackerStore';
import { uiKindOf } from '@core/mirror/layerKinds';
import { canParentTo } from '@core/mirror/tracking';
import { runAutoTrack } from '@core/tracking/autoTrackCommand';
import { edit } from '@core/engine/uiEdits';
import { isLayer } from '@core/mirror/docFacts';
import { customConfirm } from '@components/Modal';
import { needsSelfApplyConfirm, selfApplyConfirmCopy } from './applyTargetGuard';

export type StabVariant = 'similarity' | 'subspace' | 'rolling-shutter';

/** A tracker result's samples as the engine's trackApply job takes them (composition flicks, source display px). */
export function trackSeriesOf(tracks: TrackerResult['tracks']): TrackSeries[] {
  return tracks.map((t) => ({
    samples: t.map((smp) => ({ time: secondsToFlicks(smp.compTime), x: smp.x, y: smp.y, confidence: smp.confidence, coasted: smp.coasted })),
  }));
}

/** What the engine's trackApply job reports once its entry is written. */
interface TrackApplySummary {
  mode: TrackApplyMode;
  keyframes: number;
  nullIds: string[];
  /** cameraSolve: the solve camera and how well the path fits. */
  cameraId?: string;
  meanRmsPx?: number;
  solvedFrames?: number;
  totalFrames?: number;
}

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
    time, endCompTime, fps, durationSeconds, src, stabVariant, targets,
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

  /**
   * Apply the held track in the engine (the trackApply job: the plans over
   * the engine's document, one history entry). Null only without a result.
   */
  const applyInEngine = async (
    applyMode: TrackApplyMode,
    extra: { target?: string; nullMode?: TrackApplyMode; tracks?: TrackerResult['tracks'] } = {},
  ): Promise<{ ok: boolean; summary: TrackApplySummary | null; message: string } | null> => {
    if (!result) return null;
    const out = await runEngineJob<TrackApplySummary>({
      kind: 'trackApply',
      value: {
        layer: nodeId,
        mode: applyMode,
        tracks: trackSeriesOf(extra.tracks ?? result.tracks),
        sourceWidth: result.sourceWidth,
        sourceHeight: result.sourceHeight,
        ...(extra.target ? { target: extra.target } : {}),
        ...(extra.nullMode ? { nullMode: extra.nullMode } : {}),
      },
    });
    if (!out) return { ok: false, summary: null, message: 'this engine does not apply tracks' };
    return { ok: out.status === 'done', summary: out.result, message: out.error?.message ?? (out.status === 'cancelled' ? 'cancelled' : '') };
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
    const viaEngine = await applyInEngine('createNull', { nullMode: applyMode === 'transform' ? 'transform' : applyMode === 'corner' ? 'corner' : 'follow' });
    if (viaEngine) {
      const nullId = viaEngine.summary?.nullIds[0];
      if (!viaEngine.ok || !nullId) {
        store.getState().finishTracking(result, viaEngine.message ? `Could not create null: ${viaEngine.message}` : 'Could not create null.');
        return;
      }
      useSelectionStore.getState().set([nullId]);
      setTargetId(nullId);
      ctx.onNullCreated?.(nullId);
      store.getState().finishTracking(
        result,
        `Created a tracked null with ${viaEngine.summary?.keyframes ?? 0} ${asTransform ? 'position, rotation & scale' : 'position'} keyframes.`,
      );
      return;
    }
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
        // the mask. The engine's trackMotion job (kind mask): the mask path
        // keys are one undoable entry.
        let cancelMask: (() => void) | null = null;
        const maskJob = requireEngineJob(await startEngineJob<{ keyframes: number; vertices: number; sampled: number; status: string }>(
          {
            kind: 'trackMotion',
            value: {
              layer: nodeId,
              kind: 'mask',
              points: [{
                feature: { x: 0, y: 0, width: 2 * featureHalf + 1, height: 2 * featureHalf + 1 },
                search: { x: 0, y: 0, width: 2 * searchHalf + 1, height: 2 * searchHalf + 1 },
                attach: { x: 0, y: 0 },
              }],
              range: { start: secondsToFlicks(time), duration: secondsToFlicks(Math.max(0, endCompTime - time) + 1 / Math.max(1, fps)) },
              direction: 'forward',
              origin: secondsToFlicks(time),
              stabilize: false,
            },
          },
          {
            onProgress: (f) => {
              store.getState().setProgress(f);
              if (!store.getState().tracking) cancelMask?.();
            },
          },
        ), 'Mask tracking');
        {
          cancelMask = maskJob.cancel;
          const out = await maskJob.done;
          const r = out.result;
          store.getState().finishTracking(
            null,
            out.status !== 'done' || !r
              ? out.error?.message ?? 'Mask tracking was cancelled.'
              : r.sampled < r.vertices
                ? `Tracked ${r.sampled} of ${r.vertices} mask vertices (the rest follow their neighbours), wrote ${r.keyframes} mask keyframes (${r.status}).`
                : `Tracked ${r.vertices} mask vertices, wrote ${r.keyframes} mask keyframes (${r.status}).`,
          );
          return;
        }
      }
      const range = { start: secondsToFlicks(time), duration: secondsToFlicks(Math.max(0, endCompTime - time) + 1 / Math.max(1, fps)) };
      if (mode === 'smooth') {
        // The engine's stabilize job (every variant: the similarity solve's
        // keys, or the subspace / rolling-shutter Mesh Warp path — tracked and
        // written in one entry).
        const viaEngine = requireEngineJob(await runEngineJob<{ fittedPairs: number; totalPairs: number; keyframes?: number }>(
          { kind: 'stabilize', value: { layer: nodeId, range, smoothness: 50, method: 'positionRotationScale', variant: stabVariant } },
          { onProgress: (f) => store.getState().setProgress(f) },
        ), 'Stabilize');
        store.getState().finishTracking(
          null,
          viaEngine.status === 'done'
            ? `Stabilized (${stabVariant}): fitted ${viaEngine.result?.fittedPairs ?? 0}/${viaEngine.result?.totalPairs ?? 0} frame pairs.`
            : viaEngine.error?.message ?? 'Stabilize was cancelled.',
        );
        return;
      }
      // The engine's point tracker: analysis only (no applyTo) — Apply below
      // writes from the samples. Dense grid: the engine densifies the quad
      // itself (kind planar) from the handles.
      const stored = store.getState().points;
      const planar = mode === 'corner' && store.getState().dense;
      const kind: TrackKind = mode === 'transform' ? 'positionRotationScale' : planar ? 'planar' : mode === 'corner' ? 'perspectiveCorner' : 'position';
      const enginePts = stored;
      let cancelEngine: (() => void) | null = null;
      const handle = requireEngineJob(await startEngineJob<{ status: 'completed' | 'lost' | 'partial'; sourceWidth: number; sourceHeight: number; tracks: Array<Array<[number, number, number, number, number]>> }>(
        {
          kind: 'trackMotion',
          value: {
            layer: nodeId,
            kind,
            points: enginePts.map((p) => ({
              feature: { x: p.x, y: p.y, width: 2 * featureHalf + 1, height: 2 * featureHalf + 1 },
              search: { x: p.x, y: p.y, width: 2 * searchHalf + 1, height: 2 * searchHalf + 1 },
              attach: { x: 0, y: 0 },
            })),
            range,
            direction: 'forward',
            origin: secondsToFlicks(time),
            stabilize: false,
          },
        },
        {
          onProgress: (f) => {
            store.getState().setProgress(f);
            // A cleared store means the user pressed Cancel.
            if (!store.getState().tracking) cancelEngine?.();
          },
        },
      ), 'Tracking');
      {
        cancelEngine = handle.cancel;
        const viaEngine = await handle.done;
        const res = viaEngine.result;
        if (viaEngine.status !== 'done' || !res) {
          store.getState().finishTracking(null, viaEngine.error?.message ?? 'Tracking was cancelled.');
          return;
        }
        const tracks = res.tracks.map((t) => t.map(([compTime, x, y, confidence, coasted]) => ({ compTime, x, y, confidence, coasted: coasted === 1 })));
        const status = res.status === 'lost' ? 'lost' : 'completed';
        const coasted = tracks.flat().filter((smp) => smp.coasted).length;
        store.getState().finishTracking(
          { tracks, sourceWidth: res.sourceWidth, sourceHeight: res.sourceHeight, status },
          summarize(tracks, status, coasted > 0 ? ` · ${coasted} coasted` : ''),
        );
      }
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
    const targetIsCamera = uiKindOf(documentMirror().layer(targetId)) === 'camera';
    const whatFor = (): string =>
      mode === 'follow'
        ? targetIsCamera ? `camera position + look-at to “${targetName(targetId)}”` : `position keyframes to “${targetName(targetId)}”`
        : mode === 'transform'
          ? targetIsCamera
            ? `camera solve (position + orientation) to “${targetName(targetId)}”`
            : `position/rotation/scale keyframes to “${targetName(targetId)}”`
          : mode === 'stabilize'
            ? 'stabilizing keyframes to this layer'
            : `corner-pin keyframes to “${targetName(targetId)}”`;
    if (mode === 'follow' || mode === 'transform' || mode === 'stabilize' || mode === 'corner') {
      const viaEngine = await applyInEngine(mode, mode === 'stabilize' ? {} : { target: targetId });
      if (viaEngine) {
        const n = viaEngine.summary?.keyframes ?? 0;
        store.getState().finishTracking(
          result,
          !viaEngine.ok ? `Not applied: ${viaEngine.message || 'the engine refused the track'}` : n > 0 ? `Applied ${n} ${whatFor()}.` : 'Nothing to apply.',
        );
      }
    }
  };

  const onApplyMesh = async (): Promise<void> => {
    if (!result || mode !== 'corner') return;
    const viaEngine = await applyInEngine('meshWarp', { target: targetId });
    if (viaEngine) {
      const n = viaEngine.summary?.keyframes ?? 0;
      store.getState().finishTracking(
        result,
        !viaEngine.ok ? `Not applied: ${viaEngine.message}` : n > 0 ? `Applied ${n} mesh-warp keyframes to “${targetName(targetId)}”.` : 'Nothing to apply.',
      );
    }
  };

  const onSolveCamera = async (): Promise<void> => {
    if (!result || mode !== 'corner') return;
    // The engine's 3D Camera Tracker (the trackApply job, mode cameraSolve:
    // the SfM / planar solve and the solve camera, one entry).
    const viaEngine = await applyInEngine('cameraSolve');
    if (viaEngine) {
      const r = viaEngine.summary;
      if (viaEngine.ok && r?.cameraId) useSelectionStore.getState().set([r.cameraId]);
      store.getState().finishTracking(
        result,
        viaEngine.ok && r?.cameraId
          ? `3D Camera Tracker: ${r.solvedFrames ?? 0}/${r.totalFrames ?? 0} frames, mean error ${(r.meanRmsPx ?? 0).toFixed(2)} px. Enable 3D on layers to see it.`
          : viaEngine.message || 'Camera solve failed — the plane is degenerate over this range.',
      );
    }
  };

  const onRotoBrush = async (): Promise<void> => {
    if (!src) return;
    store.getState().beginTracking();
    try {
      const rotoEnd = durationSeconds ?? time + 2;
      const end = Math.max(time + 1 / fps, rotoEnd);
      let cancelRoto: (() => void) | null = null;
      const rotoJob = requireEngineJob(await startEngineJob<{ frames: number; keyframes: number }>(
        {
          kind: 'rotoBrush',
          value: {
            layer: nodeId,
            range: {
              start: secondsToFlicks(time),
              duration: secondsToFlicks(Math.max(0, end - time) + 1 / Math.max(1, fps)),
            },
            seed: { x: points[0]?.x ?? src.width / 2, y: points[0]?.y ?? src.height / 2 },
            tolerance: 40,
            feather: 2,
          },
        },
        {
          onProgress: (f) => {
            store.getState().setProgress(f);
            if (!store.getState().tracking) cancelRoto?.();
          },
        },
      ), 'Roto Brush');
      {
        cancelRoto = rotoJob.cancel;
        const out = await rotoJob.done;
        if (out.status === 'failed') throw new Error(out.error?.message ?? 'Roto Brush failed');
        const r = out.result;
        store.getState().finishTracking(
          null,
          out.status === 'cancelled'
            ? 'Roto Brush cancelled.'
            : `Roto Brush: ${r?.keyframes ?? 0} mask keyframes over ${r?.frames ?? 0} frames (completed). Refine with Track mask.`,
        );
      }
    } catch (e) {
      store.getState().finishTracking(null, e instanceof Error ? e.message : String(e));
    }
  };

  const onContentAwareFill = async (): Promise<void> => {
    store.getState().beginTracking();
    try {
      const fillEnd = durationSeconds ?? time + 1;
      const end = Math.max(time + 1 / fps, Math.min(time + 2, fillEnd));
      let cancelFill: (() => void) | null = null;
      const fillJob = requireEngineJob(await startEngineJob<{ frames: number; filledPixels: number }>(
        {
          kind: 'contentAwareFill',
          value: {
            layer: nodeId,
            range: {
              start: secondsToFlicks(time),
              duration: secondsToFlicks(Math.max(0, end - time) + 1 / Math.max(1, fps)),
            },
            outputFolder: '',
          },
        },
        {
          onProgress: (f) => {
            store.getState().setProgress(f);
            if (!store.getState().tracking) cancelFill?.();
          },
        },
      ), 'Content-Aware Fill');
      {
        cancelFill = fillJob.cancel;
        const out = await fillJob.done;
        if (out.status === 'failed') throw new Error(out.error?.message ?? 'Content-Aware Fill failed');
        const r = out.result;
        store.getState().finishTracking(
          null,
          out.status === 'cancelled'
            ? 'Content-Aware Fill cancelled.'
            : `Content-Aware Fill: ${r?.frames ?? 0} frames, ${r?.filledPixels ?? 0} px (completed). Mask the hole first.`,
        );
      }
    } catch (e) {
      store.getState().finishTracking(null, e instanceof Error ? e.message : String(e));
    }
  };

  const onCreateNullsForPlanes = async (): Promise<void> => {
    if (!result || mode !== 'corner' || result.tracks.length < 8) return;
    const viaEngine = await applyInEngine('nullsForPlanes');
    if (viaEngine) {
      const ids = viaEngine.summary?.nullIds ?? [];
      store.getState().finishTracking(
        result,
        !viaEngine.ok
          ? `Could not create plane nulls: ${viaEngine.message}`
          : ids.length > 0
            ? `Created ${ids.length} plane nulls (${viaEngine.summary?.keyframes ?? 0} keyframes).`
            : 'Need at least two quads (8 tracks) for multi-plane nulls.',
      );
    }
  };

  /** The roto foothold: the engine's SAM segment of the real frame (the synthetic page GrabCut is gone). */
  const onSeedMatte = (): void => {
    void onSegmentSam();
  };

  /** SAM-class click segment → an Add mask on this layer (`addMask` + its 2 px feather, one entry). */
  const onSegmentSam = async (): Promise<void> => {
    // The engine segments the real frame with SAM (the objectMatte job — the
    // model in a child engine process) and adds the mask.
    {
      const p0 = points[0];
      const box = points.length >= 2
        ? {
            x: Math.min(points[0]!.x, points[1]!.x),
            y: Math.min(points[0]!.y, points[1]!.y),
            width: Math.abs(points[1]!.x - points[0]!.x),
            height: Math.abs(points[1]!.y - points[0]!.y),
          }
        : undefined;
      const viaEngine = p0 ? await runEngineJob<{ contourPoints: number }>({
        kind: 'objectMatte',
        value: {
          layer: nodeId,
          range: { start: secondsToFlicks(time), duration: secondsToFlicks(1 / Math.max(1, fps)) },
          prompts: [{ x: p0.x, y: p0.y }],
          backgroundPrompts: [],
          encoderModel: '',
          decoderModel: '',
          replaceMasks: [],
          ...(box ? { box } : {}),
        },
      }) : null;
      store.getState().finishTracking(
        null,
        !viaEngine
          ? 'Segment: place a track point on the subject first (or two points as a box).'
          : viaEngine.status === 'done'
            ? `Segment (SAM): ${viaEngine.result?.contourPoints ?? 0} contour points → mask path. Use Track mask / Roto Brush to propagate.`
            : `Segment: ${viaEngine.error?.message ?? 'cancelled'}`,
      );
    }
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
