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
import { useSceneRevision } from '@stores/sceneStore';
import { useTrackerStore, type TrackerMode } from '@stores/trackerStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { trackVideoLayerPoints } from '@core/tracking/trackVideoLayer';
import {
  applyTrackToLayer,
  applyStabilizeToLayer,
  applyCornerPinTrack,
  applyTransformTrack,
} from '@core/tracking/applyTrack';
import { trackLayerMask } from '@core/tracking/maskTrack';
import { sourceDisplaySize } from '@core/tracking/trackerSource';
import { getNodeMask } from '@core/effects/mask';
import { webCodecsAvailable } from '@core/video/exactVideoSource';

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
  corner: 'Corner pin',
  mask: 'Track mask',
};

const MODE_HINTS: Record<TrackerMode, string> = {
  follow: 'Drag the point onto the feature to follow, track, then apply as position keyframes on a target layer.',
  transform:
    'Two points: the ANCHOR drives position, the anchor→reference vector drives rotation and scale. Put both on the same rigid surface.',
  stabilize: 'Drag the point onto the feature to lock, track, then apply — this layer moves inversely so the feature stays put.',
  corner: 'Drag the four corners onto the surface to replace (TL, TR, BR, BL), track, then pin a target layer onto them.',
  mask: 'Tracks every vertex of this layer’s mask and writes mask keyframes — the mask follows the footage.',
};

export function TrackMotionSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const mode = useTrackerStore((s) => s.mode);
  const points = useTrackerStore((s) => s.points);
  const featureHalf = useTrackerStore((s) => s.featureHalf);
  const searchHalf = useTrackerStore((s) => s.searchHalf);
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

  const node = defaultSceneGraph.getNode(nodeId);
  const src = sourceDisplaySize(nodeId);
  const maskPoints = node ? getNodeMask(nodeId).paths.reduce((n, p) => n + p.points.length, 0) : 0;

  // Opening the section for a layer arms the overlay for it and seeds the
  // mode's points so there are handles to grab at all.
  useEffect(() => {
    store.getState().activate(nodeId);
    if (src) store.getState().seedPoints(src.width, src.height);
  }, [nodeId, src?.width, src?.height, mode]);

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
      const pts = store.getState().points;
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
      n = applyTrackToLayer({
        videoNodeId: nodeId,
        targetNodeId: targetId,
        samples: result.tracks[0] ?? [],
        sourceWidth: result.sourceWidth,
        sourceHeight: result.sourceHeight,
        comp,
      });
      what = `position keyframes to “${targetName(targetId)}”`;
    } else if (mode === 'transform') {
      n = applyTransformTrack({
        videoNodeId: nodeId,
        targetNodeId: targetId,
        tracks: result.tracks,
        sourceWidth: result.sourceWidth,
        sourceHeight: result.sourceHeight,
        comp,
      });
      what = `position/rotation/scale keyframes to “${targetName(targetId)}”`;
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

  const canTrack = mode === 'mask' ? maskPoints > 0 : points.length > 0;
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
      {mode !== 'mask' && (
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
        </>
      )}
    </div>
  );
}

export default TrackMotionSection;
