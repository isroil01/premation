/**
 * One keyframeable paint scalar — a ValueField plus a keyframe toggle — for
 * the SELECTION.
 *
 * Started as the gradient-geometry row (angle / centre / radius) and was WIDENED
 * rather than copied when stroke dash offset needed the same control. Every
 * property it drives shares one contract: a scalar engine track that
 * `buildSnapshot` samples by name, with label / unit / range / step read from
 * the property registry — so this row and the timeline row for the same track
 * cannot disagree about what the number means.
 *
 * B3z: every write goes through the engine API (docs/B3_PATTERNS.md §3). The
 * track is a catalog property on each layer — a stroke parameter's static value
 * lives in its stroke stack entry, a gradient's inside the paint, a corner
 * radius on the Style (latentPropSpecs.ts makes the unstored ones
 * addressable) — so a field write is `valueCommands` (a key at the playhead
 * where animated or under auto-keyframe, else the static value), a scrub is
 * ONE gesture of absolute values, and the stopwatch is `setAnimated`.
 *
 * Multi-selection (2026-09-04): the row reads `prop` across every selected
 * layer through the caller's `access.read` (a per-node static read), shows `—`
 * where they disagree, writes every layer that has the value on a typed
 * number, offsets every layer on a drag. A layer whose `access.read` answers
 * `undefined` has no such value and is left alone.
 *
 * `valuesFor` lets one field write several tracks of the same layer in the
 * same command (the linked corner radius writes the uniform radius and the
 * four corners); `staticCommands` replaces the STATIC write of a layer whose
 * track is not animated (a stroke's Taper / Wave at identity is a whole-stack
 * write that seeds the ramp, StrokeRows.tsx).
 *
 * `scale` converts between the display unit and the engine value (e.g. % ↔ 0..1).
 */

import { useMemo, useRef } from 'react';
import type { Command } from '@motion/engine-api';
import { ValueField } from '@components/ValueField';
import { PropertyRow } from '@components/PropertyRow';
import { useTrackNavigator } from '../AnimToggle';
import { applyValueExpression } from '@utils/evalMath';
import type { PropertyAccess } from '@core/inspector/multiSelection';
import { isTrackAnimated, readTrack, type MultiValue } from '@core/mirror/selection';
import { paintPropertyMeta } from '@core/mirror/paintFields';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorTrackWatch } from '@hooks/useMirror';
import { useThrottledTime } from '@stores/playbackClockStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useInspectorHosted, useInspectorSelection } from '../inspectorSelection';
import { useEngineEdit } from '../useEngineEdit';
import { stopwatchCommands, valueCommands } from '../inspectorEdits';

export type PaintProp =
  | 'fillAngle' | 'fillCenterX' | 'fillCenterY' | 'fillRadius' | 'strokeWidth' | 'strokeDashOffset'
  | 'strokeAngle' | 'strokeCenterX' | 'strokeCenterY' | 'strokeRadius'
  | 'cornerRadius' | 'cornerRadiusTL' | 'cornerRadiusTR' | 'cornerRadiusBR' | 'cornerRadiusBL'
  | 'strokeTaperStartWidth' | 'strokeTaperEndWidth'
  | 'strokeTaperStartLength' | 'strokeTaperEndLength'
  | 'strokeTaperStartEase' | 'strokeTaperEndEase'
  | 'strokeWaveAmount' | 'strokeWaveWavelength' | 'strokeWavePhase';

/** The linked corner radius writes every corner track the renderer reads. */
const CORNER_TRACKS: ReadonlyArray<string> = [
  'cornerRadius', 'cornerRadiusTL', 'cornerRadiusTR', 'cornerRadiusBR', 'cornerRadiusBL',
];

/**
 * One layer's value of `prop` at comp time `time`, in stored units — from the
 * document MIRROR (B4; the twin of `readPropertyValue`, as in
 * useMultiPropertyField.ts): the caller's static `access.read` (a paint value
 * inside the fill / stroke stack, read from the mirror's json field) unless the
 * track is keyframed, then the mirror's value at `time`.
 */
function valueOf(nodeId: string, prop: string, time: number, access: PropertyAccess): number | undefined {
  const m = documentMirror();
  if (!m.layer(nodeId)) return undefined;
  if (access.read && !isTrackAnimated(m, nodeId, prop)) return access.read(nodeId);
  return readTrack(m, nodeId, prop, time);
}

/** The selection's aggregate (mirror twin of `aggregateProperty`). */
function aggregateOf(nodeIds: ReadonlyArray<string>, prop: string, time: number, access: PropertyAccess): MultiValue {
  const m = documentMirror();
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
  const value = values[0] ?? 0;
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
function startsOf(nodeIds: ReadonlyArray<string>, prop: string, time: number, access: PropertyAccess): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of nodeIds) {
    const v = valueOf(id, prop, time, access);
    if (v !== undefined) out.set(id, v);
  }
  return out;
}

export interface AnimatablePaintRowProps {
  /** The PRIMARY layer; the selection comes from context. */
  nodeId: string;
  /**
   * A `PaintProp`, or any registered track path — every stroke's parameters
   * (`stroke.<i>.<param>`, see `strokeTracks.ts`) ride this same row.
   */
  prop: PaintProp | (string & {});
  /**
   * Decimals SHOWN. Unset keeps the historical whole-number display; Miter
   * Limit and a wave's cycle count set 1, where 1.5 is a different value from 2.
   */
  precision?: number;
  /** Overrides the registry label — the panel shows "Angle" under a Fill
   *  heading where the timeline needs the unambiguous "Fill Angle". */
  label?: string;
  /**
   * Per-node static READ of the PAINT value (engine units). `read` answering
   * `undefined` means that layer has no such value.
   */
  access: PropertyAccess;
  /** The track(s) one write sets on a layer (stored units); default `{ [prop]: value }`. */
  valuesFor?: (nodeId: string, value: number) => Record<string, number>;
  /**
   * A layer's STATIC write (its tracks not animated, no auto-keyframe) as
   * commands; `null` = the ordinary static write.
   */
  staticCommands?: (nodeId: string, value: number) => Command[] | null;
  /** The tracks the stopwatch / navigator govern; default: `prop` (the corner radius: all five). */
  tracks?: ReadonlyArray<string>;
}

export function AnimatablePaintRow({
  nodeId,
  prop,
  label: labelOverride,
  access,
  precision,
  valuesFor,
  staticCommands,
  tracks,
}: AnimatablePaintRowProps): JSX.Element {
  const nodeIds = useInspectorSelection(nodeId);
  const tracked: ReadonlyArray<string> = useMemo(
    () => tracks ?? (prop === 'cornerRadius' ? CORNER_TRACKS : [prop]),
    [tracks, prop],
  );
  // B4: wakes on the tracks' infos / keys / values and each selected layer's
  // tree (a stroke-stack or paint json edit is a property change on the layer).
  const rev = useMirrorTrackWatch(nodeIds, tracked);
  const time = useThrottledTime();
  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);
  const starts = useRef<Map<string, number>>(new Map());
  const hosted = useInspectorHosted();
  const e = useEngineEdit();

  // Label, unit, range, step and the stored→displayed scale all come from the
  // property registry, so this row and the timeline row for the same track
  // cannot disagree about what the number means.
  const mirror = documentMirror();
  const meta = paintPropertyMeta(mirror, nodeId, prop);
  const label = labelOverride ?? meta.label;
  const unit = meta.unit;
  const scale = meta.displayScale ?? 1;
  const min = meta.min !== undefined ? meta.min * scale : undefined;
  const max = meta.max !== undefined ? meta.max * scale : undefined;

  const agg = useMemo(
    () => aggregateOf(nodeIds, prop, time, access),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mirror-watch driven (`rev`)
    [nodeIds, prop, time, access, rev],
  );
  const animated = nodeIds.some((id) => tracked.some((p) => isTrackAnimated(mirror, id, p)));
  // The same stopwatch + navigator wiring `AnimToggle` drew, now laid out by
  // `PropertyRow` so this row shares the inspector grid with Transform's rows.
  const navigator = useTrackNavigator(nodeId, tracked, label);
  const clampDisplay = (v: number): number => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));

  /** Per-node engine values → one command list (keys where animated, else static). */
  const commandsFor = (writes: ReadonlyArray<{ nodeId: string; value: number }>): Command[] => {
    const out: Command[] = [];
    const entries: Array<{ nodeId: string; values: Record<string, number> }> = [];
    for (const w of writes) {
      const values = valuesFor ? valuesFor(w.nodeId, w.value) : { [prop]: w.value };
      const keyed = autoKeyframe || Object.keys(values).some((t) => isTrackAnimated(documentMirror(), w.nodeId, t));
      const custom = !keyed && staticCommands ? staticCommands(w.nodeId, w.value) : null;
      if (custom) out.push(...custom);
      else entries.push({ nodeId: w.nodeId, values });
    }
    return [...out, ...valueCommands(entries, { seconds: time, autoKeyframe })];
  };
  const commit = (writes: ReadonlyArray<{ nodeId: string; value: number }>): void => {
    e.send(`Set ${label}`, commandsFor(writes));
  };

  const onChange = (display: number): void => {
    commit(agg.nodeIds.map((id) => ({ nodeId: id, value: display / scale })));
  };

  const scrub = e.scrub(`Set ${label}`);
  const onScrubStart = (): void => {
    starts.current = startsOf(nodeIds, prop, time, access);
    scrub.onScrubStart();
  };

  const onRelative = (delta: number, cumulative: boolean): void => {
    // Absolute values from the scrub's start (a gesture is latest-wins).
    const from = cumulative ? starts.current : startsOf(nodeIds, prop, time, access);
    const writes: Array<{ nodeId: string; value: number }> = [];
    for (const [id, start] of from) writes.push({ nodeId: id, value: clampDisplay(start * scale + delta) / scale });
    commit(writes);
  };

  const onCommitText = (raw: string): boolean => {
    const writes: Array<{ nodeId: string; value: number }> = [];
    for (const id of agg.nodeIds) {
      const current = valueOf(id, prop, time, access);
      if (current === undefined) continue;
      const next = applyValueExpression(current * scale, raw);
      if (next === null) return false;
      writes.push({ nodeId: id, value: clampDisplay(next) / scale });
    }
    if (writes.length === 0) return false;
    commit(writes);
    return true;
  };

  return (
    <PropertyRow
      label={label}
      layout={hosted ? 'inspector' : undefined}
      compact
      animated={animated}
      mixed={agg.mixed}
      hint={nodeIds.length > 1 && agg.present < nodeIds.length ? `${agg.present} of ${nodeIds.length}` : undefined}
      onStopwatch={() => e.send(animated ? `Remove ${label} animation` : `Animate ${label}`, stopwatchCommands(agg.nodeIds.length > 0 ? agg.nodeIds : nodeIds, tracked, time))}
      navigator={navigator}
    >
      <ValueField
        value={precision !== undefined
          ? Number((agg.value * scale).toFixed(precision))
          : Math.round(agg.value * scale)}
        mixed={agg.mixed}
        unit={unit}
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        step={meta.step * scale}
        precision={precision ?? meta.precision}
        onChange={(v) => onChange(Number(v))}
        onScrubStart={onScrubStart}
        onScrubEnd={scrub.onScrubEnd}
        onRelative={onRelative}
        onCommitText={onCommitText}
        aria-label={label}
      />
    </PropertyRow>
  );
}

export default AnimatablePaintRow;
