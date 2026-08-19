/**
 * The Track Motion point on the canvas: one draggable cross, its feature box,
 * its search box, and — after a run — the tracked path.
 *
 * Same shape as EffectHandleOverlay, on purpose: pointer plumbing and SVG
 * only, projection through the shared `layerScreenMapping`, hit-testing in
 * SCREEN pixels at constant radius. The maths that isn't drawing lives in
 * core/tracking (`trackSampleToComp`).
 *
 * The point itself is stored in SOURCE pixels (trackerStore's contract): the
 * overlay converts source → layer-local (content is centred on the local
 * origin) → screen for drawing, and the exact inverse for dragging. Boxes are
 * drawn by mapping their CORNERS, not by drawing a fixed-size rect, so they
 * stay honest under rotation, non-uniform scale and 3D.
 */

import { useEffect, useMemo, useRef } from 'react';
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

export function TrackPointOverlay(): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const ids = useSelectionStore((s) => s.ids);
  const nodeId = useTrackerStore((s) => s.nodeId);
  const point = useTrackerStore((s) => s.point);
  const featureHalf = useTrackerStore((s) => s.featureHalf);
  const searchHalf = useTrackerStore((s) => s.searchHalf);
  const result = useTrackerStore((s) => s.result);
  const setPoint = useTrackerStore((s) => s.setPoint);
  const time = useActiveWorkspace()?.time ?? 0;
  const comp = useCompositionStore((s) => s.comp());
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef(false);

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
    if (!svg || !sourceToScreen || !screenToSource || !point) return;

    const local = (e: PointerEvent): { x: number; y: number } => {
      const r = svg.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const onDown = (e: PointerEvent): void => {
      const p = local(e);
      const s = sourceToScreen(point.x, point.y);
      if (Math.hypot(p.x - s.x, p.y - s.y) > PICK_R) return;
      e.stopPropagation();
      e.preventDefault();
      dragRef.current = true;
      svg.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent): void => {
      if (!dragRef.current) return;
      const p = local(e);
      const s = screenToSource(p.x, p.y);
      setPoint(s.x, s.y);
    };
    const onUp = (e: PointerEvent): void => {
      if (!dragRef.current) return;
      dragRef.current = false;
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
  }, [sourceToScreen, screenToSource, point, setPoint]);

  if (!node || !geom || !src || !point || !sourceToScreen) return null;

  const p = sourceToScreen(point.x, point.y);
  const boxPoints = (half: number): string =>
    [
      sourceToScreen(point.x - half, point.y - half),
      sourceToScreen(point.x + half, point.y - half),
      sourceToScreen(point.x + half, point.y + half),
      sourceToScreen(point.x - half, point.y + half),
    ]
      .map((c) => `${c.x},${c.y}`)
      .join(' ');

  // The tracked path, each sample projected through the video layer's
  // transform AT ITS OWN TIME — a path on a moving layer is a comp-space
  // curve, not a source-space one.
  const path = result
    ? result.samples
        .map((s) => {
          const c = trackSampleToComp(
            node.id, s.x, s.y, s.compTime, result.sourceWidth, result.sourceHeight, comp,
          );
          if (!c) return null;
          const sc = camera.worldToScreen({ x: c.x, y: c.y });
          return { sc, coasted: s.coasted };
        })
        .filter((v): v is NonNullable<typeof v> => v !== null)
    : [];

  return (
    <svg
      ref={svgRef}
      aria-label="Track point"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'auto' }}
    >
      {path.length > 1 && (
        <polyline
          points={path.map((v) => `${v.sc.x},${v.sc.y}`).join(' ')}
          fill="none"
          stroke="rgba(102, 217, 132, 0.85)"
          strokeWidth={1.5}
        />
      )}
      {path.map((v, i) => (
        // Coasted samples in amber: the stretch the tracker predicted rather
        // than measured should LOOK different before anyone applies it.
        <circle
          key={i}
          cx={v.sc.x}
          cy={v.sc.y}
          r={1.5}
          fill={v.coasted ? '#ffd166' : 'rgba(102, 217, 132, 0.9)'}
        />
      ))}
      <polygon points={boxPoints(featureHalf)} fill="none" stroke="#ffffff" strokeWidth={1} />
      <polygon
        points={boxPoints(searchHalf)}
        fill="none"
        stroke="rgba(255,255,255,0.45)"
        strokeDasharray="4 4"
        strokeWidth={1}
      />
      <circle cx={p.x} cy={p.y} r={POINT_R + 1.5} fill="rgba(0,0,0,0.55)" />
      <circle cx={p.x} cy={p.y} r={POINT_R} fill="#ffd166" stroke="#101014" strokeWidth={1} />
      <line x1={p.x - POINT_R} y1={p.y} x2={p.x + POINT_R} y2={p.y} stroke="#101014" strokeWidth={1} />
      <line x1={p.x} y1={p.y - POINT_R} x2={p.x} y2={p.y + POINT_R} stroke="#101014" strokeWidth={1} />
    </svg>
  );
}

export default TrackPointOverlay;
