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
import { documentMirror } from '@stores/documentMirror';
import { useActiveCompFps, useMirrorTrackWatch } from '@hooks/useMirror';
import { isTrackAnimated, navigatorFor, type MirrorRead, type NavState } from '@core/mirror/selection';
import { edit } from '@core/engine/uiEdits';
import { allAddressable, keyToggleCommands } from './inspectorEdits';

export type TrackNavigator = Omit<KeyframeNavigatorProps, 'label'>;

/**
 * The navigator over ONE layer's `tracks` at comp time `seconds`, from the
 * mirror (the twin of `trackNavigatorState`): prev / next are the nearest keys
 * across every animated track, the diamond is lit when EVERY animated track
 * has a key at the playhead.
 */
function trackNavigatorOf(m: MirrorRead, nodeId: string, tracks: ReadonlyArray<string>, seconds: number): NavState {
  const out: NavState = { hasPrev: false, hasNext: false, atKeyframe: false, prevT: null, nextT: null };
  let animated = 0;
  let at = 0;
  for (const p of tracks) {
    if (!isTrackAnimated(m, nodeId, p)) continue;
    animated += 1;
    const n = navigatorFor(m, [nodeId], p, seconds);
    if (n.atKeyframe) at += 1;
    if (n.hasPrev) out.hasPrev = true;
    if (n.hasNext) out.hasNext = true;
    if (n.prevT !== null && (out.prevT === null || n.prevT > out.prevT)) out.prevT = n.prevT;
    if (n.nextT !== null && (out.nextT === null || n.nextT < out.nextT)) out.nextT = n.nextT;
  }
  out.atKeyframe = animated > 0 && at === animated;
  return out;
}

/**
 * Navigator wiring for `tracks` on `nodeId` at the playhead. `values` supplies
 * the current per-track values for the ◆ add (the numbers the row displays);
 * omitted, the track's own sample at the playhead is used.
 */
export function useTrackNavigator(
  nodeId: string,
  tracks: ReadonlyArray<string>,
  label: string,
  // Kept for callers: the engine's added key holds the evaluated value, which is what the row displays.
  _values?: () => ReadonlyArray<number | undefined>,
): TrackNavigator {
  const time = useActiveWorkspace()?.time ?? 0;
  const fps = useActiveCompFps();
  // B4: wake on these tracks' keys / info on this layer only.
  useMirrorTrackWatch([nodeId], tracks);
  const nav = trackNavigatorOf(documentMirror(), nodeId, tracks, time);
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
      // always in the engine's catalog. A node that is not a layer of a
      // composition has no API address and no keyframes to toggle here (B3z).
      const m = documentMirror();
      const live = tracks.filter((p) => isTrackAnimated(m, nodeId, p));
      if (live.length === 0 || !allAddressable([nodeId], live)) return;
      const label2 = nav.atKeyframe ? `Remove ${label} keyframe` : `Add ${label} keyframe`;
      void keyToggleCommands([nodeId], live, time).then((cmds) => edit(label2, cmds));
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
