/**
 * The on-canvas gradient editor — the axis, its end grips, and the colour stops
 * as draggable diamonds along it.
 *
 * ## The gap this closes
 *
 * A gradient is a spatial object edited, until now, as four numbers in a panel:
 * an angle in degrees, a centre as two percentages, a radius as a third, and a
 * stop list of "position %" fields. Every one of those is a coordinate typed
 * blind. `mographParams.ts` has carried a `needs the real gradient editor` note
 * against exactly this. Nothing about the MODEL was missing — the rasterizer has
 * always drawn any number of stops, and `fill.stops` has always been
 * keyframeable — only the surface that lets you put them where you can see them.
 *
 * ## What is NOT here
 *
 * No geometry, no hit-test arithmetic, no stop-list rules: those are
 * `gradientHandles.ts`, pure and unit-tested, for the reason
 * `EffectHandleOverlay` states — this file is pointer plumbing and SVG, the part
 * that cannot be unit-tested, and so it should be the smallest part.
 *
 * ## Every write goes where the inspector's writes go
 *
 * The panel's `StopList` already resolved the hard question: when `fill.stops`
 * is animated the rows show the SAMPLED list at the playhead and each edit
 * writes a `gradientStops` keyframe there, because the renderer reads the track
 * and a write to the static paint would change nothing on screen. A gizmo with
 * its own write path would rediscover that the wrong way round, so it does not
 * have one — the same three branches (data keyframe / fill stack / primary
 * fill) are taken here, and the gradient GEOMETRY follows `AnimatablePaintRow`'s
 * rule in the same way: a keyframe on `fillAngle` / `fillCenterX|Y` /
 * `fillRadius` when that track is live or Auto-Keyframe is on, the static paint
 * otherwise.
 *
 * B3: those writes are the engine API's (the builders are `viewportEdits.ts`
 * ▸ gradient*Commands, over the paint writers the Fill & Stroke rows use): the
 * paint is a json field sent whole, a keyed stop list is `layer/fillStops`,
 * the geometry scalars are catalog properties keyed in comp time. A press-drag
 * on the gizmo is ONE gesture (one undo entry, absolute values per move); a
 * Delete is one edit.
 *
 * ## Armed, not automatic
 *
 * Gradient layers are usually backgrounds, and an axis that appeared across the
 * artwork on every selection would be chrome in the way far more often than it
 * was wanted. Selecting one shows a single small swatch chip at the layer's
 * centre; double-clicking that (or the Appearance panel's "Edit on canvas"
 * toggle) arms the full gizmo, and Escape puts it away. See `gradientEditStore`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useActiveCompSize, useMirrorRevisionFrame } from '@hooks/useMirrorFrame';
import { usePreferenceStore } from '@stores/preferenceStore';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { readGeometry } from '@core/workspace/geometry';
import { defaultAnimation } from '@motion/animation';
import type { Command } from '@motion/engine-api';
import { keyAxisTimeForDisplay } from '@core/engine/displayTime';
import { edit } from '@core/engine/uiEdits';
import { useGesture } from '@hooks/useGesture';
import { useEngineEdit } from '@layout/Inspector/useEngineEdit';
import { readTextStrokePaint } from '@core/text/textExtras';
import {
  applyGradientTracks,
  FILL_GRADIENT_TRACKS,
  TEXT_STROKE_GRADIENT_TRACKS,
  type GradientTrackNames,
} from '@core/rendering/gradientPaintTracks';
import { ColorPicker } from '@components/ColorPicker';
import {
  getNodeFills,
  sortedStops,
  type ColorStop,
  type FillPaint,
} from '@core/paint/fill';
import { getNodeStrokeAt, type Stroke, type StrokeGradientGeometry } from '@core/paint/stroke';
import { strokeGradientGeometryFor, strokeTrackPath } from '@core/rendering/strokeTracks';
import { useGradientEditStore, type GradientEditTarget } from './gradientEditStore';
import { strokePatchCommands } from '@layout/Inspector/appearance/paintEdits';
import { gradientGeometryCommands, gradientPaintCommands, gradientStopsCommands } from './viewportEdits';
import { layerScreenMapping } from './layerScreen';
import { beginViewportGesture, endViewportGesture } from '@core/workspace/viewportGesture';
import {
  addStopAt,
  duplicateStop,
  gradientAxisLocal,
  gradientGrips,
  hitTestGradient,
  moveStopTo,
  offsetAtPoint,
  paintFromGripDrag,
  pointAtOffset,
  removeStopById,
  strokeGradientAxisLocal,
  strokeGradientFromGripDrag,
  type GradientGripKind,
  type GradientPaint,
  type GradientScreenView,
  type Pt,
} from './gradientHandles';
import styles from './GradientHandleOverlay.module.css';

/** Half-diagonal of a stop diamond, in screen px. */
const STOP_R = 6;
/** Drawn radius of a geometry grip. */
const GRIP_R = 5.5;
/** The gizmo's own colour — the app's accent, so it reads as UI, not artwork. */
const AXIS_COLOR = '#4c8dff';

/** Which paint the gizmo edits: the layer's fill, or a text layer's stroke gradient. */
type PaintChannel = GradientEditTarget;

/** The keyframeable geometry scalars of each angle/centre channel — the names the
 *  renderer samples. A shape stroke's gradient has POINTS instead (see
 *  `writeStrokeGradientPoints`). */
const GEOMETRY_TRACKS: Readonly<Record<'fill' | 'stroke', GradientTrackNames>> = {
  fill: FILL_GRADIENT_TRACKS,
  stroke: TEXT_STROKE_GRADIENT_TRACKS,
};

function isGradient(p: FillPaint | undefined): p is GradientPaint {
  return !!p && (p.type === 'linear' || p.type === 'radial');
}

/** Everything one write needs to know about what it is writing to. */
interface EditTarget {
  nodeId: string;
  channel: PaintChannel;
  fillIndex: number;
  /** The shape stroke's index in its stack (shapeStroke channel only). */
  strokeIndex: number;
  /** The shape stroke as STORED (shapeStroke channel only) — what a static point write spreads over. */
  storedStroke: Stroke | null;
  /** The shape stroke's Start/End points as the frame shows them (shapeStroke only). */
  strokePoints: StrokeGradientGeometry | null;
  fills: FillPaint[];
  /** The STORED paint — what a static write spreads over. */
  paint: GradientPaint;
  /** The paint as the frame shows it (keyframed geometry applied) — what a grip drags from. */
  shown: GradientPaint;
  /** Storage order — what a write must preserve. See `moveStopTo`. */
  stops: ColorStop[];
  /** True when the primary fill's stop list is a live `fill.stops` track. */
  stopsAnimated: boolean;
  /** The playhead, comp seconds — where keys land (the engine maps it to the layer's key axis). */
  time: number;
  width: number;
  height: number;
}

const autoKeyframe = (): boolean => usePreferenceStore.getState().timelineAutoKeyframe;

/**
 * A shape stroke's Start/End points from a grip drag — `AnimatablePaintRow`'s
 * rule per coordinate: a live track (or Auto-Keyframe) takes a key on the
 * stroke's own `gradientStartX…` property, everything else lands in ONE static
 * write of the stack with the dragged end moved. Commands for the current
 * pointer position (absolute).
 */
function strokeGradientPointCommands(t: EditTarget, next: StrokeGradientGeometry, grip: GradientGripKind): Command[] {
  const writes = grip === 'start'
    ? [
        { track: strokeTrackPath(t.strokeIndex, 'gradientStartX'), value: next.startX },
        { track: strokeTrackPath(t.strokeIndex, 'gradientStartY'), value: next.startY },
      ]
    : [
        { track: strokeTrackPath(t.strokeIndex, 'gradientEndX'), value: next.endX },
        { track: strokeTrackPath(t.strokeIndex, 'gradientEndY'), value: next.endY },
      ];
  // Only the dragged end goes onto the STORED points — the other end and the
  // highlight keep their stored values, not the keyframed ones on screen.
  const statics = (): Command[] => {
    const stored = t.storedStroke;
    if (!stored) return [];
    const base = stored.gradient ?? strokeGradientGeometryFor(stored.paint, t.width, t.height);
    return strokePatchCommands(t.nodeId, t.strokeIndex, {
      gradient: grip === 'start'
        ? { ...base, startX: next.startX, startY: next.startY }
        : { ...base, endX: next.endX, endY: next.endY },
    });
  };
  return gradientGeometryCommands(t, writes, statics, { seconds: t.time, autoKeyframe: autoKeyframe() });
}

/**
 * A new stop list, through whichever of the two paths is live.
 *
 * The animated branch is not an optimisation: the renderer reads the
 * `fill.stops` track when one exists, so a write to the static paint would be
 * an edit that changes nothing on screen — the same trap `StopList` documents.
 */
function gradientStopListCommands(t: EditTarget, next: ColorStop[]): Command[] {
  return gradientStopsCommands(t, t.paint, next, { keyed: t.stopsAnimated, seconds: t.time });
}

/**
 * A geometry change, scalar track by scalar track.
 *
 * `AnimatablePaintRow`'s rule, applied per property rather than per row: a live
 * track (or Auto-Keyframe) takes a key at the playhead, everything else falls
 * through to one static paint write. A radial centre drag moves two props at
 * once; both ride the same gesture message, so one drag is one undo step.
 */
function gradientGeometryDragCommands(t: EditTarget, next: GradientPaint, grip: GradientGripKind): Command[] {
  // The channel's own track names: `fillAngle`… for a fill, `strokeAngle`… for
  // a text stroke gradient — the names the renderer samples.
  const names = GEOMETRY_TRACKS[t.channel === 'stroke' ? 'stroke' : 'fill'];
  const writes: Array<{ track: string; value: number }> =
    next.type === 'linear'
      ? [{ track: names.angle, value: next.angle }]
      : grip === 'start'
        ? [
            { track: names.centerX, value: next.cx },
            { track: names.centerY, value: next.cy },
          ]
        : [{ track: names.radius, value: next.radius }];
  // Only the dragged fields go onto the STORED paint: `next` was derived from
  // the shown (keyframed) geometry, whose other values must not bake in.
  // Written even when a sibling prop keyed: the static value is what a later
  // "remove animation" falls back to, and leaving it stale is how a handle
  // drag appears to undo itself when the track is deleted.
  const staticNext = (
    next.type === 'linear'
      ? { ...t.paint, angle: next.angle }
      : grip === 'start'
        ? { ...t.paint, cx: next.cx, cy: next.cy }
        : { ...t.paint, radius: next.radius }
  ) as GradientPaint;
  return gradientGeometryCommands(t, writes, () => gradientPaintCommands(t, staticNext), { seconds: t.time, autoKeyframe: autoKeyframe() });
}

export function GradientHandleOverlay(): JSX.Element | null {
  // Frame-coalesced: a drag bumps the scene revision per pointer event and this
  // overlay only has to track it visually.
  const sceneTick = useMirrorRevisionFrame();
  const ids = useSelectionStore((s) => s.ids);
  const armedId = useGradientEditStore((s) => s.nodeId);
  const fillIndexRaw = useGradientEditStore((s) => s.fillIndex);
  const selectedStopId = useGradientEditStore((s) => s.selectedStopId);
  const time = useActiveWorkspace()?.time ?? 0;
  const comp = useActiveCompSize();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  /** The stop whose ColorPicker is open, if any. */
  const [editingColorId, setEditingColorId] = useState<string | null>(null);

  const singleId = ids.length === 1 ? ids[0] ?? null : null;
  const armed = armedId !== null && singleId === armedId;
  const nodeId = armed ? armedId : singleId;

  const node = nodeId ? defaultSceneGraph.getNode(nodeId) : null;
  const geom = node ? readGeometry(node) : null;
  const fills = nodeId ? getNodeFills(nodeId) : [];
  // A stack that shrank under an armed index must not read past its end.
  const fillIndex = armed ? Math.min(fillIndexRaw, Math.max(0, fills.length - 1)) : 0;
  const fillPaint = isGradient(fills[fillIndex]) ? (fills[fillIndex] as GradientPaint) : null;
  // A text layer's STROKE gradient — `strokePaint` on its Text component.
  const strokePaint: GradientPaint | null = node ? readTextStrokePaint(node) ?? null : null;
  const textComponentId = node?.components.find((c) => c.type === 'Text')?.id ?? null;
  const armedTarget = useGradientEditStore((s) => s.target);
  // A SHAPE stroke's gradient, only when armed on it from its stroke rows —
  // `fillIndex` then names the stroke's index in the stack.
  const shapeStroke = armed && armedTarget === 'shapeStroke' && nodeId ? getNodeStrokeAt(nodeId, fillIndexRaw) : undefined;
  const shapeStrokePaint: GradientPaint | null = isGradient(shapeStroke?.paint) ? (shapeStroke!.paint as GradientPaint) : null;
  // The stroke when armed on it (the Fill/Stroke chip, or the stroke rows'
  // "Edit on canvas"), or when it is the layer's only gradient; else the fill.
  const channel: PaintChannel = shapeStrokePaint
    ? 'shapeStroke'
    : strokePaint && textComponentId && ((armed && armedTarget === 'stroke') || !fillPaint) ? 'stroke' : 'fill';
  const storedPaint = channel === 'shapeStroke' ? shapeStrokePaint : channel === 'stroke' ? strokePaint : fillPaint;

  // Display only: where the `fill.stops` track is SAMPLED for drawing (its key
  // axis). Writes send comp time and the engine maps it.
  const layerT = nodeId ? keyAxisTimeForDisplay(nodeId, time, 'fill.stops') : 0;
  // Stop KEYFRAMES bind to the primary FILL only — the same gating the panel
  // applies, because `fill.stops` is one track per node, not per stack slot.
  const stopsAnimated =
    !!nodeId && channel === 'fill' && fillIndex === 0 && defaultAnimation.isDataAnimated(nodeId, 'fill.stops');

  /**
   * The paint as the FRAME draws it: keyframed geometry (`fillAngle`… or
   * `strokeAngle`…) sampled at the playhead over the stored paint, so the axis
   * sits where the ramp is. Geometry tracks bind to the primary fill, exactly
   * as the renderer reads them.
   */
  const paint = useMemo<GradientPaint | null>(() => {
    // A shape stroke's geometry is its POINTS (sampled below), not these tracks.
    if (!storedPaint || !nodeId || channel === 'shapeStroke' || (channel === 'fill' && fillIndex !== 0)) return storedPaint;
    const names = GEOMETRY_TRACKS[channel];
    const sampled = new Map<string, number>();
    for (const prop of [names.angle, names.centerX, names.centerY, names.radius]) {
      if (!defaultAnimation.isAnimated(nodeId, prop)) continue;
      const v = defaultAnimation.sample(nodeId, prop, keyAxisTimeForDisplay(nodeId, time, prop));
      if (v !== undefined) sampled.set(prop, v);
    }
    return applyGradientTracks(storedPaint, sampled, names) ?? storedPaint;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- anim rev drives this
  }, [storedPaint, nodeId, channel, fillIndex, time, sceneTick]);

  /**
   * The stop list the gizmo is actually editing — sampled at the playhead when
   * the track is live, so a diamond sits where the FRAME shows the ramp rather
   * than where the static paint happens to say.
   */
  const stops = useMemo<ColorStop[]>(() => {
    if (!paint || !nodeId) return [];
    if (!stopsAnimated) return paint.stops;
    const sampled = defaultAnimation.sampleData(nodeId, 'fill.stops', layerT) as
      | Array<{ pos: number; color: string }>
      | undefined;
    // Ids are synthesised from the INDEX, which is why every write preserves
    // storage order — see `moveStopTo`.
    return sampled
      ? sampled.map((s, i) => ({ id: `anim_${i}`, offset: s.pos, color: s.color }))
      : paint.stops;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- anim rev drives this
  }, [paint, nodeId, stopsAnimated, layerT, sceneTick]);

  const camera = getWorkspaceController().ws.camera;
  const mapping = useMemo(
    () => (nodeId ? layerScreenMapping(nodeId, time, comp, camera) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- camera is a live singleton
    [nodeId, time, comp.width, comp.height, sceneTick],
  );

  const width = geom?.width ?? 0;
  const height = geom?.height ?? 0;

  /**
   * A shape stroke's Start/End points as the FRAME shows them: its stored points
   * (or those its angle/centre model implies), with any `gradientStartX…` track
   * sampled at the playhead — the same fold `resolveStrokeTracks` renders.
   */
  const strokePoints = useMemo<StrokeGradientGeometry | null>(() => {
    if (channel !== 'shapeStroke' || !nodeId || !shapeStroke || !shapeStrokePaint) return null;
    const base = shapeStroke.gradient ?? strokeGradientGeometryFor(shapeStrokePaint, width, height);
    const read = (param: 'gradientStartX' | 'gradientStartY' | 'gradientEndX' | 'gradientEndY', fallback: number): number => {
      const prop = strokeTrackPath(fillIndexRaw, param);
      if (!defaultAnimation.isAnimated(nodeId, prop)) return fallback;
      const v = defaultAnimation.sample(nodeId, prop, keyAxisTimeForDisplay(nodeId, time, prop));
      return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    };
    return {
      ...base,
      startX: read('gradientStartX', base.startX),
      startY: read('gradientStartY', base.startY),
      endX: read('gradientEndX', base.endX),
      endY: read('gradientEndY', base.endY),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- anim rev drives this
  }, [channel, nodeId, shapeStroke, shapeStrokePaint, width, height, fillIndexRaw, time, sceneTick]);

  const axis = useMemo(
    () => (strokePoints
      ? strokeGradientAxisLocal(strokePoints, width, height)
      : paint ? gradientAxisLocal(paint, width, height) : null),
    [paint, strokePoints, width, height],
  );

  /** The axis and every stop, projected — the input the hit test wants. */
  const view = useMemo<GradientScreenView | null>(() => {
    if (!paint || !axis || !mapping) return null;
    const project = (p: Pt): Pt => mapping.localToScreen(p.x, p.y);
    return {
      type: paint.type,
      start: project(axis.start),
      end: project(axis.end),
      // Ordered for DRAWING; every write goes back through storage order.
      stops: sortedStops(stops).map((s) => ({
        id: s.id,
        offset: s.offset,
        at: project(pointAtOffset(axis, s.offset)),
      })),
    };
  }, [paint, axis, mapping, stops]);

  // Live values for the pointer listeners, which attach once per armed layer.
  const target: EditTarget | null =
    nodeId && paint && storedPaint
      ? {
          nodeId,
          channel,
          fillIndex,
          strokeIndex: fillIndexRaw,
          storedStroke: shapeStroke ?? null,
          strokePoints,
          fills,
          paint: storedPaint,
          shown: paint,
          stops,
          stopsAnimated,
          time,
          width,
          height,
        }
      : null;
  const stateRef = useRef<{
    target: EditTarget | null;
    view: GradientScreenView | null;
    axis: { start: Pt; end: Pt } | null;
    mapping: ReturnType<typeof layerScreenMapping>;
  }>({ target: null, view: null, axis: null, mapping: null });
  stateRef.current = { target, view, axis, mapping };

  const disarm = useGradientEditStore((s) => s.disarm);
  const selectStop = useGradientEditStore((s) => s.selectStop);
  /** A handle drag (grip, stop, add-and-drag, Alt-duplicate) is ONE engine gesture. */
  const gesture = useGesture();
  /** The ColorPicker's writes: a picker drag is one gesture (`press`), a typed hex one edit. */
  const pickerEdit = useEngineEdit();

  /**
   * Pointer plumbing. Attached once while ARMED — keyed on the boolean and the
   * node, not on the geometry, so dragging does not tear the listeners down and
   * rebuild them on every frame.
   */
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !armed) return;

    const at = (e: PointerEvent | MouseEvent): Pt => {
      const r = svg.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    /** Pointer → 0..1 along the axis, through the layer's own space. */
    const offsetOf = (p: Pt): number => {
      const s = stateRef.current;
      if (!s.axis || !s.mapping) return 0;
      const l = s.mapping.screenToLocal(p.x, p.y);
      return offsetAtPoint(s.axis, { x: l.x, y: l.y });
    };

    let drag: { kind: 'grip'; grip: GradientGripKind } | { kind: 'stop'; id: string } | null = null;
    /**
     * The stop list this gesture has written but React has not re-rendered yet.
     *
     * `stateRef.current.target.stops` comes from a render, and renders are
     * coalesced to one per frame (`useMirrorRevisionFrame`). Within a single
     * frame that is normally harmless — a move recomputes the offset from the
     * pointer, not from the previous one — but adding a stop and then dragging
     * it is the case where it is not: the next move would map over a list that
     * does not contain the stop it is dragging and write it straight back out
     * of existence. So a gesture that CHANGES the list keeps its own copy.
     */
    let liveStops: ColorStop[] | null = null;
    /** Whether the gesture writes the keyed stop list (fixed at the press). */
    let keyedStops = false;
    const currentStops = (t: EditTarget): ColorStop[] => liveStops ?? t.stops;
    // Every message is the WHOLE list for the current pointer (latest wins); do
    // not await in the pointer handlers — the gizmo follows the pointer and the
    // engine's refresh lands within a frame.
    const commitStops = (t: EditTarget, next: ColorStop[]): void => {
      liveStops = next;
      gesture.send(gradientStopListCommands(t, next));
    };

    const onDown = (e: PointerEvent): void => {
      const s = stateRef.current;
      if (e.button !== 0 || !s.view || !s.target) return;
      const p = at(e);
      const hit = hitTestGradient(s.view, p);
      if (!hit) return;
      e.stopPropagation();
      e.preventDefault();
      // The drag flag, so the RAM preview is not blitted over the live
      // gradient while a stop is being dragged (see beginViewportGesture).
      beginViewportGesture();
      keyedStops = s.target.stopsAnimated;
      const dup = hit.kind === 'stop' && e.altKey ? duplicateStop(currentStops(s.target), hit.id, offsetOf(p)) : null;
      // One gesture for the whole press (it captures the pointer and ends on
      // capture loss / cancel / blur; Escape reverts it).
      gesture.begin(
        hit.kind === 'grip' ? 'Move Gradient Handle'
          : hit.kind === 'axis' ? 'Add Gradient Stop'
            : dup ? 'Duplicate Gradient Stop' : 'Move Gradient Stop',
        e,
      );

      if (hit.kind === 'grip') {
        drag = { kind: 'grip', grip: hit.grip };
        return;
      }
      if (hit.kind === 'axis') {
        // Click on the line = a new stop, carrying the colour already there, so
        // the picture does not change until it is dragged. The gesture then
        // continues as a drag of the stop it just made.
        const added = addStopAt(currentStops(s.target), hit.offset);
        commitStops(s.target, added.stops);
        selectStop(added.id);
        drag = { kind: 'stop', id: added.id };
        return;
      }
      // Alt-drag duplicates: the copy is what moves, the original stays put.
      if (dup) {
        commitStops(s.target, dup.stops);
        selectStop(dup.id);
        drag = { kind: 'stop', id: dup.id };
        return;
      }
      selectStop(hit.id);
      drag = { kind: 'stop', id: hit.id };
    };

    const onMove = (e: PointerEvent): void => {
      const s = stateRef.current;
      const p = at(e);
      if (!drag) {
        if (!s.view) return;
        const hit = hitTestGradient(s.view, p);
        setHovered(
          hit === null ? null : hit.kind === 'grip' ? `grip:${hit.grip}` : hit.kind === 'stop' ? `stop:${hit.id}` : 'axis',
        );
        return;
      }
      // Escape cancelled the gesture: the drag is over for the document.
      if (!s.target || !gesture.isActive()) return;
      if (drag.kind === 'grip') {
        if (!s.mapping) return;
        const l = s.mapping.screenToLocal(p.x, p.y);
        // A shape stroke's gradient: the grip IS a point, moved where it is put.
        if (s.target.channel === 'shapeStroke' && s.target.strokePoints) {
          gesture.send(strokeGradientPointCommands(
            s.target,
            strokeGradientFromGripDrag(s.target.strokePoints, drag.grip, { x: l.x, y: l.y }, s.target.width, s.target.height),
            drag.grip,
          ));
          return;
        }
        // From the geometry as SHOWN (keyframes applied): a radius grip measures
        // from the centre the frame draws, not from the static one.
        const next = paintFromGripDrag(
          s.target.shown,
          drag.grip,
          { x: l.x, y: l.y },
          s.target.width,
          s.target.height,
        );
        gesture.send(gradientGeometryDragCommands(s.target, next, drag.grip));
        return;
      }
      commitStops(s.target, moveStopTo(currentStops(s.target), drag.id, offsetOf(p)));
    };

    const onUp = (e: PointerEvent): void => {
      if (!drag) return;
      // A keyed stop list is stored in OFFSET order (the engine sorts a Colors
      // key), and its stops are named by index (`anim_<i>`): follow the dragged
      // stop to the index it lands on, so the selection — and a Delete after
      // it — still names the stop that was dragged.
      if (drag.kind === 'stop' && keyedStops && liveStops) {
        const id = drag.id;
        const at = liveStops.map((st, i) => ({ st, i }))
          .sort((a, b) => (a.st.offset - b.st.offset) || (a.i - b.i))
          .findIndex((x) => x.st.id === id);
        if (at >= 0) selectStop(`anim_${at}`);
      }
      drag = null;
      liveStops = null;
      void gesture.end();
      endViewportGesture();
      if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
    };

    /** Double-click a stop → the app's own ColorPicker, at the stop. */
    const onDblClick = (e: MouseEvent): void => {
      const s = stateRef.current;
      if (!s.view) return;
      const hit = hitTestGradient(s.view, at(e));
      if (hit?.kind !== 'stop') return;
      e.stopPropagation();
      e.preventDefault();
      selectStop(hit.id);
      setEditingColorId(hit.id);
    };

    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    svg.addEventListener('pointercancel', onUp);
    svg.addEventListener('dblclick', onDblClick);
    return () => {
      svg.removeEventListener('pointerdown', onDown);
      svg.removeEventListener('pointermove', onMove);
      svg.removeEventListener('pointerup', onUp);
      svg.removeEventListener('pointercancel', onUp);
      svg.removeEventListener('dblclick', onDblClick);
      if (drag) { drag = null; void gesture.end(); endViewportGesture(); }
    };
  }, [armed, nodeId, selectStop, gesture]);

  /**
   * Escape puts the gizmo away; Delete removes the selected stop.
   *
   * Guarded on the focused element: Delete inside a text field is a text edit,
   * and a viewport shortcut that fires while someone is typing a hex value is
   * the classic way an overlay eats a keystroke that was never meant for it.
   */
  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (typing) return;
      if (e.key === 'Escape') {
        setEditingColorId(null);
        disarm();
        return;
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const s = stateRef.current;
      const id = useGradientEditStore.getState().selectedStopId;
      if (!s.target || !id) return;
      const next = removeStopById(s.target.stops, id);
      // null = the two-stop floor, or the stop is already gone. Either way this
      // is not an edit, so it must not consume the key or push an undo step.
      if (!next) return;
      e.preventDefault();
      e.stopPropagation();
      void edit('Delete Gradient Stop', gradientStopListCommands(s.target, next));
      selectStop(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [armed, disarm, selectStop]);

  /** Radix opens on a click, so the popover is opened by clicking its trigger. */
  const pickerHost = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const btn = el.querySelector('button');
    if (btn) btn.click();
  }, []);

  if (!nodeId || !paint || !view || !mapping) return null;

  const editingStop = editingColorId ? view.stops.find((s) => s.id === editingColorId) : undefined;
  const editingColor = editingColorId
    ? stops.find((s) => s.id === editingColorId)?.color ?? '#ffffff'
    : '#ffffff';

  // ── Disarmed: one small swatch chip, double-click to arm ──────────
  if (!armed) {
    const centre = mapping.localToScreen(0, 0);
    if (!Number.isFinite(centre.x) || !Number.isFinite(centre.y)) return null;
    const gid = `gradchip_${nodeId}`;
    return (
      <svg className={styles.overlay} aria-label="Gradient fill">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
            {sortedStops(stops).map((s) => (
              <stop key={s.id} offset={s.offset} stopColor={s.color} />
            ))}
          </linearGradient>
        </defs>
        <g
          className={styles.chip}
          onDoubleClick={() => useGradientEditStore.getState().arm(nodeId, fillIndex, channel)}
        >
          <title>Double-click to edit this gradient on the canvas</title>
          <circle cx={centre.x} cy={centre.y} r={11} fill="rgba(0,0,0,0.55)" />
          <circle
            cx={centre.x}
            cy={centre.y}
            r={9}
            fill={`url(#${gid})`}
            stroke="#ffffff"
            strokeWidth={1.5}
          />
        </g>
      </svg>
    );
  }

  // ── Armed: the full gizmo ─────────────────────────────────────────
  const grips = gradientGrips(view);
  const finite = (p: Pt): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);
  if (!finite(view.start) || !finite(view.end)) return null;

  const gripNode = (kind: GradientGripKind, p: Pt): JSX.Element => {
    const on = hovered === `grip:${kind}`;
    const label = paint.type === 'radial' ? (kind === 'start' ? 'Center' : 'Radius') : kind === 'start' ? 'Start' : 'End';
    return (
      <g aria-label={`Gradient ${label} handle`}>
        <circle cx={p.x} cy={p.y} r={GRIP_R + 2} fill="rgba(0,0,0,0.55)" />
        <circle
          cx={p.x}
          cy={p.y}
          r={GRIP_R}
          fill={on ? AXIS_COLOR : '#ffffff'}
          stroke="#101014"
          strokeWidth={1}
        />
      </g>
    );
  };

  return (
    <>
      <svg ref={svgRef} className={styles.overlay} aria-label="Gradient handles">
        {/* The line the ramp runs along, dark under light so it stays legible
            over whatever the gradient itself is painting. */}
        <line
          x1={view.start.x}
          y1={view.start.y}
          x2={view.end.x}
          y2={view.end.y}
          stroke="rgba(0,0,0,0.5)"
          strokeWidth={3}
        />
        <line
          x1={view.start.x}
          y1={view.start.y}
          x2={view.end.x}
          y2={view.end.y}
          stroke={AXIS_COLOR}
          strokeWidth={1.5}
        />
        {/* Radial: a hairline from the centre out to its perpendicular grip, so
            the offset handle reads as belonging to the centre it moves. */}
        {paint.type === 'radial' && (
          <line
            x1={view.start.x}
            y1={view.start.y}
            x2={grips.start.x}
            y2={grips.start.y}
            stroke={AXIS_COLOR}
            strokeWidth={1}
            strokeDasharray="2 3"
            strokeOpacity={0.7}
          />
        )}

        {/* The interactive band. Everything above is decoration on a
            pointer-transparent SVG; this fat invisible line and the fat circles
            below are the only parts that claim an event, and the svg's own
            listeners re-run the same hit test to decide what was grabbed. */}
        <line
          x1={view.start.x}
          y1={view.start.y}
          x2={view.end.x}
          y2={view.end.y}
          stroke="transparent"
          strokeWidth={12}
          className={styles.axisHit}
        />

        {gripNode('start', grips.start)}
        {gripNode('end', grips.end)}
        <circle cx={grips.start.x} cy={grips.start.y} r={10} fill="transparent" className={styles.hit} />
        <circle cx={grips.end.x} cy={grips.end.y} r={10} fill="transparent" className={styles.hit} />

        {view.stops.map((s) => {
          const on = hovered === `stop:${s.id}`;
          const picked = selectedStopId === s.id;
          const color = stops.find((x) => x.id === s.id)?.color ?? '#ffffff';
          const d = `M ${s.at.x} ${s.at.y - STOP_R} L ${s.at.x + STOP_R} ${s.at.y} L ${s.at.x} ${s.at.y + STOP_R} L ${s.at.x - STOP_R} ${s.at.y} Z`;
          return (
            <g key={s.id} aria-label={`Gradient stop ${Math.round(s.offset * 100)}%`}>
              {/* A dark halo UNDER the diamond, so a stop whose colour matches
                  the artwork behind it is still visible — the same trick every
                  other handle in this viewport uses. */}
              <path d={d} fill="rgba(0,0,0,0.55)" stroke="rgba(0,0,0,0.55)" strokeWidth={4} />
              <path
                d={d}
                fill={color}
                stroke={picked || on ? AXIS_COLOR : '#ffffff'}
                strokeWidth={picked ? 2.5 : 1.5}
              />
              <circle cx={s.at.x} cy={s.at.y} r={9} fill="transparent" className={styles.hit} />
            </g>
          );
        })}
      </svg>

      {/* Which fill of the stack is being edited. Only for a real stack — one
          fill needs no chooser, and a chip that never has an alternative is
          chrome describing a choice that does not exist. */}
      {/* Fill or Stroke — for a text layer whose stroke carries a gradient. At
          the axis END, clear of the fill-stack chips at its start. */}
      {strokePaint && textComponentId && (
        <div
          className={styles.fillChips}
          style={{ left: Math.round(view.end.x), top: Math.round(view.end.y) }}
          role="group"
          aria-label="Which paint to edit"
        >
          {(['fill', 'stroke'] as const).map((c) => (
            <button
              key={c}
              type="button"
              className={`${styles.fillChip} ${styles.paintChip}${c === channel ? ` ${styles.fillChipOn}` : ''}`}
              aria-pressed={c === channel}
              disabled={c === 'fill' && !fillPaint}
              title={c === 'fill' ? (fillPaint ? 'Edit the fill gradient' : 'The fill is not a gradient') : 'Edit the stroke gradient'}
              onClick={() => useGradientEditStore.getState().setTarget(c)}
            >
              {c === 'fill' ? 'Fill' : 'Stroke'}
            </button>
          ))}
        </div>
      )}
      {channel === 'fill' && fills.length > 1 && (
        <div
          className={styles.fillChips}
          style={{ left: Math.round(view.start.x), top: Math.round(view.start.y) }}
          role="group"
          aria-label="Which fill to edit"
        >
          {fills.map((f, i) => (
            <button
              key={`fill_${i}`}
              type="button"
              className={i === fillIndex ? `${styles.fillChip} ${styles.fillChipOn}` : styles.fillChip}
              aria-pressed={i === fillIndex}
              disabled={!isGradient(f)}
              title={isGradient(f) ? `Edit fill ${i + 1}` : `Fill ${i + 1} is not a gradient`}
              onClick={() => useGradientEditStore.getState().setFillIndex(i)}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}

      {/* Double-click a stop → the app's ColorPicker, at the stop, opened for
          you. The same component the inspector rows use, so recents, swatches
          and the eyedropper come with it rather than being reimplemented. */}
      {editingStop && (
        <div
          key={editingStop.id}
          ref={pickerHost}
          className={styles.picker}
          style={{ left: Math.round(editingStop.at.x), top: Math.round(editingStop.at.y + STOP_R) }}
          onPointerDown={(e) => e.stopPropagation()}
          {...pickerEdit.press('Gradient Stop Color')}
        >
          <ColorPicker
            compact
            value={editingColor}
            aria-label="Gradient stop color"
            onChange={(color) => {
              const t = stateRef.current.target;
              if (!t) return;
              pickerEdit.send(
                'Gradient Stop Color',
                gradientStopListCommands(t, t.stops.map((s) => (s.id === editingStop.id ? { ...s, color } : s))),
              );
            }}
          />
        </div>
      )}
    </>
  );
}

export default GradientHandleOverlay;
