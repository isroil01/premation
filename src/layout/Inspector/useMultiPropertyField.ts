/**
 * useMultiPropertyField — the value and gesture logic of ONE animatable numeric
 * property of the SELECTION, without any markup.
 *
 * Extracted from `MultiPropertyRow` (2026-09-15) when the inspector grew rows
 * that hold two or three fields — Position X/Y(/Z), Scale W/H. Every field of
 * such a row needs exactly what a single row always had: the aggregate across
 * the selection (`—` when mixed), relative drag, per-layer `+10` / `*2`, one
 * undo entry per gesture, display-unit scaling, the keyframe navigator state,
 * the expression editor request, the right-click menu. Copying that into a
 * pair row would be a second place for "what dragging a mixed field means" to
 * drift, so both rows call this.
 *
 * Values leave this hook in DISPLAY units (`meta.displayScale`) and are written
 * back in engine units.
 *
 * `enabled: false` is an inert slot. A pair row calls this a FIXED number of
 * times (hooks cannot be conditional) and gains or loses its Z field when the
 * layer turns 3D; the spare slot must not claim expression-editor requests or
 * aggregate anything.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyValueExpression } from '@utils/evalMath';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { compToKeyframeTime, keyframeToCompTime } from '@core/timeline/TimelineController';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { whipExpression } from '@core/whip/whipTarget';
import { resolvePropertyMeta, type PropertyMeta } from '@core/inspector/propertyMeta';
import { buildPropertyMenu } from '@core/inspector/propertyMenu';
import { isPinnedProp } from '@core/inspector/pinnedProps';
import { useNodesRevision } from '@hooks/useNodeRevision';
import { readModifierStack } from '@core/animation/modifierStack';
import {
  aggregateProperty,
  applyValues,
  KEYFRAME_EPS,
  layerTimeFor,
  navigatorState,
  readPropertyValue,
  snapshotStarts,
  type PropertyAccess,
} from '@core/inspector/multiSelection';
import { openContextMenu, type ContextMenuItem } from '@stores/contextMenuStore';
import { useThrottledTime } from '@stores/playbackClockStore';
import { useProjectStore } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import {
  addExpression,
  consumeExpressionEditorRequest,
  DEFAULT_EXPRESSION,
  onExpressionEditorRequest,
  setFocusedExpressionRow,
} from '@core/animation/expressionCommands';
import type { KeyframeNavigatorProps } from '@components/PropertyRow';
import { useInspectorSelection } from './inspectorSelection';
import { useGesture } from '@hooks/useGesture';
import { edit } from '@core/engine/uiEdits';
import {
  allAddressable,
  deleteKeysAtCommands,
  easeKeysAtCommands,
  expressionCommands,
  keyToggleCommands,
  moveKeysCommands,
  stopwatchCommands,
  valueCommands,
  type EasePreset,
} from './inspectorEdits';

export interface MultiPropertyFieldOptions {
  /** Custom read / static-write for values the property seam cannot see. */
  access?: PropertyAccess;
  /** A second property written with the same value — Linked Scale. */
  linkedProp?: string;
  /** Display label override (the registry label otherwise). */
  label?: string;
  /** False → an inert slot (see the header). Default true. */
  enabled?: boolean;
}

type NavState = ReturnType<typeof navigatorState>;
type AggState = ReturnType<typeof aggregateProperty>;

export interface MultiPropertyField {
  nodeIds: ReadonlyArray<string>;
  /** False when the primary node is gone (or the slot is inert). */
  exists: boolean;
  prop: string;
  /** The property's full name — accessible labels, menus, history. */
  label: string;
  meta: PropertyMeta;
  /** Engine → display multiplier. */
  scale: number;
  agg: AggState;
  time: number;
  /** Set every layer to one DISPLAY value (one undo step per gesture). */
  writeAll: (display: number) => void;
  /** Props to spread onto the `ValueField` (display units, relative gestures). */
  fieldProps: {
    value: number;
    mixed: boolean;
    unit: string | undefined;
    min: number | undefined;
    max: number | undefined;
    step: number;
    precision: number;
    onChange: (display: number) => void;
    onScrubStart: () => void;
    onScrubEnd: () => void;
    onRelative: (delta: number, cumulative: boolean) => void;
    onCommitText: (raw: string) => boolean;
    'aria-label': string;
  };
  nav: NavState;
  /** Navigator wiring for a `PropertyRow`. */
  navigator: Omit<KeyframeNavigatorProps, 'label'>;
  toggleAnimation: () => void;
  seek: (compT: number) => void;
  hasExpr: boolean;
  exprEnabled: boolean;
  exprError: string | null;
  exprOpen: boolean;
  setExprOpen: (open: boolean | ((v: boolean) => boolean)) => void;
  /** The `=` toggle: add `value` when there is none (and open), else show/hide. */
  toggleExpression: () => void;
  /** Pick-whip drop: link every selected layer's prop to the target. */
  onWhip: (target: { nodeId: string; prop?: string }) => void;
  hasStack: boolean;
  pinned: boolean;
  /** The registry default in ENGINE units, when the property may be reset. */
  resetValue: number | undefined;
  /** "2 of 3" when only some selected layers have the property. */
  hint: string | undefined;
  /** Comp-axis keyframe times for the mini lane, or null when it is off. */
  laneTimes: number[] | null;
  onLaneRetime: (fromCompT: number, toCompT: number) => void;
  onLaneContext: (e: React.MouseEvent, compT: number) => void;
  menuItems: () => ContextMenuItem[];
  openMenu: (e: React.MouseEvent) => void;
  onFocusCapture: () => void;
  onBlurCapture: (e: React.FocusEvent<HTMLElement>) => void;
}

const EASINGS: ReadonlyArray<{ id: EasePreset; label: string }> = [
  { id: 'Linear', label: 'Linear' },
  { id: 'Ease', label: 'Easy Ease' },
  { id: 'EaseIn', label: 'Easy Ease In' },
  { id: 'EaseOut', label: 'Easy Ease Out' },
  { id: 'Hold', label: 'Toggle Hold' },
];

const NO_NAV: NavState = { hasPrev: false, hasNext: false, atKeyframe: false, prevT: null, nextT: null };

export function useMultiPropertyField(
  nodeId: string,
  prop: string,
  { access, linkedProp, label: labelOverride, enabled = true }: MultiPropertyFieldOptions = {},
): MultiPropertyField {
  const gesture = useGesture();
  const nodeIds = useInspectorSelection(nodeId);
  // The tick is a dependency below: the scene graph can hand back the same
  // node object after a write, so identity alone cannot invalidate the read.
  const rev = useNodesRevision(nodeIds);
  const time = useThrottledTime();
  const fps = useCompositionStore((c) => c.fps) || 30;
  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);
  const showLane = usePreferenceStore((s) => s.inspectorShowLane);
  const [exprOpen, setExprOpen] = useState(false);
  const starts = useRef<Map<string, number>>(new Map());

  // Add Expression from the timeline's row menu, this row's own menu, or
  // Alt+Shift+= asks THIS field to open its editor — including when it mounts
  // just after the request.
  useEffect(() => {
    if (!enabled) return undefined;
    if (consumeExpressionEditorRequest(nodeId, prop)) setExprOpen(true);
    return onExpressionEditorRequest((ref) => {
      if (ref.nodeId === nodeId && ref.prop === prop && consumeExpressionEditorRequest(nodeId, prop)) {
        setExprOpen(true);
      }
    });
  }, [nodeId, prop, enabled]);

  const node = enabled ? defaultSceneGraph.getNode(nodeId) : undefined;
  const meta = resolvePropertyMeta(prop, nodeId);
  const scale = meta.displayScale ?? 1;
  const agg = useMemo(
    () => (enabled
      ? aggregateProperty(nodeIds, prop, time, access)
      : { value: 0, mixed: false, present: 0, nodeIds: [], animated: false, allAnimated: false }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revision-driven
    [nodeIds, prop, time, access, node, rev, enabled],
  );

  const opts = useMemo(
    () => ({ compTime: time, autoKeyframe, ...access }),
    [time, autoKeyframe, access],
  );
  const mergeKey = `multi:${prop}:${nodeIds.join(',')}:${time}`;

  // B3: writes go through the engine API (commands; a scrub is ONE gesture).
  // The route is decided per write — a property the engine's catalog does not
  // address, or one with its own static writer (a plugin panel's params), keeps
  // the legacy writer below. Decided at scrub START for a drag, so a gesture
  // never switches route halfway.
  const engineRoute = useCallback(
    (): boolean => !access?.writeStatic && allAddressable(nodeIds, linkedProp ? [prop, linkedProp] : [prop]),
    [access, nodeIds, prop, linkedProp],
  );
  const scrubRoute = useRef<boolean | null>(null);

  /**
   * Per-layer values (stored units) → the document. `linkedWrites` are Linked
   * Scale's second property, written in the SAME command (one API property).
   */
  const sendValues = useCallback((
    writes: ReadonlyArray<{ nodeId: string; value: number }>,
    linkedWrites: ReadonlyArray<{ nodeId: string; value: number }> | null,
    label: string,
  ) => {
    const onEngine = scrubRoute.current ?? engineRoute();
    if (onEngine) {
      const byNode = new Map<string, Record<string, number>>();
      for (const w of writes) byNode.set(w.nodeId, { [prop]: w.value });
      if (linkedProp && linkedWrites) {
        for (const w of linkedWrites) byNode.set(w.nodeId, { ...byNode.get(w.nodeId), [linkedProp]: w.value });
      }
      const cmds = valueCommands([...byNode].map(([nodeId, values]) => ({ nodeId, values })), { seconds: time, autoKeyframe });
      if (gesture.isActive()) gesture.send(cmds);
      else void edit(label, cmds);
      return;
    }
    // B3-legacy: engine gap — properties outside the engine catalog / custom static writers (plugin panel params, `plugin/<p>`).
    const legacy = (p: string, ws: ReadonlyArray<{ nodeId: string; value: number }>): void => applyValues(p, ws, { ...opts, mergeKey, label });
    legacy(prop, writes);
    if (linkedProp && linkedWrites) legacy(linkedProp, linkedWrites);
  }, [prop, linkedProp, time, autoKeyframe, gesture, engineRoute, opts, mergeKey]);

  const writeAll = useCallback((display: number) => {
    const stored = display / scale;
    const writes = nodeIds.map((nodeId) => ({ nodeId, value: stored }));
    sendValues(writes, linkedProp ? writes : null, `Set ${meta.label}`);
  }, [nodeIds, linkedProp, meta.label, scale, sendValues]);

  const onScrubStart = useCallback(() => {
    starts.current = snapshotStarts(nodeIds, prop, time, access);
    // One undo entry for the whole scrub (ENGINE_API.md §5.2).
    scrubRoute.current = engineRoute();
    if (scrubRoute.current) gesture.begin(`Set ${meta.label}`);
  }, [nodeIds, prop, time, access, engineRoute, gesture, meta.label]);

  const onScrubEnd = useCallback(() => {
    if (scrubRoute.current) void gesture.end();
    scrubRoute.current = null;
  }, [gesture]);

  const onRelative = useCallback((delta: number, cumulative: boolean) => {
    const from = cumulative ? starts.current : snapshotStarts(nodeIds, prop, time, access);
    const lo = meta.min ?? -Infinity;
    const hi = meta.max ?? Infinity;
    const offset = (m: ReadonlyMap<string, number>): Array<{ nodeId: string; value: number }> =>
      [...m].map(([nodeId, start]) => ({ nodeId, value: Math.min(hi, Math.max(lo, start + delta / scale)) }));
    // Linked: offset the second property from ITS values (the scrub's start map when cumulative, as before).
    const linkedFrom = linkedProp ? (cumulative ? starts.current : snapshotStarts(nodeIds, linkedProp, time, access)) : null;
    sendValues(offset(from), linkedFrom ? offset(linkedFrom) : null, `Offset ${meta.label}`);
  }, [nodeIds, prop, linkedProp, time, access, meta, scale, sendValues]);

  const onCommitText = useCallback((raw: string): boolean => {
    const writes: Array<{ nodeId: string; value: number }> = [];
    for (const id of nodeIds) {
      const cur = readPropertyValue(id, prop, time, access);
      if (cur === undefined) continue;
      const next = applyValueExpression(cur * scale, raw);
      if (next === null) return false;
      const clamped = Math.min(meta.max ?? Infinity, Math.max(meta.min ?? -Infinity, next));
      writes.push({ nodeId: id, value: clamped / scale });
    }
    if (writes.length === 0) return false;
    sendValues(writes, linkedProp ? writes : null, `Set ${meta.label}`);
    return true;
  }, [nodeIds, prop, linkedProp, time, access, meta, scale, sendValues]);

  // ── Plain per-render derivations (no hooks below this line) ────────────
  const exists = node !== undefined;
  const label = labelOverride ?? meta.label;
  const nav = exists ? navigatorState(nodeIds, prop, time) : NO_NAV;
  const seek = (t: number): void => {
    useProjectStore.getState().actions.setTime(t, Math.round(t * fps));
  };
  const hasExpr = exists && defaultAnimation.hasExpression(nodeId, prop);
  const exprEnabled = exists && defaultAnimation.isExpressionEnabled(nodeId, prop);
  const exprError = exprEnabled ? defaultAnimation.getExpressionError(nodeId, prop) ?? null : null;
  const hasStack = node !== undefined && readModifierStack(node, prop) !== null;
  const pinned = exists && isPinnedProp(nodeId, prop);
  const resetValue = meta.resettable && typeof meta.defaultValue === 'number' ? meta.defaultValue : undefined;
  // B3-legacy: feeds `buildPropertyMenu` (src/core/inspector, not this area), which still writes on the keyframe axis.
  const layerT = compToKeyframeTime(nodeId, time, prop);
  const hint = nodeIds.length > 1 && agg.present < nodeIds.length
    ? `${agg.present} of ${nodeIds.length}`
    : undefined;

  // The lane draws the PRIMARY layer's keyframes on the comp axis.
  const laneTimes = exists && showLane && agg.animated
    ? (defaultAnimation.getTrackKeyframes(nodeId, prop) ?? []).map((k) => keyframeToCompTime(nodeId, k.t, prop))
    : null;

  const onLaneRetime = (fromC: number, toC: number): void => {
    void moveKeysCommands(nodeId, [prop], fromC, toC).then((cmds) => edit(`Move ${label} keyframe`, cmds));
  };

  const onLaneContext = (e: React.MouseEvent, compT: number): void => {
    openContextMenu(e.clientX, e.clientY, [
      {
        id: 'lane-easing',
        label: 'Keyframe Interpolation',
        children: EASINGS.map((p) => ({
          id: `lane-ease-${p.id}`,
          label: p.label,
          onSelect: () => { void easeKeysAtCommands(nodeId, [prop], compT, p.id).then((cmds) => edit(`Set keyframe easing: ${p.id}`, cmds)); },
        })),
      },
      { id: 'lane-sep', separator: true },
      {
        id: 'lane-remove',
        label: 'Remove Keyframe',
        danger: true,
        onSelect: () => { void deleteKeysAtCommands(nodeId, [prop], compT).then((cmds) => edit(`Remove ${label} keyframe`, cmds)); },
      },
    ]);
  };

  const onWhip = (target: { nodeId: string; prop?: string }): void => {
    const name = defaultSceneGraph.getNode(target.nodeId)?.name;
    if (!name) return;
    const src = whipExpression(name, target.prop ?? prop);
    const cmds = expressionCommands(nodeIds.map((id) => ({ nodeId: id, track: prop, source: src })));
    if (cmds) void edit(`Link ${label}`, cmds);
    else legacyExpressions(`Link ${label}`, nodeIds.map((id) => ({ nodeId: id, prop, src })));
    setExprOpen(true);
  };

  const toggleExpression = (): void => {
    // No expression yet: ADD one — AE's default `value`, one undo step — and open it.
    if (!hasExpr) {
      const fresh = nodeIds.filter((id) => !defaultAnimation.hasExpression(id, prop));
      const cmds = expressionCommands(fresh.map((id) => ({ nodeId: id, track: prop, source: DEFAULT_EXPRESSION })));
      if (cmds) void edit(fresh.length === 1 ? 'Add Expression' : 'Add Expressions', cmds);
      // B3-legacy: engine gap — an expression on ONE member of a vector (X of Position): API expressions are per property.
      else addExpression(nodeIds.map((id) => ({ nodeId: id, prop })), { openEditor: false });
      setExprOpen(true);
      return;
    }
    setExprOpen((v) => !v);
  };

  const menuItems = (): ContextMenuItem[] => buildPropertyMenu({
    nodeId,
    prop,
    layerT,
    value: agg.value,
    setValue: (v) => writeAll(v * scale),
    nodeIds,
  });

  return {
    nodeIds,
    exists,
    prop,
    label,
    meta,
    scale,
    agg,
    time,
    writeAll,
    fieldProps: {
      value: agg.value * scale,
      mixed: agg.mixed,
      unit: meta.unit,
      min: meta.min !== undefined ? meta.min * scale : undefined,
      max: meta.max !== undefined ? meta.max * scale : undefined,
      step: meta.step * scale,
      precision: meta.precision,
      onChange: writeAll,
      onScrubStart,
      onScrubEnd,
      onRelative,
      onCommitText,
      'aria-label': label,
    },
    nav,
    navigator: {
      hasPrev: nav.hasPrev,
      hasNext: nav.hasNext,
      atKeyframe: nav.atKeyframe,
      onPrev: () => { if (nav.prevT !== null) seek(nav.prevT); },
      onNext: () => { if (nav.nextT !== null) seek(nav.nextT); },
      onToggleKeyframe: () => toggleKeyframeGroup(nodeIds, [{ prop, access }], time, label),
    },
    toggleAnimation: () => toggleAnimationGroupEach(nodeIds, [{ prop, access }], time, label),
    seek,
    hasExpr,
    exprEnabled,
    exprError,
    exprOpen,
    setExprOpen,
    toggleExpression,
    onWhip,
    hasStack,
    pinned,
    resetValue,
    hint,
    laneTimes,
    onLaneRetime,
    onLaneContext,
    menuItems,
    openMenu: (e) => {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, menuItems());
    },
    // "The focused property" for Alt+Shift+= (Add Expression).
    onFocusCapture: () => setFocusedExpressionRow({ nodeId, prop }),
    onBlurCapture: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusedExpressionRow(null);
    },
  };
}

// ── Group helpers for rows that hold several properties ─────────────────

export interface GroupMember {
  prop: string;
  access?: PropertyAccess;
}

/**
 * The engine addresses every member on every layer, and none has its own
 * static storage (a plugin panel's params do) — the group's writes can go
 * through the API.
 */
function groupOnEngine(nodeIds: ReadonlyArray<string>, members: ReadonlyArray<GroupMember>): boolean {
  return members.every((m) => !m.access?.writeStatic) && allAddressable(nodeIds, members.map((m) => m.prop));
}

/**
 * Link / set expressions the API cannot address (one member of a vector
 * property, a param outside the catalog) — the pre-API writer, ONE undo step.
 */
export function legacyExpressions(label: string, list: ReadonlyArray<{ nodeId: string; prop: string; src: string }>): void {
  // B3-legacy: engine gap — per-member expressions (X of Position): `setExpression` puts one source on every member.
  runAnimEdit(label, () => defaultAnimation.batch(() => {
    for (const x of list) {
      // B3-legacy: same gap (the member-level writer).
      defaultAnimation.setExpression(x.nodeId, x.prop, x.src);
      // B3-legacy: same gap.
      defaultAnimation.setExpressionEnabled(x.nodeId, x.prop, true);
    }
  }));
}

/**
 * The GROUP stopwatch (a pair row; a single row is a group of one): any
 * property on any layer animated → every one stops (the static value becomes
 * the value at the playhead); else every layer gets a first keyframe holding
 * its current value. One undo step, through `setAnimated` (AE: Position's X
 * and Y are ONE property, so its stopwatch is one command per layer).
 */
export function toggleAnimationGroupEach(
  nodeIds: ReadonlyArray<string>,
  members: ReadonlyArray<GroupMember>,
  compTime: number,
  groupLabel: string,
): void {
  const ids = nodeIds.filter((id) => defaultSceneGraph.getNode(id));
  if (ids.length === 0 || members.length === 0) return;
  const anyAnimated = ids.some((id) => members.some((m) => defaultAnimation.isAnimated(id, m.prop)));
  const label = anyAnimated ? `Remove ${groupLabel} animation` : `Animate ${groupLabel}`;
  if (groupOnEngine(ids, members)) {
    void edit(label, stopwatchCommands(ids, members.map((m) => m.prop), compTime));
    return;
  }
  // B3-legacy: engine gap — members outside the engine catalog / with custom storage (plugin panel params): seeds need their own readers.
  runAnimEdit(label, () => defaultAnimation.batch(() => {
    for (const id of ids) {
      for (const m of members) {
        const v = readPropertyValue(id, m.prop, compTime, m.access);
        if (anyAnimated) {
          // B3-legacy: same gap (stop = drop the track).
          if (defaultAnimation.isAnimated(id, m.prop)) defaultAnimation.removeTrack(id, m.prop);
        } else if (typeof v === 'number') {
          // B3-legacy: same gap (start = first key from the member's own reader).
          defaultAnimation.setKeyframe(id, m.prop, layerTimeFor(id, m.prop, compTime), v);
        }
      }
    }
  }));
}

/**
 * One navigator for a group: prev = the nearest previous keyframe across every
 * member and layer, next likewise; the diamond is lit when ANY member has a
 * keyframe at the playhead — so a key set on X alone can still be seen and
 * removed from the merged row.
 */
export function groupNavigatorState(
  nodeIds: ReadonlyArray<string>,
  props: ReadonlyArray<string>,
  compTime: number,
): NavState {
  let hasPrev = false;
  let hasNext = false;
  let atKeyframe = false;
  let prevT: number | null = null;
  let nextT: number | null = null;
  for (const p of props) {
    const n = navigatorState(nodeIds, p, compTime);
    const animatedHere = nodeIds.some((id) => defaultAnimation.isAnimated(id, p));
    if (!animatedHere) continue;
    if (n.atKeyframe) atKeyframe = true;
    if (n.hasPrev) hasPrev = true;
    if (n.hasNext) hasNext = true;
    if (n.prevT !== null && (prevT === null || n.prevT > prevT)) prevT = n.prevT;
    if (n.nextT !== null && (nextT === null || n.nextT < nextT)) nextT = n.nextT;
  }
  return { hasPrev, hasNext, atKeyframe, prevT, nextT };
}

/**
 * The group diamond: on a keyframe → remove the keyframes at the playhead from
 * every animated property; off → add one to every animated property of every
 * layer, holding its current value. One undo step. Key ids come from the
 * engine (`getKeyframes`), never from positional ids.
 */
export function toggleKeyframeGroup(
  nodeIds: ReadonlyArray<string>,
  members: ReadonlyArray<GroupMember>,
  compTime: number,
  groupLabel: string,
): void {
  const props = members.map((m) => m.prop);
  const animatedIds = nodeIds.filter((id) => props.some((p) => defaultAnimation.isAnimated(id, p)));
  if (animatedIds.length === 0) return;
  const { atKeyframe } = groupNavigatorState(animatedIds, props, compTime);
  const label = atKeyframe ? `Remove ${groupLabel} keyframe` : `Add ${groupLabel} keyframe`;
  if (groupOnEngine(animatedIds, members)) {
    void keyToggleCommands(animatedIds, props, compTime).then((cmds) => edit(label, cmds));
    return;
  }
  // B3-legacy: engine gap — members outside the engine catalog / with custom storage (plugin panel params).
  runAnimEdit(label, () => defaultAnimation.batch(() => {
    for (const id of animatedIds) {
      for (const m of members) {
        if (!defaultAnimation.isAnimated(id, m.prop)) continue;
        const lt = layerTimeFor(id, m.prop, compTime);
        const at = (defaultAnimation.getTrackKeyframes(id, m.prop) ?? []).find((k) => Math.abs(k.t - lt) < KEYFRAME_EPS);
        const v = readPropertyValue(id, m.prop, compTime, m.access);
        if (atKeyframe) {
          // B3-legacy: same gap (remove the key at the playhead).
          if (at) defaultAnimation.removeKeyframe(id, m.prop, at.t);
        } else if (v !== undefined) {
          // B3-legacy: same gap (add one holding the member's value).
          defaultAnimation.setKeyframe(id, m.prop, lt, v);
        }
      }
    }
  }));
}
