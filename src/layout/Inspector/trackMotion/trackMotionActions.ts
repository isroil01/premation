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

import { flicksToSeconds, secondsToFlicks, type LayerInfo, type TrackApplyMode, type TrackKind, type TrackSeries } from '@motion/engine-api';
import { requireEngineJob, runEngineJob, startEngineJob } from '@core/engine/engineJobs';
import { documentMirror } from '@stores/documentMirror';
import { useLayoutStore } from '@stores/layoutStore';
import { useSelectionStore } from '@stores/selectionStore';
import { spliceResult, useTrackerStore, type AutoPhase, type TrackDirectionChoice, type TrackerMode, type TrackerResult } from '@stores/trackerStore';
import { uiKindOf } from '@core/mirror/layerKinds';
import { canParentTo } from '@core/mirror/tracking';
import { runAutoTrack } from '@core/tracking/autoTrackCommand';
import { trackPointLayersJob, groundPlaneJob, loadCameraSolve, solveJob, type TrackPointLayer } from '@core/tracking/cameraTrack';
import { useCameraTrackStore } from '@stores/cameraTrackStore';
import { engine } from '@core/engine/engineInstance';
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
    extra: {
      target?: string; nullMode?: TrackApplyMode; tracks?: TrackerResult['tracks'];
      targetPath?: string; stabilizeRotation?: boolean; stabilizeScale?: boolean;
    } = {},
  ): Promise<{ ok: boolean; summary: TrackApplySummary | null; message: string } | null> => {
    if (!result) return null;
    // The attach point rides each feature at its offset (AE): applied to the samples sent.
    const attach = store.getState().attach;
    const withAttach = (extra.tracks ?? result.tracks).map((t, i) => {
      const a = attach[i];
      return a && (a.x !== 0 || a.y !== 0) ? t.map((smp) => ({ ...smp, x: smp.x + a.x, y: smp.y + a.y })) : t;
    });
    const out = await runEngineJob<TrackApplySummary>({
      kind: 'trackApply',
      value: {
        layer: nodeId,
        mode: applyMode,
        tracks: trackSeriesOf(withAttach),
        sourceWidth: result.sourceWidth,
        sourceHeight: result.sourceHeight,
        ...(extra.target ? { target: extra.target } : {}),
        ...(extra.nullMode ? { nullMode: extra.nullMode } : {}),
        ...(extra.targetPath ? { targetPath: extra.targetPath } : {}),
        ...(extra.stabilizeRotation ? { stabilizeRotation: true } : {}),
        ...(extra.stabilizeScale ? { stabilizeScale: true } : {}),
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

  /**
   * The range and origin of a walk (AE parity 3.6): forward from the playhead
   * to the end, backward from it to the layer's start, both ways over the
   * layer, or one frame either way.
   */
  const walkOf = (direction: TrackDirectionChoice, oneFrame: boolean): { range: { start: number; duration: number }; origin: number } => {
    const frame = 1 / Math.max(1, fps);
    const layer = documentMirror().layer(nodeId);
    const layerStart = layer ? Math.max(0, flicksToSeconds(layer.timing.inPoint)) : 0;
    const layerEnd = layer ? flicksToSeconds(layer.timing.outPoint) : endCompTime + frame;
    let start = time;
    let end = endCompTime + frame;
    if (oneFrame) {
      start = direction === 'backward' ? time - frame : time;
      end = start + 2 * frame;
    } else if (direction === 'backward') {
      start = layerStart;
      end = time + frame;
    } else if (direction === 'both') {
      start = layerStart;
      end = Math.max(layerEnd, time + 2 * frame);
    }
    start = Math.max(0, start);
    return { range: { start: secondsToFlicks(start), duration: secondsToFlicks(Math.max(2 * frame, end - start)) }, origin: secondsToFlicks(time) };
  };

  /** The 3D Camera Tracker over the layer (AE parity 3.5): solve, then load the solve for the viewer. */
  const runCameraSolve = async (): Promise<void> => {
    const layer = documentMirror().layer(nodeId);
    const start = layer ? Math.max(0, flicksToSeconds(layer.timing.inPoint)) : 0;
    const end = layer ? flicksToSeconds(layer.timing.outPoint) : durationSeconds;
    let cancelSolve: (() => void) | null = null;
    const focal = useCameraTrackStore.getState().focalLength;
    const job = requireEngineJob(await startEngineJob<{ focal: number; points: number; solvedFrames: number; totalFrames: number; errorPx: number; camera: string }>(
      solveJob(nodeId, start, end, focal > 0 ? focal : undefined),
      {
        onProgress: (f) => {
          store.getState().setProgress(f);
          if (!store.getState().tracking) cancelSolve?.();
        },
      },
    ), '3D Camera Tracker');
    cancelSolve = job.cancel;
    const out = await job.done;
    if (out.status !== 'done' || !out.result) {
      store.getState().finishTracking(null, out.error?.message ?? 'The camera solve was cancelled.');
      return;
    }
    const r = out.result;
    useCameraTrackStore.getState().setSolve(nodeId, await loadCameraSolve(engine(), nodeId));
    store.getState().finishTracking(
      null,
      `Solved ${r.solvedFrames} of ${r.totalFrames} frames · ${r.points} track points · lens ${Math.round(r.focal)} px · error ${r.errorPx.toFixed(2)} px. `
        + 'Select track points in the viewer to set the ground plane or create layers on them.',
    );
  };

  /** Set Ground Plane and Origin / Create … from the selected track points. */
  const onCameraPoints = async (action: 'ground' | TrackPointLayer): Promise<void> => {
    const selected = useCameraTrackStore.getState().selected;
    if (selected.length === 0 || tracking) return;
    if (action === 'ground' && selected.length < 3) {
      store.getState().finishTracking(null, 'Select three or more track points on the ground first.');
      return;
    }
    store.getState().beginTracking();
    const out = await runEngineJob<{ layer: string; camera: string }>(action === 'ground' ? groundPlaneJob(nodeId, selected) : trackPointLayersJob(nodeId, selected, action));
    if (!out || out.status !== 'done') {
      store.getState().finishTracking(null, out?.error?.message ?? 'This engine does not run the camera tracker.');
      return;
    }
    if (action === 'ground') useCameraTrackStore.getState().setSolve(nodeId, await loadCameraSolve(engine(), nodeId));
    else if (out.result?.layer) useSelectionStore.getState().set([out.result.layer]);
    store.getState().finishTracking(
      null,
      action === 'ground' ? 'The ground plane and origin are set; the camera was re-keyed.'
        : `Created a ${action === 'shadowCatcher' ? 'shadow catcher' : action} on the track points.`,
    );
  };

  /** Face tracking (AE parity 3.3): masks (and nulls) written in one entry. */
  const runFaceTrack = async (direction: TrackDirectionChoice, walk: { range: { start: number; duration: number }; origin: number }): Promise<void> => {
    const st = store.getState();
    let cancelFace: (() => void) | null = null;
    const job = requireEngineJob(await startEngineJob<{ frames: number; status: string; masks: string[]; nulls: string[]; provider: string }>(
      {
        kind: 'faceTrack',
        value: {
          layer: nodeId,
          range: walk.range,
          direction,
          mode: st.faceMode,
          landmarkModel: '',
          origin: walk.origin,
          ...(st.faceMask ? { mask: st.faceMask } : {}),
        },
      },
      {
        onProgress: (f) => {
          store.getState().setProgress(f);
          if (!store.getState().tracking) cancelFace?.();
        },
      },
    ), 'Face tracking');
    cancelFace = job.cancel;
    const out = await job.done;
    const r = out.result;
    store.getState().finishTracking(
      null,
      out.status !== 'done' || !r
        ? out.error?.message ?? 'Face tracking was cancelled.'
        : `Face tracked over ${r.frames} frames${r.status === 'lost' ? ' (the face was lost part-way; the frames before it are kept)' : ''}: `
          + `${r.masks.length} mask${r.masks.length === 1 ? '' : 's'}${r.nulls.length ? `, ${r.nulls.length} nulls` : ''}.`,
    );
  };

  const onTrack = async (direction: TrackDirectionChoice = 'forward', oneFrame = false): Promise<void> => {
    if (tracking) return;
    const held = store.getState().result;
    const opts = store.getState();
    const walk = walkOf(direction, oneFrame);
    const analysis = opts.fullResolution ? { analysisMaxEdge: 0 } : {};
    store.getState().beginTracking();
    try {
      if (mode === 'camera') {
        await runCameraSolve();
        return;
      }
      if (mode === 'face') {
        await runFaceTrack(direction, walk);
        return;
      }
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
              range: walk.range,
              direction,
              origin: walk.origin,
              stabilize: false,
              excludeMasks: [],
              ...analysis,
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
      const range = walk.range;
      if (mode === 'smooth') {
        const warp = opts.warp;
        // The engine's stabilize job (every variant: the similarity solve's
        // keys, or the subspace / rolling-shutter Mesh Warp path — tracked and
        // written in one entry).
        const viaEngine = requireEngineJob(await runEngineJob<{ fittedPairs: number; totalPairs: number; keyframes?: number }>(
          {
            kind: 'stabilize',
            value: {
              layer: nodeId, range, smoothness: warp.smoothness, method: warp.method, variant: stabVariant,
              // Framing zooms the similarity solve only; the mesh variants keep the frame.
              ...(stabVariant === 'similarity' ? { framing: warp.framing, maxScale: warp.maxScale } : {}),
              ...analysis,
            },
          },
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
      const stabTwo = mode === 'stabilize' && (opts.stabRotation || opts.stabScale) && stored.length >= 2;
      const kind: TrackKind = mode === 'planar'
        ? 'planarRegion'
        : mode === 'transform' || stabTwo ? 'positionRotationScale' : planar ? 'planar' : mode === 'corner' ? 'perspectiveCorner' : 'position';
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
            direction,
            origin: walk.origin,
            stabilize: false,
            excludeMasks: mode === 'planar' ? opts.excludeMasks : [],
            ...analysis,
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
        const fresh = res.tracks.map((t) => t.map(([compTime, x, y, confidence, coasted]) => ({ compTime, x, y, confidence, coasted: coasted === 1 })));
        const status = res.status === 'lost' ? 'lost' : 'completed';
        // A walk from a corrected (or any held) frame splices into the held
        // track: forward replaces what follows the playhead, backward what precedes it.
        const merged = spliceResult(held, { tracks: fresh, sourceWidth: res.sourceWidth, sourceHeight: res.sourceHeight, status }, direction, time);
        const coasted = merged.tracks.flat().filter((smp) => smp.coasted).length;
        store.getState().finishTracking(
          merged,
          summarize(merged.tracks, status, coasted > 0 ? ` · ${coasted} coasted` : ''),
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
    // An effect point on the footage itself is the usual target (AE), not the accident the guard catches.
    if (!(mode === 'follow' && store.getState().applyPath) && needsSelfApplyConfirm({ mode, targetId, sourceId: nodeId })) {
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
            : `corner-pin keyframes to “${targetName(targetId)}”`;  // corner and planar
    if (mode === 'follow' || mode === 'transform' || mode === 'stabilize' || mode === 'corner' || mode === 'planar') {
      const st = store.getState();
      const applyPath = mode === 'follow' ? st.applyPath : '';
      const viaEngine = await applyInEngine(
        mode === 'planar' ? 'corner' : mode,
        mode === 'stabilize'
          ? result.tracks.length >= 2 ? { stabilizeRotation: st.stabRotation, stabilizeScale: st.stabScale } : {}
          : { target: targetId, ...(applyPath ? { targetPath: applyPath } : {}) },
      );
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
            // Every placed point seeds the matte (not only the first).
            prompts: points.map((p) => ({ x: p.x, y: p.y })),
            backgroundPrompts: [],
            replaceMasks: [],
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

  /** Content-Aware Fill has its own panel (AE parity 3.7): method, lighting, range, reference frames. */
  const onContentAwareFill = (): Promise<void> => {
    useLayoutStore.getState().openPanel('contentAwareFill');
    return Promise.resolve();
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

  /** Seed Matte: the engine's SAM segment of the real frame (the same job as Segment). */
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
          strokes: [],
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
    onCameraPoints,
  };
}
