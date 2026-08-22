/**
 * Track Motion — AE's tracker family, on the exact decoder.
 *
 * The section owns the WORKFLOW (mode → place points → track → apply);
 * everything that computes lives in core/tracking. Points are placed by
 * dragging the handles the TrackPointOverlay draws on the canvas — this
 * panel only reports them, because a coordinate you can see on the footage
 * beats a number field you have to guess into.
 *
 * Modes:
 *   Follow     — one point; apply as position keyframes on any layer.
 *   Stabilize  — one point; apply INVERSE motion to this layer, pinning the
 *                feature where it started.
 *   Corner pin — four points; keyframe a Corner Pin effect on a target
 *                layer (screen replacement).
 *   Track mask — this layer's mask vertices are the points; tracking writes
 *                mask keyframes directly (rotoscoping's first step).
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
import { useTrackerStore, type TrackerMode } from '@stores/trackerStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { trackVideoLayerPoints } from '@core/tracking/trackVideoLayer';
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

/** Shared <select> chrome — matches BoneControls/PuppetControls. */
const selectStyle: React.CSSProperties = {
  padding: '3px 8px',
  fontSize: 11,
  borderRadius: 4,
  background: 'var(--color-surface, #1e1e1e)',
  color: 'var(--color-text-primary, #fff)',
  border: '1px solid var(--color-border, #333)',
};

const noteStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-secondary, #999)',
  lineHeight: 1.4,
};

const FEATURE_SIZES = [5, 10, 15, 20];
const SEARCH_SIZES = [12, 24, 40, 60];

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
    return <p style={noteStyle}>Tracking needs WebCodecs, which this runtime does not have.</p>;
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
      const endCompTime = durationSeconds ?? time + 2;
      const r = await runRotoBrush({
        nodeId,
        seed: { x: points[0]?.x ?? src.width / 2, y: points[0]?.y ?? src.height / 2, tolerance: 40 },
        startCompTime: time,
        endCompTime: Math.max(time + 1 / fps, endCompTime),
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
      const endCompTime = durationSeconds ?? time + 1;
      const r = await runContentAwareFill({
        nodeId,
        startCompTime: time,
        endCompTime: Math.max(time + 1 / fps, Math.min(time + 2, endCompTime)),
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

  const onCreateNullAndApply = (): void => {
    if (!result) return;
    if (mode !== 'follow' && mode !== 'transform' && mode !== 'corner') return;
    const out = createNullAndApplyTrack({
      videoNodeId: nodeId,
      mode,
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
      `Created null “${out.nullId}” and applied ${out.keyframes} keyframes.`,
    );
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
    const node = defaultSceneGraph.getNode(nodeId);
    const g = node ? readGeometry(node) : null;
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
    const result = segmentSamSync({
      rgba,
      width: w,
      height: h,
      points: [{ x: sx, y: sy, label: 1, tolerance: 40 }],
      box,
      featherPx: 2,
    });
    const pts = matteToPath(result.mask, w, h);
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
        ? `Segment (${result.engine}): ${pts.length} contour points → mask path. Use Track mask / Roto Brush to propagate.`
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <InspectorRow label="Mode">
        <select
          style={selectStyle}
          value={mode}
          onChange={(e) => store.getState().setMode(e.target.value as TrackerMode, src.width, src.height)}
        >
          {(Object.keys(MODE_LABELS) as TrackerMode[]).map((m) => (
            <option key={m} value={m}>{MODE_LABELS[m]}</option>
          ))}
        </select>
      </InspectorRow>
      <p style={noteStyle}>{MODE_HINTS[mode]}</p>
      {mode === 'mask' && maskPoints === 0 && (
        <p style={noteStyle} role="status">
          This layer has no mask — draw one with the mask tools first.
        </p>
      )}
      {mode !== 'mask' && mode !== 'smooth' && (
        <InspectorRow label={points.length > 1 ? 'Points' : 'Point'}>
          <span style={noteStyle}>
            {points.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' · ') || '—'}
          </span>
        </InspectorRow>
      )}
      <InspectorRow label="Feature size">
        <select
          style={selectStyle}
          value={featureHalf}
          onChange={(e) => store.getState().setSizes(Number(e.target.value), searchHalf)}
        >
          {FEATURE_SIZES.map((v) => (
            <option key={v} value={v}>{v * 2 + 1}×{v * 2 + 1}</option>
          ))}
        </select>
      </InspectorRow>
      {mode === 'smooth' && (
        <InspectorRow label="Variant">
          <select
            style={selectStyle}
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
          style={selectStyle}
          value={searchHalf}
          onChange={(e) => store.getState().setSizes(featureHalf, Number(e.target.value))}
        >
          {SEARCH_SIZES.map((v) => (
            <option key={v} value={v}>±{v} px</option>
          ))}
        </select>
      </InspectorRow>
      <Button size="sm" onClick={onTrack} disabled={tracking || !canTrack}>
        {tracking
          ? `Tracking… ${Math.round(progress * 100)}%`
          : mode === 'mask'
            ? 'Track mask (playhead → end)'
            : 'Track (playhead → end)'}
      </Button>
      {note && (
        <p style={noteStyle} role="status">
          {note}
        </p>
      )}
      {result && mode !== 'mask' && (result.tracks[0]?.length ?? 0) > 1 && (
        <>
          {(mode === 'follow' || mode === 'transform' || mode === 'corner') && (
            <InspectorRow label={mode === 'corner' ? 'Pin layer' : 'Apply to'}>
              <select style={selectStyle} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id === nodeId ? `${t.name || 'this layer'} (this layer)` : t.name || t.id}
                  </option>
                ))}
              </select>
            </InspectorRow>
          )}
          <Button size="sm" onClick={onApply}>
            {applyLabel}
          </Button>
          {mode === 'corner' && (
            <Button size="sm" variant="secondary" onClick={onApplyMesh}>
              Apply as Mesh Warp
            </Button>
          )}
          {mode === 'corner' && (
            <Button
              size="sm"
              variant="secondary"
              onClick={onSolveCamera}
              title="3D Camera Tracker: SfM + bundle adjustment / planar-hybrid pose from tracked features."
            >
              Solve 3D Camera Tracker
            </Button>
          )}
          {mode === 'corner' && result && result.tracks.length >= 8 && (
            <Button size="sm" variant="secondary" onClick={onCreateNullsForPlanes}>
              Create Nulls per Plane
            </Button>
          )}
          {(mode === 'follow' || mode === 'transform' || mode === 'corner') && (
            <Button size="sm" variant="secondary" onClick={onCreateNullAndApply}>
              Create Null & Apply
            </Button>
          )}
        </>
      )}
      {/* Roto / CAF — available without a prior track result (mask mode was unreachable before). */}
      <Button size="sm" variant="secondary" onClick={() => void onRotoBrush()} disabled={!src || tracking}>
        Roto Brush (propagate)
      </Button>
      <Button size="sm" variant="secondary" onClick={onSeedMatte} disabled={tracking}>
        Seed Matte (GrabCut)
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={onSegmentSam}
        disabled={tracking}
        title="SAM-class segment from track point (or two points as a box). Writes an Add mask. Register ONNX via registerSamOnnxSession for neural."
      >
        Segment (SAM-class)
      </Button>
      <Button size="sm" variant="secondary" onClick={() => void onContentAwareFill()} disabled={tracking}>
        Content-Aware Fill
      </Button>
    </div>
  );
}

export default TrackMotionSection;
