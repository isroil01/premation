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
import { whipExpression } from '@core/whip/whipTarget';
import type { PropertyMeta } from '@core/inspector/propertyMeta';
import { mirrorModifierStack } from '@core/mirror/modifierStacks';
import { memberExpressionOf } from '@core/mirror/memberExpressions';
import type { PropertyAccess } from '@core/inspector/multiSelection';
import {
  aggregateTrack,
  groupNavigatorFor,
  isTrackAnimated,
  navigatorFor,
  readTrack,
  trackKeyTimes,
  trackRef as mirrorTrackRef,
  type MirrorRead,
  type MultiValue,
  type NavState as MirrorNavState,
} from '@core/mirror/selection';
import { mirrorPropertyMeta } from '@core/mirror/metaFacts';
import { documentMirror } from '@stores/documentMirror';
import { useActiveCompFps, useMirrorTrackWatch } from '@hooks/useMirror';
import { openContextMenu, type ContextMenuItem } from '@stores/contextMenuStore';
import { useThrottledTime } from '@stores/playbackClockStore';
import { useProjectStore } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import {
  consumeExpressionEditorRequest,
  DEFAULT_EXPRESSION,
  onExpressionEditorRequest,
  setFocusedExpressionRow,
} from '@core/animation/expressionCommands';
import type { KeyframeNavigatorProps } from '@components/PropertyRow';
import { useInspectorSelection } from './inspectorSelection';
import { useGesture } from '@hooks/useGesture';
import { edit } from '@core/engine/uiEdits';
import { reportUnaddressed } from './useComponentProp';
import { engineRowMenuItems } from './propertyRowMenu';
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

type NavState = MirrorNavState;
type AggState = MultiValue;

/**
 * The expression THIS member track carries (the mirror's per-dimension
 * `memberExpressions`: the X field of an unseparated Position has its own).
 */
function trackExpressionOf(m: MirrorRead, nodeId: string, prop: string): { source: string; enabled: boolean; error: string } | null {
  const r = mirrorTrackRef(m, nodeId, prop);
  return r ? memberExpressionOf(r.info, r.member) : null;
}

/**
 * One layer's value of `prop` at comp time `time`, in stored units — read from
 * the document MIRROR (B4). A row with its own reader (`access.read`: a value
 * the catalog does not address, like a plugin panel's param) keeps it for the
 * static value; an animated one always comes from the mirror.
 */
function valueOf(nodeId: string, prop: string, time: number, access?: PropertyAccess): number | undefined {
  const m = documentMirror();
  if (!m.layer(nodeId)) return undefined;
  if (access?.read && !isTrackAnimated(m, nodeId, prop)) return access.read(nodeId);
  return readTrack(m, nodeId, prop, time);
}

/** The selection's aggregate (mirror twin of `aggregateProperty`, honouring a custom reader). */
function aggregateOf(nodeIds: ReadonlyArray<string>, prop: string, time: number, meta: PropertyMeta, access?: PropertyAccess): AggState {
  const m = documentMirror();
  const fallback = typeof meta.defaultValue === 'number' ? meta.defaultValue : 0;
  if (!access?.read) return aggregateTrack(m, nodeIds, prop, time, fallback);
  const present: string[] = [];
  const values: number[] = [];
  let animated = 0;
  for (const id of nodeIds) {
    const v = valueOf(id, prop, time, access);
    if (v === undefined) continue;
    present.push(id);
    values.push(v);
    if (isTrackAnimated(m, id, prop)) animated += 1;
  }
  const value = values[0] ?? fallback;
  return {
    value,
    mixed: values.some((v) => Math.abs(v - value) > 1e-6),
    present: present.length,
    nodeIds: present,
    animated: animated > 0,
    allAnimated: present.length > 0 && animated === present.length,
  };
}

/** Per-layer start values of a drag (mirror twin of `snapshotStarts`). */
function startsOf(nodeIds: ReadonlyArray<string>, prop: string, time: number, access?: PropertyAccess): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of nodeIds) {
    const v = valueOf(id, prop, time, access);
    if (v !== undefined) out.set(id, v);
  }
  return out;
}

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
  // B4: the row reads the document MIRROR and wakes only when THIS property
  // (its info, keys or value) or a selected layer's header/tree changes.
  const watchedTracks = useMemo(() => (enabled ? (linkedProp ? [prop, linkedProp] : [prop]) : []), [enabled, prop, linkedProp]);
  const rev = useMirrorTrackWatch(enabled ? nodeIds : [], watchedTracks);
  const time = useThrottledTime();
  const fps = useActiveCompFps();
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

  const mirror = documentMirror();
  const layer = enabled ? mirror.layer(nodeId) : undefined;
  const meta = mirrorPropertyMeta(prop, layer, layer ? mirror.tree(nodeId) : undefined);
  const scale = meta.displayScale ?? 1;
  const agg = useMemo(
    () => (enabled
      ? aggregateOf(nodeIds, prop, time, meta, access)
      : { value: 0, mixed: false, present: 0, nodeIds: [], animated: false, allAnimated: false }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mirror-watch driven (`rev`)
    [nodeIds, prop, time, access, layer, rev, enabled],
  );

  // B3: writes go through the engine API (commands; a scrub is ONE gesture).
  // A row whose property the catalog may not list YET (a plugin panel's param
  // before its panel group exists) brings its own path-addressed, self-seeding
  // command builder (`access.engine`, pluginParamEdits.ts). A property the
  // engine does not address at all is REFUSED (a toast), never written around
  // the engine. Decided at scrub START for a drag, so a gesture never switches
  // route halfway.
  const engineRoute = useCallback(
    (): boolean => access?.engine !== undefined || allAddressable(nodeIds, linkedProp ? [prop, linkedProp] : [prop]),
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
    if (!onEngine) {
      reportUnaddressed(nodeIds[0] ?? '', [prop], label);
      return;
    }
    let cmds;
    if (access?.engine) {
      cmds = access.engine.commands(writes, { seconds: time, autoKeyframe });
    } else {
      const byNode = new Map<string, Record<string, number>>();
      for (const w of writes) byNode.set(w.nodeId, { [prop]: w.value });
      if (linkedProp && linkedWrites) {
        for (const w of linkedWrites) byNode.set(w.nodeId, { ...byNode.get(w.nodeId), [linkedProp]: w.value });
      }
      cmds = valueCommands([...byNode].map(([nodeId, values]) => ({ nodeId, values })), { seconds: time, autoKeyframe });
    }
    if (gesture.isActive()) gesture.send(cmds);
    else void edit(label, cmds);
  }, [prop, linkedProp, time, autoKeyframe, gesture, engineRoute, access, nodeIds]);

  const writeAll = useCallback((display: number) => {
    const stored = display / scale;
    const writes = nodeIds.map((nodeId) => ({ nodeId, value: stored }));
    sendValues(writes, linkedProp ? writes : null, `Set ${meta.label}`);
  }, [nodeIds, linkedProp, meta.label, scale, sendValues]);

  const onScrubStart = useCallback(() => {
    starts.current = startsOf(nodeIds, prop, time, access);
    // One undo entry for the whole scrub (ENGINE_API.md §5.2).
    scrubRoute.current = engineRoute();
    if (scrubRoute.current) gesture.begin(`Set ${meta.label}`);
  }, [nodeIds, prop, time, access, engineRoute, gesture, meta.label]);

  const onScrubEnd = useCallback(() => {
    if (scrubRoute.current) void gesture.end();
    scrubRoute.current = null;
  }, [gesture]);

  const onRelative = useCallback((delta: number, cumulative: boolean) => {
    const from = cumulative ? starts.current : startsOf(nodeIds, prop, time, access);
    const lo = meta.min ?? -Infinity;
    const hi = meta.max ?? Infinity;
    const offset = (m: ReadonlyMap<string, number>): Array<{ nodeId: string; value: number }> =>
      [...m].map(([nodeId, start]) => ({ nodeId, value: Math.min(hi, Math.max(lo, start + delta / scale)) }));
    // Linked: offset the second property from ITS values (the scrub's start map when cumulative, as before).
    const linkedFrom = linkedProp ? (cumulative ? starts.current : startsOf(nodeIds, linkedProp, time, access)) : null;
    sendValues(offset(from), linkedFrom ? offset(linkedFrom) : null, `Offset ${meta.label}`);
  }, [nodeIds, prop, linkedProp, time, access, meta, scale, sendValues]);

  const onCommitText = useCallback((raw: string): boolean => {
    const writes: Array<{ nodeId: string; value: number }> = [];
    for (const id of nodeIds) {
      const cur = valueOf(id, prop, time, access);
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
  const exists = layer !== undefined;
  const label = labelOverride ?? meta.label;
  const nav = exists ? navigatorFor(mirror, nodeIds, prop, time) : NO_NAV;
  const seek = (t: number): void => {
    useProjectStore.getState().actions.setTime(t, Math.round(t * fps));
  };
  const expr = exists ? trackExpressionOf(mirror, nodeId, prop) : null;
  const hasExpr = expr !== null;
  const exprEnabled = expr?.enabled === true;
  const exprError = exprEnabled && expr!.error !== '' ? expr!.error : null;
  // The modifier stack record (`layer/modifiers`) and the pins (`LayerInfo.pinned`), from the mirror.
  const hasStack = exists && mirrorModifierStack(mirror, nodeId, prop) !== null;
  const pinned = exists && layer!.pinned.includes(prop);
  const resetValue = meta.resettable && typeof meta.defaultValue === 'number' ? meta.defaultValue : undefined;
  const hint = nodeIds.length > 1 && agg.present < nodeIds.length
    ? `${agg.present} of ${nodeIds.length}`
    : undefined;

  // The lane draws the PRIMARY layer's keyframes on the comp axis.
  const laneTimes = exists && showLane && agg.animated ? trackKeyTimes(mirror, nodeId, prop) : null;

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
    const name = mirror.layer(target.nodeId)?.name;
    if (!name) return;
    const src = whipExpression(name, target.prop ?? prop);
    linkExpressions(`Link ${label}`, nodeIds.map((id) => ({ nodeId: id, prop, src })));
    setExprOpen(true);
  };

  const toggleExpression = (): void => {
    // No expression yet: ADD one — AE's default `value`, one undo step — and open it.
    if (!hasExpr) {
      const fresh = nodeIds.filter((id) => trackExpressionOf(mirror, id, prop) === null);
      // A member of an unseparated vector (X of Position) is its own per-dimension
      // expression (`setExpression` with `member`).
      linkExpressions(fresh.length === 1 ? 'Add Expression' : 'Add Expressions', fresh.map((id) => ({ nodeId: id, prop, src: DEFAULT_EXPRESSION })));
      setExprOpen(true);
      return;
    }
    setExprOpen((v) => !v);
  };

  const menuItems = (): ContextMenuItem[] => engineRowMenuItems({
    nodeId,
    prop,
    nodeIds,
    time,
    label,
    resetValue,
    setValue: (v) => writeAll(v * scale),
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

/** The engine addresses every member on every layer — the group's writes go through the API. */
function groupOnEngine(nodeIds: ReadonlyArray<string>, members: ReadonlyArray<GroupMember>): boolean {
  return allAddressable(nodeIds, members.map((m) => m.prop));
}

/**
 * Set / link expressions as ONE undo step — a whole property's, or one
 * dimension's of an unseparated vector (`setExpression` `member`: the X field
 * of Position carries its own expression, as the document stores it).
 * Refused (a toast) when a pair is not an engine property.
 */
export function linkExpressions(label: string, list: ReadonlyArray<{ nodeId: string; prop: string; src: string }>): void {
  const cmds = expressionCommands(list.map((x) => ({ nodeId: x.nodeId, track: x.prop, source: x.src })));
  if (cmds) void edit(label, cmds);
  else reportUnaddressed(list[0]?.nodeId ?? '', [...new Set(list.map((x) => x.prop))], label);
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
  const mirror = documentMirror();
  const ids = nodeIds.filter((id) => mirror.hasLayer(id));
  if (ids.length === 0 || members.length === 0) return;
  const anyAnimated = ids.some((id) => members.some((m) => isTrackAnimated(mirror, id, m.prop)));
  const label = anyAnimated ? `Remove ${groupLabel} animation` : `Animate ${groupLabel}`;
  if (groupOnEngine(ids, members)) {
    void edit(label, stopwatchCommands(ids, members.map((m) => m.prop), compTime));
    return;
  }
  // A property the catalog does not list yet (a plugin panel's param before
  // its panel exists) cannot be animated yet: its own builder seeds it and
  // starts the stopwatch (`access.engine`, pluginParamEdits.ts).
  const own = members.map((m) => m.access?.engine).filter((e) => e !== undefined);
  if (!anyAnimated && own.length === members.length) {
    void edit(label, own[0]!.stopwatchOn(ids, compTime));
    return;
  }
  reportUnaddressed(ids[0]!, members.map((m) => m.prop), label);
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
  return groupNavigatorFor(documentMirror(), nodeIds, props, compTime);
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
  const mirror = documentMirror();
  // Only the ANIMATED layers matter, and an animated track is always a catalog
  // property — a layer whose member is not addressable has no key to toggle.
  const animatedIds = nodeIds.filter((id) => props.some((p) => isTrackAnimated(mirror, id, p)));
  if (animatedIds.length === 0 || !groupOnEngine(animatedIds, members)) return;
  const { atKeyframe } = groupNavigatorState(animatedIds, props, compTime);
  const label = atKeyframe ? `Remove ${groupLabel} keyframe` : `Add ${groupLabel} keyframe`;
  void keyToggleCommands(animatedIds, props, compTime).then((cmds) => edit(label, cmds));
}
