/**
 * The Track Motion points on the canvas: draggable crosses (one in follow /
 * stabilize, four in corner mode), the primary point's feature and search
 * boxes, the corner quad, and — after a run — the tracked paths.
 *
 * Same shape as EffectHandleOverlay, on purpose: pointer plumbing and SVG
 * only, projection through the shared `layerScreenMapping`, hit-testing in
 * SCREEN pixels at constant radius. The maths that isn't drawing lives in
 * core/tracking (`trackSampleToComp`).
 *
 * Points are stored in SOURCE pixels (trackerStore's contract): the overlay
 * converts source → layer-local (content is centred on the local origin) →
 * screen for drawing, and the exact inverse for dragging. Boxes are drawn by
 * mapping their CORNERS, not by drawing a fixed-size rect, so they stay
 * honest under rotation, non-uniform scale and 3D.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSceneRevision } from '@stores/sceneStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useTrackerStore } from '@stores/trackerStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { readGeometry } from '@core/workspace/geometry';
import { trackSampleToComp } from '@core/tracking/applyTrack';
import { sourceDisplaySize } from '@core/tracking/trackerSource';
import { layerScreenMapping } from './layerScreen';

const POINT_R = 5;
const PICK_R = 12;
const CORNER_LABELS = ['TL', 'TR', 'BR', 'BL'];

export function TrackPointOverlay(): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const ids = useSelectionStore((s) => s.ids);
  const nodeId = useTrackerStore((s) => s.nodeId);
  const mode = useTrackerStore((s) => s.mode);
  const points = useTrackerStore((s) => s.points);
  const featureHalf = useTrackerStore((s) => s.featureHalf);
  const searchHalf = useTrackerStore((s) => s.searchHalf);
  const result = useTrackerStore((s) => s.result);
  const setPoint = useTrackerStore((s) => s.setPoint);
  const time = useActiveWorkspace()?.time ?? 0;
  const comp = useCompositionStore((s) => s.comp());
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<number | null>(null);
  const [, setDragTick] = useState(0);

  const active = nodeId && ids.includes(nodeId) ? nodeId : null;
  const node = active ? defaultSceneGraph.getNode(active) : null;
  const geom = node ? readGeometry(node) : null;
  const src = active ? sourceDisplaySize(active) : null;

  const camera = getWorkspaceController().ws.camera;
  const mapping = useMemo(
    () => (active ? layerScreenMapping(active, time, comp, camera) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- camera is a live singleton
    [active, time, comp.width, comp.height, useSceneRevision((s) => s.rev)],
  );

  const sourceToScreen = useMemo(() => {
    if (!mapping || !geom || !src) return null;
    return (sx: number, sy: number): { x: number; y: number } =>
      mapping.localToScreen(
        (sx / src.width - 0.5) * geom.width,
        (sy / src.height - 0.5) * geom.height,
      );
  }, [mapping, geom?.width, geom?.height, src?.width, src?.height]);

  const screenToSource = useMemo(() => {
    if (!mapping || !geom || !src) return null;
    return (px: number, py: number): { x: number; y: number } => {
      const l = mapping.screenToLocal(px, py);
      return {
        x: (l.x / geom.width + 0.5) * src.width,
        y: (l.y / geom.height + 0.5) * src.height,
      };
    };
  }, [mapping, geom?.width, geom?.height, src?.width, src?.height]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !sourceToScreen || !screenToSource || points.length === 0) return;

    const local = (e: PointerEvent): { x: number; y: number } => {
      const r = svg.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const hit = (p: { x: number; y: number }): number | null => {
      let best: number | null = null;
      let bestD = PICK_R;
      for (let i = 0; i < points.length; i++) {
        const s = sourceToScreen(points[i]!.x, points[i]!.y);
        const d = Math.hypot(p.x - s.x, p.y - s.y);
        if (d <= bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    };

    const onDown = (e: PointerEvent): void => {
      const i = hit(local(e));
      if (i === null) return;
      e.stopPropagation();
      e.preventDefault();
      dragRef.current = i;
      setDragTick((n) => n + 1);
      svg.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent): void => {
      if (dragRef.current === null) return;
      const s = screenToSource(local(e).x, local(e).y);
      setPoint(dragRef.current, s.x, s.y);
    };
    const onUp = (e: PointerEvent): void => {
      if (dragRef.current === null) return;
      dragRef.current = null;
      if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
    };

    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    svg.addEventListener('pointercancel', onUp);
    return () => {
      svg.removeEventListener('pointerdown', onDown);
      svg.removeEventListener('pointermove', onMove);
      svg.removeEventListener('pointerup', onUp);
      svg.removeEventListener('pointercancel', onUp);
    };
  }, [sourceToScreen, screenToSource, points, setPoint]);

  if (!node || !geom || !src || points.length === 0 || !sourceToScreen) return null;

  const screenPts = points.map((p) => sourceToScreen(p.x, p.y));
  const boxPoints = (centre: { x: number; y: number }, half: number): string =>
    [
      sourceToScreen(centre.x - half, centre.y - half),
      sourceToScreen(centre.x + half, centre.y - half),
      sourceToScreen(centre.x + half, centre.y + half),
      sourceToScreen(centre.x - half, centre.y + half),
    ]
      .map((c) => `${c.x},${c.y}`)
      .join(' ');

  // Tracked paths, each sample projected through the video layer's transform
  // AT ITS OWN TIME — a path on a moving layer is a comp-space curve.
  const paths = result
    ? result.tracks.map((track) =>
        track
          .map((s) => {
            const c = trackSampleToComp(
              node.id, s.x, s.y, s.compTime, result.sourceWidth, result.sourceHeight, comp,
            );
            if (!c) return null;
            return { sc: camera.worldToScreen({ x: c.x, y: c.y }), coasted: s.coasted };
          })
          .filter((v): v is NonNullable<typeof v> => v !== null),
      )
    : [];

  return (
    <svg
      ref={svgRef}
      aria-label="Track points"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'auto' }}
    >
      {paths.map((path, i) =>
        path.length > 1 ? (
          <polyline
            key={`path-${i}`}
            points={path.map((v) => `${v.sc.x},${v.sc.y}`).join(' ')}
            fill="none"
            stroke="rgba(102, 217, 132, 0.85)"
            strokeWidth={1.5}
          />
        ) : null,
      )}
      {paths.flatMap((path, i) =>
        path.map((v, j) => (
          // Coasted samples in amber: the stretch the tracker predicted rather
          // than measured should LOOK different before anyone applies it.
          <circle
            key={`s-${i}-${j}`}
            cx={v.sc.x}
            cy={v.sc.y}
            r={1.5}
            fill={v.coasted ? '#ffd166' : 'rgba(102, 217, 132, 0.9)'}
          />
        )),
      )}
      {mode === 'corner' && screenPts.length === 4 && (
        <polygon
          points={screenPts.map((s) => `${s.x},${s.y}`).join(' ')}
          fill="none"
          stroke="rgba(255, 209, 102, 0.6)"
          strokeDasharray="6 4"
          strokeWidth={1}
        />
      )}
      {points[0] && (
        <>
          <polygon points={boxPoints(points[0], featureHalf)} fill="none" stroke="#ffffff" strokeWidth={1} />
          <polygon
            points={boxPoints(points[0], searchHalf)}
            fill="none"
            stroke="rgba(255,255,255,0.45)"
            strokeDasharray="4 4"
            strokeWidth={1}
          />
        </>
      )}
      {screenPts.map((s, i) => (
        <g key={`pt-${i}`} aria-label={`Track point ${i + 1}`}>
          <circle cx={s.x} cy={s.y} r={POINT_R + 1.5} fill="rgba(0,0,0,0.55)" />
          <circle cx={s.x} cy={s.y} r={POINT_R} fill="#ffd166" stroke="#101014" strokeWidth={1} />
          <line x1={s.x - POINT_R} y1={s.y} x2={s.x + POINT_R} y2={s.y} stroke="#101014" strokeWidth={1} />
          <line x1={s.x} y1={s.y - POINT_R} x2={s.x} y2={s.y + POINT_R} stroke="#101014" strokeWidth={1} />
          {mode === 'corner' && (
            <text x={s.x + 8} y={s.y - 8} fontSize={10} fill="#ffd166" style={{ userSelect: 'none' }}>
              {CORNER_LABELS[i]}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

export default TrackPointOverlay;
