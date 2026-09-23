/**
 * One keyframeable paint scalar — a ValueField plus a keyframe toggle — for
 * the SELECTION.
 *
 * Started as the gradient-geometry row (angle / centre / radius) and was WIDENED
 * rather than copied when stroke dash offset needed the same control. Every
 * property it drives shares one contract: a scalar engine track that
 * `buildSnapshot` samples by name, with label / unit / range / step read from
 * the property registry — so this row and the timeline row for the same track
 * cannot disagree about what the number means. A second component would have
 * been a second place for that agreement to break (§2·0).
 *
 * Multi-selection (2026-09-04): the row reads `prop` across every selected
 * layer through the caller's `access` (a per-node static read and write —
 * stroke width lives inside the paint stack, which the property-value seam
 * cannot see), shows `—` where they disagree, writes every layer that has the
 * value on a typed number, offsets every layer on a drag, and records one undo
 * entry per gesture (`core/inspector/multiSelection.ts`). A layer whose
 * `access.read` answers `undefined` has no such value and is left alone.
 *
 * `cornerRadius` is the one property that is five tracks — the uniform radius
 * and the four corners — so its keyframes land on every track the renderer
 * samples, exactly as the single-layer row always wrote them.
 *
 * `scale` converts between the display unit and the engine value (e.g. % ↔ 0..1).
 * Dash offset is 1:1 — both sides are layer-local px of arc length.
 */

import { useMemo, useRef } from 'react';
import { ValueField } from '@components/ValueField';
import { PropertyRow } from '@components/PropertyRow';
import { useTrackNavigator } from '../AnimToggle';
import { defaultAnimation } from '@motion/animation';
import { applyValueExpression } from '@utils/evalMath';
import { resolvePropertyMeta } from '@core/inspector/propertyMeta';
import { useNodesRevision } from '@hooks/useNodeRevision';
import {
  aggregateProperty,
  applyValues,
  readPropertyValue,
  snapshotStarts,
  toggleAnimationGroup,
  type PropertyAccess,
} from '@core/inspector/multiSelection';
import { useThrottledTime } from '@stores/playbackClockStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useInspectorHosted, useInspectorSelection } from '../inspectorSelection';

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
   * Per-node static read / write of the PAINT value (engine units). `read`
   * answering `undefined` means that layer has no such value.
   */
  access: PropertyAccess;
}

export function AnimatablePaintRow({
  nodeId,
  prop,
  label: labelOverride,
  access,
  precision,
}: AnimatablePaintRowProps): JSX.Element {
  const nodeIds = useInspectorSelection(nodeId);
  const rev = useNodesRevision(nodeIds);
  const time = useThrottledTime();
  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);
  const starts = useRef<Map<string, number>>(new Map());
  const hosted = useInspectorHosted();

  // Label, unit, range, step and the stored→displayed scale all come from the
  // property registry, so this row and the timeline row for the same track
  // cannot disagree about what the number means.
  const meta = resolvePropertyMeta(prop, nodeId);
  const label = labelOverride ?? meta.label;
  const unit = meta.unit;
  const scale = meta.displayScale ?? 1;
  const min = meta.min !== undefined ? meta.min * scale : undefined;
  const max = meta.max !== undefined ? meta.max * scale : undefined;
  const tracked: ReadonlyArray<string> = prop === 'cornerRadius' ? CORNER_TRACKS : [prop];

  const agg = useMemo(
    () => aggregateProperty(nodeIds, prop, time, access),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revision-driven
    [nodeIds, prop, time, access, rev],
  );
  const animated = nodeIds.some((id) => tracked.some((p) => defaultAnimation.isAnimated(id, p)));
  // The same stopwatch + navigator wiring `AnimToggle` drew, now laid out by
  // `PropertyRow` so this row shares the inspector grid with Transform's rows.
  const navigator = useTrackNavigator(nodeId, tracked, label);

  const opts = { compTime: time, autoKeyframe, ...access };
  const mergeKey = `paint:${prop}:${nodeIds.join(',')}:${time}`;
  const clampDisplay = (v: number): number => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));

  /** Per-node engine values → one undo entry, keyframed where animated. */
  const commit = (writes: ReadonlyArray<{ nodeId: string; value: number }>): void => {
    // B3-legacy: engine gap — fill/stroke paint (gradient geometry inside a paint object) has no API property; custom static writer.
    applyValues(prop, writes, { ...opts, mergeKey, label: `Set ${label}` });
    // The sibling tracks of a grouped property take keyframes only — the
    // primary prop's static write already covers every corner.
    for (const sibling of tracked.slice(1)) {
      if (autoKeyframe || nodeIds.some((id) => defaultAnimation.isAnimated(id, sibling))) {
        // B3-legacy: engine gap — fill/stroke paint (gradient geometry inside a paint object) has no API property; custom static writer.
        applyValues(sibling, writes, { ...opts, writeStatic: () => true, mergeKey, label: `Set ${label}` });
      }
    }
  };

  const onChange = (display: number): void => {
    commit(agg.nodeIds.map((id) => ({ nodeId: id, value: display / scale })));
  };

  const onScrubStart = (): void => {
    starts.current = snapshotStarts(nodeIds, prop, time, access);
  };

  const onRelative = (delta: number, cumulative: boolean): void => {
    const from = cumulative ? starts.current : snapshotStarts(nodeIds, prop, time, access);
    const writes: Array<{ nodeId: string; value: number }> = [];
    for (const [id, start] of from) writes.push({ nodeId: id, value: clampDisplay(start * scale + delta) / scale });
    commit(writes);
  };

  const onCommitText = (raw: string): boolean => {
    const writes: Array<{ nodeId: string; value: number }> = [];
    for (const id of agg.nodeIds) {
      const current = readPropertyValue(id, prop, time, access);
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
      // B3-legacy: engine gap — fill/stroke paint (gradient geometry inside a paint object) has no API property; custom static writer.
      onStopwatch={() => toggleAnimationGroup(nodeIds, tracked, time, label, access)}
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
        onRelative={onRelative}
        onCommitText={onCommitText}
        aria-label={label}
      />
    </PropertyRow>
  );
}

export default AnimatablePaintRow;
