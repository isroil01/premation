/**
 * Track Motion — AE's point tracker, on the exact decoder.
 *
 * The section owns the WORKFLOW (place point → track → apply); everything
 * that computes lives in core/tracking. The track point itself is placed by
 * dragging the handle the TrackPointOverlay draws on the canvas — this panel
 * only reports it, because a coordinate you can see on the footage beats a
 * number field you have to guess into.
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
import { useTrackerStore } from '@stores/trackerStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { trackVideoLayer } from '@core/tracking/trackVideoLayer';
import { applyTrackToLayer } from '@core/tracking/applyTrack';
import { sourceDisplaySize } from '@core/tracking/trackerSource';
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

export function TrackMotionSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const point = useTrackerStore((s) => s.point);
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

  // Opening the section for a layer arms the overlay for it, and seeds the
  // point at frame centre so there is a handle to grab at all.
  useEffect(() => {
    store.getState().activate(nodeId);
    if (!store.getState().point && src) {
      store.getState().setPoint(src.width / 2, src.height / 2);
    }
  }, [nodeId, src?.width, src?.height]);

  const targets = useMemo(() => {
    if (!node) return [];
    const siblings = node.parent ? defaultSceneGraph.getChildren(node.parent) : [node];
    return siblings;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scene rev drives this
  }, [node, useSceneRevision((s) => s.rev)]);

  if (!node || !src) return null;

  if (!webCodecsAvailable()) {
    return <p style={noteStyle}>Tracking needs WebCodecs, which this runtime does not have.</p>;
  }

  const onTrack = async (): Promise<void> => {
    const p = store.getState().point;
    if (!p || tracking) return;
    store.getState().beginTracking();
    try {
      const r = await trackVideoLayer({
        nodeId,
        startCompTime: time,
        endCompTime: Math.max(time, durationSeconds - 1 / fps),
        fps,
        startX: p.x,
        startY: p.y,
        featureHalf,
        searchHalf,
        onProgress: (f) => {
          store.getState().setProgress(f);
          return store.getState().tracking; // cleared store = cancelled
        },
      });
      const coasted = r.samples.filter((s) => s.coasted).length;
      const measured = r.samples.length - coasted;
      const avg =
        measured > 0
          ? r.samples.filter((s) => !s.coasted).reduce((a, s) => a + s.confidence, 0) / measured
          : 0;
      const outcome =
        r.status === 'lost'
          ? 'lost the feature — samples up to the loss are kept'
          : r.status === 'cancelled'
            ? 'cancelled'
            : 'completed';
      store.getState().finishTracking(
        {
          samples: r.samples,
          sourceWidth: r.sourceWidth,
          sourceHeight: r.sourceHeight,
          status: r.status,
        },
        `Tracked ${r.samples.length} frames (${outcome}) · confidence ${avg.toFixed(2)}` +
          (coasted > 0 ? ` · ${coasted} coasted` : ''),
      );
    } catch (e) {
      store.getState().finishTracking(null, e instanceof Error ? e.message : String(e));
    }
  };

  const onApply = (): void => {
    if (!result) return;
    const n = applyTrackToLayer({
      videoNodeId: nodeId,
      targetNodeId: targetId,
      samples: result.samples,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      comp,
    });
    store.getState().finishTracking(
      result,
      n > 0 ? `Applied ${n} keyframes to “${targetName(targetId)}”.` : 'Nothing to apply.',
    );
  };

  const targetName = (id: string): string =>
    targets.find((t) => t.id === id)?.name || (id === nodeId ? 'this layer' : id);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={noteStyle}>
        Drag the track point on the footage to the feature to follow, then track from the playhead.
      </p>
      <InspectorRow label="Point">
        <span style={noteStyle}>
          {point ? `${point.x.toFixed(1)}, ${point.y.toFixed(1)} px` : '—'}
        </span>
      </InspectorRow>
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
      <Button size="sm" onClick={onTrack} disabled={tracking || !point}>
        {tracking ? `Tracking… ${Math.round(progress * 100)}%` : 'Track (playhead → end)'}
      </Button>
      {note && (
        <p style={noteStyle} role="status">
          {note}
        </p>
      )}
      {result && result.samples.length > 1 && (
        <>
          <InspectorRow label="Apply to">
            <select style={selectStyle} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id === nodeId ? `${t.name || 'this layer'} (this layer)` : t.name || t.id}
                </option>
              ))}
            </select>
          </InspectorRow>
          <Button size="sm" onClick={onApply}>
            Apply as position keyframes
          </Button>
        </>
      )}
    </div>
  );
}

export default TrackMotionSection;
