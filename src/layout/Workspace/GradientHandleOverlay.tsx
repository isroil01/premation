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
import { useSceneRevisionFrame } from '@hooks/useSceneRevisionFrame';
import { useSelectionStore } from '@stores/selectionStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { batchHistory } from '@stores/historyStore';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { readGeometry } from '@core/workspace/geometry';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { ColorPicker } from '@components/ColorPicker';
import {
  getNodeFills,
  setNodeFill,
  setNodeFills,
  sortedStops,
  type ColorStop,
  type FillPaint,
} from '@core/paint/fill';
import { useGradientEditStore } from './gradientEditStore';
import { layerScreenMapping } from './layerScreen';
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

type GeomProp = 'fillAngle' | 'fillCenterX' | 'fillCenterY' | 'fillRadius';

function isGradient(p: FillPaint | undefined): p is GradientPaint {
  return !!p && (p.type === 'linear' || p.type === 'radial');
}

/** Everything one write needs to know about what it is writing to. */
interface EditTarget {
  nodeId: string;
  fillIndex: number;
  fills: FillPaint[];
  paint: GradientPaint;
  /** Storage order — what a write must preserve. See `moveStopTo`. */
  stops: ColorStop[];
  /** True when the primary fill's stop list is a live `fill.stops` track. */
  stopsAnimated: boolean;
  layerT: number;
  time: number;
  width: number;
  height: number;
}

/** The paint itself — the fill stack's slot, or the primary-fill shortcut. */
function writePaintStatic(t: EditTarget, paint: GradientPaint): void {
  batchHistory(`gradient:${t.nodeId}`, () => {
    if (t.fillIndex === 0) {
      setNodeFill(t.nodeId, paint);
      return;
    }
    const next = [...t.fills];
    next[t.fillIndex] = paint;
    setNodeFills(t.nodeId, next);
  });
}

/**
 * A new stop list, through whichever of the two paths is live.
 *
 * The animated branch is not an optimisation: the renderer reads the
 * `fill.stops` track when one exists, so a write to the static paint would be
 * an edit that changes nothing on screen — the same trap `StopList` documents.
 */
function writeGradientStops(t: EditTarget, next: ColorStop[]): void {
  if (t.stopsAnimated) {
    runAnimEdit(
      'Edit gradient stops keyframe',
      () => {
        defaultAnimation.setDataKeyframe(
          t.nodeId,
          'fill.stops',
          'gradientStops',
          t.layerT,
          next.map((s) => ({ pos: s.offset, color: s.color })),
        );
      },
      // Stable across the whole gesture, so one drag is one undo entry.
      `gradStops:${t.nodeId}`,
    );
    return;
  }
  writePaintStatic(t, { ...t.paint, stops: next });
}

/**
 * A geometry change, scalar track by scalar track.
 *
 * `AnimatablePaintRow`'s rule, applied per property rather than per row: a live
 * track (or Auto-Keyframe) takes a keyframe at the playhead, everything else
 * falls through to one static paint write. A radial centre drag moves two props
 * at once, which is why the whole thing sits inside one `batchHistory` — the
 * undo debounce keys on the target, and two targets would be two undo steps for
 * one drag (the exact bug the linked corner radius had).
 */
function writeGradientGeometry(t: EditTarget, next: GradientPaint, grip: GradientGripKind): void {
  const props: Array<{ prop: GeomProp; value: number }> =
    next.type === 'linear'
      ? [{ prop: 'fillAngle', value: next.angle }]
      : grip === 'start'
        ? [
            { prop: 'fillCenterX', value: next.cx },
            { prop: 'fillCenterY', value: next.cy },
          ]
        : [{ prop: 'fillRadius', value: next.radius }];

  const autoKey = usePreferenceStore.getState().timelineAutoKeyframe;
  batchHistory(`gradient:${t.nodeId}`, () => {
    let anyStatic = false;
    for (const { prop, value } of props) {
      if (defaultAnimation.isAnimated(t.nodeId, prop) || autoKey) {
        const at = compToKeyframeTime(t.nodeId, t.time, prop);
        runAnimEdit(
          `Set ${prop}`,
          () => defaultAnimation.setKeyframe(t.nodeId, prop, at, value),
          `gradGeom:${t.nodeId}:${prop}`,
        );
      } else {
        anyStatic = true;
      }
    }
    // Written even when some sibling prop keyframed: the static value is what a
    // later "remove animation" falls back to, and leaving it stale is how a
    // handle drag appears to undo itself when the track is deleted.
    if (anyStatic) writePaintStatic(t, next);
  });
}

export function GradientHandleOverlay(): JSX.Element | null {
  // Frame-coalesced: a drag bumps the scene revision per pointer event and this
  // overlay only has to track it visually.
  const sceneTick = useSceneRevisionFrame();
  const ids = useSelectionStore((s) => s.ids);
  const armedId = useGradientEditStore((s) => s.nodeId);
  const fillIndexRaw = useGradientEditStore((s) => s.fillIndex);
  const selectedStopId = useGradientEditStore((s) => s.selectedStopId);
  const time = useActiveWorkspace()?.time ?? 0;
  const comp = useCompositionStore((s) => s.comp());
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
  const paint = isGradient(fills[fillIndex]) ? (fills[fillIndex] as GradientPaint) : null;

  const layerT = nodeId ? compToKeyframeTime(nodeId, time) : 0;
  // Stop KEYFRAMES bind to the primary fill only — the same gating the panel
  // applies, because `fill.stops` is one track per node, not per stack slot.
  const stopsAnimated =
    !!nodeId && fillIndex === 0 && defaultAnimation.isDataAnimated(nodeId, 'fill.stops');

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
  const axis = useMemo(
    () => (paint ? gradientAxisLocal(paint, width, height) : null),
    [paint, width, height],
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
    nodeId && paint
      ? {
          nodeId,
          fillIndex,
          fills,
          paint,
          stops,
          stopsAnimated,
          layerT,
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
     * coalesced to one per frame (`useSceneRevisionFrame`). Within a single
     * frame that is normally harmless — a move recomputes the offset from the
     * pointer, not from the previous one — but adding a stop and then dragging
     * it is the case where it is not: the next move would map over a list that
     * does not contain the stop it is dragging and write it straight back out
     * of existence. So a gesture that CHANGES the list keeps its own copy.
     */
    let liveStops: ColorStop[] | null = null;
    const currentStops = (t: EditTarget): ColorStop[] => liveStops ?? t.stops;
    const commitStops = (t: EditTarget, next: ColorStop[]): void => {
      liveStops = next;
      writeGradientStops(t, next);
    };

    const onDown = (e: PointerEvent): void => {
      const s = stateRef.current;
      if (e.button !== 0 || !s.view || !s.target) return;
      const p = at(e);
      const hit = hitTestGradient(s.view, p);
      if (!hit) return;
      e.stopPropagation();
      e.preventDefault();
      try {
        svg.setPointerCapture(e.pointerId);
      } catch {
        /* best-effort — jsdom and synthetic events have no capture */
      }

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
      if (e.altKey) {
        const dup = duplicateStop(currentStops(s.target), hit.id, offsetOf(p));
        if (dup) {
          commitStops(s.target, dup.stops);
          selectStop(dup.id);
          drag = { kind: 'stop', id: dup.id };
          return;
        }
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
      if (!s.target) return;
      if (drag.kind === 'grip') {
        if (!s.mapping) return;
        const l = s.mapping.screenToLocal(p.x, p.y);
        const next = paintFromGripDrag(
          s.target.paint,
          drag.grip,
          { x: l.x, y: l.y },
          s.target.width,
          s.target.height,
        );
        writeGradientGeometry(s.target, next, drag.grip);
        return;
      }
      commitStops(s.target, moveStopTo(currentStops(s.target), drag.id, offsetOf(p)));
    };

    const onUp = (e: PointerEvent): void => {
      if (!drag) return;
      drag = null;
      liveStops = null;
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
    };
  }, [armed, nodeId, selectStop]);

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
      writeGradientStops(s.target, next);
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
          onDoubleClick={() => useGradientEditStore.getState().arm(nodeId, fillIndex)}
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
      {fills.length > 1 && (
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
        >
          <ColorPicker
            compact
            value={editingColor}
            aria-label="Gradient stop color"
            onChange={(color) => {
              const t = stateRef.current.target;
              if (!t) return;
              writeGradientStops(
                t,
                t.stops.map((s) => (s.id === editingStop.id ? { ...s, color } : s)),
              );
            }}
          />
        </div>
      )}
    </>
  );
}

export default GradientHandleOverlay;
