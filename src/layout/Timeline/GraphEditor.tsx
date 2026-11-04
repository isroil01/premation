/**
 * GraphEditor — After Effects–style Value/Speed graph editor.
 *
 * Features:
 *  - Value mode: shows animated property curves as SVG paths sampled per segment
 *    (so the curve passes exactly through every keyframe, holds draw as steps).
 *  - Speed mode: shows the speed magnitude (|dv/dt|) of the curve; a keyframe
 *    whose in/out speeds differ shows the AE-style vertical jump.
 *  - Keyframe diamonds: drag horizontally to retime (frame-snapped, never past a
 *    neighbour), vertically to change the value (value mode) or speed (speed mode).
 *    Shift constrains to one axis while dragging; Shift-click toggles multi-select
 *    (shared with the timeline via keyframeSelectionStore). Dragging any diamond
 *    in a multi-selection moves the whole set in time (and value, in value mode).
 *    Time snaps to playhead / other keys / frames; value snaps to other keys /
 *    zero. Alt disables snapping. Guide lines show the active snap target.
 *  - Bézier handles: drag to shape the curve. Linked keyframes keep both sides
 *    collinear (value) / equal speed (speed); Alt-drag breaks the link.
 *  - The vertical range is FROZEN for the whole drag — the graph no longer re-fits
 *    under the cursor — and re-fits on release (AE "auto-zoom graph height").
 *  - Toolbar: Easy Ease / In / Out / Linear / Hold, numeric t / value / in+out
 *    speed & influence fields (each field edits ONLY its own side), link toggle.
 *    Easing presets apply to the multi-keyframe selection (same set as F9).
 *  - Click-drag on the background scrubs the playhead. Alt-drag draws a box
 *    zoom (time span → fill viewport), matching AE’s graph box-zoom gesture.
 *  - Selected keyframes always show value labels; at high horizontal zoom every
 *    in-view diamond gets a label too.
 *  - Legend chips solo a curve (click) or toggle into a multi-solo set (Shift).
 *  - Click a curve body (not a diamond) to select the nearest keyframe on that
 *    track — Shift toggles it into the multi-selection, same as diamonds.
 *
 * Interaction notes (the bugs this design exists to avoid):
 *  - Pointer capture is taken on the <svg>, not the grabbed element. Diamonds
 *    re-mount while they retime, and capture on a removed element is lost.
 *  - All drags are ORIGIN + DELTA: the grabbed thing's start position plus the
 *    pointer's movement since pointer-down. Absolute pointer→value mapping made
 *    the thing jump to the cursor hotspot on the first move.
 *  - The <svg> is CSS-translated by -scrollLeft, so getBoundingClientRect()
 *    already accounts for scroll: client - rect.left IS the svg x coordinate.
 */

import { useState, useRef, useCallback, useMemo, useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import { memberTracksVersion, subscribeMemberTracks } from '@stores/memberTracks';
import { clampPps, TIMELINE_PPS_MAX } from './zoomAnchor';
import { Icon } from '@components/Icon';
import { IconButton } from '@components/IconButton';
import { TooltipProvider } from '@components/Tooltip';
import { EASY_EASE_BEZIER, EASY_EASE_IN_BEZIER, EASY_EASE_OUT_BEZIER, type EasingKind, type PropertyTrack } from '@motion/animation';
import { type EasingPreset } from '@core/animation/keyframeAssistants';
import { easingTargetKeyframes } from '@core/animation/easingSelection';
import { easeKindOnKeys, easePresetOnKeys } from './keyframeEdits';
import {
  EASING_KINDS,
  activeEasingKind,
} from '@core/animation/easingVocabulary';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useEaseClipboardStore } from '@stores/easeClipboardStore';
import { EaseLibrarySection } from '@layout/Motion/EaseLibrarySection';
import { flicksToSeconds, secondsToFlicks, type KeyframePatch, type LayerInfo } from '@motion/engine-api';
import { GestureSession, edit } from '@core/engine/uiEdits';
import { engineIdle } from '@core/engine/engineInstance';
import { compTime } from '@core/engine/propRefs';
import {
  keyTimeById,
  memberKeyPatches,
  memberKeyStart,
  memberKeyValue,
  memberPatchFields,
  resolveKeyIds,
  resolveKeysForGesture,
  setRovingOnKeys,
  toCubic,
  type MemberKeyStart,
  type MemberKeyWrite,
} from './keyframeEdits';
import { resolveSelectionKey, storedTimeOf, trackSelectionId } from '@core/mirror/keySelection';
import { isDataProperty } from './buildPropertyRows';
import { CurveSampler, samplerPropKey } from './graphSamples';
import { isTimelineSnapOn, snapForDrag } from './snapCommands';
import { clamp } from '@utils/lang';
import { cn } from '@utils/cn';
import { ValueField } from '@components/ValueField';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorLayersWatch } from '@hooks/useMirror';
import { memberKeysOf, type MemberKey, type StoredTimeOf } from '@core/mirror/memberKeys';
import { isPinPositionPath, membersOf, pinPositionAxes, trackRefIn, type MirrorTreeLike } from '@core/mirror/trackIndex';
import { mirrorPropertyMeta } from '@core/mirror/metaFacts';
import { isRigTrack } from '@core/timeline/propertyTree';
import {
  withOutgoingSpeed,
  withIncomingSpeed,
  withOutgoingSlope,
  withIncomingSlope,
  outgoingSpeed,
  incomingSpeed,
  outgoingSlope,
  incomingSlope,
  segmentBezierOf,
  isHoldEasing,
  type Bezier,
} from './speedGraph';
import { keyframesInBox, nearestCurveAt } from './graphHover';
import { installGraphNormalizeCommands, onGraphNormalize } from './graphNormalize';
import { applyKeyframeVelocity, readKeyframeVelocity, type KeyframeVelocity } from './keyframeVelocity';
import { snapKeyframeTime, snapKeyframeValue, type SnapTarget, type ValueSnapTarget } from './keyframeSnap';
import { computeBoxZoomFromSvg } from './graphBoxZoom';
import { fitTimeSpan, fitValueRange, panValueRange, zoomValueRange, VALUE_ZOOM_STEP } from './graphValueView';
import { memberPropertyTrack, sampleMemberLocal, spatialSiblingTracks } from './graphLocalSample';
import { nearestKeyframeOnCurve } from './graphCurveClick';
import {
  planGraphGroupTimes,
  applyGroupValueDelta,
  type GraphGroupMemberStart,
} from './graphGroupMove';
import {
  visibleGraphTracks,
  graphSelectedTrackKeys,
  type GraphVisibilityMode,
} from './graphTrackFilter';
import {
  polylinePath,
  snapshotReferenceCurves,
  valueToY,
  yToValue,
  type ReferenceCurve,
} from './graphReferenceCurve';
import { smoothFrameSteps, timeStep, timeTicks, valueTicks } from './graphAxis';
import { usePropertySelectionStore } from '@stores/propertySelectionStore';
import { useResizeObserver } from '@hooks/useResizeObserver';
import { t } from '@core/i18n';
import styles from './GraphEditor.module.css';

/**
 * The graph's fixed UI strings, resolved once on first use. The graph
 * re-renders on every playback tick (`GraphEditorAtPlayhead`), so `t()` is
 * kept out of that path; a language change reloads the interface, which
 * resets this cache. Not at module scope: the catalogue loads after import.
 */
function buildGraphText() {
  return {
    value: t('timeline.graph.value', 'Value'),
    valueTitle: t('timeline.graph.valueTitle', 'Value graph (edit values & curve paths)'),
    speed: t('timeline.graph.speed', 'Speed'),
    speedTitle: t('timeline.graph.speedTitle', 'Speed graph (edit velocity & influence %)'),
    visibility: t('timeline.graph.visibility', 'Graph visibility'),
    sharedAxis: t('timeline.graph.sharedAxis', 'Shared axis'),
    sharedAxisTitle: t('timeline.graph.sharedAxisTitle', 'One vertical axis for every curve, so values compare across properties (off: each curve fitted to its own range)'),
    fitAll: t('timeline.graph.fitAll', 'Fit all graphs to view'),
    fitAllTitle: t('timeline.graph.fitAllTitle', 'Fit all graphs to view — every curve re-fitted to its values and the whole composition in time. Alt+wheel zooms the values, Shift+wheel pans them, middle-drag pans both ways.'),
    fitSelection: t('timeline.graph.fitSelection', 'Fit selection to view'),
    fitSelectionTitle: t('timeline.graph.fitSelectionTitle', 'Fit selection to view — zoom to the selected keyframes’ values and times (every curve, with none selected)'),
    animated: t('timeline.graph.animated', 'Animated'),
    animatedTitle: t('timeline.graph.animatedTitle', 'Show Animated Properties — every keyframed property of the selected layers'),
    selected: t('timeline.graph.selected', 'Selected'),
    selectedTitle: t('timeline.graph.selectedTitle', 'Show Selected Properties — only the property rows selected in the timeline (all animated ones while nothing is selected)'),
    reference: t('timeline.graph.reference', 'Reference'),
    referenceOnTitle: t('timeline.graph.referenceOnTitle', 'Reference graph on — the dashed ghosts are the curves as they were when you switched it on. Click to clear.'),
    referenceOffTitle: t('timeline.graph.referenceOffTitle', 'Reference graph — freeze a dashed ghost of the current curves to compare your edits against'),
    easyEase: t('timeline.graph.easyEase', 'Easy Ease'),
    easyEaseTitle: t('timeline.graph.easyEaseTitle', 'Easy Ease (F9)'),
    easyEaseIn: t('timeline.graph.easyEaseIn', 'Easy Ease In'),
    easyEaseInTitle: t('timeline.graph.easyEaseInTitle', 'Easy Ease In (Shift+F9)'),
    easyEaseOut: t('timeline.graph.easyEaseOut', 'Easy Ease Out'),
    easyEaseOutTitle: t('timeline.graph.easyEaseOutTitle', 'Easy Ease Out (Ctrl+Shift+F9)'),
    easingKind: t('timeline.graph.easingKind', 'Easing kind'),
    easingKindTitle: t('timeline.graph.easingKindTitle', 'Interpolation kind for the selected keyframes'),
    rove: t('timeline.graph.rove', 'Rove across time'),
    roveTitle: t('timeline.graph.roveTitle', 'Rove Across Time — the keyframe keeps its value and gives up its time, so the speed through it is constant'),
    roveDisabledTitle: t('timeline.graph.roveDisabledTitle', 'The first and last keyframes of a track cannot rove'),
    copyEase: t('timeline.graph.copyEase', 'Copy ease'),
    copyEaseTitle: t('timeline.graph.copyEaseTitle', "Copy this keyframe's easing"),
    pasteEase: t('timeline.graph.pasteEase', 'Paste ease'),
    pasteEaseTitle: t('timeline.graph.pasteEaseTitle', 'Paste the copied easing onto the selected keyframes'),
    nothingCopied: t('timeline.graph.nothingCopied', 'Nothing copied yet'),
    easeLibrary: t('timeline.graph.easeLibrary', 'Ease library'),
    easeLibraryTitle: t('timeline.graph.easeLibraryTitle', 'Ease library — named curves, applied to the selected keyframes'),
    linkedTitle: t('timeline.graph.linkedTitle', 'Handles are linked — drag moves both sides (Alt-drag to split). Click to break.'),
    brokenTitle: t('timeline.graph.brokenTitle', 'Handles are split — each side moves alone. Click to link.'),
    linked: t('timeline.graph.linked', '🔗 Linked'),
    broken: t('timeline.graph.broken', '🔓 Broken'),
    emptyAll: t('timeline.graph.emptyAll', 'Nothing is animated yet — switch back to the layer bars and click a property’s stopwatch to add a keyframe'),
    emptySelected: t('timeline.graph.emptySelected', 'The selected layer has no keyframes — deselect it to see every animated layer'),
    noMatch: t('timeline.graph.noMatch', 'No animated property matches the timeline filter'),
    soloActiveTitle: t('timeline.graph.soloActiveTitle', 'Click to solo / Shift-click to toggle · click soloed chip to show all'),
    soloTitle: t('timeline.graph.soloTitle', 'Click to solo this curve · Shift-click to multi-solo'),
    curves: t('timeline.graph.curves', 'Curves'),
    curvesNote: t('timeline.graph.curvesNote', 'Animated properties are listed here.'),
    curveRowTitle: t('timeline.graph.curveRowTitle', 'Click to show only this curve · Shift-click to add or remove it · click again to show all'),
    transformBox: t('timeline.graph.transformBox', 'Transform box'),
    scaleTime: t('timeline.graph.scaleTime', 'Scale the keys in time'),
    scaleValues: t('timeline.graph.scaleValues', 'Scale the values'),
    scaleBoth: t('timeline.graph.scaleBoth', 'Scale time and values'),
    selectedKeyframe: t('timeline.graph.selectedKeyframe', 'Selected keyframe'),
    numValue: t('timeline.graph.numValue', 'Value'),
    keyframeValue: t('timeline.graph.keyframeValue', 'Keyframe value'),
    inSpeed: t('timeline.graph.inSpeed', 'In speed'),
    incomingSpeed: t('timeline.graph.incomingSpeed', 'Incoming speed'),
    outSpeed: t('timeline.graph.outSpeed', 'Out speed'),
    outgoingSpeed: t('timeline.graph.outgoingSpeed', 'Outgoing speed'),
    inInfluence: t('timeline.graph.inInfluence', 'In inf.'),
    incomingInfluence: t('timeline.graph.incomingInfluence', 'Incoming influence'),
    outInfluence: t('timeline.graph.outInfluence', 'Out inf.'),
    outgoingInfluence: t('timeline.graph.outgoingInfluence', 'Outgoing influence'),
  };
}
let graphTextCache: ReturnType<typeof buildGraphText> | null = null;
function graphText(): ReturnType<typeof buildGraphText> {
  return (graphTextCache ??= buildGraphText());
}

export interface GraphEditorProps {
  selectedNodeIds: ReadonlyArray<string>;
  currentTime: number;
  duration: number;
  pixelsPerSecond: number;
  scrollLeft: number;
  /** The graph scrolled itself (wheel / scrollbar) — keep the host's scroll state in step. */
  onScrollChange?: (scrollLeft: number) => void;
  /** Ctrl/⌘ + wheel zoom (pixels per second). Omit to disable. */
  onZoom?: (pixelsPerSecond: number) => void;
  /** Comp frame rate — keyframe retimes snap to this grid. */
  frameRate?: number;
  height?: number;
  onScrub?: (t: number) => void;
  /**
   * `selectedNodeIds` is the comp's layers, not a selection — nothing is
   * selected and the host passed everything so the graph is not blank. Only
   * changes what the empty state says.
   */
  showingAllLayers?: boolean;
  /**
   * Draw the graph's own list of curves down its left edge — layer by layer,
   * each curve with its colour, click to solo. For a host where the graph
   * covers the timeline's layer list (the bottom timeline does), so there is
   * still something to pick curves from. Replaces the toolbar's legend chips.
   */
  showCurveList?: boolean;
  /**
   * The timeline's property search string, verbatim.
   *
   * The graph is a view OF the timeline's rows, so it plots only the tracks
   * whose rows survive the same filter — see `graphTrackFilter`. Omitted (the
   * default) means "no filter", which is exactly the behaviour this panel had
   * before the field existed, so an embedder that has not been taught about it
   * loses nothing.
   */
  propertyFilter?: string;
}

interface KfPoint {
  nodeId: string;
  prop: string;
  index: number;
  /** The engine's keyframe id. */
  keyId: string;
  /** The keyframe SELECTION's id for this diamond (core/mirror/keySelection.ts). */
  selId: string;
  t: number;
  value: number;
  /** What is plotted on the y axis: the value, or (speed mode) the outgoing speed. */
  plotted: number;
  tAbs: number;
  y: number;
  minV: number;
  maxV: number;
  easing?: EasingKind;
  bezier?: [number, number, number, number];
  continuous?: boolean;
  roving?: boolean;
  /** Ends of a track cannot rove — there is nothing to rove BETWEEN. */
  canRove: boolean;
  inSpeed?: number;
  outSpeed?: number;
  inInfluence?: number;
  outInfluence?: number;
}

interface SelectedKf {
  nodeId: string;
  prop: string;
  t: number;
  /**
   * The engine key's id, when known: the focused diamond is found by it first.
   * Found by TIME alone, a diamond being dragged along the time axis lost its
   * focus on every move (its stored time had already changed, the focus
   * followed only once the engine went idle) — its handles, value label and
   * the ease pills' state blinked off and on for the whole drag.
   */
  keyId?: string;
}

/**
 * Keep a selected diamond selected when its ENGINE id changed under an edit —
 * a key a pre-API writer left with a positional fallback id is stamped with a
 * stable one by its first API edit (keyframeEdits `resolveKeysForGesture`).
 * A key with a stable id keeps it when it moves, and this is a no-op.
 */
function rewriteSelectedKeyframeId(oldId: string, newId: string): void {
  if (oldId === newId) return;
  const store = useKeyframeSelectionStore.getState();
  if (!store.ids.has(oldId)) return;
  const next = new Set(store.ids);
  next.delete(oldId);
  next.add(newId);
  store.set(next);
}

interface Range {
  minV: number;
  maxV: number;
}

/** One plottable curve: an engine track plus the text/colour the panel needs. */
interface GraphTrack {
  nodeId: string;
  prop: string;
  /** Layer name — what the timeline's filter matches a whole layer on. */
  layerName: string;
  /** Display label ("Position", "Glow Radius") — the filter matches this too. */
  label: string;
  color: string;
}

type DragKind = 'kf' | 'handle-in' | 'handle-out' | 'scrub' | 'box-zoom' | 'box-select' | 'box-transform' | 'pan';

interface DragState {
  kind: DragKind;
  pointerId: number;
  nodeId: string;
  prop: string;
  /** Current layer time of the anchor keyframe (updated as a retime progresses). */
  kfT: number;
  origValue: number;
  /** svg coords of the grabbed thing (diamond / handle) at pointer-down. */
  ox: number;
  oy: number;
  /** svg coords of the pointer at pointer-down. */
  px0: number;
  py0: number;
  minV: number;
  maxV: number;
  mode: 'value' | 'speed';
  moved: boolean;
  /**
   * Every keyframe drag (diamond or handle) is ONE engine gesture, every move
   * sending the ABSOLUTE state it computed. `keyIds` (handles: stored time →
   * engine keyframe id) and `groupEids` (diamonds: per group member) arrive
   * asynchronously; moves before them are dropped (the next one carries the
   * whole state anyway).
   */
  gesture?: GestureSession;
  keyIds?: Map<number, string>;
  /** The handle drag's own key, by engine id (its stored time changes under a drag). */
  keyId?: string;
  /** A plain press on a diamond already in a multi-selection: a click (no move) collapses the selection to it. */
  collapseOnClick?: boolean;
  /** Diamond drag: each group member's engine key id (parallel to `group`). */
  groupEids?: Array<string | undefined>;
  /** Diamond drag: each group member's selection id at pointer-down (parallel to `group`). */
  groupSelIds?: string[];
  /** Diamond drag: each member's whole key at pointer-down (absolute value writes). */
  startKeys?: Array<MemberKeyStart | null>;
  /** Diamond drag: each member's nearest keys that do NOT move with it (comp seconds). */
  /** Per group member: the comp times of its track's keys that do NOT move with the drag (a key may cross them, never land on one). */
  fixedTimes?: number[][];
  /** Middle-drag pan: the pointer's last CLIENT position (the svg scrolls under it, so svg x is not a stable origin). */
  lastClientX?: number;
  lastClientY?: number;
  /** Live box-zoom corner (svg); start corner is ox/oy. */
  boxX?: number;
  boxY?: number;
  /** Multi-select body at pointer-down (origin+delta). Absent = single diamond. */
  group?: GraphGroupMemberStart[];
  /** Index of the grabbed diamond inside `group`. */
  grabIndex?: number;
  /** Current layer times for `group` members (parallel; mutated while dragging). */
  groupCurrentT?: number[];
  /**
   * Transform box: the selection's svg bounds at pointer-down, which edges the
   * grabbed handle moves (null = that axis is not scaled), and each member's
   * svg y at pointer-down (values scale in screen space, so curves of
   * different ranges scale together, as AE's box does).
   */
  box?: { x0: number; x1: number; y0: number; y1: number; edgeX: 'l' | 'r' | null; edgeY: 't' | 'b' | null };
  groupY0?: number[];
}

/** The transform box's eight handles: which edge(s) each moves. */
const BOX_HANDLES: ReadonlyArray<{ id: string; edgeX: 'l' | 'r' | null; edgeY: 't' | 'b' | null; cursor: string }> = [
  { id: 'l', edgeX: 'l', edgeY: null, cursor: 'ew-resize' },
  { id: 'r', edgeX: 'r', edgeY: null, cursor: 'ew-resize' },
  { id: 't', edgeX: null, edgeY: 't', cursor: 'ns-resize' },
  { id: 'b', edgeX: null, edgeY: 'b', cursor: 'ns-resize' },
  { id: 'tl', edgeX: 'l', edgeY: 't', cursor: 'nwse-resize' },
  { id: 'tr', edgeX: 'r', edgeY: 't', cursor: 'nesw-resize' },
  { id: 'bl', edgeX: 'l', edgeY: 'b', cursor: 'nesw-resize' },
  { id: 'br', edgeX: 'r', edgeY: 'b', cursor: 'nwse-resize' },
];
/** The box's margin around the outermost diamonds, px. */
const BOX_PAD = 6;

/** Fixed multi-curve series palette (data-viz, not chrome) — shared across themes. */
/** Width of the curve list (`showCurveList`), px — `.curveList` in the sheet matches. */
const CURVE_LIST_WIDTH = 240;

const COLORS = ['#e5564b', '#55c271', '#4d9be6', '#e0a94f', '#b58cf0', '#e58cc8'];
const GRAPH_HEIGHT_DEFAULT = 200;
const HANDLE_RADIUS = 3.5;
/** Invisible grab radius around handles / diamonds — AE-sized hit targets. */
const HIT_RADIUS = 10;
const KF_SIZE = 7;
/** Show value labels next to every in-view diamond once zoomed in this far. */
const LABEL_PPS = 120;
const GRAPH_PPS_MIN = 4;
const GRAPH_PPS_MAX = TIMELINE_PPS_MAX;
/** Pointer must travel this far before a press becomes a drag (click ≠ nudge). */
const DRAG_DEAD_ZONE_PX = 2;
/** Handle y is clamped to this band around the segment (overshoot allowed, runaway not). */
// A value-graph handle may overshoot well past the segment (AE lets it): the
// old ±2/3 cap stopped the handle under the cursor and read back a different
// number than was typed.
const MIN_HANDLE_Y = -10;
const MAX_HANDLE_Y = 11;
const MIN_INFLUENCE = 0.001;
const MAX_INFLUENCE = 0.999;

function trackKey(nodeId: string, prop: string): string {
  return `${nodeId}:${prop}`;
}

/** A plotted key's position (layer, member track, stored time) — the drag's own bookkeeping, not a selection id. */
function posKey(nodeId: string, prop: string, t: number): string {
  return `${nodeId}|${prop}|${t}`;
}

/** The selection id of the plotted key at (layer, member track, stored time), if it is plotted. */
function selIdAt(paths: ReadonlyArray<{ nodeId: string; prop: string; keyframes: ReadonlyArray<KfPoint> }>, nodeId: string, prop: string, t: number): string | undefined {
  for (const p of paths) {
    if (p.nodeId !== nodeId || p.prop !== prop) continue;
    return p.keyframes.find((k) => Math.abs(k.t - t) < 1e-9)?.selId;
  }
  return undefined;
}

/**
 * A member track's keys, from the document MIRROR (B4): the property's keys
 * seen from this member — stored units, stored times (the selection's axis),
 * comp seconds in `tAbs`. Undefined when the layer has no such track.
 */
function trackKeys(nodeId: string, prop: string, storedT: StoredTimeOf = storedTimeOf(nodeId)): MemberKey[] | undefined {
  return memberKeysOf(documentMirror(), nodeId, prop, storedT)?.keys;
}

/**
 * The member tracks the graph plots for a layer: every member of every
 * animated NUMERIC property (a data property — Source Text, a path — has no
 * curve), in the mirror's order.
 */
function graphTracksOf(nodeId: string): string[] {
  const m = documentMirror();
  const tree = m.tree(nodeId);
  const out: string[] = [];
  for (const [path, keys] of m.layerKeyframes(nodeId)) {
    if (keys.length === 0) continue;
    const info = tree?.nodes.get(path);
    if (!info || isDataProperty(info)) continue;
    const members = membersOf(info);
    // A puppet pin's Position is ONE data track holding a point (C2): plotted
    // as its X and Y views (trackIndex `pinPositionAxes`), each a curve of its own.
    const tracks = members.length === 1 && info.dimensions === 2 && isPinPositionPath(path) ? pinPositionAxes(members[0]!) : members;
    for (const t of tracks) if (!out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * A plotted track's name. The registry labels the TypeScript track names
 * (`x`, `effect.fx_1.radius`); a rig track (`puppet.pin_1.rotation`,
 * `bone.b1.x`, a pin Position's `.x` view) has none there and would read as
 * its path, so it takes its property's name from the mirror tree ("Rotation",
 * "Position" — the axis letter is added by the curve list).
 */
function graphTrackLabel(prop: string, layer: LayerInfo | undefined, tree: MirrorTreeLike | undefined): string {
  if (isRigTrack(prop)) {
    const name = trackRefIn(tree, prop)?.info.name;
    if (name) return name;
  }
  return mirrorPropertyMeta(prop, layer, tree).label;
}

function findKfIndex(kfs: ReadonlyArray<{ t: number }>, t: number): number {
  return kfs.findIndex((k) => Math.abs(k.t - t) < 1e-9);
}

/** How a track's stored numbers are shown: its factor (Scale is stored as 1, shown as 100) and unit. */
function displayOf(nodeId: string, prop: string, mode: 'value' | 'speed'): { factor: number; unit: string } {
  const m = documentMirror();
  const meta = mirrorPropertyMeta(prop, m.layer(nodeId), m.tree(nodeId));
  const unit = meta.unit ?? '';
  const spaced = unit && unit !== '°' ? ` ${unit}` : unit;
  return {
    factor: typeof meta.displayScale === 'number' && meta.displayScale > 0 ? meta.displayScale : 1,
    unit: mode === 'speed' ? `${spaced}/s` : spaced,
  };
}

/** Format an axis label compactly (1234.5 → "1234.5", 0.00012 → "0"). */
function fmtAxis(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, '');
  return v.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * One write to ONE member track's key at stored time `t`, with the legacy
 * setters' semantics resolved up front: a `bezier` is `setBezier` (easing
 * becomes bezier; `continuous` = the given flag, else the key's, else true),
 * `value` / `continuous` alone are `updateKeyframe`. The graph editor COMPUTES
 * these from the current curves and then sends them — through the engine API
 * (B3) when the track is its own property, else through the legacy writer.
 */
interface MemberWrite {
  t: number;
  value?: number;
  bezier?: Bezier;
  continuous?: boolean;
}

function bezierWrite(kf: { t: number; continuous?: boolean }, bz: Bezier, continuous?: boolean): MemberWrite {
  return { t: kf.t, bezier: bz, continuous: continuous ?? kf.continuous ?? true };
}

function toMemberKeyWrite(w: MemberWrite): MemberKeyWrite {
  return {
    t: w.t,
    ...(w.bezier ? { easing: 'bezier' as const, bezier: toCubic(w.bezier) } : {}),
    ...(w.continuous !== undefined ? { continuous: w.continuous } : {}),
    ...(w.value !== undefined ? { value: w.value } : {}),
  };
}

/**
 * A handle drag's writes for the current pointer position, into the drag's
 * engine gesture (absolute handles, one entry for the drag). On one dimension
 * of a vector (Scale X, one axis of Position) they are that dimension's ease
 * (`KeyframePatch.dim` — AE's per-dimension temporal ease).
 */
function sendHandleWrites(d: DragState, writes: ReadonlyArray<MemberWrite>): void {
  if (writes.length === 0 || !d.gesture || !d.keyIds) return;
  const patches: KeyframePatch[] = [];
  for (const w of writes) {
    const id = d.keyIds.get(w.t);
    if (!id) return;
    patches.push({ id, ...memberPatchFields(d.nodeId, d.prop, toMemberKeyWrite(w)), spatialIn: [], spatialOut: [] });
  }
  d.gesture.send({ type: 'updateKeyframes', patches });
}

/** One click / typed field = one undo entry (`updateKeyframes`). */
async function commitMemberWrites(label: string, nodeId: string, prop: string, writes: ReadonlyArray<MemberWrite>): Promise<void> {
  if (writes.length === 0) return;
  const patches = await memberKeyPatches(nodeId, prop, writes.map(toMemberKeyWrite));
  if (patches && patches.length > 0) await edit(label, { type: 'updateKeyframes', patches });
}

/**
 * A dragged key's time kept OFF the keys that do not move with it (comp
 * seconds): a key may pass its neighbours and reorder, as in After Effects —
 * only landing on a fixed key's frame is avoided (the engine replaces the key
 * already there, and a drag that passed through would have eaten it).
 */
function avoidFixedKeys(t: number, fixed: ReadonlyArray<number> | undefined, frame: number): number {
  const gap = frame > 0 ? frame : 1e-3;
  let out = t;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const f of fixed ?? []) {
      if (Math.abs(out - f) < gap - 1e-9) {
        out = out < f ? f - gap : f + gap;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return Math.max(0, out);
}

/**
 * Make the keyframe at `t` linked (continuous) by re-solving the PREVIOUS
 * segment's arriving slope to match the outgoing slope — the value-graph
 * meaning of "link": collinear tangents. Returns the write (none at the ends).
 */
function alignTangentsWrites(nodeId: string, prop: string, t: number): MemberWrite[] {
  const kfs = trackKeys(nodeId, prop);
  if (!kfs) return [];
  const idx = findKfIndex(kfs, t);
  if (idx <= 0 || idx >= kfs.length - 1) return [];
  const prevKf = kfs[idx - 1]!;
  const kf = kfs[idx]!;
  const nextKf = kfs[idx + 1]!;
  const slope = outgoingSlope(segmentBezierOf(kfs, idx), nextKf.value - kf.value, nextKf.t - kf.t);
  const prevBz = withIncomingSlope(segmentBezierOf(kfs, idx - 1), kf.value - prevKf.value, kf.t - prevKf.t, slope);
  return [bezierWrite(prevKf, prevBz, prevKf.continuous)];
}

/**
 * Set the speed magnitude at keyframe `t`. `side` picks which segment(s) are
 * rewritten: 'in' / 'out' touch ONE side only; 'linked' writes the outgoing
 * side and, when the keyframe is continuous, the incoming one too.
 */
function speedWrites(
  nodeId: string,
  prop: string,
  t: number,
  speed: number,
  side: 'in' | 'out' | 'linked',
): MemberWrite[] {
  const kfs = trackKeys(nodeId, prop);
  if (!kfs) return [];
  const i = findKfIndex(kfs, t);
  if (i < 0) return [];
  const out: MemberWrite[] = [];
  const self = kfs[i]!;
  const next = kfs[i + 1];
  const prev = kfs[i - 1];
  const target = Math.max(0, speed);

  const doOut = side === 'out' || side === 'linked';
  const doIn = side === 'in' || (side === 'linked' && (self.continuous !== false || !next));

  if (doOut && next) {
    const bz = withOutgoingSpeed(segmentBezierOf(kfs, i), next.value - self.value, next.t - self.t, target);
    out.push(bezierWrite(self, bz, self.continuous));
  }
  if (doIn && prev) {
    const bz = withIncomingSpeed(segmentBezierOf(kfs, i - 1), self.value - prev.value, self.t - prev.t, target);
    out.push(bezierWrite(prev, bz, prev.continuous));
  }
  return out;
}

export function GraphEditor({
  selectedNodeIds,
  currentTime,
  duration,
  pixelsPerSecond: pps,
  scrollLeft,
  onScrollChange,
  onZoom,
  frameRate = 30,
  height: propsHeight,
  onScrub,
  propertyFilter,
  showingAllLayers = false,
  showCurveList = false,
}: GraphEditorProps): JSX.Element {
  // B4: the curves are the document MIRROR's keys (and the engine's
  // `sampleProperty` between them); redraw when a selected layer's header,
  // property tree or keyframes change — keeps their trees loaded.
  const mirrorRev = useMirrorLayersWatch(selectedNodeIds);
  // The keys' STORED times come from the engine's member records
  // (keySelection `storedKeyIndex`): redraw when an answer lands.
  const memberRev = useSyncExternalStore(subscribeMemberTracks, memberTracksVersion);
  const rev = `${mirrorRev}|${memberRev}`;
  /** Bumped when an asynchronous curve sample lands (`CurveSampler`). */
  const [samplesTick, setSamplesTick] = useState(0);
  const samplerRef = useRef<CurveSampler | null>(null);
  // One redraw per animation frame however many curves' answers land in it
  // (a drag over N plotted tracks answered N queries per move, each a render).
  const samplesRafRef = useRef(0);
  samplerRef.current ??= new CurveSampler(() => {
    if (samplesRafRef.current) return;
    samplesRafRef.current = requestAnimationFrame(() => {
      samplesRafRef.current = 0;
      setSamplesTick((n) => n + 1);
    });
  });
  const sampler = samplerRef.current;
  useEffect(() => () => {
    samplerRef.current?.dispose();
    samplerRef.current = null;
    if (samplesRafRef.current) cancelAnimationFrame(samplesRafRef.current);
    samplesRafRef.current = 0;
  }, []);
  const [mode, setMode] = useState<'value' | 'speed'>('value');
  /**
   * AE's two graph visibility modes. Component state, not a preference: there
   * is no graph/timeline preference bag to put it in, and unlike the header
   * width this follows what you are doing right now rather than how you like
   * the app set up.
   */
  const [visibility, setVisibility] = useState<GraphVisibilityMode>('animated');
  const propertySelection = usePropertySelectionStore((s) => s.entries);
  // AE's value graph plots every curve on ONE axis; per-curve fitting (the
  // old behaviour) overlaid curves of different ranges so they could not be
  // compared or edited against each other.
  const sharedAxis = usePreferenceStore((s) => s.graphSharedAxis);
  const setPreference = usePreferenceStore((s) => s.set);
  /**
   * Which manual value range a curve reads (`manualRangesRef`): one for every
   * value curve on the shared axis, its own otherwise. The mode is part of the
   * key, so a view set in the value graph is not the speed graph's, and comes
   * back when you return.
   */
  const viewKeyOf = useCallback(
    (nodeId: string, prop: string): string => (mode === 'value' && sharedAxis ? `${mode}|*` : `${mode}|${trackKey(nodeId, prop)}`),
    [mode, sharedAxis],
  );
  const [selectedKf, setSelectedKf] = useState<SelectedKf | null>(null);
  const selectedKfIds = useKeyframeSelectionStore((s) => s.ids);
  const setSelectedKfIds = useKeyframeSelectionStore((s) => s.set);
  const [dragging, setDragging] = useState(false);
  /** null = show all curves; non-empty = only these trackKeys at full opacity. */
  const [soloKeys, setSoloKeys] = useState<Set<string> | null>(null);
  /** Live Alt-drag box-zoom rectangle (svg coords), or null. */
  const [boxZoom, setBoxZoom] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** Live Shift-drag SELECTION rectangle (svg coords), or null. */
  const [boxSelect, setBoxSelect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /**
   * The value read-out under the pointer, or null when the pointer is not near
   * a curve. Held as state rather than written to the DOM because it is one
   * small `<g>` and re-rendering it is cheaper than the ref plumbing would be —
   * but it is CLEARED during a drag, where the pointer moves at pointer rate
   * and the drag has its own read-out.
   */
  const [hover, setHover] = useState<{ x: number; y: number; label: string; color: string } | null>(null);
  const hoverRafRef = useRef(0);
  const hoverPendingRef = useRef<{ hx: number; hy: number } | null>(null);
  useEffect(() => () => { if (hoverRafRef.current) cancelAnimationFrame(hoverRafRef.current); }, []);
  /** Live snap guides while dragging a diamond (time vertical / value horizontal). */
  const [graphSnap, setGraphSnap] = useState<{
    time: SnapTarget | null;
    value: ValueSnapTarget | null;
    minV: number;
    maxV: number;
  } | null>(null);
  // Bumped when a drag ends so the range re-fits once (the memo below reads the
  // frozen ranges through a ref, which a state change must flush).
  const [refitTick, setRefitTick] = useState(0);
  /**
   * The value axis as the user LEFT it — Alt+wheel zoom, Shift+wheel / middle
   * drag pan, Fit selection — per view key (`viewKeyOf`), replacing the
   * auto-fit for that curve while set, so a zoom outlives the re-fit every
   * engine answer would otherwise cause. A ref, not state: the sampling memo
   * reads it; bumping `viewTick` is what redraws. Fit clears it.
   */
  const manualRangesRef = useRef<Map<string, Range>>(new Map());
  const [viewTick, setViewTick] = useState(0);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const { ref: containerRef, size } = useResizeObserver<HTMLDivElement>();

  const height = propsHeight ?? (size.height > 0 ? size.height : GRAPH_HEIGHT_DEFAULT);
  const viewportW = Math.max(120, (size.width > 0 ? size.width : 800) - (showCurveList ? CURVE_LIST_WIDTH : 0));

  // Clear focus when selected nodes change. Solo follows the visible tracks.
  useEffect(() => {
    setSelectedKf(null);
    setSoloKeys(null);
  }, [selectedNodeIds]);

  // ── Track / curve data ─────────────────────────────────────────
  /**
   * Every animated track of every selected layer, carrying the text the
   * timeline's filter matches on.
   *
   * Colour is assigned HERE, across the UNFILTERED list, so a curve keeps its
   * colour (and its legend chip) when the filter or the visibility mode
   * narrows the set — a curve that changed colour as you typed would be a new
   * curve as far as the eye is concerned.
   */
  const allTracks = useMemo(() => {
    const m = documentMirror();
    const out: GraphTrack[] = [];
    let colorIdx = 0;
    for (const nodeId of selectedNodeIds) {
      const layer = m.layer(nodeId);
      const layerName = layer?.name ?? nodeId;
      const tree = m.tree(nodeId);
      for (const prop of graphTracksOf(nodeId)) {
        out.push({
          nodeId,
          prop,
          layerName,
          label: graphTrackLabel(prop, layer, tree),
          color: COLORS[colorIdx++ % COLORS.length] ?? '#2988ff',
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mirror-watch driven (`rev`)
  }, [selectedNodeIds, rev]);

  /** Property ROW selection, expanded to the engine tracks it stands for. */
  const selectedTrackKeys = useMemo(
    () => graphSelectedTrackKeys(propertySelection),
    [propertySelection],
  );

  /** What this panel actually plots: the filter's survivors, in the chosen mode. */
  const tracks = useMemo(
    () =>
      visibleGraphTracks({
        tracks: allTracks,
        query: propertyFilter,
        mode: visibility,
        selectedKeys: selectedTrackKeys,
      }),
    [allTracks, propertyFilter, visibility, selectedTrackKeys],
  );

  // The numeric strip's row (measured: it is always mounted, so the plot never
  // jumps under the cursor when the focus changes mid-drag).
  const { ref: stripRef, size: stripSize } = useResizeObserver<HTMLDivElement>();
  const INNER_H = Math.max(40, height - 40 - stripSize.height); // leave 40 px for toolbar
  const totalWidth = Math.max(duration * pps, 1);
  const graphWidth = Math.max(totalWidth, viewportW);

  /**
   * Vertical ranges frozen for the duration of a drag. While this is set the
   * graph does NOT re-fit to the data, so the thing under the cursor stays
   * under the cursor. Cleared (and re-fitted) on release.
   */
  const frozenRangesRef = useRef<Map<string, Range> | null>(null);
  const dragRef = useRef<DragState | null>(null);
  /**
   * The focused keyframe's handle positions, readable from a pointermove
   * handler that must not DEPEND on them — it would re-bind on every frame of
   * a drag. Written further down, once `handleGeom` has been computed.
   */
  const handleGeomRef = useRef<Array<{ nodeId: string; prop: string; t: number; x: number; y: number }>>([]);

  const sampledPaths = useMemo(() => {
    const paths: {
      color: string;
      d: string;
      /** What the property holds outside its keys, drawn dashed. */
      dExt: string;
      /** The polyline in data space ([comp seconds, plotted value]) — what the
       *  reference overlay snapshots, so a ghost is independent of zoom. */
      samples: ReadonlyArray<readonly [number, number]>;
      keyframes: KfPoint[];
      prop: string;
      nodeId: string;
      minV: number;
      maxV: number;
    }[] = [];

    // Visible comp-time window (plus margin) — only this stretch is sampled
    // densely; offscreen segments get their endpoints only.
    const visT0 = Math.max(0, (scrollLeft - 50) / pps);
    const visT1 = Math.min(duration, (scrollLeft + viewportW + 50) / pps);

    // One dense `sampleProperty` answer per plotted property over the visible
    // window, about one sample per 2 px (B4: the curve between keys is the
    // engine's, never re-derived in the UI).
    const winT1 = Math.max(visT0 + 1e-3, visT1);
    const winSamples = clamp(Math.ceil(((winT1 - visT0) * pps) / 2) + 1, 2, 4000);
    const plotted = new Set<string>();

    const mirror = documentMirror();
    // The keys a drag is moving right now (their time or their handles): the
    // segments touching them are drawn from the keys while the engine's
    // samples for this revision are still on their way (see `stale` below).
    const drag = dragRef.current;
    const movingNow = new Set<string>();
    if (drag && (drag.kind === 'kf' || drag.kind === 'box-transform') && drag.group && drag.groupCurrentT) {
      drag.group.forEach((m, i) => movingNow.add(posKey(m.nodeId, m.prop, drag.groupCurrentT![i]!)));
    } else if (drag && (drag.kind === 'handle-in' || drag.kind === 'handle-out')) {
      movingNow.add(posKey(drag.nodeId, drag.prop, drag.kfT));
    }
    const sampleStep = Math.max(1e-4, 2 / pps);  // seconds per dense sample (about one per 2 px)
    /** Every plotted track's samples and keys, before the ranges are known (one axis needs them all). */
    const pre: Array<{ nodeId: string; prop: string; color: string; kfs: MemberKey[]; samples: [number, number][]; body: [number, number][]; extensions: [number, number][][]; toAbs: (kf: MemberKey) => number }> = [];
    for (const { nodeId, prop, color } of tracks) {
      const storedT = storedTimeOf(nodeId);
      const hit = memberKeysOf(mirror, nodeId, prop, storedT);
      const kfs = hit?.keys;
      if (!hit || !kfs || kfs.length === 0) continue;
      const { ref } = hit;

      const toAbs = (kf: MemberKey): number => kf.tAbs;
      plotted.add(samplerPropKey(nodeId, ref.path));
      const query = {
        type: 'sampleProperty' as const,
        prop: { layer: nodeId, path: ref.path },
        range: { start: secondsToFlicks(visT0), duration: secondsToFlicks(winT1) - secondsToFlicks(visT0) },
        samples: winSamples,
        speed: false,
      };
      const answer = sampler.get(query, rev);
      const stale = answer !== undefined && !sampler.isCurrent(query, rev);
      /** A segment whose ends include a key being dragged, while the samples shown are the previous revision's. */
      const driftingSeg = (a: MemberKey, b: MemberKey): boolean =>
        stale && (movingNow.has(posKey(nodeId, prop, a.t)) || movingNow.has(posKey(nodeId, prop, b.t)));
      /**
       * The segment from its own keys, dense at the same spacing as the
       * engine's answer: the member's temporal bezier (CSS cubic-bezier
       * semantics, packages/animation interpolate.ts) — or, for an axis of a
       * spatial property, the arc-length-timed motion path its siblings trace
       * with it (graphLocalSample), which is what the engine evaluates. Built
       * on the first drifting segment only: a drag rarely has one.
       */
      let localTracks: { own: PropertyTrack; siblings: Array<PropertyTrack | undefined> | null } | null = null;
      const localIn = (a: MemberKey, b: MemberKey, aAbs: number, bAbs: number): Array<[number, number]> => {
        const out: Array<[number, number]> = [];
        const dt = b.t - a.t;
        const span = bAbs - aAbs;
        if (!(dt > 0) || !(span > 0)) return out;
        localTracks ??= {
          own: memberPropertyTrack(nodeId, prop, ref, kfs, ref.member),
          siblings: spatialSiblingTracks(mirror, nodeId, ref, storedT),
        };
        for (let t = aAbs + sampleStep; t < bAbs - 1e-9; t += sampleStep) {
          if (t < visT0 - sampleStep || t > visT1 + sampleStep) continue;
          // Comp seconds → the keys' stored axis, where the tracks live.
          const v = sampleMemberLocal(localTracks.own, localTracks.siblings, ref.member, a.t + ((t - aAbs) / span) * dt);
          if (typeof v === 'number' && Number.isFinite(v)) out.push([t, v]);
        }
        return out;
      };
      /** The window's samples of this member, [comp seconds, stored value]. */
      const rawDense: Array<[number, number]> = [];
      if (answer && answer.dimensions > ref.member) {
        for (let i = 0; i < answer.times.length; i++) {
          const v = answer.values[i * answer.dimensions + ref.member];
          if (typeof v === 'number' && Number.isFinite(v)) rawDense.push([flicksToSeconds(answer.times[i]!), v / ref.factor]);
        }
      }
      const dense = smoothFrameSteps(rawDense, frameRate > 0 ? 1 / frameRate : 0);
      /** The dense samples strictly inside (a, b), comp seconds — the engine's, or the keys' own while a drag outruns them. */
      const denseIn = (a: number, b: number, ka?: MemberKey, kb?: MemberKey): Array<[number, number]> =>
        ka && kb && driftingSeg(ka, kb) ? localIn(ka, kb, a, b) : dense.filter(([t]) => t > a + 1e-9 && t < b - 1e-9);

      /**
       * Speed INSIDE segment [a,b] — a finite difference over the segment's own
       * samples that never straddles a keyframe; the ends take the analytic
       * out / in speed of the handles, so the curve meets each keyframe there.
       */
      const speedSegment = (a: MemberKey, b: MemberKey, aAbs: number, bAbs: number): Array<[number, number]> => {
        if (isHoldEasing(a.easing)) return [[aAbs, 0], [bAbs, 0]];
        const dt = b.t - a.t;
        const bz = segmentBezierOf(kfs, kfs.indexOf(a));
        const out: Array<[number, number]> = [[aAbs, dt > 0 ? outgoingSpeed(bz, b.value - a.value, dt) : 0]];
        const inner = denseIn(aAbs, bAbs, a, b);
        for (let i = 0; i < inner.length; i++) {
          const p0 = inner[Math.max(0, i - 1)]!;
          const p1 = inner[Math.min(inner.length - 1, i + 1)]!;
          const span = p1[0] - p0[0];
          out.push([inner[i]![0], span > 0 ? Math.abs((p1[1] - p0[1]) / span) : out[out.length - 1]![1]]);
        }
        out.push([bAbs, dt > 0 ? incomingSpeed(bz, b.value - a.value, dt) : 0]);
        return out;
      };

      // ── Sample per segment: [comp seconds, plotted value] ──
      // Seconds, not pixels: the same polyline is what the reference overlay
      // freezes, and a frozen ghost measured in pixels would drift the moment
      // the graph was zoomed.
      const samples: [number, number][] = [];
      const firstAbs = toAbs(kfs[0]!);
      const lastAbs = toAbs(kfs[kfs.length - 1]!);

      const extensions: [number, number][][] = [];

      // Before the first keyframe: flat (value) / zero (speed).
      if (firstAbs > 0) {
        const v = mode === 'speed' ? 0 : kfs[0]!.value;
        samples.push([0, v], [firstAbs, v]);
        extensions.push([[0, v], [firstAbs, v]]);
      }
      const bodyStart = samples.length;

      for (let s = 0; s < kfs.length - 1; s++) {
        const a = kfs[s]!;
        const b = kfs[s + 1]!;
        const aAbs = toAbs(a);
        const bAbs = toAbs(b);
        if (mode === 'value' && isHoldEasing(a.easing)) {
          samples.push([aAbs, a.value], [bAbs, a.value], [bAbs, b.value]);
          continue;
        }
        if (mode === 'speed') {
          samples.push(...speedSegment(a, b, aAbs, bAbs));
          continue;
        }
        // Offscreen segments (and a window not sampled yet) get their ends only.
        samples.push([aAbs, a.value], ...denseIn(aAbs, bAbs, a, b), [bAbs, b.value]);
      }

      const body = samples.slice(bodyStart);
      if (lastAbs < duration) {
        const v = mode === 'speed' ? 0 : kfs[kfs.length - 1]!.value;
        samples.push([lastAbs, v], [duration, v]);
        extensions.push([[lastAbs, v], [duration, v]]);
      }
      if (kfs.length === 1) {
        const v = mode === 'speed' ? 0 : kfs[0]!.value;
        samples.push([0, v], [duration, v]);
      }

      pre.push({ nodeId, prop, color, kfs, samples, body, extensions, toAbs });
    }

    // ── Range: frozen during a drag, auto-fit otherwise ──
    // The raw extent of one track's samples and keys (value mode counts the
    // keys too: a hold key's value is on no sample).
    const extentOf = (p: { samples: ReadonlyArray<readonly [number, number]>; kfs: MemberKey[] }): { lo: number; hi: number } => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const [, v] of p.samples) {
        if (Number.isFinite(v)) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
      if (mode === 'value') {
        for (const kf of p.kfs) {
          lo = Math.min(lo, kf.value);
          hi = Math.max(hi, kf.value);
        }
      }
      return { lo, hi };
    };
    const padded = (lo: number, hi: number): Range => {
      let minV = lo;
      let maxV = hi;
      if (!Number.isFinite(minV) || !Number.isFinite(maxV)) {
        minV = 0;
        maxV = 1;
      }
      if (mode === 'speed') {
        minV = 0;
        if (maxV <= 0) maxV = 100;
        maxV *= 1.25; // headroom
      } else {
        if (maxV === minV) {
          minV -= 1;
          maxV += 1;
        }
        const pad = (maxV - minV) * 0.15;
        minV -= pad;
        maxV += pad;
      }
      return { minV, maxV };
    };
    // One axis for every value curve (AE): the union of their extents.
    let shared: Range | null = null;
    if (sharedAxis && mode === 'value' && pre.length > 0) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of pre) {
        const e = extentOf(p);
        lo = Math.min(lo, e.lo);
        hi = Math.max(hi, e.hi);
      }
      shared = padded(lo, hi);
    }

    for (const { nodeId, prop, color, kfs, samples, body, extensions, toAbs } of pre) {
      // The manual view first (a zoom or pan outlives any drag), then the
      // range frozen by a drag in progress, then the fit.
      let range = manualRangesRef.current.get(viewKeyOf(nodeId, prop)) ?? frozenRangesRef.current?.get(trackKey(nodeId, prop));
      if (!range) {
        if (shared) {
          range = shared;
        } else {
          const e = extentOf({ samples, kfs });
          range = padded(e.lo, e.hi);
        }
      }
      const { minV, maxV } = range;

      const d = polylinePath(body, pps, minV, maxV, INNER_H);
      const dExt = extensions.map((e) => polylinePath(e, pps, minV, maxV, INNER_H)).join(' ');

      const keyframes: KfPoint[] = kfs.map((kf, i) => {
        const prev = i > 0 ? kfs[i - 1] : null;
        const next = i < kfs.length - 1 ? kfs[i + 1] : null;

        let inSpd: number | undefined;
        let inInf: number | undefined;
        let outSpd: number | undefined;
        let outInf: number | undefined;

        if (prev) {
          const prevBz = segmentBezierOf(kfs, i - 1);
          inSpd = isHoldEasing(prev.easing) ? 0 : incomingSpeed(prevBz, kf.value - prev.value, kf.t - prev.t);
          inInf = 1 - prevBz[2];
        }
        if (next) {
          const bz = segmentBezierOf(kfs, i);
          outSpd = isHoldEasing(kf.easing) ? 0 : outgoingSpeed(bz, next.value - kf.value, next.t - kf.t);
          outInf = bz[0];
        }

        const plotted = mode === 'speed' ? (outSpd ?? inSpd ?? 0) : kf.value;

        return {
          nodeId,
          prop,
          index: i,
          keyId: kf.key.id,
          selId: trackSelectionId(mirror, nodeId, prop, kf.key.id),
          t: kf.t,
          tAbs: toAbs(kf),
          value: kf.value,
          plotted,
          y: valueToY(plotted, minV, maxV, INNER_H),
          minV,
          maxV,
          easing: kf.easing,
          bezier: kf.bezier,
          continuous: kf.continuous,
          roving: kf.roving,
          canRove: !!prev && !!next,
          inSpeed: inSpd,
          outSpeed: outSpd,
          inInfluence: inInf,
          outInfluence: outInf,
        };
      });

      paths.push({ color, d, dExt, samples, keyframes, prop, nodeId, minV, maxV });
    }
    sampler.retain(plotted);
    return paths;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `rev` (mirror watch) and `samplesTick` (a curve answer landed) drive the re-sample
  }, [tracks, duration, pps, INNER_H, rev, samplesTick, mode, scrollLeft, viewportW, refitTick, sharedAxis, viewKeyOf, viewTick, frameRate]);
  // Read by the wheel / pan handlers, which must not re-bind on every sample that lands.
  const sampledPathsRef = useRef(sampledPaths);
  sampledPathsRef.current = sampledPaths;

  /**
   * The transform box around the selected diamonds — value graph only (the
   * speed graph plots derivatives, which do not scale like values), and only
   * for two or more keys.
   */
  const transformBox = useMemo(() => {
    if (mode !== 'value' || selectedKfIds.size < 2) return null;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    let n = 0;
    for (const p of sampledPaths) {
      for (const k of p.keyframes) {
        if (!selectedKfIds.has(k.selId)) continue;
        const kx = k.tAbs * pps;
        x0 = Math.min(x0, kx);
        x1 = Math.max(x1, kx);
        y0 = Math.min(y0, k.y);
        y1 = Math.max(y1, k.y);
        n++;
      }
    }
    if (n < 2) return null;
    return { x0: x0 - BOX_PAD, x1: x1 + BOX_PAD, y0: y0 - BOX_PAD, y1: y1 + BOX_PAD };
  }, [mode, selectedKfIds, sampledPaths, pps]);

  /**
   * Every keyframe a Shift-drag box has caught — diamonds, plus the focused
   * keyframe's tangent handles. Declared here, above the pointer handlers that
   * call it, so the box-select cannot be a use-before-declaration hazard.
   */
  const boxSelectIds = useCallback(
    (rect: { x0: number; y0: number; x1: number; y1: number }): Set<string> =>
      keyframesInBox(sampledPaths, rect, handleGeomRef.current, pps, (n, p, t) => selIdAt(sampledPaths, n, p, t) ?? ''),
    [sampledPaths, pps],
  );

  // ── Reference ("before") curves ───────────────────────────────
  /**
   * Turn it on and every visible curve is frozen as it stands; the ghosts then
   * sit behind the live curves, dashed and muted, until it is turned off.
   *
   * What is frozen is the SAMPLED POLYLINE, not the keyframes — re-deriving a
   * ghost from the data being edited would give you a reference that changes
   * with every drag, which is the one thing a reference must not do. Stored in
   * data space and re-projected each frame, so zooming moves the ghost with
   * its curve instead of leaving it behind.
   */
  const [referenceOn, setReferenceOn] = useState(false);
  const [reference, setReference] = useState<Map<string, ReferenceCurve> | null>(null);
  /** Ghosts are stale: freshly enabled, or the subject changed under them. */
  const recaptureRef = useRef(false);

  // A new selection / mode / filter means a new subject, and a reference means
  // "before I started editing THIS" — so it re-freezes rather than keeping
  // ghosts of curves that are no longer on screen.
  //
  // Keyed on the selection's CONTENT, not the array's identity: the host may
  // hand us a fresh array on every render, and a dep that changes every render
  // would re-freeze the ghost on every sampled frame of a drag — which is the
  // ghost following the live curve, i.e. no reference at all.
  const selectionKey = selectedNodeIds.join('\u0000');
  useEffect(() => {
    if (referenceOn) recaptureRef.current = true;
  }, [referenceOn, selectionKey, mode, visibility, propertyFilter]);

  useEffect(() => {
    if (!referenceOn) {
      recaptureRef.current = false;
      setReference(null);
      return;
    }
    const full = recaptureRef.current;
    recaptureRef.current = false;
    setReference((prev) => {
      // A whole new subject — freeze everything as it stands.
      if (full || !prev) return snapshotReferenceCurves(sampledPaths, trackKey);
      // Otherwise only tracks that have just BECOME visible (a property row was
      // added to the selection, say) get a ghost. Ghosts already held are never
      // rewritten: a re-sample caused by the edit in progress must not move the
      // thing being compared against, which is the entire point.
      let next: Map<string, ReferenceCurve> | null = null;
      for (const p of sampledPaths) {
        const key = trackKey(p.nodeId, p.prop);
        if (prev.has(key)) continue;
        next ??= new Map(prev);
        next.set(key, { points: p.samples });
      }
      return next ?? prev;
    });
  }, [referenceOn, sampledPaths]);

  // ── Pointer helpers ───────────────────────────────────────────
  const svgCoords = useCallback((e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    // The svg lives inside a natively scrolling container; its client rect
    // already reflects the scroll, so this IS the svg-space coordinate.
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  // ── Horizontal scroll / zoom ──────────────────────────────────
  const canvasRef = useRef<HTMLDivElement | null>(null);
  // Keep the time under the cursor fixed across a wheel zoom (applied by the
  // layout effect below, once the svg has been laid out at the new width).
  const zoomAnchorRef = useRef<{ t: number; localX: number } | null>(null);
  // Follow the host's scroll (the Timeline's lanes) when it changes under us.
  useEffect(() => {
    const el = canvasRef.current;
    if (el && Math.abs(el.scrollLeft - scrollLeft) > 0.5) el.scrollLeft = scrollLeft;
  }, [scrollLeft, totalWidth]);

  const onCanvasScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      onScrollChange?.(e.currentTarget.scrollLeft);
    },
    [onScrollChange],
  );

  // ── Vertical view: zoom / pan / fit (AE's value-axis navigation) ──
  /** Apply `fn` to every plotted curve's CURRENT range and keep the result as the manual view. */
  const transformView = useCallback(
    (fn: (r: Range) => Range) => {
      const paths = sampledPathsRef.current;
      if (paths.length === 0) return;
      const next = manualRangesRef.current;
      for (const p of paths) next.set(viewKeyOf(p.nodeId, p.prop), fn({ minV: p.minV, maxV: p.maxV }));
      setViewTick((n) => n + 1);
    },
    [viewKeyOf],
  );
  /** Zoom the value axis about svg `cy`; `factor` < 1 zooms in. */
  const zoomValueAxis = useCallback(
    (cy: number, factor: number) => transformView((r) => zoomValueRange(r, cy, INNER_H, factor)),
    [transformView, INNER_H],
  );
  /** Pan the value axis by `dyPx` screen pixels (positive = the content moves down). */
  const panValueAxis = useCallback(
    (dyPx: number) => transformView((r) => panValueRange(r, dyPx, INNER_H)),
    [transformView, INNER_H],
  );
  /** Zoom the TIME axis so [t0, t1] fills the viewport — the box-zoom's plumbing. */
  const zoomTimeTo = useCallback(
    (t0: number, t1: number) => {
      if (!onZoom || !(t1 > t0)) return;
      const result = computeBoxZoomFromSvg({
        x0: t0 * pps,
        x1: t1 * pps,
        currentPps: pps,
        viewportW,
        minPps: GRAPH_PPS_MIN,
        maxPps: GRAPH_PPS_MAX,
        minSpanPx: 0,
      });
      if (!result) return;
      zoomAnchorRef.current = { t: result.t0, localX: 0 };
      onZoom(result.pps);
      const el = canvasRef.current;
      if (el) {
        el.scrollLeft = result.scrollLeft;
        onScrollChange?.(result.scrollLeft);
      }
    },
    [onZoom, onScrollChange, pps, viewportW],
  );
  /** Fit all graphs to view: every manual range (and a drag's freeze) dropped, the composition fitted in time. */
  const fitAllToView = useCallback(() => {
    manualRangesRef.current = new Map();
    frozenRangesRef.current = null;
    setRefitTick((n) => n + 1);
    zoomTimeTo(0, duration);
  }, [zoomTimeTo, duration]);
  /**
   * Fit selection to view: the selected keys' plotted values (per curve, or
   * together on the shared axis) and their time span. With nothing selected
   * it is Fit all — a button that did nothing is the failure to avoid.
   */
  const fitSelectionToView = useCallback(() => {
    const picked = sampledPathsRef.current
      .map((p) => ({ p, keys: p.keyframes.filter((k) => selectedKfIds.has(k.selId)) }))
      .filter((e) => e.keys.length > 0);
    if (picked.length === 0) {
      fitAllToView();
      return;
    }
    const next = manualRangesRef.current;
    if (mode === 'value' && sharedAxis) {
      const r = fitValueRange(picked.flatMap((e) => e.keys.map((k) => k.plotted)), mode);
      if (r) next.set(viewKeyOf(picked[0]!.p.nodeId, picked[0]!.p.prop), r);
    } else {
      for (const e of picked) {
        const r = fitValueRange(e.keys.map((k) => k.plotted), mode);
        if (r) next.set(viewKeyOf(e.p.nodeId, e.p.prop), r);
      }
    }
    setViewTick((n) => n + 1);
    const span = fitTimeSpan(picked.flatMap((e) => e.keys.map((k) => k.tAbs)));
    if (span) zoomTimeTo(span.t0, span.t1);
  }, [selectedKfIds, mode, sharedAxis, viewKeyOf, fitAllToView, zoomTimeTo]);

  // Wheel: plain → pan horizontally; ctrl / ⌘ → zoom time, keeping the time
  // under the cursor fixed; alt → zoom the VALUE axis about the pointer;
  // shift → pan the value axis (After Effects' graph editor).
  const onCanvasWheel = useCallback(
    (e: WheelEvent) => {
      const el = canvasRef.current;
      if (!el) return;
      if (e.altKey) {
        e.preventDefault();
        const rect = svgRef.current?.getBoundingClientRect();
        zoomValueAxis(rect ? e.clientY - rect.top : INNER_H / 2, e.deltaY < 0 ? 1 / VALUE_ZOOM_STEP : VALUE_ZOOM_STEP);
        return;
      }
      if (e.shiftKey) {
        e.preventDefault();
        // Some platforms hand shift+wheel over as deltaX already.
        const dy = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        // Wheel down shows the lower values: the content moves UP.
        if (dy !== 0) panValueAxis(-dy);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        if (!onZoom) return;
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const next = clampPps(pps * factor);
        const rect = el.getBoundingClientRect();
        const localX = e.clientX - rect.left;
        // Re-anchored by the layout effect below once the new pps has rendered.
        zoomAnchorRef.current = { t: (el.scrollLeft + localX) / pps, localX };
        onZoom(next);
        return;
      }
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (delta === 0) return;
      el.scrollLeft += delta;
    },
    [pps, onZoom, zoomValueAxis, panValueAxis, INNER_H],
  );
  // Keep the time under the cursor fixed across a wheel zoom. Runs after the
  // svg has been laid out at the new width, so the scroll can actually land.
  useLayoutEffect(() => {
    const a = zoomAnchorRef.current;
    const el = canvasRef.current;
    if (!a || !el) return;
    zoomAnchorRef.current = null;
    el.scrollLeft = Math.max(0, a.t * pps - a.localX);
    onScrollChange?.(el.scrollLeft);
  }, [pps, onScrollChange]);

  // Native, non-passive: React's wheel listener is passive, so preventDefault
  // there cannot stop the browser's own ctrl+wheel zoom.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.addEventListener('wheel', onCanvasWheel, { passive: false });
    return () => el.removeEventListener('wheel', onCanvasWheel);
  }, [onCanvasWheel]);

  const freezeRanges = useCallback(() => {
    const m = new Map<string, Range>();
    for (const p of sampledPaths) m.set(trackKey(p.nodeId, p.prop), { minV: p.minV, maxV: p.maxV });
    frozenRangesRef.current = m;
  }, [sampledPaths]);

  const beginDrag = useCallback(
    (e: React.PointerEvent<Element>, state: Omit<DragState, 'pointerId' | 'moved'>) => {
      e.stopPropagation();
      e.preventDefault();
      // Capture on the SVG: it survives child re-mounts (diamonds re-key as they retime).
      try {
        svgRef.current?.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
      freezeRanges();
      dragRef.current = { ...state, pointerId: e.pointerId, moved: false };
      setHover(null);  // a chip from before the drag came back on release, pointing at nothing
      setDragging(true);
    },
    [freezeRanges],
  );

  const endDrag = useCallback(() => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'box-zoom') {
      const x1 = d.boxX ?? d.ox;
      if (d.moved && onZoom) {
        const result = computeBoxZoomFromSvg({
          x0: d.ox,
          x1,
          currentPps: pps,
          viewportW,
          minPps: GRAPH_PPS_MIN,
          maxPps: GRAPH_PPS_MAX,
        });
        if (result) {
          zoomAnchorRef.current = { t: result.t0, localX: 0 };
          onZoom(result.pps);
          // scrollLeft applied by the layout effect after pps lands; also set
          // immediately so a no-op clamp still pans to the box.
          const el = canvasRef.current;
          if (el) {
            el.scrollLeft = result.scrollLeft;
            onScrollChange?.(result.scrollLeft);
          }
        }
      }
      setBoxZoom(null);
    } else if (d.kind === 'box-select') {
      // The selection was applied live on every move, so release only clears
      // the rectangle. A box that never moved leaves the selection alone
      // rather than emptying it: shift-click on empty space is "add nothing".
      setBoxSelect(null);
    } else if (d.gesture) {
      // Nothing sent (a click on a diamond or a handle) → nothing recorded.
      void (d.moved ? d.gesture.end() : d.gesture.cancel());
      if (!d.moved && d.collapseOnClick && d.kind === 'kf') {
        const sel = d.groupSelIds?.[d.grabIndex ?? 0];
        if (sel) setSelectedKfIds(new Set([sel]));
      }
    }
    try {
      if (svgRef.current?.hasPointerCapture(d.pointerId)) svgRef.current.releasePointerCapture(d.pointerId);
    } catch {
      /* ignore */
    }
    dragRef.current = null;
    frozenRangesRef.current = null;
    setDragging(false);
    setGraphSnap(null);
    setRefitTick((n) => n + 1);
  }, [onZoom, onScrollChange, pps, viewportW, setSelectedKfIds]);

  // Start dragging a keyframe diamond. Shift-click toggles multi-select (same
  // set the timeline / F9 commands use); plain click focuses and replaces the
  // set unless the diamond was already part of a multi-selection (group drag
  // keeps the set and moves every selected diamond together).
  const onKfPointerDown = useCallback(
    (e: React.PointerEvent<SVGElement>, kf: KfPoint) => {
      if (e.button !== 0) return;
      const id = kf.selId;
      const next = new Set(selectedKfIds);
      const wasSelected = next.has(id);
      if (e.shiftKey) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      } else if (!next.has(id)) {
        next.clear();
        next.add(id);
      }
      setSelectedKfIds(next);
      setSelectedKf({ nodeId: kf.nodeId, prop: kf.prop, t: kf.t, keyId: kf.keyId });
      // A click on a diamond already in a multi-selection selects just it on
      // release (AE); a DRAG keeps the set and moves it as one body.
      const collapseOnClick = !e.shiftKey && wasSelected && next.size > 1;

      // Snapshot the moving body at pointer-down (origin+delta). Prefer the
      // multi-selection when the grab is already in it; otherwise just the grab.
      const idsForGroup = next.has(id) && next.size > 1 ? next : new Set([id]);
      const group: GraphGroupMemberStart[] = [];
      const groupSelIds: string[] = [];
      const groupKeyIds: Array<string | undefined> = [];
      for (const sid of idsForGroup) {
        let point: KfPoint | undefined;
        for (const p of sampledPaths) {
          point = p.keyframes.find((k) => k.selId === sid);
          if (point) break;
        }
        if (!point) continue;
        groupSelIds.push(point.selId);
        groupKeyIds.push(point.keyId.startsWith('@') ? undefined : point.keyId);
        group.push({
          nodeId: point.nodeId,
          prop: point.prop,
          startT: point.t,
          startCompT: point.tAbs,
          startValue: point.value,
          minV: point.minV,
          maxV: point.maxV,
        });
      }
      if (group.length === 0) {
        group.push({ nodeId: kf.nodeId, prop: kf.prop, startT: kf.t, startCompT: kf.tAbs, startValue: kf.value, minV: kf.minV, maxV: kf.maxV });
        groupSelIds.push(kf.selId);
        groupKeyIds.push(kf.keyId.startsWith('@') ? undefined : kf.keyId);
      }
      const grabIndex = Math.max(0, group.findIndex(
        (m) => m.nodeId === kf.nodeId && m.prop === kf.prop && Math.abs(m.startT - kf.t) < 1e-9,
      ));
      // The keys each member may not LAND on: its track's keys that are not
      // moving with it, in comp time (the API moves keys in comp time).
      const moving = new Set(group.map((m) => `${m.nodeId}|${m.prop}|${m.startT}`));
      const fixedTimes = group.map((m) =>
        (trackKeys(m.nodeId, m.prop) ?? []).filter((k) => !moving.has(`${m.nodeId}|${m.prop}|${k.t}`)).map((k) => k.tAbs));
      const gesture = new GestureSession('Move Keyframe');

      const { x, y } = svgCoords(e);
      beginDrag(e, {
        kind: 'kf',
        nodeId: kf.nodeId,
        prop: kf.prop,
        kfT: kf.t,
        origValue: kf.value,
        ox: kf.tAbs * pps,
        oy: kf.y,
        px0: x,
        py0: y,
        minV: kf.minV,
        maxV: kf.maxV,
        mode,
        gesture,
        group,
        grabIndex,
        groupCurrentT: group.map((m) => m.startT),
        groupSelIds,
        // The mirror's engine ids, so the FIRST move already writes (a drag
        // whose first moves were dropped while the ids resolved lagged, then jumped).
        ...(groupKeyIds.every((id) => id !== undefined) ? { groupEids: groupKeyIds } : {}),
        collapseOnClick,
        startKeys: group.map((m) => memberKeyStart(m.nodeId, m.prop, m.startT)),
        fixedTimes,
      });
      // The engine ids of the moving keys (stamped first if a pre-API writer
      // left them unnamed — resolveKeysForGesture).
      void resolveKeysForGesture(gesture, group.map((m, i) => ({ id: String(i), nodeId: m.nodeId, prop: m.prop, t: m.startT }))).then((ids) => {
        const d = dragRef.current;
        if (!ids || !d || d.gesture !== gesture) return;
        d.groupEids = group.map((_m, i) => ids.get(String(i)));
      });
    },
    [svgCoords, beginDrag, pps, mode, selectedKfIds, setSelectedKfIds, sampledPaths],
  );

  // ── Transform box (AE's Graph Editor "Show Transform Box") ──────
  // Two or more selected keys in the value graph get a box; dragging an edge
  // scales their times (from the opposite edge) and/or values (in screen
  // space, from the opposite edge). One engine gesture, absolute per move.
  const onBoxHandlePointerDown = useCallback(
    (e: React.PointerEvent<SVGElement>, edgeX: 'l' | 'r' | null, edgeY: 't' | 'b' | null, box: { x0: number; x1: number; y0: number; y1: number }) => {
      if (e.button !== 0) return;
      const group: GraphGroupMemberStart[] = [];
      const groupSelIds: string[] = [];
      const groupY0: number[] = [];
      const groupKeyIds: Array<string | undefined> = [];
      for (const p of sampledPaths) {
        for (const k of p.keyframes) {
          if (!selectedKfIds.has(k.selId)) continue;
          group.push({ nodeId: k.nodeId, prop: k.prop, startT: k.t, startCompT: k.tAbs, startValue: k.value, minV: k.minV, maxV: k.maxV });
          groupSelIds.push(k.selId);
          groupY0.push(k.y);
          groupKeyIds.push(k.keyId.startsWith('@') ? undefined : k.keyId);
        }
      }
      if (group.length < 2) return;
      const moving = new Set(group.map((m) => `${m.nodeId}|${m.prop}|${m.startT}`));
      const fixedTimes = group.map((m) =>
        (trackKeys(m.nodeId, m.prop) ?? []).filter((k) => !moving.has(`${m.nodeId}|${m.prop}|${k.t}`)).map((k) => k.tAbs));
      const gesture = new GestureSession('Scale Keyframes');
      const { x, y } = svgCoords(e);
      const first = group[0]!;
      beginDrag(e, {
        kind: 'box-transform',
        nodeId: first.nodeId,
        prop: first.prop,
        kfT: first.startT,
        origValue: first.startValue,
        ox: x,
        oy: y,
        px0: x,
        py0: y,
        minV: first.minV,
        maxV: first.maxV,
        mode,
        gesture,
        group,
        grabIndex: 0,
        groupCurrentT: group.map((m) => m.startT),
        groupSelIds,
        groupY0,
        ...(groupKeyIds.every((id) => id !== undefined) ? { groupEids: groupKeyIds } : {}),
        startKeys: group.map((m) => memberKeyStart(m.nodeId, m.prop, m.startT)),
        fixedTimes,
        box: { ...box, edgeX, edgeY },
      });
      void resolveKeysForGesture(gesture, group.map((m, i) => ({ id: String(i), nodeId: m.nodeId, prop: m.prop, t: m.startT }))).then((ids) => {
        const d = dragRef.current;
        if (!ids || !d || d.gesture !== gesture) return;
        d.groupEids = group.map((_m, i) => ids.get(String(i)));
      });
    },
    [sampledPaths, selectedKfIds, svgCoords, beginDrag, mode],
  );

  // Click the curve body (fat invisible stroke) → nearest keyframe on that track.
  // Does not start a drag; scrubbing stays on empty background.
  const onCurvePointerDown = useCallback(
    (e: React.PointerEvent<SVGPathElement>, nodeId: string, prop: string) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const path = sampledPaths.find((p) => p.nodeId === nodeId && p.prop === prop);
      if (!path) return;
      const { x } = svgCoords(e);
      const near = nearestKeyframeOnCurve(path.keyframes, x / pps);
      if (!near) return;
      const kf = path.keyframes.find((k) => Math.abs(k.t - near.t) < 1e-9);
      if (!kf) return;
      const id = kf.selId;
      const next = new Set(selectedKfIds);
      if (e.shiftKey) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      } else {
        next.clear();
        next.add(id);
      }
      setSelectedKfIds(next);
      setSelectedKf({ nodeId: kf.nodeId, prop: kf.prop, t: kf.t, keyId: kf.keyId });
    },
    [sampledPaths, svgCoords, pps, selectedKfIds, setSelectedKfIds],
  );

  // Start dragging a Bézier handle. `hx/hy` = the handle's current svg position.
  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<SVGElement>, kf: KfPoint, which: 'handle-in' | 'handle-out', hx: number, hy: number) => {
      if (e.button !== 0) return;
      const { x, y } = svgCoords(e);
      // One engine gesture; on one dimension of a vector the handles are that
      // dimension's ease (`KeyframePatch.dim`).
      const gesture = new GestureSession('Edit Curve');
      // The keys a handle drag can touch: this one and its two neighbours.
      const kfs = trackKeys(kf.nodeId, kf.prop) ?? [];
      const i = findKfIndex(kfs, kf.t);
      const near = [kfs[i - 1], kfs[i], kfs[i + 1]].filter((k): k is NonNullable<typeof k> => !!k);
      const mirrorIds = near.every((k) => !k.key.id.startsWith('@')) ? new Map(near.map((k) => [k.t, k.key.id])) : undefined;
      void memberKeyPatches(kf.nodeId, kf.prop, near.map((k) => ({ t: k.t }))).then((patches) => {
        const d = dragRef.current;
        if (!patches || !d || d.gesture !== gesture) return;
        d.keyIds = new Map(near.map((k, n) => [k.t, patches[n]!.id]));
      });
      beginDrag(e, {
        kind: which,
        nodeId: kf.nodeId,
        prop: kf.prop,
        kfT: kf.t,
        keyId: kf.keyId,
        ...(mirrorIds ? { keyIds: mirrorIds } : {}),
        origValue: kf.value,
        ox: hx,
        oy: hy,
        px0: x,
        py0: y,
        minV: kf.minV,
        maxV: kf.maxV,
        mode,
        gesture,
      });
    },
    [svgCoords, beginDrag, mode],
  );

  // Background: Alt-drag box-zooms; plain click-drag scrubs the playhead;
  // a middle drag pans both axes (the diamonds, handles and curves let a
  // middle press through, so it works from anywhere on the canvas).
  const onSvgPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (e.button === 1) {
        const { x, y } = svgCoords(e);
        beginDrag(e, {
          kind: 'pan',
          nodeId: '',
          prop: '',
          kfT: 0,
          origValue: 0,
          ox: x,
          oy: y,
          px0: x,
          py0: y,
          minV: 0,
          maxV: 1,
          mode,
          lastClientX: e.clientX,
          lastClientY: e.clientY,
        });
        return;
      }
      if (e.button !== 0) return;
      const { x, y } = svgCoords(e);
      // Shift on empty space is a SELECTION box, not a scrub. Shift already
      // means "add to the selection" on a diamond, so extending it to the
      // background is the reading people arrive at without being told; and the
      // gesture it displaces (shift-scrub) never had a meaning.
      if (e.shiftKey) {
        setBoxSelect({ x0: x, y0: y, x1: x, y1: y });
        beginDrag(e, {
          kind: 'box-select',
          nodeId: '',
          prop: '',
          kfT: 0,
          origValue: 0,
          ox: x,
          oy: y,
          px0: x,
          py0: y,
          minV: 0,
          maxV: 1,
          mode,
          boxX: x,
          boxY: y,
        });
        return;
      }
      if (e.altKey && onZoom) {
        setBoxZoom({ x0: x, y0: y, x1: x, y1: y });
        beginDrag(e, {
          kind: 'box-zoom',
          nodeId: '',
          prop: '',
          kfT: 0,
          origValue: 0,
          ox: x,
          oy: y,
          px0: x,
          py0: y,
          minV: 0,
          maxV: 1,
          mode,
          boxX: x,
          boxY: y,
        });
        return;
      }
      if (!onScrub) return;
      onScrub(clamp(x / pps, 0, duration));
      beginDrag(e, {
        kind: 'scrub',
        nodeId: '',
        prop: '',
        kfT: 0,
        origValue: 0,
        ox: x,
        oy: y,
        px0: x,
        py0: y,
        minV: 0,
        maxV: 1,
        mode,
      });
    },
    [onScrub, onZoom, svgCoords, pps, duration, beginDrag, mode],
  );

  // ── Drag: keyframe diamond ────────────────────────────────────
  // One engine gesture (opened in onKfPointerDown). Every move sends each
  // moving key's ABSOLUTE comp time and whole value; a key may pass the keys
  // that do not move with it (they reorder, as in AE) but never lands on one
  // (`avoidFixedKeys` — the API moves keys in comp time, quantized to frames
  // inside a clip, so a sub-frame gap could land it ON a neighbour, which
  // would replace it). The focused key
  // follows the keys by their engine ids once the move landed; the selection
  // names engine keys, so it follows by itself (a stamped key excepted).
  const relocateKeys = useCallback((d: DragState) => {
    if (!d.group || !d.groupEids || !d.groupCurrentT) return;
    for (let i = 0; i < d.group.length; i++) {
      const m = d.group[i]!;
      const eid = d.groupEids[i];
      const sel = d.groupSelIds?.[i];
      if (eid && sel) {
        const now = trackSelectionId(documentMirror(), m.nodeId, m.prop, eid);
        rewriteSelectedKeyframeId(sel, now);
        d.groupSelIds![i] = now;
      }
      const t = eid ? keyTimeById(m.nodeId, m.prop, eid) : null;
      const from = d.groupCurrentT[i]!;
      if (t === null || t === from) continue;
      d.groupCurrentT[i] = t;
      if (i === d.grabIndex) {
        d.kfT = t;
        setSelectedKf({ nodeId: m.nodeId, prop: m.prop, t, ...(eid ? { keyId: eid } : {}) });
      }
    }
  }, []);

  const moveKeyframe = useCallback(
    (d: DragState, ex: number, ey: number, e: React.PointerEvent) => {
      if (!d.group || !d.groupCurrentT || d.grabIndex === undefined) return;
      const frameDur = frameRate > 0 ? 1 / frameRate : 0;
      const rawComp = clamp((d.ox + ex) / pps, 0, duration);
      const range = Math.max(1e-9, d.maxV - d.minV);
      const pixelsPerUnit = INNER_H / range;
      const group = d.group;
      const moving = new Set(group.map((m, i) => posKey(m.nodeId, m.prop, d.groupCurrentT![i]!)));
      const movingIds = new Set((d.groupEids ?? []).filter((id): id is string => !!id));
      // Snapping follows the timeline's toggle (Alt inverts it), as the lanes do.
      const snapOff = !snapForDrag(isTimelineSnapOn(), e.altKey);

      // Values worth snapping to: the grabbed key's OWN track (another track's
      // values are in other units), never a key that moves with the drag — the
      // dragged key's last written value counted as a target, so the drag stuck
      // to where it had just been and the guide blinked on every move.
      const grabM = group[d.grabIndex]!;
      const collectOtherValues = (): number[] => {
        const vals: number[] = [];
        for (const p of sampledPaths) {
          if (p.nodeId !== grabM.nodeId || p.prop !== grabM.prop) continue;
          for (const k of p.keyframes) {
            if (movingIds.has(k.keyId) || moving.has(posKey(p.nodeId, p.prop, k.t))) continue;
            vals.push(k.value);
          }
        }
        return vals;
      };

      let compTimes: number[];
      let values: Array<number | undefined>;
      let timeTarget: SnapTarget | null;
      let valueSnap: ValueSnapTarget | null = null;
      if (group.length > 1) {
        // Multi-select body: every selected diamond by the same time (and
        // value) delta.
        const otherTimes: number[] = [];
        for (const p of sampledPaths) {
          for (const k of p.keyframes) {
            if (!moving.has(posKey(p.nodeId, p.prop, k.t))) otherTimes.push(k.tAbs);
          }
        }
        const plan = planGraphGroupTimes({
          members: group,
          grabIndex: d.grabIndex,
          rawGrabCompT: rawComp,
          duration,
          pixelsPerSecond: pps,
          frameDuration: frameDur,
          playheadTime: currentTime,
          otherCompTimes: otherTimes,
          disableSnap: snapOff,
        });
        timeTarget = plan.snapTarget;
        compTimes = plan.compTimes.map((t, i) => avoidFixedKeys(t, d.fixedTimes?.[i], frameDur));
        const grab = group[d.grabIndex]!;
        if (d.mode === 'value') {
          const snapped = snapKeyframeValue(yToValue(d.oy + ey, d.minV, d.maxV, INNER_H), {
            pixelsPerUnit,
            keyframeValues: collectOtherValues(),
            disabled: snapOff,
          });
          valueSnap = snapped.target;
          values = group.map((m) => applyGroupValueDelta(m, grab, snapped.value));
        } else {
          values = group.map((m) => m.startValue);
        }
      } else {
        // One diamond: snapped to the playhead / other curves' keys / frames.
        const m = group[0]!;
        const otherTimes: number[] = [];
        for (const p of sampledPaths) {
          if (p.nodeId === m.nodeId && p.prop === m.prop) continue;
          for (const k of p.keyframes) otherTimes.push(k.tAbs);
        }
        const timeSnap = snapKeyframeTime(rawComp, {
          pixelsPerSecond: pps,
          frameDuration: frameDur,
          playheadTime: currentTime,
          keyframeTimes: otherTimes,
          disabled: snapOff,
        });
        timeTarget = timeSnap.target;
        compTimes = [avoidFixedKeys(clamp(timeSnap.time, 0, duration), d.fixedTimes?.[0], frameDur)];
        if (d.mode === 'value') {
          const snapped = snapKeyframeValue(yToValue(d.oy + ey, d.minV, d.maxV, INNER_H), {
            pixelsPerUnit,
            keyframeValues: collectOtherValues(),
            disabled: snapOff,
          });
          valueSnap = snapped.target;
          values = [snapped.value];
        } else {
          values = [m.startValue];
        }
      }

      setGraphSnap({
        time: timeTarget?.kind === 'frame' ? null : timeTarget,
        value: valueSnap,
        minV: d.minV,
        maxV: d.maxV,
      });

      if (!d.gesture || !d.groupEids || !d.startKeys) return;
      // One patch per engine key: two member rows of one key (X and Y diamonds
      // of a Position key) are ONE key — their values combine.
      const byId = new Map<string, { time: number; start: MemberKeyStart; rep: Map<number, number> }>();
      group.forEach((_m, i) => {
        const eid = d.groupEids![i];
        const start = d.startKeys![i];
        if (!eid || !start) return;
        const x = byId.get(eid) ?? { time: compTimes[i]!, start, rep: new Map<number, number>() };
        const v = values[i];
        if (v !== undefined) x.rep.set(start.index, v);
        byId.set(eid, x);
      });
      const patches: KeyframePatch[] = [...byId].map(([id, x]) => ({
        id, time: compTime(x.time), value: memberKeyValue(x.start, x.rep), spatialIn: [], spatialOut: [],
      }));
      if (d.mode === 'speed') {
        // The grabbed key's speed, both sides (linked), on its own dimension.
        const g = group[d.grabIndex]!;
        const speed = Math.max(0, yToValue(d.oy + ey, d.minV, d.maxV, INNER_H));
        const liveT = d.groupCurrentT[d.grabIndex]!;
        const kfs = trackKeys(g.nodeId, g.prop) ?? [];
        for (const w of speedWrites(g.nodeId, g.prop, liveT, speed, 'linked')) {
          const id = kfs.find((k) => k.t === w.t)?.key.id;
          if (id) patches.push({ id, ...memberPatchFields(g.nodeId, g.prop, toMemberKeyWrite(w)), spatialIn: [], spatialOut: [] });
        }
      }
      if (patches.length === 0) return;
      d.gesture.send({ type: 'updateKeyframes', patches });
      void engineIdle().then(() => relocateKeys(d));
    },
    [pps, duration, INNER_H, frameRate, currentTime, sampledPaths, relocateKeys],
  );

  // ── Drag: transform box ───────────────────────────────────────
  const moveBoxTransform = useCallback(
    (d: DragState, x: number, y: number) => {
      const b = d.box;
      if (!b || !d.group || !d.gesture || !d.groupEids || !d.startKeys || !d.groupY0) return;
      const frameDur = frameRate > 0 ? 1 / frameRate : 0;
      // Scale factors from the opposite edge; never flipped or collapsed (keys
      // would cross or land on one another and replace each other).
      const factor = (pos: number, edge: number, anchor: number): number =>
        Math.abs(edge - anchor) < 1 ? 1 : Math.max(0.02, (pos - anchor) / (edge - anchor));
      const anchorX = b.edgeX === 'l' ? b.x1 : b.x0;
      const anchorY = b.edgeY === 't' ? b.y1 : b.y0;
      const sx = b.edgeX ? factor(x, b.edgeX === 'l' ? b.x0 : b.x1, anchorX) : 1;
      const sy = b.edgeY ? factor(y, b.edgeY === 't' ? b.y0 : b.y1, anchorY) : 1;
      const byId = new Map<string, { time: number; start: MemberKeyStart; rep: Map<number, number> }>();
      d.group.forEach((m, i) => {
        const eid = d.groupEids![i];
        const start = d.startKeys![i];
        if (!eid || !start) return;
        const compT = avoidFixedKeys(clamp((anchorX + (m.startCompT * pps - anchorX) * sx) / pps, 0, duration), d.fixedTimes?.[i], frameDur);
        const value = sy === 1 ? m.startValue : yToValue(anchorY + (d.groupY0![i]! - anchorY) * sy, m.minV, m.maxV, INNER_H);
        const entry = byId.get(eid) ?? { time: compT, start, rep: new Map<number, number>() };
        entry.rep.set(start.index, value);
        byId.set(eid, entry);
      });
      const patches: KeyframePatch[] = [...byId].map(([id, e]) => ({
        id, time: compTime(e.time), value: memberKeyValue(e.start, e.rep), spatialIn: [], spatialOut: [],
      }));
      if (patches.length === 0) return;
      d.gesture.send({ type: 'updateKeyframes', patches });
      void engineIdle().then(() => relocateKeys(d));
    },
    [frameRate, pps, duration, INNER_H, relocateKeys],
  );

  // ── Drag: Bézier handle ───────────────────────────────────────
  const moveHandle = useCallback(
    (d: DragState, ex: number, ey: number, e: React.PointerEvent) => {
      const kfs = trackKeys(d.nodeId, d.prop);
      if (!kfs) return;
      // By engine id first: the key's stored time is stale for a moment after
      // every write, and a move found no key then — the handle stuttered.
      const byId = d.keyId ? kfs.findIndex((k) => k.key.id === d.keyId) : -1;
      const selfIdx = byId >= 0 ? byId : findKfIndex(kfs, d.kfT);
      if (selfIdx < 0) return;
      const selfKf = kfs[selfIdx]!;

      const writes: MemberWrite[] = [];
      // Alt breaks the link for this keyframe (AE: Alt/Option-drag a handle).
      if (e.altKey && selfKf.continuous !== false) {
        writes.push({ t: selfKf.t, continuous: false });
      }
      const linked = selfKf.continuous !== false && !e.altKey;

      const hx = d.ox + ex;
      const hy = d.oy + ey;
      const selfTComp = selfKf.tAbs;

      if (d.kind === 'handle-out') {
        const nextKf = kfs[selfIdx + 1];
        if (!nextKf) return;
        const prevKf = selfIdx > 0 ? kfs[selfIdx - 1] : null;
        const dt = nextKf.t - selfKf.t;
        const dv = nextKf.value - selfKf.value;

        // Influence is a FRACTION of the segment — measured in comp pixels so it
        // stays continuous (compToKeyframeTime snaps to the frame grid).
        const segPx = (nextKf.tAbs - selfTComp) * pps;
        const curBz = segmentBezierOf(kfs, selfIdx);
        // Never past the segment's incoming handle: x1 > x2 folds the curve
        // back on itself and the sampler returns garbage (jumps, reversals).
        const influence = segPx <= 0 ? 1 / 3 : clamp((hx - selfTComp * pps) / segPx, MIN_INFLUENCE, Math.min(MAX_INFLUENCE, curBz[2] - 0.01));

        // A FLAT segment (dv = 0) has no normalised y: its speed is 0 whatever
        // the handle does, so the drag edits INFLUENCE only (AE stores speed +
        // influence per side, and a flat side's influence still matters when
        // the segment is un-flattened or the graph shows speed). The stored y
        // is kept, and the linked neighbour is left alone — a slope of 0 read
        // off a flat segment is the representation, not the user's intent.
        const flat = dv === 0;
        if (d.mode === 'value') {
          const vHover = yToValue(hy, d.minV, d.maxV, INNER_H);
          const y1 = flat ? curBz[1] : clamp((vHover - selfKf.value) / dv, MIN_HANDLE_Y, MAX_HANDLE_Y);
          const bz: Bezier = [influence, y1, curBz[2], curBz[3]];
          writes.push(bezierWrite(selfKf, bz, linked));
          if (linked && !flat && prevKf && !isHoldEasing(prevKf.easing)) {
            const slope = outgoingSlope(bz, dv, dt);
            const prevBz = withIncomingSlope(segmentBezierOf(kfs, selfIdx - 1), selfKf.value - prevKf.value, selfKf.t - prevKf.t, slope);
            writes.push(bezierWrite(prevKf, prevBz, prevKf.continuous));
          }
        } else {
          const speed = Math.max(0, yToValue(hy, d.minV, d.maxV, INNER_H));
          const bz = withOutgoingSpeed([influence, curBz[1], curBz[2], curBz[3]], dv, dt, speed);
          writes.push(bezierWrite(selfKf, bz, linked));
          if (linked && !flat && prevKf && !isHoldEasing(prevKf.easing)) {
            const prevBz = withIncomingSpeed(segmentBezierOf(kfs, selfIdx - 1), selfKf.value - prevKf.value, selfKf.t - prevKf.t, speed);
            writes.push(bezierWrite(prevKf, prevBz, prevKf.continuous));
          }
        }
      } else if (d.kind === 'handle-in') {
        const prevKf = kfs[selfIdx - 1];
        if (!prevKf) return;
        const nextKf = selfIdx < kfs.length - 1 ? kfs[selfIdx + 1] : null;
        const dtPrev = selfKf.t - prevKf.t;
        const dvPrev = selfKf.value - prevKf.value;

        const segPx = (selfTComp - prevKf.tAbs) * pps;
        const prevBz = segmentBezierOf(kfs, selfIdx - 1);
        // 1 − influence is the segment's x2: never behind its outgoing handle x1.
        const influence = segPx <= 0 ? 1 / 3 : clamp((selfTComp * pps - hx) / segPx, MIN_INFLUENCE, Math.min(MAX_INFLUENCE, 1 - prevBz[0] - 0.01));

        // Flat arriving segment: influence only, neighbour untouched (see the out handle).
        const flat = dvPrev === 0;
        if (d.mode === 'value') {
          const vHover = yToValue(hy, d.minV, d.maxV, INNER_H);
          const y2 = flat
            ? prevBz[3]
            : clamp(1 - (selfKf.value - vHover) / dvPrev, 1 - MAX_HANDLE_Y, 1 - MIN_HANDLE_Y);
          const bz: Bezier = [prevBz[0], prevBz[1], 1 - influence, y2];
          writes.push(bezierWrite(prevKf, bz, prevKf.continuous));
          if (linked && !flat && nextKf && !isHoldEasing(selfKf.easing)) {
            const slope = incomingSlope(bz, dvPrev, dtPrev);
            const curBz = withOutgoingSlope(segmentBezierOf(kfs, selfIdx), nextKf.value - selfKf.value, nextKf.t - selfKf.t, slope);
            writes.push(bezierWrite(selfKf, curBz, true));
          }
        } else {
          const speed = Math.max(0, yToValue(hy, d.minV, d.maxV, INNER_H));
          const bz = withIncomingSpeed([prevBz[0], prevBz[1], 1 - influence, prevBz[3]], dvPrev, dtPrev, speed);
          writes.push(bezierWrite(prevKf, bz, prevKf.continuous));
          if (linked && !flat && nextKf && !isHoldEasing(selfKf.easing)) {
            const curBz = withOutgoingSpeed(segmentBezierOf(kfs, selfIdx), nextKf.value - selfKf.value, nextKf.t - selfKf.t, speed);
            writes.push(bezierWrite(selfKf, curBz, true));
          }
        }
      }
      sendHandleWrites(d, writes);
    },
    [pps, INNER_H],
  );

  const onSvgPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const d = dragRef.current;
      // ── The hover read-out ──────────────────────────────────────
      // Only while nothing is being dragged: a drag has its own numbers, and
      // a second chip following the pointer through one would be noise.
      if (!d) {
        // One read-out per animation frame: every pointer move re-rendered the
        // whole editor otherwise.
        const { x: hx, y: hy } = svgCoords(e);
        hoverPendingRef.current = { hx, hy };
        if (!hoverRafRef.current) {
          hoverRafRef.current = requestAnimationFrame(() => {
            hoverRafRef.current = 0;
            const p = hoverPendingRef.current;
            if (!p || dragRef.current) return;
            const reading = nearestCurveAt(sampledPaths, p.hx / pps, p.hy, INNER_H);
            setHover(
              reading
                ? {
                  x: p.hx,
                  y: reading.y,
                  color: reading.color,
                  label: (() => {
                    const shown = displayOf(reading.nodeId, reading.prop, mode);
                    return `${reading.prop} ${fmtAxis(reading.value * shown.factor)}${shown.unit} @ ${(p.hx / pps).toFixed(2)}s`;
                  })(),
                }
                : null,
            );
          });
        }
      }
      if (!d || e.pointerId !== d.pointerId) return;
      const { x, y } = svgCoords(e);
      let ex = x - d.px0;
      let ey = y - d.py0;

      if (d.kind === 'pan') {
        // Client deltas: the svg scrolls under the pointer as it pans.
        const dx = e.clientX - (d.lastClientX ?? e.clientX);
        const dy = e.clientY - (d.lastClientY ?? e.clientY);
        d.lastClientX = e.clientX;
        d.lastClientY = e.clientY;
        const el = canvasRef.current;
        if (el && dx !== 0) el.scrollLeft -= dx;
        if (dy !== 0) panValueAxis(dy);
        return;
      }

      if (d.kind === 'scrub') {
        onScrub?.(clamp(x / pps, 0, duration));
        return;
      }

      if (d.kind === 'box-zoom' || d.kind === 'box-select') {
        if (!d.moved && Math.hypot(ex, ey) < DRAG_DEAD_ZONE_PX) return;
        d.moved = true;
        d.boxX = x;
        d.boxY = y;
        const rect = { x0: d.ox, y0: d.oy, x1: x, y1: y };
        if (d.kind === 'box-zoom') setBoxZoom(rect);
        else {
          setBoxSelect(rect);
          // Live, not on release: the selection ring appearing as the box
          // crosses each diamond is what tells you the box is the right shape
          // before you let go.
          setSelectedKfIds(boxSelectIds(rect));
        }
        return;
      }

      if (!d.moved && Math.hypot(ex, ey) < DRAG_DEAD_ZONE_PX) return;
      d.moved = true;

      if (d.kind === 'box-transform') {
        moveBoxTransform(d, x, y);
        return;
      }

      // Shift constrains the drag.
      //
      // A KEYFRAME takes the dominant axis: it is a point in two dimensions and
      // "which of the two did I mean" is genuinely the question.
      //
      // A TANGENT HANDLE is constrained HORIZONTALLY, always. Its two axes are
      // not symmetrical: x is influence (how far into the segment the ease
      // reaches) and y is the slope. Adjusting influence while holding the
      // slope is a gesture people use constantly; the vertical-only version is
      // not, because moving a handle straight up ALSO changes the influence
      // implicitly through the curve it produces. Letting Shift pick the
      // dominant axis here meant a careful horizontal drag that strayed two
      // pixels up silently flipped to a slope edit.
      if (e.shiftKey) {
        if (d.kind === 'kf') {
          if (Math.abs(ex) >= Math.abs(ey)) ey = 0;
          else ex = 0;
        } else {
          ey = 0;
        }
      }

      if (d.kind === 'kf') moveKeyframe(d, ex, ey, e);
      else moveHandle(d, ex, ey, e);
    },
    [svgCoords, onScrub, pps, duration, moveKeyframe, moveHandle, moveBoxTransform, panValueAxis, sampledPaths, INNER_H, mode, boxSelectIds],
  );

  const onSvgPointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      endDrag();
    },
    [endDrag],
  );

  // Belt and braces: a drag must never outlive its pointer.
  useEffect(() => {
    if (!dragging) return;
    const up = () => endDrag();
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', up);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', up);
    };
  }, [dragging, endDrag]);

  const playheadX = currentTime * pps;

  // ── Find selected keyframe for handle rendering ───────────────
  // By the engine key's id first (stable across a drag), by stored time otherwise.
  const selectedKfData = selectedKf
    ? (() => {
      const own = sampledPaths.filter((p) => p.nodeId === selectedKf.nodeId && p.prop === selectedKf.prop).flatMap((p) => p.keyframes);
      return (selectedKf.keyId ? own.find((kf) => kf.keyId === selectedKf.keyId) : undefined)
        ?? own.find((kf) => Math.abs(kf.t - selectedKf.t) < 1e-6)
        ?? null;
    })()
    : null;

  const handleApplyPreset = useCallback((preset: EasingPreset) => {
    const ids = easingTargetKeyframes();
    if (ids.length > 0) void easePresetOnKeys(ids, preset);
  }, []);

  // ── Keyframe-level tools (were the Motion panel's) ────────────
  /**
   * What the ease tools write to: the shared keyframe selection, falling back
   * to the focused diamond. The fallback matters — clicking a curve BODY
   * focuses a keyframe without necessarily leaving it in the multi-selection,
   * and a toolbar that then silently did nothing is the bug these buttons had
   * in the panel (where they only ever touched one keyframe, no matter how
   * many you had selected).
   */
  const focusedSelId = selectedKfData?.selId;
  const targetKfIds = useMemo(() => {
    const ids = [...selectedKfIds];
    if (ids.length > 0) return ids;
    return focusedSelId ? [focusedSelId] : [];
  }, [selectedKfIds, focusedSelId]);

  const copyEase = useEaseClipboardStore((s) => s.copyEase);
  const pasteEase = useEaseClipboardStore((s) => s.pasteEase);
  const hasCopiedEase = useEaseClipboardStore((s) => s.copied);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const libraryRef = useRef<HTMLDivElement | null>(null);

  const applyKind = useCallback(
    (kind: EasingKind) => {
      void easeKindOnKeys(targetKfIds, kind);
    },
    [targetKfIds],
  );

  /**
   * Rove across time: the keyframe keeps its VALUE and gives up its TIME, which
   * the engine re-solves for constant speed between the anchors either side.
   *
   * Roving MOVES the keyframe. The selection names engine keys, so it follows
   * them; the focused key (a stored time) is moved to the key's new time, read
   * back by its engine id, exactly as a drag does.
   */
  const toggleRoving = useCallback(() => {
    if (targetKfIds.length === 0) return;
    const next = !selectedKfData?.roving;
    // Ends have nothing to rove between; skipping them is why a whole-track
    // selection can be roved in one click.
    const m = documentMirror();
    const inner = targetKfIds.filter((id) => {
      const hit = resolveSelectionKey(m, id);
      return !!hit && hit.index > 0 && hit.index < hit.keys.length - 1;
    });
    if (inner.length === 0) return;
    void (async () => {
      const ids = await resolveKeyIds(inner);
      if (!ids) return;
      // The engine re-times the roving run (updateKeyframes{roving}); the
      // selection follows each key by its engine id.
      const focused = selectedKfData ? { selId: selectedKfData.selId, nodeId: selectedKfData.nodeId, prop: selectedKfData.prop } : null;
      await setRovingOnKeys(inner, next);
      const eid = focused ? ids.get(focused.selId) : undefined;
      if (!focused || !eid) return;
      const t = keyTimeById(focused.nodeId, focused.prop, eid);
      if (t === null) return;
      setSelectedKf((cur) => (cur && cur.nodeId === focused.nodeId && cur.prop === focused.prop ? { ...cur, t, keyId: eid } : cur));
    })();
  }, [targetKfIds, selectedKfData]);

  // Deselecting takes the whole tool group away with it, so the popover must
  // not still be "open" when the next keyframe is picked — it would appear
  // unasked, over a curve, from a click two minutes ago.
  const hasFocusedKf = !!selectedKf;
  useEffect(() => {
    if (!hasFocusedKf) setLibraryOpen(false);
  }, [hasFocusedKf]);

  // Escape closes the library popover; so does a click anywhere outside it.
  useEffect(() => {
    if (!libraryOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setLibraryOpen(false);
    };
    const onDown = (e: PointerEvent): void => {
      const el = libraryRef.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) setLibraryOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [libraryOpen]);

  // Which quick-ease pill matches the selected keyframe's ACTUAL easing, so
  // the applied one lights up (`iconBtnActive` existed in the CSS unused —
  // the pills never showed state, which read as "did that click work?").
  const bezierEq = (a?: readonly number[], b?: readonly number[]): boolean =>
    !!a && !!b && a.length === 4 && b.length === 4 &&
    a.every((v, i) => Math.abs(v - b[i]!) < 1e-6);
  const activePreset: EasingPreset | null = !selectedKfData
    ? null
    : isHoldEasing(selectedKfData.easing) ? 'Hold'
    : selectedKfData.easing === 'bezier' && bezierEq(selectedKfData.bezier, EASY_EASE_BEZIER) ? 'Ease'
    : selectedKfData.easing === 'bezier' && bezierEq(selectedKfData.bezier, EASY_EASE_IN_BEZIER) ? 'EaseIn'
    : selectedKfData.easing === 'bezier' && bezierEq(selectedKfData.bezier, EASY_EASE_OUT_BEZIER) ? 'EaseOut'
    : !selectedKfData.easing || selectedKfData.easing === 'linear' ? 'Linear'
    : null;
  const pillClass = (preset: EasingPreset): string | undefined =>
    activePreset === preset ? styles.iconBtnActive : styles.iconBtn;

  // Axis labels follow the selected track (or the first one).
  const axisTrack = selectedKfData
    ? sampledPaths.find((p) => p.nodeId === selectedKfData.nodeId && p.prop === selectedKfData.prop)
    : sampledPaths[0];
  const axisShown = axisTrack ? displayOf(axisTrack.nodeId, axisTrack.prop, mode) : null;
  const axisValues = axisTrack && axisShown
    ? valueTicks(axisTrack.minV * axisShown.factor, axisTrack.maxV * axisShown.factor, INNER_H)
    : [];

  // ── Handle geometry for the selected keyframe ─────────────────
  const handleGeom = useMemo(() => {
    if (!selectedKfData) return null;
    const path = sampledPaths.find((p) => p.nodeId === selectedKfData.nodeId && p.prop === selectedKfData.prop);
    if (!path) return null;
    const kf = selectedKfData;
    const i = kf.index;
    const prevKf = i > 0 ? path.keyframes[i - 1] : null;
    const nextKf = i < path.keyframes.length - 1 ? path.keyframes[i + 1] : null;
    const kx = kf.tAbs * pps;
    const ky = kf.y;

    const showIn = !!prevKf && !isHoldEasing(prevKf.easing);
    const showOut = !!nextKf && !isHoldEasing(kf.easing);

    let inX = kx, inY = ky, inAnchorY = ky;
    let outX = kx, outY = ky;

    if (showIn && prevKf) {
      const prevBz = segmentBezierOf(path.keyframes, i - 1);
      const dtPrev = kf.t - prevKf.t;
      const dvPrev = kf.value - prevKf.value;
      inX = kx - (kx - prevKf.tAbs * pps) * (1 - prevBz[2]);
      if (mode === 'value') {
        inY = valueToY(kf.value - dvPrev * (1 - prevBz[3]), kf.minV, kf.maxV, INNER_H);
      } else {
        const inSpd = incomingSpeed(prevBz, dvPrev, dtPrev);
        inY = valueToY(inSpd, kf.minV, kf.maxV, INNER_H);
        inAnchorY = inY; // the in-handle hangs off the INCOMING speed point
      }
    }
    if (showOut && nextKf) {
      const bz = segmentBezierOf(path.keyframes, i);
      const dt = nextKf.t - kf.t;
      const dv = nextKf.value - kf.value;
      outX = kx + (nextKf.tAbs * pps - kx) * bz[0];
      outY = mode === 'value'
        ? valueToY(kf.value + dv * bz[1], kf.minV, kf.maxV, INNER_H)
        : valueToY(outgoingSpeed(bz, dv, dt), kf.minV, kf.maxV, INNER_H);
    }
    return { kf, color: path.color, kx, ky, showIn, showOut, inX, inY, inAnchorY, outX, outY };
  }, [selectedKfData, sampledPaths, pps, mode, INNER_H]);

  // Refreshed on every render; read only by the box-select (see the ref above).
  handleGeomRef.current = handleGeom
    ? [
      ...(handleGeom.showIn
        ? [{ nodeId: handleGeom.kf.nodeId, prop: handleGeom.kf.prop, t: handleGeom.kf.t, x: handleGeom.inX, y: handleGeom.inY }]
        : []),
      ...(handleGeom.showOut
        ? [{ nodeId: handleGeom.kf.nodeId, prop: handleGeom.kf.prop, t: handleGeom.kf.t, x: handleGeom.outX, y: handleGeom.outY }]
        : []),
    ]
    : [];

  // ── "Fit all curves vertically" ────────────────────────────────
  // The command broadcasts; the editor answers by dropping the range frozen by
  // the last drag and bumping the tick the sampling memo watches. Registered
  // here rather than in a provider so the command and its only listener are
  // installed together — a command in the palette whose handler is not mounted
  // is the failure this codebase keeps finding.
  useEffect(() => {
    installGraphNormalizeCommands();
    return onGraphNormalize(() => {
      frozenRangesRef.current = null;
      manualRangesRef.current = new Map();
      setRefitTick((n) => n + 1);
    });
  }, []);

  const cursorClass = dragging
    ? dragRef.current?.kind === 'scrub'
      ? styles.svgScrubbing
      : dragRef.current?.kind === 'box-zoom' || dragRef.current?.kind === 'box-select'
        ? styles.svgBoxZoom
        : styles.svgDragging
    : '';

  const showDenseLabels = pps >= LABEL_PPS;
  const visT0 = Math.max(0, (scrollLeft - 40) / pps);
  const visT1 = Math.min(duration, (scrollLeft + viewportW + 40) / pps);
  const gridTimes = timeTicks(visT0, visT1, timeStep(pps));

  const toggleSolo = useCallback((key: string, additive: boolean) => {
    setSoloKeys((prev) => {
      if (!additive) {
        // Click the only soloed track again → show all.
        if (prev && prev.size === 1 && prev.has(key)) return null;
        return new Set([key]);
      }
      const next = new Set(prev ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next.size === 0 ? null : next;
    });
  }, []);

  const tx = graphText();
  return (
    <div className={styles.root} style={propsHeight ? { height: propsHeight } : undefined} ref={containerRef}>
      {/* ── Toolbar ────────────────────────────────────────────── */}
      <div className={styles.toolbar}>
        <button
          type="button"
          className={mode === 'value' ? styles.tabActive : styles.tab}
          onClick={() => setMode('value')}
          title={tx.valueTitle}
        >
          <Icon name="graph-value" size="sm" /> {tx.value}
        </button>
        <button
          type="button"
          className={mode === 'speed' ? styles.tabActive : styles.tab}
          onClick={() => setMode('speed')}
          title={tx.speedTitle}
        >
          <Icon name="graph-speed" size="sm" /> {tx.speed}
        </button>

        {/* AE's two graph visibility modes. "Selected" answers "show me the
            row I clicked"; it falls back to the animated set when nothing is
            selected, because a blank graph is never what deselecting meant. */}
        <div className={styles.segmented} role="group" aria-label={tx.visibility}>
          <button
            type="button"
            className={visibility === 'animated' ? styles.segBtnActive : styles.segBtn}
            aria-pressed={visibility === 'animated'}
            onClick={() => setVisibility('animated')}
            title={tx.animatedTitle}
          >
            {tx.animated}
          </button>
          <button
            type="button"
            className={visibility === 'selected' ? styles.segBtnActive : styles.segBtn}
            aria-pressed={visibility === 'selected'}
            onClick={() => setVisibility('selected')}
            title={tx.selectedTitle}
          >
            {tx.selected}
          </button>
        </div>

        {mode === 'value' && (
          <button
            type="button"
            className={sharedAxis ? styles.segBtnActive : styles.segBtn}
            aria-pressed={sharedAxis}
            onClick={() => setPreference('graphSharedAxis', !sharedAxis)}
            title={tx.sharedAxisTitle}
          >
            {tx.sharedAxis}
          </button>
        )}

        <button
          type="button"
          className={referenceOn ? styles.tabActive : styles.tab}
          aria-pressed={referenceOn}
          onClick={() => setReferenceOn((v) => !v)}
          title={referenceOn ? tx.referenceOnTitle : tx.referenceOffTitle}
        >
          <Icon name="history" size="sm" /> {tx.reference}
        </button>

        {/* AE's footer pair. Fit all also drops the manual view a wheel zoom
            / pan left behind (there is no other way back to the auto-fit). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 6 }}>
          {/* The editor is hosted by panels that mount it alone (Motion panel,
              pop-outs); the tooltips need a provider, so it carries its own. */}
          <TooltipProvider>
            <IconButton size="sm" aria-label={tx.fitAll} tooltip={tx.fitAllTitle} onClick={fitAllToView}>
              <Icon name="fit" size="sm" />
            </IconButton>
            <IconButton size="sm" aria-label={tx.fitSelection} tooltip={tx.fitSelectionTitle} onClick={fitSelectionToView}>
              <Icon name="select-all" size="sm" />
            </IconButton>
          </TooltipProvider>
        </div>

        {/* Quick Ease Presets Group — aria-pressed + the active class reflect
            the selected keyframe's real easing, so the pills answer "which one
            is applied?" instead of only "which ones exist?". */}
        {selectedKfData && (
          <div className={styles.btnGroup}>
            <button type="button" className={pillClass('Ease')} aria-pressed={activePreset === 'Ease'} aria-label={tx.easyEase} onClick={() => handleApplyPreset('Ease')} title={tx.easyEaseTitle}>
              <Icon name="ease" size="sm" />
            </button>
            <button type="button" className={pillClass('EaseIn')} aria-pressed={activePreset === 'EaseIn'} aria-label={tx.easyEaseIn} onClick={() => handleApplyPreset('EaseIn')} title={tx.easyEaseInTitle}>
              <Icon name="arrow-right" size="sm" />
            </button>
            <button type="button" className={pillClass('EaseOut')} aria-pressed={activePreset === 'EaseOut'} aria-label={tx.easyEaseOut} onClick={() => handleApplyPreset('EaseOut')} title={tx.easyEaseOutTitle}>
              <Icon name="arrow-left" size="sm" />
            </button>
          </div>
        )}

        {/* Keyframe tools. These used to live in the Motion panel, applied to
            the ONE keyframe it had focused; here they take the whole keyframe
            selection, which is what the timeline and F9 already operate on. */}
        {selectedKfData && (
          <div className={styles.btnGroup}>
            {/* Interpolation KIND (Linear, Bezier, Auto / Continuous Bezier,
                Hold) — the ease pills beside it pick a named CURVE. Linear and
                Hold live only here, not as pills too. See `easingVocabulary`. */}
            <select
              className={styles.select}
              aria-label={tx.easingKind}
              title={tx.easingKindTitle}
              value={activeEasingKind(selectedKfData)}
              onChange={(e) => applyKind(e.target.value as EasingKind)}
            >
              {EASING_KINDS.map(({ kind, label }) => (
                <option key={kind} value={kind}>{label}</option>
              ))}
            </select>

            <button
              type="button"
              className={selectedKfData.roving ? styles.iconBtnActive : styles.iconBtn}
              aria-pressed={!!selectedKfData.roving}
              aria-label={tx.rove}
              disabled={!selectedKfData.canRove}
              onClick={toggleRoving}
              title={selectedKfData.canRove ? tx.roveTitle : tx.roveDisabledTitle}
            >
              <Icon name="stopwatch" size="sm" />
            </button>

            <button
              type="button"
              className={styles.iconBtn}
              aria-label={tx.copyEase}
              onClick={() => copyEase(selectedKfData.selId)}
              title={tx.copyEaseTitle}
            >
              <Icon name="copy" size="sm" />
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              aria-label={tx.pasteEase}
              disabled={!hasCopiedEase}
              onClick={() => { void pasteEase(targetKfIds); }}
              title={hasCopiedEase ? tx.pasteEaseTitle : tx.nothingCopied}
            >
              <Icon name="download" size="sm" />
            </button>

            {/* Anchor wraps the trigger AND the popover: the outside-click
                dismiss is a capturing pointerdown, so a trigger outside the
                anchor would close the popover a moment before its own click
                re-opened it — a button that could never be used to close. */}
            <div className={styles.libraryAnchor} ref={libraryRef}>
              <button
                type="button"
                className={libraryOpen ? styles.iconBtnActive : styles.iconBtn}
                aria-expanded={libraryOpen}
                aria-haspopup="dialog"
                aria-label={tx.easeLibrary}
                onClick={() => setLibraryOpen((v) => !v)}
                title={tx.easeLibraryTitle}
              >
                <Icon name="curvature" size="sm" />
              </button>
              {libraryOpen && (
                <div className={styles.popover} role="dialog" aria-label={tx.easeLibrary}>
                  <EaseLibrarySection keyframeIds={targetKfIds} bezier={selectedKfData.bezier} />
                </div>
              )}
            </div>
          </div>
        )}

        <span className={styles.spacer} />

        {selectedKfData && (
          <div className={styles.hint} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <div style={{ width: 62 }}>
              <span className={styles.fieldLabel}>t=</span>
              <ValueField
                value={selectedKfData.tAbs}
                unit="s"
                precision={2}
                min={0}
                max={duration}
                onChange={(newCompT: number) => {
                  // COMP time, as the diamond is drawn (the API moves keys in
                  // comp time; the engine maps it onto the layer's key axis).
                  const { nodeId, prop, t: oldT, selId: uiId } = selectedKfData;
                  void (async () => {
                    const ids = await resolveKeyIds([uiId]);
                    const eid = ids?.get(uiId);
                    if (!eid) return;
                    const res = await edit('Move Keyframe', { type: 'updateKeyframes', patches: [{ id: eid, time: compTime(Math.max(0, newCompT)), spatialIn: [], spatialOut: [] }] });
                    if (!res.ok) return;
                    rewriteSelectedKeyframeId(uiId, trackSelectionId(documentMirror(), nodeId, prop, eid));
                    const t = keyTimeById(nodeId, prop, eid);
                    if (t === null || t === oldT) return;
                    setSelectedKf((cur) => (cur ? { ...cur, t, keyId: eid } : null));
                  })();
                }}
              />
            </div>

            {/* Value, speeds and influences are the numeric strip under the
                graph (one set of fields, AE's Keyframe Velocity numbers);
                the toolbar keeps the key's time. */}
            {selectedKfData.easing === 'bezier' && (
              <button
                type="button"
                className={selectedKfData.continuous !== false ? styles.tabActive : styles.tab}
                style={{ padding: '2px 6px', fontSize: 'var(--font-size-micro, 10px)', display: 'inline-flex', alignItems: 'center', gap: 3 }}
                title={selectedKfData.continuous !== false ? tx.linkedTitle : tx.brokenTitle}
                onClick={() => {
                  const nextContinuous = selectedKfData.continuous === false;
                  const writes: MemberWrite[] = [{ t: selectedKfData.t, continuous: nextContinuous }];
                  if (nextContinuous) writes.push(...alignTangentsWrites(selectedKfData.nodeId, selectedKfData.prop, selectedKfData.t));
                  void commitMemberWrites(nextContinuous ? 'Link Tangents' : 'Break Tangents', selectedKfData.nodeId, selectedKfData.prop, writes);
                }}
              >
                {selectedKfData.continuous !== false ? tx.linked : tx.broken}
              </button>
            )}

            {selectedKfData.easing ? <span className={styles.easingLabel}>· {selectedKfData.easing}</span> : null}
          </div>
        )}

        {allTracks.length === 0 && (
          <span className={styles.hint}>
            {showingAllLayers ? tx.emptyAll : tx.emptySelected}
          </span>
        )}
        {/* Something IS animated but nothing is plotted — say which gate ate it,
            or the panel reads as broken. */}
        {allTracks.length > 0 && tracks.length === 0 && (
          <span className={styles.hint}>{tx.noMatch}</span>
        )}

        {!showCurveList && tracks.map(({ nodeId, prop, color }) => {
          const key = trackKey(nodeId, prop);
          const soloed = !soloKeys || soloKeys.has(key);
          return (
            <button
              key={key}
              type="button"
              className={soloed ? styles.legendItem : styles.legendItemDim}
              title={soloKeys ? tx.soloActiveTitle : tx.soloTitle}
              onClick={(e) => toggleSolo(key, e.shiftKey)}
            >
              <span className={styles.legendDot} style={{ background: color }} />
              {prop}
            </button>
          );
        })}
      </div>

      {/* ── The selected key's numbers ─────────────────────────────
          A dragged handle is an approximation of a number, and there are
          answers a drag cannot give: "make both sides exactly 200/s", "give
          this a third of the segment". AE puts these behind a modal
          (Keyframe Velocity) and that dialog still exists for the multi-key
          case — this is the same values, docked, live, for the one key you are
          looking at. Every field is a `ValueField`, so each is scrubbable and
          typeable with the same gestures as the inspector's. */}
      <div ref={stripRef}><KeyframeNumericStrip kf={selectedKfData ?? null} /></div>

      <div className={styles.plotRow}>
      {showCurveList && (
        <div className={styles.curveList} role="list" aria-label={tx.curves}>
          {tracks.length === 0 ? (
            <p className={styles.curveListNote}>{tx.curvesNote}</p>
          ) : (
            tracks.map((t, i) => {
              const key = trackKey(t.nodeId, t.prop);
              const soloed = !!soloKeys && soloKeys.has(key);
              const dimmed = !!soloKeys && !soloKeys.has(key);
              // "Position" names both of its curves; the member tells them apart.
              const member = /[/.]([a-z])$/i.exec(t.prop)?.[1]?.toUpperCase();
              return (
                <div key={key} role="listitem">
                  {(i === 0 || tracks[i - 1]?.nodeId !== t.nodeId) && (
                    <div className={styles.curveListLayer} title={t.layerName}>{t.layerName}</div>
                  )}
                  <button
                    type="button"
                    className={cn(styles.curveListRow, soloed && styles.curveListRowOn, dimmed && styles.curveListRowDim)}
                    aria-pressed={soloed}
                    title={tx.curveRowTitle}
                    onClick={(e) => toggleSolo(key, e.shiftKey)}
                  >
                    <span className={styles.curveListDot} style={{ background: t.color }} />
                    <span className={styles.curveListName}>{t.label}{member ? ` ${member}` : ''}</span>
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ── SVG graph canvas ───────────────────────────────────── */}
      <div ref={canvasRef} className={styles.canvas} onScroll={onCanvasScroll}>
        <svg
          ref={svgRef}
          className={`${styles.svg} ${cursorClass}`}
          width={graphWidth}
          height={INNER_H}
          onPointerDown={onSvgPointerDown}
          onPointerMove={onSvgPointerMove}
          onPointerUp={onSvgPointerUp}
          onPointerLeave={() => setHover(null)}
          onPointerCancel={onSvgPointerUp}
          onLostPointerCapture={onSvgPointerUp}
        >
          {/* Grid — horizontal */}
          {axisTrack && axisShown && axisValues.map((v) => {
            // On a half pixel, so a 1px line stays one pixel wide.
            const y = Math.round(valueToY(v / axisShown.factor, axisTrack.minV, axisTrack.maxV, INNER_H)) + 0.5;
            return <line key={v} className={styles.gridLine} x1={0} y1={y} x2={graphWidth} y2={y} strokeWidth={1} />;
          })}

          {/* Grid — vertical, at a step that suits the zoom */}
          {gridTimes.map((sec) => {
            const x = Math.round(sec * pps) + 0.5;
            return <line key={sec} className={styles.gridLine} x1={x} y1={0} x2={x} y2={INNER_H} strokeWidth={1} />;
          })}

          {/* Reference ghosts — behind everything live, and never hit-testable:
              the dashed curve is a memory, not something you can grab. Projected
              with the LIVE range so both curves share one y axis. */}
          {reference && sampledPaths.map(({ nodeId, prop, color, minV, maxV }) => {
            const key = trackKey(nodeId, prop);
            const ghost = reference.get(key);
            if (!ghost || ghost.points.length === 0) return null;
            const dimmed = !!soloKeys && !soloKeys.has(key);
            return (
              <path
                key={`ref-${key}`}
                className={styles.referenceCurve}
                d={polylinePath(ghost.points, pps, minV, maxV, INNER_H)}
                stroke={color}
                strokeWidth={1.5}
                fill="none"
                opacity={dimmed ? 0.08 : 0.42}
              />
            );
          })}

          {/* Curves */}
          {sampledPaths.map(({ color, d, dExt, nodeId, prop }) => {
            const dimmed = !!soloKeys && !soloKeys.has(trackKey(nodeId, prop));
            return (
              <g key={`curve-${nodeId}:${prop}`}>
                {/* Fat invisible stroke — AE-sized grab for curve-body click. */}
                <path
                  d={`${d} ${dExt}`}
                  stroke="transparent"
                  strokeWidth={12}
                  fill="none"
                  style={{ pointerEvents: dimmed ? 'none' : 'stroke', cursor: 'pointer' }}
                  onPointerDown={(e) => onCurvePointerDown(e, nodeId, prop)}
                >
                  <title>{t('timeline.graph.selectCurve', 'Select {prop} curve', { prop })}</title>
                </path>
                <path
                  className={styles.curve}
                  d={d}
                  stroke={color}
                  strokeWidth={1.5}
                  fill="none"
                  opacity={dimmed ? 0.12 : 1}
                  style={{ pointerEvents: 'none' }}
                />
                <path className={styles.curveExtension} d={dExt} stroke={color} strokeWidth={1} fill="none" opacity={dimmed ? 0.08 : 0.6} />
              </g>
            );
          })}

          {/* Keyframe diamonds (all tracks) */}
          {sampledPaths.map(({ color, keyframes, nodeId, prop }) => {
            const dimmed = !!soloKeys && !soloKeys.has(trackKey(nodeId, prop));
            const shown = displayOf(nodeId, prop, mode);
            return (
            <g key={`kfs-${nodeId}:${prop}`} opacity={dimmed ? 0.2 : 1}>
              {keyframes.map((kf) => {
                const kx = kf.tAbs * pps;
                const ky = kf.y;
                const isSelected = selectedKfIds.has(kf.selId);
                const inView = kf.tAbs >= visT0 && kf.tAbs <= visT1;
                const showLabel = inView && (isSelected || showDenseLabels);
                const hasInJump = mode === 'speed' && kf.inSpeed !== undefined && kf.outSpeed !== undefined
                  && Math.abs(kf.inSpeed - kf.outSpeed) > 1e-6;
                const inJumpY = hasInJump ? valueToY(kf.inSpeed!, kf.minV, kf.maxV, INNER_H) : ky;
                return (
                  // Keyed by INDEX: a retiming diamond keeps its element (and its hover state).
                  <g key={kf.index}>
                    {hasInJump && (
                      <>
                        <line className={styles.speedJump} x1={kx} y1={inJumpY} x2={kx} y2={ky} strokeWidth={1} />
                        <circle className={styles.speedInDot} cx={kx} cy={inJumpY} r={2.5} stroke={color} strokeWidth={1.2} />
                      </>
                    )}
                    <rect
                      className={isSelected ? styles.keyframeSelected : styles.keyframe}
                      x={Math.round(kx - KF_SIZE / 2) + 0.5}
                      y={Math.round(ky - KF_SIZE / 2) + 0.5}
                      width={KF_SIZE}
                      height={KF_SIZE}
                      strokeWidth={1}
                    />
                    {showLabel && (
                      <text
                        className={styles.kfLabel}
                        x={kx + KF_SIZE}
                        y={ky - 6}
                        fontSize={10}
                        fill={color}
                      >
                        {fmtAxis((mode === 'speed' ? kf.plotted : kf.value) * shown.factor)}{shown.unit}
                      </text>
                    )}
                    <circle
                      className={styles.kfHit}
                      cx={kx}
                      cy={ky}
                      r={HIT_RADIUS}
                      onPointerDown={(e) => onKfPointerDown(e, kf)}
                    >
                      <title>{`${kf.prop} @ ${kf.tAbs.toFixed(2)}s = ${fmtAxis(kf.value * (mode === 'speed' ? displayOf(nodeId, prop, 'value').factor : shown.factor))}`}</title>
                    </circle>
                  </g>
                );
              })}
            </g>
            );
          })}

          {transformBox && (
            <g aria-label={tx.transformBox}>
              <rect
                className={styles.transformBoxRect}
                x={transformBox.x0}
                y={transformBox.y0}
                width={transformBox.x1 - transformBox.x0}
                height={transformBox.y1 - transformBox.y0}
              />
              {BOX_HANDLES.map((h) => {
                const hx = h.edgeX === 'l' ? transformBox.x0 : h.edgeX === 'r' ? transformBox.x1 : (transformBox.x0 + transformBox.x1) / 2;
                const hy = h.edgeY === 't' ? transformBox.y0 : h.edgeY === 'b' ? transformBox.y1 : (transformBox.y0 + transformBox.y1) / 2;
                return (
                  <rect
                    key={h.id}
                    className={styles.transformBoxHandle}
                    x={hx - 4}
                    y={hy - 4}
                    width={8}
                    height={8}
                    style={{ cursor: h.cursor }}
                    onPointerDown={(e) => onBoxHandlePointerDown(e, h.edgeX, h.edgeY, transformBox)}
                  >
                    <title>{h.edgeY === null ? tx.scaleTime : h.edgeX === null ? tx.scaleValues : tx.scaleBoth}</title>
                  </rect>
                );
              })}
            </g>
          )}

          {boxZoom && (
            <rect
              className={styles.boxZoomRect}
              x={Math.min(boxZoom.x0, boxZoom.x1)}
              y={Math.min(boxZoom.y0, boxZoom.y1)}
              width={Math.abs(boxZoom.x1 - boxZoom.x0)}
              height={Math.abs(boxZoom.y1 - boxZoom.y0)}
            />
          )}

          {boxSelect && (
            <rect
              className={styles.boxSelectRect}
              x={Math.min(boxSelect.x0, boxSelect.x1)}
              y={Math.min(boxSelect.y0, boxSelect.y1)}
              width={Math.abs(boxSelect.x1 - boxSelect.x0)}
              height={Math.abs(boxSelect.y1 - boxSelect.y0)}
            />
          )}

          {/* Hover read-out. Anchored to the CURVE's y rather than the
              pointer's, so the chip names the line it is pointing at instead
              of hovering in the space above it. */}
          {hover && !dragging && (
            <g className={styles.hoverTip} pointerEvents="none">
              <circle cx={hover.x} cy={hover.y} r={3} fill={hover.color} />
              <text x={hover.x + 8} y={hover.y - 6} fontSize={10} fill={hover.color}>
                {hover.label}
              </text>
            </g>
          )}

          {graphSnap?.time && (
            <line
              className={`${styles.snapLine} ${graphSnap.time.kind === 'playhead' ? styles.snapPlayhead : styles.snapKeyframe}`}
              x1={graphSnap.time.time * pps}
              x2={graphSnap.time.time * pps}
              y1={0}
              y2={INNER_H}
            />
          )}
          {graphSnap?.value && (
            <line
              className={`${styles.snapLine} ${styles.snapValue}`}
              x1={0}
              x2={totalWidth}
              y1={valueToY(graphSnap.value.value, graphSnap.minV, graphSnap.maxV, INNER_H)}
              y2={valueToY(graphSnap.value.value, graphSnap.minV, graphSnap.maxV, INNER_H)}
            />
          )}

          {/* Bézier handles — drawn LAST so they sit above every diamond. */}
          {handleGeom && (
            <g>
              {handleGeom.showIn && (
                <>
                  <line className={styles.handleLine} x1={handleGeom.kx} y1={handleGeom.inAnchorY} x2={handleGeom.inX} y2={handleGeom.inY} strokeWidth={1} />
                  <circle className={styles.handleDot} cx={handleGeom.inX} cy={handleGeom.inY} r={HANDLE_RADIUS} strokeWidth={1.5} />
                  <circle
                    className={styles.handleHit}
                    cx={handleGeom.inX}
                    cy={handleGeom.inY}
                    r={HIT_RADIUS}
                    onPointerDown={(e) => onHandlePointerDown(e, handleGeom.kf, 'handle-in', handleGeom.inX, handleGeom.inY)}
                  />
                </>
              )}
              {handleGeom.showOut && (
                <>
                  <line className={styles.handleLine} x1={handleGeom.kx} y1={handleGeom.ky} x2={handleGeom.outX} y2={handleGeom.outY} strokeWidth={1} />
                  <circle className={styles.handleDot} cx={handleGeom.outX} cy={handleGeom.outY} r={HANDLE_RADIUS} strokeWidth={1.5} />
                  <circle
                    className={styles.handleHit}
                    cx={handleGeom.outX}
                    cy={handleGeom.outY}
                    r={HIT_RADIUS}
                    onPointerDown={(e) => onHandlePointerDown(e, handleGeom.kf, 'handle-out', handleGeom.outX, handleGeom.outY)}
                  />
                </>
              )}
            </g>
          )}

          {/* Axis labels, over the curves and pinned to the visible edges */}
          <g pointerEvents="none">
            {gridTimes.map((sec) => (
              <text key={sec} className={styles.axisLabel} x={Math.round(sec * pps) + 5} y={INNER_H - 5} fontSize={10}>
                {sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`}
              </text>
            ))}
            {axisTrack && axisShown && axisValues.map((v) => {
              const y = valueToY(v / axisShown.factor, axisTrack.minV, axisTrack.maxV, INNER_H);
              return (
                <text key={v} className={styles.axisLabel} x={scrollLeft + 6} y={y < 14 ? y + 13 : y - 4} fontSize={10}>
                  {fmtAxis(v)}{axisShown.unit}
                </text>
              );
            })}
          </g>

          {/* Playhead (never intercepts the pointer) */}
          <g className={styles.playhead}>
            <line className={styles.playheadLine} x1={playheadX} y1={0} x2={playheadX} y2={INNER_H} strokeWidth={1} />
            <polygon className={styles.playheadCap} points={`${playheadX - 5},0 ${playheadX + 5},0 ${playheadX},8`} />
          </g>
        </svg>
      </div>
      </div>
    </div>
  );
}

/**
 * The docked numeric strip for one keyframe.
 *
 * Its own component so it re-reads the velocity through
 * `readKeyframeVelocity` — the same accessor the Keyframe Velocity dialog
 * uses — rather than duplicating the "which keyframe owns which bezier"
 * reasoning that module's header spells out. Getting that wrong writes the
 * INCOMING half onto this keyframe and silently reshapes the side of the curve
 * the user was not looking at.
 *
 * `rev` in the key forces a fresh read after every edit: the values are pulled
 * from the engine, not held in state, so an undo or a handle drag has to be
 * able to reset the fields.
 */
function KeyframeNumericStrip({
  kf,
}: {
  /** The focused key, or null: the strip stays, its fields disabled (a row that came and went moved the plot). */
  kf: { nodeId: string; prop: string; t: number; value: number } | null;
}): JSX.Element | null {
  const reading = kf ? readKeyframeVelocity(kf.nodeId, kf.prop, kf.t) : null;
  const velocity: KeyframeVelocity = reading?.velocity ?? { inSpeed: 0, inInfluence: 1 / 3, outSpeed: 0, outInfluence: 1 / 3 };
  const hasIncoming = !!reading?.hasIncoming;
  const hasOutgoing = !!reading?.hasOutgoing;

  const write = (patch: Partial<typeof velocity>): void => {
    if (!kf) return;
    // Through the engine: the mirror's change events redraw the graph.
    applyKeyframeVelocity(kf.nodeId, kf.prop, kf.t, { ...velocity, ...patch });
  };

  const tx = graphText();
  return (
    <div className={styles.numericStrip} role="group" aria-label={tx.selectedKeyframe}>
      <span className={styles.numericLabel}>{kf?.prop ?? '—'}</span>
      <label className={styles.numericField}>
        <span>{tx.numValue}</span>
        <ValueField
          value={kf?.value ?? 0}
          disabled={!kf}
          aria-label={tx.keyframeValue}
          onChange={(v) => {
            if (!kf) return;
            // The graph plots MEMBER tracks (`graphTracksOf`), so the strip's
            // key is one member's: the value writes that member of the key.
            void commitMemberWrites('Set Keyframe Value', kf.nodeId, kf.prop, [{ t: kf.t, value: v }]);
          }}
        />
      </label>
      <label className={styles.numericField}>
        <span>{tx.inSpeed}</span>
        <ValueField
          value={velocity.inSpeed}
          min={0}
          disabled={!hasIncoming}
          unit="/s"
          aria-label={tx.incomingSpeed}
          onChange={(v) => write({ inSpeed: v })}
        />
      </label>
      <label className={styles.numericField}>
        <span>{tx.outSpeed}</span>
        <ValueField
          value={velocity.outSpeed}
          min={0}
          disabled={!hasOutgoing}
          unit="/s"
          aria-label={tx.outgoingSpeed}
          onChange={(v) => write({ outSpeed: v })}
        />
      </label>
      <label className={styles.numericField}>
        <span>{tx.inInfluence}</span>
        <ValueField
          value={velocity.inInfluence * 100}
          min={0.1}
          max={99.9}
          unit="%"
          disabled={!hasIncoming}
          aria-label={tx.incomingInfluence}
          onChange={(v) => write({ inInfluence: v / 100 })}
        />
      </label>
      <label className={styles.numericField}>
        <span>{tx.outInfluence}</span>
        <ValueField
          value={velocity.outInfluence * 100}
          min={0.1}
          max={99.9}
          unit="%"
          disabled={!hasOutgoing}
          aria-label={tx.outgoingInfluence}
          onChange={(v) => write({ outInfluence: v / 100 })}
        />
      </label>
    </div>
  );
}
