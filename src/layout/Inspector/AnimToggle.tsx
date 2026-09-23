/**
 * AnimToggle — the stopwatch AND the keyframe navigator (◀ ◆ ▶) for a
 * single-node animatable row that is not laid out as a `PropertyRow`.
 *
 * Before this, a dozen inspector rows (camera, light, effect colours, morph
 * targets, path operators, particles, time remap, text animators, fill and
 * stroke colours) drew a bare checkbox: it could start a track and stop it,
 * and that was the whole keyframing UI. A second keyframe only appeared if
 * the value changed at another time, so a hold — the same value later — and
 * stepping between keyframes were impossible from those rows. The Transform
 * rows had all of it through `PropertyRow`; this puts the same two controls,
 * with the same glyphs, on every other row.
 *
 * `useTrackNavigator` is the hook half, for rows that already render a
 * `PropertyRow` and only need its `navigator` prop.
 */

import { useCallback } from 'react';
import { StopwatchButton, KeyframeNavigator, type KeyframeNavigatorProps } from '@components/PropertyRow';
import { useActiveWorkspace, useProjectStore } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useAnimationRevision } from '@hooks/useAnimationRevision';
import { trackNavigatorState, toggleKeyframeAtPlayhead } from '@core/inspector/keyframeNavigator';
import { defaultAnimation } from '@motion/animation';
import { edit } from '@core/engine/uiEdits';
import { allAddressable, keyToggleCommands } from './inspectorEdits';

export type TrackNavigator = Omit<KeyframeNavigatorProps, 'label'>;

/**
 * Navigator wiring for `tracks` on `nodeId` at the playhead. `values` supplies
 * the current per-track values for the ◆ add (the numbers the row displays);
 * omitted, the track's own sample at the playhead is used.
 */
export function useTrackNavigator(
  nodeId: string,
  tracks: ReadonlyArray<string>,
  label: string,
  values?: () => ReadonlyArray<number | undefined>,
): TrackNavigator {
  const time = useActiveWorkspace()?.time ?? 0;
  const fps = useCompositionStore((c) => c.fps) || 30;
  useAnimationRevision();
  const nav = trackNavigatorState(nodeId, tracks, time);
  const seek = useCallback((t: number): void => {
    useProjectStore.getState().actions.setTime(t, Math.round(t * fps));
  }, [fps]);
  return {
    hasPrev: nav.hasPrev,
    hasNext: nav.hasNext,
    atKeyframe: nav.atKeyframe,
    onPrev: () => { if (nav.prevT !== null) seek(nav.prevT); },
    onNext: () => { if (nav.nextT !== null) seek(nav.nextT); },
    onToggleKeyframe: () => {
      // The diamond acts on the ANIMATED tracks only; an animated track is
      // always in the engine's catalog, so this is the API path in practice.
      const live = tracks.filter((p) => defaultAnimation.isAnimated(nodeId, p));
      if (live.length > 0 && allAddressable([nodeId], live)) {
        const label2 = nav.atKeyframe ? `Remove ${label} keyframe` : `Add ${label} keyframe`;
        void keyToggleCommands([nodeId], live, time).then((cmds) => edit(label2, cmds));
        return;
      }
      // B3-legacy: engine gap — a track the catalog cannot address (a node that is not a layer of a composition).
      toggleKeyframeAtPlayhead(nodeId, tracks, time, label, values);
    },
  };
}

export interface AnimToggleProps {
  nodeId: string;
  /** The track(s) this control governs — one prop, or a colour's four channels. */
  tracks: ReadonlyArray<string>;
  label: string;
  animated: boolean;
  /** The stopwatch: start (first keyframe at the playhead) or stop (remove tracks). */
  onToggle: () => void;
  /** Current per-track values for an added keyframe; defaults to the sampled value. */
  values?: () => ReadonlyArray<number | undefined>;
  className?: string;
}

export function AnimToggle({ nodeId, tracks = [], label, animated, onToggle, values, className }: AnimToggleProps): JSX.Element {
  const nav = useTrackNavigator(nodeId, tracks, label, values);
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
      <StopwatchButton animated={animated} label={label} onToggle={onToggle} />
      {animated && <KeyframeNavigator label={label} {...nav} />}
    </span>
  );
}
