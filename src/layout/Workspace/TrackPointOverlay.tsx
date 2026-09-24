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
 *
 * It is also the pointer half of one-click tracking. While `autoPhase` is
 * 'picking' the whole surface takes the pointer and shows a crosshair; a
 * CLICK runs the analysis at that spot, and a DRAG draws a marquee whose box
 * becomes the analysis region — "track the thing inside this" — feeding
 * `pickFeature`'s hint + radius, which is exactly the AE gesture of putting a
 * box around the object. Either way the surface then goes back to letting
 * everything through. That arming exists because a click on the viewport
 * already means "select this layer" — the tracker gets the pointer for
 * exactly one gesture, announced, and never by ambush.
 *
 * Manual mode is AE's track-point instrument: the feature and search boxes
 * are RESIZED ON THE FOOTAGE by their corner handles (the panel dropdowns
 * remain as the numeric view of the same values), and dragging the point
 * itself raises a magnifier loupe — a 4× pixel view of what is under the
 * point — because placing a tracker on a corner is a one-pixel decision made
 * on content the point's own crosshair is covering.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useTrackerStore } from '@stores/trackerStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useActiveCompSize, useMirrorRevisionFrame } from '@hooks/useMirrorFrame';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { readGeometry } from '@core/workspace/geometry';
import { trackSampleToComp } from '@core/tracking/applyTrack';
import { runAutoTrack } from '@core/tracking/autoTrackCommand';
import { runObjectMaskPick } from '@core/tracking/objectMask';
import { sourceDisplaySize } from '@core/tracking/trackerSource';
import { layerScreenMapping } from './layerScreen';

const POINT_R = 5;
const PICK_R = 12;
const CORNER_LABELS = ['TL', 'TR', 'BR', 'BL'];
/** The magnifier: a LOUPE_SIZE square showing footage at LOUPE_ZOOM×. */
const LOUPE_SIZE = 120;
const LOUPE_ZOOM = 4;

/**
 * Match confidence → dot opacity.
 *
 * Mapped from the tracker's own accept threshold (0.55) up to a strong match
 * (0.95) rather than from 0, because everything BELOW the threshold was
 * coasted and is already drawn amber — spending half the opacity range on
 * scores that cannot occur would make every real sample look uncertain.
 */
function qualityStroke(distinctness: number): string {
  // Same three bands the panel's quality pill uses — one vocabulary, two
  // places, so the canvas and the inspector never disagree about a feature.
  if (distinctness >= 0.6) return 'rgba(102, 217, 132, 0.9)';
  if (distinctness >= 0.35) return 'rgba(255, 209, 102, 0.9)';
  return 'rgba(255, 107, 107, 0.9)';
}

function confidenceAlpha(confidence: number): number {
  const t = (confidence - 0.55) / (0.95 - 0.55);
  return 0.35 + 0.55 * Math.max(0, Math.min(1, t));
}

export function TrackPointOverlay(): JSX.Element | null {
  // Frame-coalesced — visual tracking only; the raw rev re-rendered per
  // pointer event during drags and defeated the mapping memo below.
  const sceneTick = useMirrorRevisionFrame();
  const nodeId = useTrackerStore((s) => s.nodeId);
  const armed = useTrackerStore((s) => s.armed);
  const mode = useTrackerStore((s) => s.mode);
  const points = useTrackerStore((s) => s.points);
  const featureHalf = useTrackerStore((s) => s.featureHalf);
  const searchHalf = useTrackerStore((s) => s.searchHalf);
  const result = useTrackerStore((s) => s.result);
  const autoPhase = useTrackerStore((s) => s.autoPhase);
  const pickIntent = useTrackerStore((s) => s.pickIntent);
  const autoPlan = useTrackerStore((s) => s.autoPlan);
  const advancedOpen = useTrackerStore((s) => s.advancedOpen);
  const setPoint = useTrackerStore((s) => s.setPoint);
  const time = useActiveWorkspace()?.time ?? 0;
  const comp = useActiveCompSize();
  const svgRef = useRef<SVGSVGElement | null>(null);
  /** What the pointer is holding: a point, or one of the primary point's two
   *  box corners. Boxes resize about the point, so the corner grabbed does
   *  not matter — only which box it belongs to. */
  const dragRef = useRef<{ kind: 'point'; index: number } | { kind: 'feature' } | { kind: 'search' } | null>(null);
  const [, setDragTick] = useState(0);
  /** Live marquee while a picking drag is in flight, in overlay screen px. */
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** Magnifier while a point drags: where to draw it, and what it looks at. */
  const [loupe, setLoupe] = useState<{ screenX: number; screenY: number } | null>(null);
  const loupeCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Armed = the Track Motion section is open — and that alone. This used to
  // ALSO require the tracked layer to be in the selection, which read as
  // safety and was a dead switch: the panel keeps its own Motion Source (it
  // survives any selection), and "Create null & apply" SELECTS the new null —
  // so the very next "Pick target in viewport" armed a pick over an overlay
  // that refused to exist, and clicks fell through to plain layer selection.
  // The original worry (selection alone putting chrome over the viewport)
  // is still covered: `armed` is set only while the section is mounted.
  const active = armed && nodeId ? nodeId : null;
  const node = active ? defaultSceneGraph.getNode(active) : null;
  const geom = node ? readGeometry(node) : null;
  const src = active ? sourceDisplaySize(active) : null;

  const camera = getWorkspaceController().ws.camera;
  const mapping = useMemo(
    () => (active ? layerScreenMapping(active, time, comp, camera) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- camera is a live singleton
    [active, time, comp.width, comp.height, sceneTick],
  );

  const sourceToScreen = useMemo(() => {
    if (!mapping || !geom || !src) return null;
    return (sx: number, sy: number): { x: number; y: number } =>
      mapping.localToScreen(
        (sx / src.width - 0.5) * geom.width,
        (sy / src.height - 0.5) * geom.height,
      );
  }, [mapping, geom, src]);

  const screenToSource = useMemo(() => {
    if (!mapping || !geom || !src) return null;
    return (px: number, py: number): { x: number; y: number } => {
      const l = mapping.screenToLocal(px, py);
      return {
        x: (l.x / geom.width + 0.5) * src.width,
        y: (l.y / geom.height + 0.5) * src.height,
      };
    };
  }, [mapping, geom, src]);

  // The pick gesture. Separate from the drag plumbing below because it is a
  // different interaction with a different lifetime: it owns the WHOLE
  // surface, lasts exactly one gesture, and must not be reachable when the
  // panel has not armed it.
  //
  // One gesture, two readings: a CLICK asks "track whatever is here" (the
  // analysis searches its default radius around the click), a DRAG draws a
  // box that MEANS "the object is inside this" — its centre becomes the hint
  // and its half-size the search radius, so the chosen feature is guaranteed
  // to come from the marquee rather than from something stronger nearby.
  // The 5 px threshold is what separates them; below it a shaky click stays
  // a click.
  // The gesture's own state lives in REFS, and the mapping is read through
  // one: this effect must depend only on arm/disarm, because the coordinate
  // mapping's identity changes on every scene tick and playhead move — and an
  // effect that re-ran mid-drag would tear its listeners down with the
  // marquee half-drawn. The mapping ref always holds the CURRENT mapping, so
  // the box the user releases is measured against the frame they see.
  const screenToSourceRef = useRef(screenToSource);
  screenToSourceRef.current = screenToSource;
  const pickStartRef = useRef<{ x: number; y: number } | null>(null);
  const pickDraggingRef = useRef(false);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || autoPhase !== 'picking' || !active) {
      pickStartRef.current = null;
      pickDraggingRef.current = false;
      setMarquee(null);
      return;
    }
    const local = (e: PointerEvent): { x: number; y: number } => {
      const r = svg.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onDown = (e: PointerEvent): void => {
      e.stopPropagation();
      e.preventDefault();
      pickStartRef.current = local(e);
      pickDraggingRef.current = false;
      // Capture keeps the marquee alive when the cursor leaves the stage.
      // Best-effort: an id the browser does not consider active (synthetic
      // events, some pen edge cases) throws, and losing capture must not
      // lose the gesture.
      try { svg.setPointerCapture(e.pointerId); } catch { /* uncaptured is fine */ }
    };
    const onMove = (e: PointerEvent): void => {
      const start = pickStartRef.current;
      if (!start) return;
      const p = local(e);
      if (!pickDraggingRef.current && Math.hypot(p.x - start.x, p.y - start.y) < 5) return;
      pickDraggingRef.current = true;
      setMarquee({ x0: start.x, y0: start.y, x1: p.x, y1: p.y });
    };
    const onUp = (e: PointerEvent): void => {
      const start = pickStartRef.current;
      const toSource = screenToSourceRef.current;
      if (!start || !toSource) return;
      const p = local(e);
      if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
      const wasDrag = pickDraggingRef.current;
      pickStartRef.current = null;
      pickDraggingRef.current = false;
      setMarquee(null);
      // One crosshair, two verbs — the armed INTENT decides what the gesture
      // means (trackerStore.pickIntent): 'track' feeds the one-click tracker,
      // 'object' feeds SAM segmentation and lands a mask path.
      const intent = useTrackerStore.getState().pickIntent;
      if (wasDrag) {
        const a = toSource(start.x, start.y);
        const b = toSource(p.x, p.y);
        if (intent === 'object') {
          void runObjectMaskPick({ nodeId: active, box: { x0: a.x, y0: a.y, x1: b.x, y1: b.y } });
          return;
        }
        const hint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        // The larger half-side: the region is what was CIRCLED, and a thin
        // box around a wide object still means the whole object. Floored at
        // 12 px so a tiny box is a precise pick, not an unsearchable one.
        const radius = Math.max(12, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2);
        void runAutoTrack({ nodeId: active, hint, radius });
      } else if (intent === 'object') {
        void runObjectMaskPick({ nodeId: active, point: toSource(p.x, p.y) });
      } else {
        void runAutoTrack({ nodeId: active, hint: toSource(p.x, p.y) });
      }
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
  }, [autoPhase, active]);

  /*
    Whether the MANUAL chrome exists: seeded handles, the feature/search
    boxes, and their drag targets. The one-click flow seeds a point the user
    never placed — drawing it (a crosshair in a dashed box, dead centre over
    the footage) made an untouched panel look broken. It appears once the
    person opens Advanced tracking (they asked for handles), the analysis
    lands a plan (the point now MEANS something and wears the quality ring),
    or the mode needs placed points at all.
  */
  const manualVisible = advancedOpen || autoPlan !== null || mode !== 'follow';

  useEffect(() => {
    const svg = svgRef.current;
    // Hidden handles must not drag either — an invisible hit target over the
    // footage is the same ambush the pointerEvents note below is about.
    if (!svg || !sourceToScreen || !screenToSource || points.length === 0 || !manualVisible) return;

    const local = (e: PointerEvent): { x: number; y: number } => {
      const r = svg.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    /** The primary point's box corners in screen px — the resize handles. */
    const boxCorners = (half: number): Array<{ x: number; y: number }> => {
      const c = points[0]!;
      return [
        sourceToScreen(c.x - half, c.y - half),
        sourceToScreen(c.x + half, c.y - half),
        sourceToScreen(c.x + half, c.y + half),
        sourceToScreen(c.x - half, c.y + half),
      ];
    };
    const cornerDist = (p: { x: number; y: number }, half: number): number =>
      Math.min(...boxCorners(half).map((c) => Math.hypot(p.x - c.x, p.y - c.y)));
    const hit = (p: { x: number; y: number }): typeof dragRef.current => {
      let bestIdx: number | null = null;
      let pointDist = Infinity;
      for (let i = 0; i < points.length; i++) {
        const s = sourceToScreen(points[i]!.x, points[i]!.y);
        const d = Math.hypot(p.x - s.x, p.y - s.y);
        if (d < pointDist) {
          pointDist = d;
          bestIdx = i;
        }
      }
      // NEAREST instrument wins, each within its own reach. A priority order
      // fails here: a small feature box's corners sit INSIDE the point's own
      // pick radius, and corners-first turned every grab of the point into a
      // resize (which also meant the loupe never appeared).
      const candidates: Array<{ d: number; grab: NonNullable<typeof dragRef.current> }> = [];
      if (bestIdx !== null && pointDist <= PICK_R) {
        candidates.push({ d: pointDist, grab: { kind: 'point', index: bestIdx } });
      }
      const fd = cornerDist(p, featureHalf);
      if (fd <= 7) candidates.push({ d: fd, grab: { kind: 'feature' } });
      const sd = cornerDist(p, searchHalf);
      if (sd <= 7) candidates.push({ d: sd, grab: { kind: 'search' } });
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => a.d - b.d);
      return candidates[0]!.grab;
    };

    const onDown = (e: PointerEvent): void => {
      const grab = hit(local(e));
      if (grab === null) return;
      e.stopPropagation();
      e.preventDefault();
      dragRef.current = grab;
      setDragTick((n) => n + 1);
      if (grab.kind === 'point') {
        const p = local(e);
        setLoupe({ screenX: p.x, screenY: p.y });
      }
      // Same best-effort capture as the pick gesture above.
      try { svg.setPointerCapture(e.pointerId); } catch { /* uncaptured is fine */ }
    };
    const onMove = (e: PointerEvent): void => {
      const grab = dragRef.current;
      if (grab === null) return;
      const p = local(e);
      const s = screenToSource(p.x, p.y);
      if (grab.kind === 'point') {
        setPoint(grab.index, s.x, s.y);
        setLoupe({ screenX: p.x, screenY: p.y });
        return;
      }
      // Box resize: the boxes are squares centred on the point, so the new
      // half-size is the Chebyshev distance from the point to the cursor in
      // SOURCE px — correct under any layer rotation or scale, because both
      // ends went through the same mapping.
      const c = points[0]!;
      const half = Math.round(Math.max(Math.abs(s.x - c.x), Math.abs(s.y - c.y)));
      const store = useTrackerStore.getState();
      if (grab.kind === 'feature') {
        const f = Math.max(3, Math.min(48, half));
        // The search box must stay OUTSIDE the feature box — growing the
        // feature pushes the search out rather than silently crossing it.
        store.setSizes(f, Math.max(f + 4, store.searchHalf));
      } else {
        store.setSizes(store.featureHalf, Math.max(store.featureHalf + 4, Math.min(128, half)));
      }
      setDragTick((n) => n + 1);
    };
    const onUp = (e: PointerEvent): void => {
      if (dragRef.current === null) return;
      dragRef.current = null;
      setLoupe(null);
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
      // Deliberately NOT setLoupe(null): this effect's identity churns with
      // the mapping (every playhead tick re-runs it), and a cleanup that
      // cleared the loupe killed it within a frame of the drag starting.
      // The loupe's life is the DRAG's: pointerup/cancel end it, and unmount
      // takes the state with it.
    };
  }, [sourceToScreen, screenToSource, points, setPoint, manualVisible, featureHalf, searchHalf]);

  /*
    The loupe's pixels. Drawn from the viewport's content canvas — the frame
    the user is looking at, magnified 4× with smoothing OFF so individual
    pixels are visible (that is the tool: a tracker point is placed on a
    pixel, not on a vibe). The content canvas is WebGPU and its buffer is
    formally only readable in the task that drew it; in practice drawImage of
    the last presented frame works, and when it does not the catch leaves the
    loupe as crosshair-on-black rather than taking the drag down.
  */
  useEffect(() => {
    const out = loupeCanvasRef.current;
    if (!loupe || !out) return;
    const content = getWorkspaceController().getContentCanvas();
    const g = out.getContext('2d');
    if (!g) return;
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#101014';
    g.fillRect(0, 0, out.width, out.height);
    if (content && content.clientWidth > 0) {
      // Overlay screen px → content buffer px (the buffer runs at device
      // resolution and adaptive preview scale; the ratio absorbs both).
      const bx = content.width / content.clientWidth;
      const by = content.height / content.clientHeight;
      const sw = (out.width / LOUPE_ZOOM) * bx;
      const sh = (out.height / LOUPE_ZOOM) * by;
      try {
        g.drawImage(
          content,
          loupe.screenX * bx - sw / 2, loupe.screenY * by - sh / 2, sw, sh,
          0, 0, out.width, out.height,
        );
      } catch {
        /* unreadable this frame — the crosshair still shows */
      }
    }
    // Crosshair, drawn in two tones so it reads on any footage.
    const mid = out.width / 2;
    g.strokeStyle = 'rgba(0,0,0,0.8)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(mid, mid - 12); g.lineTo(mid, mid + 12);
    g.moveTo(mid - 12, mid); g.lineTo(mid + 12, mid);
    g.stroke();
    g.strokeStyle = '#ffd166';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(mid, mid - 12); g.lineTo(mid, mid + 12);
    g.moveTo(mid - 12, mid); g.lineTo(mid + 12, mid);
    g.stroke();
  }, [loupe]);

  // While picking there may be no point yet — the surface still has to be
  // there to receive the click.
  const picking = autoPhase === 'picking';
  if (!node || !geom || !src || !sourceToScreen || (points.length === 0 && !picking)) return null;

  const screenPts = points.map((p) => sourceToScreen(p.x, p.y));
  const boxCornerPts = (centre: { x: number; y: number }, half: number): Array<{ x: number; y: number }> => [
    sourceToScreen(centre.x - half, centre.y - half),
    sourceToScreen(centre.x + half, centre.y - half),
    sourceToScreen(centre.x + half, centre.y + half),
    sourceToScreen(centre.x - half, centre.y + half),
  ];
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
  //
  // Only the samples within a second of the playhead are drawn. The full walk
  // used to be drawn at once: on a track that wandered or coasted, a hundred
  // dots and a zig-zagging line over the footage read as a corrupted frame —
  // "my video broke when I tracked it" — when the pixels underneath were fine.
  // A window shows where the feature IS and where it is going; the timeline
  // holds the whole path as keyframes once it is applied.
  const PATH_WINDOW_S = 1;
  const paths = result
    ? result.tracks.map((track) =>
        track
          .filter((s) => Math.abs(s.compTime - time) <= PATH_WINDOW_S)
          .map((s) => {
            const c = trackSampleToComp(
              node.id, s.x, s.y, s.compTime, result.sourceWidth, result.sourceHeight, comp,
            );
            if (!c) return null;
            return {
              sc: camera.worldToScreen({ x: c.x, y: c.y }),
              coasted: s.coasted,
              confidence: s.confidence,
            };
          })
          .filter((v): v is NonNullable<typeof v> => v !== null),
      )
    : [];

  return (
    <svg
      ref={svgRef}
      aria-label="Track points"
      // `none` at the svg level: the overlay spans the whole stage, and an
      // `auto` svg swallowed every viewport gesture (pan, zoom, layer drags)
      // whenever the tracker was armed. Only the per-point hit circles are
      // interactive; everything else lets input fall through to the canvas.
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        // Armed for a pick, the surface takes the click; otherwise only the
        // per-point hit circles are interactive.
        pointerEvents: picking ? 'all' : 'none',
        ...(picking ? { cursor: 'crosshair' } : {}),
      }}
    >
      {marquee && (
        // The picking marquee: dark underlay + light dash so it reads on any
        // footage, and a whisper of fill so the REGION reads as chosen, not
        // just outlined.
        <g pointerEvents="none">
          <rect
            x={Math.min(marquee.x0, marquee.x1)}
            y={Math.min(marquee.y0, marquee.y1)}
            width={Math.abs(marquee.x1 - marquee.x0)}
            height={Math.abs(marquee.y1 - marquee.y0)}
            // Track = green (the path colour), object mask = amber (the mask
            // colour family) — the box says what release will do.
            fill={pickIntent === 'object' ? 'rgba(255, 209, 102, 0.10)' : 'rgba(102, 217, 132, 0.08)'}
            stroke="rgba(0,0,0,0.7)"
            strokeWidth={2.5}
          />
          <rect
            x={Math.min(marquee.x0, marquee.x1)}
            y={Math.min(marquee.y0, marquee.y1)}
            width={Math.abs(marquee.x1 - marquee.x0)}
            height={Math.abs(marquee.y1 - marquee.y0)}
            fill="none"
            stroke="#ffffff"
            strokeWidth={1}
            strokeDasharray="5 4"
          />
        </g>
      )}
      {/* Track 0 is the feature the user picked; the rest are COMPANIONS the
          analysis tracked alongside it (they carry rotation & scale). Drawn
          faint and dashed, dot-free, because a solid second squiggle over
          unrelated footage read as a glitch — it is reference data, and it
          should look subordinate to the path the user asked for. */}
      {paths.map((path, i) =>
        path.length > 1 ? (
          <polyline
            key={`path-${i}`}
            points={path.map((v) => `${v.sc.x},${v.sc.y}`).join(' ')}
            fill="none"
            stroke={i === 0 ? 'rgba(102, 217, 132, 0.85)' : 'rgba(102, 217, 132, 0.28)'}
            strokeWidth={i === 0 ? 1.5 : 1}
            {...(i === 0 ? {} : { strokeDasharray: '2 4' })}
          >
            {i > 0 && <title>Companion feature — carries rotation &amp; scale</title>}
          </polyline>
        ) : null,
      )}
      {(paths[0] ?? []).map((v, j) => (
        // Coasted samples in amber: the stretch the tracker predicted rather
        // than measured should LOOK different before anyone applies it. The
        // rest fade with match confidence, so a stretch the tracker only
        // just held onto reads as faint rather than as solid fact.
        <circle
          key={`s-0-${j}`}
          cx={v.sc.x}
          cy={v.sc.y}
          r={1.5}
          fill={v.coasted ? '#ffd166' : `rgba(102, 217, 132, ${confidenceAlpha(v.confidence)})`}
        />
      ))}
      {mode === 'corner' && screenPts.length === 4 && (
        <polygon
          points={screenPts.map((s) => `${s.x},${s.y}`).join(' ')}
          fill="none"
          stroke="rgba(255, 209, 102, 0.6)"
          strokeDasharray="6 4"
          strokeWidth={1}
        />
      )}
      {mode === 'transform' && screenPts.length === 2 && (
        // The anchor→reference vector IS the measurement — draw it so both
        // points read as one instrument, not two unrelated dots.
        <line
          x1={screenPts[0]!.x}
          y1={screenPts[0]!.y}
          x2={screenPts[1]!.x}
          y2={screenPts[1]!.y}
          stroke="rgba(255, 209, 102, 0.6)"
          strokeDasharray="6 4"
          strokeWidth={1}
        />
      )}
      {points[0] && autoPlan && (
        // The analysis's verdict, on the footage rather than only in the
        // panel: the ring around the chosen feature carries its distinctness,
        // so an ambiguous pick is visible exactly where the user is looking.
        <circle
          cx={sourceToScreen(points[0].x, points[0].y).x}
          cy={sourceToScreen(points[0].x, points[0].y).y}
          r={POINT_R + 6}
          fill="none"
          stroke={qualityStroke(autoPlan.distinctness)}
          strokeWidth={1.5}
          strokeDasharray="3 3"
        />
      )}
      {points[0] && manualVisible && (
        <>
          <polygon points={boxPoints(points[0], featureHalf)} fill="none" stroke="#ffffff" strokeWidth={1} />
          <polygon
            points={boxPoints(points[0], searchHalf)}
            fill="none"
            stroke="rgba(255,255,255,0.45)"
            strokeDasharray="4 4"
            strokeWidth={1}
          />
          {/* Corner handles — AE's gesture: grab a box on the footage and
              resize it there. The drag effect above hit-tests the same four
              corners per box; these squares are the visible half plus their
              own fat hit target. */}
          {([['feature', featureHalf], ['search', searchHalf]] as const).flatMap(([kind, half]) =>
            boxCornerPts(points[0]!, half).map((c, i) => (
              <g key={`${kind}-h-${i}`}>
                <rect
                  x={c.x - 7} y={c.y - 7} width={14} height={14}
                  fill="transparent"
                  style={{ pointerEvents: 'all', cursor: (i === 0 || i === 2) ? 'nwse-resize' : 'nesw-resize' }}
                />
                <rect
                  x={c.x - 2.5} y={c.y - 2.5} width={5} height={5}
                  fill={kind === 'feature' ? '#ffffff' : 'rgba(255,255,255,0.55)'}
                  stroke="#101014" strokeWidth={1}
                />
              </g>
            )),
          )}
        </>
      )}
      {loupe && (
        // The magnifier rides ABOVE the cursor so the hand never covers it,
        // flipping below when the point is near the top edge.
        <foreignObject
          x={loupe.screenX - LOUPE_SIZE / 2}
          y={loupe.screenY - LOUPE_SIZE - 24 < 0 ? loupe.screenY + 24 : loupe.screenY - LOUPE_SIZE - 24}
          width={LOUPE_SIZE}
          height={LOUPE_SIZE}
          pointerEvents="none"
        >
          <canvas
            ref={loupeCanvasRef}
            width={LOUPE_SIZE}
            height={LOUPE_SIZE}
            style={{
              width: LOUPE_SIZE,
              height: LOUPE_SIZE,
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.6)',
              boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
              display: 'block',
            }}
          />
        </foreignObject>
      )}
      {manualVisible && screenPts.map((s, i) => (
        <g key={`pt-${i}`} aria-label={`Track point ${i + 1}`}>
          {/* Invisible fat hit target at the pick radius — the one interactive
              part of the overlay. Events bubble to the svg's own listeners. */}
          <circle cx={s.x} cy={s.y} r={PICK_R} fill="transparent" style={{ pointerEvents: 'all', cursor: 'move' }} />
          <circle cx={s.x} cy={s.y} r={POINT_R + 1.5} fill="rgba(0,0,0,0.55)" />
          <circle cx={s.x} cy={s.y} r={POINT_R} fill="#ffd166" stroke="#101014" strokeWidth={1} />
          <line x1={s.x - POINT_R} y1={s.y} x2={s.x + POINT_R} y2={s.y} stroke="#101014" strokeWidth={1} />
          <line x1={s.x} y1={s.y - POINT_R} x2={s.x} y2={s.y + POINT_R} stroke="#101014" strokeWidth={1} />
          {(mode === 'corner' || mode === 'transform') && (
            <text x={s.x + 8} y={s.y - 8} fontSize={10} fill="#ffd166" style={{ userSelect: 'none' }}>
              {mode === 'corner' ? CORNER_LABELS[i] : i === 0 ? 'A' : 'B'}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

export default TrackPointOverlay;
