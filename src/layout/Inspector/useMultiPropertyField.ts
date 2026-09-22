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
import { defaultAnimation, makeKeyframeId } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { applyEasingToKeyframes, type EasingPreset } from '@core/animation/keyframeAssistants';
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
  applyAbsolute,
  applyRelative,
  applyValues,
  KEYFRAME_EPS,
  layerTimeFor,
  navigatorState,
  readPropertyValue,
  snapshotStarts,
  toggleAnimationAll,
  toggleKeyframeAll,
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
  onExpressionEditorRequest,
  setFocusedExpressionRow,
} from '@core/animation/expressionCommands';
import type { KeyframeNavigatorProps } from '@components/PropertyRow';
import { useInspectorSelection } from './inspectorSelection';

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

const EASINGS: ReadonlyArray<{ id: EasingPreset; label: string }> = [
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

  const writeAll = useCallback((display: number) => {
    const engine = display / scale;
    applyAbsolute(nodeIds, prop, engine, { ...opts, mergeKey, label: `Set ${meta.label}` });
    if (linkedProp) applyAbsolute(nodeIds, linkedProp, engine, { ...opts, mergeKey, label: `Set ${meta.label}` });
  }, [nodeIds, prop, linkedProp, opts, mergeKey, meta.label, scale]);

  const onScrubStart = useCallback(() => {
    starts.current = snapshotStarts(nodeIds, prop, time, access);
  }, [nodeIds, prop, time, access]);

  const onRelative = useCallback((delta: number, cumulative: boolean) => {
    const from = cumulative ? starts.current : snapshotStarts(nodeIds, prop, time, access);
    const bounds = { min: meta.min, max: meta.max };
    applyRelative(prop, from, delta / scale, { ...opts, ...bounds, mergeKey, label: `Offset ${meta.label}` });
    if (linkedProp) {
      const linkedFrom = cumulative
        ? starts.current
        : snapshotStarts(nodeIds, linkedProp, time, access);
      applyRelative(linkedProp, linkedFrom, delta / scale, { ...opts, ...bounds, mergeKey, label: `Offset ${meta.label}` });
    }
  }, [nodeIds, prop, linkedProp, time, access, opts, mergeKey, meta, scale]);

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
    applyValues(prop, writes, { ...opts, label: `Set ${meta.label}` });
    if (linkedProp) applyValues(linkedProp, writes, { ...opts, label: `Set ${meta.label}` });
    return true;
  }, [nodeIds, prop, linkedProp, time, access, opts, meta, scale]);

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
  const layerT = compToKeyframeTime(nodeId, time, prop);
  const hint = nodeIds.length > 1 && agg.present < nodeIds.length
    ? `${agg.present} of ${nodeIds.length}`
    : undefined;

  // The lane draws the PRIMARY layer's keyframes on the comp axis.
  const laneTimes = exists && showLane && agg.animated
    ? (defaultAnimation.getTrackKeyframes(nodeId, prop) ?? []).map((k) => keyframeToCompTime(nodeId, k.t, prop))
    : null;

  const onLaneRetime = (fromC: number, toC: number): void => {
    const fromT = compToKeyframeTime(nodeId, fromC, prop);
    const toT = compToKeyframeTime(nodeId, toC, prop);
    runAnimEdit(`Move ${label} keyframe`, () => defaultAnimation.moveKeyframe(nodeId, prop, fromT, toT));
  };

  const onLaneContext = (e: React.MouseEvent, compT: number): void => {
    const t = compToKeyframeTime(nodeId, compT, prop);
    const id = makeKeyframeId(nodeId, prop, t);
    openContextMenu(e.clientX, e.clientY, [
      {
        id: 'lane-easing',
        label: 'Keyframe Interpolation',
        children: EASINGS.map((p) => ({ id: `lane-ease-${p.id}`, label: p.label, onSelect: () => applyEasingToKeyframes([id], p.id) })),
      },
      { id: 'lane-sep', separator: true },
      {
        id: 'lane-remove',
        label: 'Remove Keyframe',
        danger: true,
        onSelect: () => runAnimEdit(`Remove ${label} keyframe`, () => defaultAnimation.removeKeyframe(nodeId, prop, t)),
      },
    ]);
  };

  const onWhip = (target: { nodeId: string; prop?: string }): void => {
    const name = defaultSceneGraph.getNode(target.nodeId)?.name;
    if (!name) return;
    const src = whipExpression(name, target.prop ?? prop);
    runAnimEdit(`Link ${label}`, () => defaultAnimation.batch(() => {
      for (const id of nodeIds) {
        defaultAnimation.setExpression(id, prop, src);
        defaultAnimation.setExpressionEnabled(id, prop, true);
      }
    }));
    setExprOpen(true);
  };

  const toggleExpression = (): void => {
    // No expression yet: ADD one — AE's default `value`, one undo step, the
    // same helper the timeline row menu and Alt+Shift+= use — and open it.
    if (!hasExpr) {
      addExpression(nodeIds.map((id) => ({ nodeId: id, prop })), { openEditor: false });
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
      onToggleKeyframe: () => toggleKeyframeAll(nodeIds, prop, time, access),
    },
    toggleAnimation: () => toggleAnimationAll(nodeIds, prop, time, access),
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
 * The GROUP stopwatch with a reader PER PROPERTY.
 *
 * `toggleAnimationGroup` takes one `access` for the whole group, and its
 * `read(nodeId)` has no prop argument — so a group whose members need their
 * own readers (Transform's `accessFor('x')` vs `accessFor('y')`) would seed Y's
 * first keyframe from X's static value. Same rule otherwise, and one undo step:
 * any track on any node lit → every track removed; else every node gets a
 * first keyframe on every member it has.
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
  if (anyAnimated) {
    runAnimEdit(`Remove ${groupLabel} animation`, () => defaultAnimation.batch(() => {
      for (const id of ids) {
        for (const m of members) if (defaultAnimation.isAnimated(id, m.prop)) defaultAnimation.removeTrack(id, m.prop);
      }
    }));
    return;
  }
  const seeds: Array<{ id: string; prop: string; v: number }> = [];
  for (const id of ids) {
    for (const m of members) {
      const v = readPropertyValue(id, m.prop, compTime, m.access);
      if (typeof v === 'number') seeds.push({ id, prop: m.prop, v });
    }
  }
  if (seeds.length === 0) return;
  runAnimEdit(`Animate ${groupLabel}`, () => defaultAnimation.batch(() => {
    for (const s of seeds) defaultAnimation.setKeyframe(s.id, s.prop, layerTimeFor(s.id, s.prop, compTime), s.v);
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
 * The group diamond: on a keyframe → remove the keyframe at the playhead from
 * every member that has one; off → add one to EVERY member of every layer
 * where the group is animated, holding its current value. One undo step.
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
  if (atKeyframe) {
    runAnimEdit(`Remove ${groupLabel} keyframe`, () => defaultAnimation.batch(() => {
      for (const id of animatedIds) {
        for (const p of props) {
          if (!defaultAnimation.isAnimated(id, p)) continue;
          const lt = layerTimeFor(id, p, compTime);
          const at = (defaultAnimation.getTrackKeyframes(id, p) ?? []).find((k) => Math.abs(k.t - lt) < KEYFRAME_EPS);
          if (at) defaultAnimation.removeKeyframe(id, p, at.t);
        }
      }
    }));
    return;
  }
  runAnimEdit(`Add ${groupLabel} keyframe`, () => defaultAnimation.batch(() => {
    for (const id of animatedIds) {
      for (const m of members) {
        const v = readPropertyValue(id, m.prop, compTime, m.access);
        if (v !== undefined) defaultAnimation.setKeyframe(id, m.prop, layerTimeFor(id, m.prop, compTime), v);
      }
    }
  }));
}
