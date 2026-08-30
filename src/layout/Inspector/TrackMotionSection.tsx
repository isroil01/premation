/**
 * Track Motion — AE's tracker family, on the exact decoder.
 *
 * The section is arranged around the one thing most people want: point at an
 * object, get keyframes. That is the card at the top, and it is the whole
 * interface until you need more. Everything the panel used to open with —
 * six modes, two window-size dropdowns, nine buttons — still exists, one
 * disclosure down, because the people who need it need all of it.
 *
 * The split is a claim about the work, not a decoration: choosing a feature,
 * sizing the windows and choosing a direction are decisions the FOOTAGE can
 * answer (core/tracking/autoTrack.ts measures them), while choosing between a
 * planar pin and a mesh warp is a decision only the shot's author can make.
 * The first kind belongs in a button; the second belongs in controls.
 *
 * Points are placed by dragging the handles TrackPointOverlay draws on the
 * canvas — this panel reports them, because a coordinate you can see on the
 * footage beats a number field you have to guess into.
 *
 * Modes (advanced):
 *   Follow     — one point; apply as position keyframes on any layer.
 *   Transform  — two points; adds rotation and scale.
 *   Stabilize  — one point; apply INVERSE motion to this layer.
 *   Smooth     — dense optical flow; Warp Stabilizer-class.
 *   Corner pin — four points; keyframe a Corner Pin effect (screen replacement).
 *   Track mask — this layer's mask vertices are the points.
 *
 * Tracking runs on the ORIGINAL media through ExactVideoSource, never the
 * proxy and never a seeked <video> — the samples are measured on the frames
 * the renderer will actually show (see trackVideoLayer.ts).
 */

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@components/Button';
import { InspectorRow } from '@components/Inspector';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { useTrackerStore, type AutoPlanSummary, type TrackerMode } from '@stores/trackerStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { trackVideoLayerPoints } from '@core/tracking/trackVideoLayer';
import { runAutoTrack } from '@core/tracking/autoTrackCommand';
import { smoothStabilizeVideoLayer } from '@core/tracking/smoothStabilize';
import {
  applyTrackToLayer,
  applyStabilizeToLayer,
  applyCornerPinTrack,
  applyTransformTrack,
  applyTrackToCamera,
  applyCameraSolveTrack,
  applyMeshWarpTrack,
  applyPlanarCameraSolve,
  applySfmCameraSolve,
  createNullAndApplyTrack,
  createNullsForPlanes,
} from '@core/tracking/applyTrack';
import { matteToPath } from '@core/tracking/rotoMatte';
import { grabCutMatte } from '@core/tracking/grabCut';
import { segmentSamSync } from '@core/tracking/samSegment';
import { addMaskPath, getNodeMask, type MaskPath } from '@core/effects/mask';
import { runRotoBrush } from '@core/tracking/rotoBrush';
import { runContentAwareFill } from '@core/effects/contentAwareFillVideo';
import { trackLayerMask } from '@core/tracking/maskTrack';
import { densifyQuad } from '@core/tracking/planarFit';
import { sourceDisplaySize } from '@core/tracking/trackerSource';
import { webCodecsAvailable } from '@core/video/exactVideoSource';
import { readNodeKind } from '@core/scene/sceneDerive';
import { readGeometry } from '@core/workspace/geometry';
import styles from './TrackMotionSection.module.css';

const FEATURE_SIZES = [5, 10, 15, 20];
const SEARCH_SIZES = [12, 24, 40, 60];

/**
 * The preset sizes, plus whatever is actually set if it is not one of them.
 *
 * One-click sizes both windows from measurement, so the value is routinely
 * something like 8 or 22 — and a `<select>` whose `value` matches no `<option>`
 * does not show blank, it shows the FIRST option. The panel would have read
 * "11×11" while the tracker used 17×17, which is worse than having no readout
 * at all: it is a wrong number in the place people look to check.
 */
function sizeOptions(presets: readonly number[], current: number): number[] {
  return presets.includes(current) ? [...presets] : [...presets, current].sort((a, b) => a - b);
}

const MODE_LABELS: Record<TrackerMode, string> = {
  follow: 'Follow (position)',
  transform: 'Follow + rotation & scale',
  stabilize: 'Stabilize',
  smooth: 'Smooth stabilize (dense)',
  corner: 'Planar / Corner pin',
  mask: 'Track mask',
};

const MODE_HINTS: Record<TrackerMode, string> = {
  follow: 'Drag the point onto the feature to follow, track, then apply as position keyframes on a target layer.',
  transform:
    'Two points: the ANCHOR drives position, the anchor→reference vector drives rotation and scale. Put both on the same rigid surface.',
  stabilize: 'Drag the point onto the feature to lock, track, then apply — this layer moves inversely so the feature stays put.',
  smooth:
    'No points to place: dense optical flow measures the camera’s motion. Default = global similarity (Warp Stabilizer-class). Subspace / rolling-shutter variants bake a Mesh Warp lattice instead.',
  corner: 'Planar track: drag corners onto the plane (TL, TR, BR, BL). “Dense grid” tracks a feature lattice inside the quad and fits the plane by RANSAC, so partial occlusion cannot drag it. Track, then pin / mesh / Solve 3D Camera Tracker (SfM + bundle adjustment). Two+ quads → Create Nulls per Plane.',
  mask: 'Tracks every vertex of this layer’s mask and writes mask keyframes — the mask follows the footage. Seed Matte / Segment (SAM-class) / Roto Brush use GrabCut + edge CRF (optional ONNX when registered).',
};

/**
 * How trustworthy the chosen feature is, as one word.
 *
 * Distinctness is the deciding measurement, not strength: a high-contrast
 * feature with look-alikes around it is the one that produces a confident,
 * wrong track, and that is precisely the case a number nobody reads would
 * fail to warn about.
 */
function qualityOf(plan: AutoPlanSummary): { level: 'good' | 'fair' | 'poor'; label: string } {
  if (plan.distinctness >= 0.6) return { level: 'good', label: 'Strong feature' };
  if (plan.distinctness >= 0.35) return { level: 'fair', label: 'Usable feature' };
  return { level: 'poor', label: 'Ambiguous feature' };
}

export function TrackMotionSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const mode = useTrackerStore((s) => s.mode);
  const points = useTrackerStore((s) => s.points);
  const featureHalf = useTrackerStore((s) => s.featureHalf);
  const searchHalf = useTrackerStore((s) => s.searchHalf);
  const dense = useTrackerStore((s) => s.dense);
  const tracking = useTrackerStore((s) => s.tracking);
  const progress = useTrackerStore((s) => s.progress);
  const result = useTrackerStore((s) => s.result);
  const note = useTrackerStore((s) => s.note);
  const autoPhase = useTrackerStore((s) => s.autoPhase);
  const autoPlan = useTrackerStore((s) => s.autoPlan);
  const store = useTrackerStore;
  const time = useActiveWorkspace()?.time ?? 0;
  const fps = useCompositionStore((c) => c.fps) || 30;
  const durationSeconds = useCompositionStore((c) => c.durationSeconds);
  const comp = useCompositionStore((c) => c.comp());
  const [targetId, setTargetId] = useState(nodeId);
  const [stabVariant, setStabVariant] = useState<'similarity' | 'subspace' | 'rolling-shutter'>('similarity');

  const node = defaultSceneGraph.getNode(nodeId);
  const src = sourceDisplaySize(nodeId);
  const maskPoints = node ? getNodeMask(nodeId).paths.reduce((n, p) => n + p.points.length, 0) : 0;

  // Opening the section for a layer arms the overlay for it and seeds the
  // mode's points so there are handles to grab at all. The section is mounted
  // only while OPEN (`mountOnOpen` on its accordion item), so closing it
  // disarms — the overlay leaves the canvas but keeps points and any result.
  useEffect(() => {
    store.getState().activate(nodeId);
    if (src) store.getState().seedPoints(src.width, src.height);
  }, [nodeId, src?.width, src?.height, mode]);
  useEffect(() => () => store.getState().disarm(), []);

  // Escape leaves the pick without tracking.
  //
  // stopIMMEDIATEPropagation, and in the capture phase: the app's own Escape
  // handler is also on `window`, and plain stopPropagation does not stop
  // listeners on the SAME node — so cancelling a pick ALSO cleared the
  // selection, which unmounted this very section. While the pick is armed,
  // Escape means one thing.
  useEffect(() => {
    if (autoPhase !== 'picking') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      e.preventDefault();
      store.getState().setAutoPhase('idle');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [autoPhase, store]);

  const targets = useMemo(() => {
    if (!node) return [];
    // NOT getChildren(node.parent): on a fresh unsaved project layers hang
    // off the VIRTUAL 'comp_root' — a fallback id with no engine node — and
    // getChildren of a non-node is []. traverse sees every registered node,
    // so same-parent comparison works for real and virtual parents alike.
    const sameParent: typeof node[] = [];
    defaultSceneGraph.traverse((n) => {
      if ((n.parent ?? null) === (node.parent ?? null)) sameParent.push(n);
    });
    return sameParent.length > 0 ? sameParent : [node];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scene rev drives this
  }, [node, useSceneRevision((s) => s.rev)]);

  if (!node || !src) return null;

  if (!webCodecsAvailable()) {
    return <p className={styles.cardHint}>Tracking needs WebCodecs, which this runtime does not have.</p>;
  }

  const endCompTime = Math.max(time, durationSeconds - 1 / fps);

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
  const onCreateNullAndApply = (asTransform = false): void => {
    if (!result) return;
    const applyMode = asTransform ? 'transform' : mode;
    if (applyMode !== 'follow' && applyMode !== 'transform' && applyMode !== 'corner') return;
    if (applyMode === 'transform' && result.tracks.length < 2) return;
    const out = createNullAndApplyTrack({
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
    setTargetId(out.nullId);
    store.getState().finishTracking(
      result,
      `Created a tracked null with ${out.keyframes} ${asTransform ? 'position, rotation & scale' : 'position'} keyframes — parent your layer to it.`,
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
          `Tracked ${r.vertices} mask vertices, wrote ${r.keyframes} mask keyframes (${r.status}).`,
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

  const onApply = (): void => {
    if (!result) return;
    let n = 0;
    let what = '';
    if (mode === 'follow') {
      const targetNode = defaultSceneGraph.getNode(targetId);
      if (targetNode && readNodeKind(targetNode) === 'camera') {
        n = applyTrackToCamera({
          videoNodeId: nodeId,
          targetNodeId: targetId,
          samples: result.tracks[0] ?? [],
          sourceWidth: result.sourceWidth,
          sourceHeight: result.sourceHeight,
          comp,
        });
        what = `camera position + look-at to “${targetName(targetId)}”`;
      } else {
        n = applyTrackToLayer({
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
      const targetNode = defaultSceneGraph.getNode(targetId);
      if (targetNode && readNodeKind(targetNode) === 'camera') {
        n = applyCameraSolveTrack({
          videoNodeId: nodeId,
          targetNodeId: targetId,
          tracks: result.tracks,
          sourceWidth: result.sourceWidth,
          sourceHeight: result.sourceHeight,
          comp,
        });
        what = `camera solve (position + orientation) to “${targetName(targetId)}”`;
      } else {
        n = applyTransformTrack({
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
      n = applyStabilizeToLayer({
        videoNodeId: nodeId,
        samples: result.tracks[0] ?? [],
        sourceWidth: result.sourceWidth,
        sourceHeight: result.sourceHeight,
        comp,
      });
      what = 'stabilizing keyframes to this layer';
    } else if (mode === 'corner') {
      n = applyCornerPinTrack({
        videoNodeId: nodeId,
        targetNodeId: targetId,
        tracks: result.tracks,
        sourceWidth: result.sourceWidth,
        sourceHeight: result.sourceHeight,
        comp,
      });
      what = `corner-pin keyframes to “${targetName(targetId)}”`;
    }
    store.getState().finishTracking(result, n > 0 ? `Applied ${n} ${what}.` : 'Nothing to apply.');
  };

  const onApplyMesh = (): void => {
    if (!result || mode !== 'corner') return;
    const n = applyMeshWarpTrack({
      videoNodeId: nodeId,
      targetNodeId: targetId,
      tracks: result.tracks,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      comp,
    });
    store.getState().finishTracking(
      result,
      n > 0 ? `Applied ${n} mesh-warp keyframes to “${targetName(targetId)}”.` : 'Nothing to apply.',
    );
  };

  const onSolveCamera = (): void => {
    if (!result || mode !== 'corner') return;
    const out = applySfmCameraSolve({
      videoNodeId: nodeId,
      tracks: result.tracks,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      comp,
    }) ?? applyPlanarCameraSolve({
      videoNodeId: nodeId,
      tracks: result.tracks,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      comp,
    });
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

  const onCreateNullsForPlanes = (): void => {
    if (!result || mode !== 'corner' || result.tracks.length < 8) return;
    const out = createNullsForPlanes({
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

  /** SAM-class click segment → writes an Add mask path on this layer. */
  const onSegmentSam = (): void => {
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
    if (pts.length >= 3 && g) {
      const layerW = g.width;
      const layerH = g.height;
      const path: MaskPath = {
        id: `sam_${Date.now().toString(36)}`,
        name: 'Segment (SAM-class)',
        mode: 'add',
        closed: true,
        points: pts.map((p) => {
          const lx = (p.x / w - 0.5) * layerW;
          const ly = (p.y / h - 0.5) * layerH;
          return { x: lx, y: ly, inX: lx, inY: ly, outX: lx, outY: ly };
        }),
        feather: 2,
        opacity: 1,
        expansion: 0,
        inverted: false,
      };
      addMaskPath(nodeId, path);
      bumpScene();
    }
    store.getState().finishTracking(
      null,
      pts.length > 0
        ? `Segment (${segment.engine}): ${pts.length} contour points → mask path. Use Track mask / Roto Brush to propagate.`
        : 'Segment: empty matte — place a track point on the subject, or use two points as a box.',
    );
  };

  const canTrack = mode === 'mask' ? maskPoints > 0 : mode === 'smooth' ? true : points.length > 0;
  const applyLabel =
    mode === 'follow'
      ? 'Apply as position keyframes'
      : mode === 'transform'
        ? 'Apply position, rotation & scale'
        : mode === 'stabilize'
          ? 'Stabilize this layer'
          : 'Pin target to corners';
  const analyzing = autoPhase === 'analyzing';
  const picking = autoPhase === 'picking';
  const quality = autoPlan ? qualityOf(autoPlan) : null;
  const autoResult = autoPlan && result && (result.tracks[0]?.length ?? 0) > 1;

  return (
    <div className={styles.root}>
      <section className={styles.card} data-armed={picking}>
        <div className={styles.cardTitle}>
          <span>Track an object</span>
          {quality && (
            <span className={styles.quality} data-level={quality.level}>
              {quality.label}
            </span>
          )}
        </div>

        {analyzing ? (
          <>
            <div className={styles.progressRow}>
              <div
                className={styles.progressTrack}
                role="progressbar"
                aria-label="Tracking progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress * 100)}
              >
                {/* scaleX, not width — see the module CSS: this repaints on
                    every tracked frame and must not relayout the panel. */}
                <div className={styles.progressFill} style={{ transform: `scaleX(${progress})` }} />
              </div>
              <span className={styles.progressValue}>{Math.round(progress * 100)}%</span>
            </div>
            <Button size="sm" variant="secondary" onClick={onCancel} fullWidth>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <p className={styles.cardHint}>
              {picking
                ? 'Click the thing to follow in the viewport. It snaps to the nearest trackable detail, then tracks the whole clip both ways from the playhead. Esc to cancel.'
                : 'Point at anything in the shot. The feature, both window sizes and the direction are measured from the footage — no boxes to place.'}
            </p>
            <Button size="sm" variant={picking ? 'secondary' : 'primary'} onClick={onArmPick} fullWidth>
              {picking ? 'Cancel pick (Esc)' : 'Pick target in viewport'}
            </Button>
            {autoPlan && (
              <Button size="sm" variant="secondary" onClick={onTrackAgain} fullWidth>
                Track again from this feature
              </Button>
            )}
          </>
        )}

        {note && !analyzing && (
          <p
            className={styles.note}
            role="status"
            data-tone={
              result || note.startsWith('Applied') || note.startsWith('Created')
                ? quality?.level === 'poor'
                  ? 'warn'
                  : undefined
                : 'error'
            }
          >
            {note}
          </p>
        )}

        {autoPlan && !analyzing && (
          <p className={styles.stats}>
            <span className={styles.stat}>
              feature <b>{Math.round(autoPlan.featureHalf) * 2 + 1}px</b>
            </span>
            <span className={styles.stat}>
              search <b>±{Math.round(autoPlan.searchHalf)}px</b>
            </span>
            {autoPlan.motionPerFrame !== null && (
              <span className={styles.stat}>
                motion <b>{autoPlan.motionPerFrame.toFixed(1)}px/f</b>
              </span>
            )}
          </p>
        )}

        {autoResult && (
          <div className={styles.actions}>
            <Button size="sm" variant="primary" onClick={() => onCreateNullAndApply()} fullWidth>
              Create null &amp; apply
            </Button>
            {result.tracks.length > 1 && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onCreateNullAndApply(true)}
                fullWidth
                title="Uses the second feature tracked alongside the first: the angle and length of the line between them carry rotation and scale."
              >
                &hellip; with rotation &amp; scale
              </Button>
            )}
            <div className={styles.actionRow}>
              <select
                className={styles.select}
                value={targetId}
                aria-label="Layer to receive the track"
                onChange={(e) => setTargetId(e.target.value)}
              >
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id === nodeId ? `${t.name || 'this layer'} (this layer)` : t.name || t.id}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="secondary" onClick={onApply}>
                Apply
              </Button>
            </div>
          </div>
        )}
      </section>

      <details className={styles.advanced}>
        <summary className={styles.advancedSummary}>Advanced tracking</summary>
        <div className={styles.advancedBody}>
          <InspectorRow label="Mode">
            <select
              className={styles.select}
              value={mode}
              onChange={(e) => store.getState().setMode(e.target.value as TrackerMode, src.width, src.height)}
            >
              {(Object.keys(MODE_LABELS) as TrackerMode[]).map((m) => (
                <option key={m} value={m}>{MODE_LABELS[m]}</option>
              ))}
            </select>
          </InspectorRow>
          <p className={styles.cardHint}>{MODE_HINTS[mode]}</p>
          {mode === 'mask' && maskPoints === 0 && (
            <p className={styles.cardHint} role="status">
              This layer has no mask — draw one with the mask tools first.
            </p>
          )}
          {mode !== 'mask' && mode !== 'smooth' && (
            <InspectorRow label={points.length > 1 ? 'Points' : 'Point'}>
              <span className={styles.cardHint}>
                {points.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' · ') || '—'}
              </span>
            </InspectorRow>
          )}
          <InspectorRow label="Feature size">
            <select
              className={styles.select}
              value={featureHalf}
              onChange={(e) => store.getState().setSizes(Number(e.target.value), searchHalf)}
            >
              {sizeOptions(FEATURE_SIZES, featureHalf).map((v) => (
                <option key={v} value={v}>{v * 2 + 1}×{v * 2 + 1}</option>
              ))}
            </select>
          </InspectorRow>
          {mode === 'smooth' && (
            <InspectorRow label="Variant">
              <select
                className={styles.select}
                value={stabVariant}
                onChange={(e) => setStabVariant(e.target.value as typeof stabVariant)}
              >
                <option value="similarity">Similarity (global)</option>
                <option value="subspace">Subspace warp (mesh)</option>
                <option value="rolling-shutter">Rolling shutter</option>
              </select>
            </InspectorRow>
          )}
          {mode === 'corner' && (
            <InspectorRow label="Dense grid">
              <input
                type="checkbox"
                checked={dense}
                onChange={(e) => store.getState().setDense(e.target.checked)}
                title="Track a lattice of extra features inside the quad — the planar fit then survives partial occlusion (RANSAC keeps the agreeing majority)."
              />
            </InspectorRow>
          )}
          <InspectorRow label="Search size">
            <select
              className={styles.select}
              value={searchHalf}
              onChange={(e) => store.getState().setSizes(featureHalf, Number(e.target.value))}
            >
              {sizeOptions(SEARCH_SIZES, searchHalf).map((v) => (
                <option key={v} value={v}>±{v} px</option>
              ))}
            </select>
          </InspectorRow>
          <Button size="sm" onClick={onTrack} disabled={tracking || !canTrack} fullWidth>
            {tracking
              ? `Tracking… ${Math.round(progress * 100)}%`
              : mode === 'mask'
                ? 'Track mask (playhead → end)'
                : 'Track (playhead → end)'}
          </Button>

          {result && mode !== 'mask' && (result.tracks[0]?.length ?? 0) > 1 && (
            <div className={styles.group}>
              <span className={styles.groupLabel}>Apply</span>
              {(mode === 'follow' || mode === 'transform' || mode === 'corner') && (
                <InspectorRow label={mode === 'corner' ? 'Pin layer' : 'Apply to'}>
                  <select
                    className={styles.select}
                    value={targetId}
                    onChange={(e) => setTargetId(e.target.value)}
                  >
                    {targets.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.id === nodeId ? `${t.name || 'this layer'} (this layer)` : t.name || t.id}
                      </option>
                    ))}
                  </select>
                </InspectorRow>
              )}
              <Button size="sm" onClick={onApply} fullWidth>
                {applyLabel}
              </Button>
              {mode === 'corner' && (
                <Button size="sm" variant="secondary" onClick={onApplyMesh} fullWidth>
                  Apply as Mesh Warp
                </Button>
              )}
              {mode === 'corner' && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={onSolveCamera}
                  fullWidth
                  title="3D Camera Tracker: SfM + bundle adjustment / planar-hybrid pose from tracked features."
                >
                  Solve 3D Camera Tracker
                </Button>
              )}
              {mode === 'corner' && result.tracks.length >= 8 && (
                <Button size="sm" variant="secondary" onClick={onCreateNullsForPlanes} fullWidth>
                  Create Nulls per Plane
                </Button>
              )}
              {(mode === 'follow' || mode === 'transform' || mode === 'corner') && (
                <Button size="sm" variant="secondary" onClick={() => onCreateNullAndApply()} fullWidth>
                  Create Null &amp; Apply
                </Button>
              )}
            </div>
          )}

          {/* Roto / CAF — available without a prior track result (mask mode
              was unreachable before). */}
          <div className={styles.group}>
            <span className={styles.groupLabel}>Roto &amp; fill</span>
            <Button size="sm" variant="secondary" onClick={() => void onRotoBrush()} disabled={!src || tracking} fullWidth>
              Roto Brush (propagate)
            </Button>
            <Button size="sm" variant="secondary" onClick={onSeedMatte} disabled={tracking} fullWidth>
              Seed Matte (GrabCut)
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={onSegmentSam}
              disabled={tracking}
              fullWidth
              title="SAM-class segment from track point (or two points as a box). Writes an Add mask. Register ONNX via registerSamOnnxSession for neural."
            >
              Segment (SAM-class)
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void onContentAwareFill()} disabled={tracking} fullWidth>
              Content-Aware Fill
            </Button>
          </div>
        </div>
      </details>
    </div>
  );
}

export default TrackMotionSection;
