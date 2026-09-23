/**
 * useKeyedParam — one keyframeable numeric parameter of ONE layer, written
 * through the engine API (B3): the value at the playhead for display, a write
 * that keys the property when it is animated (AE setValueAtTime) and sets the
 * static value otherwise, the stopwatch, and the scrub gesture (one undo entry
 * per drag). For rows whose track is always in the engine's property catalog
 * (path-operator and polystar params: `contents/<id>/<param>`).
 *
 * The display read stays direct (B4's mirror replaces it): `readPropertyValue`
 * samples an animated track on the layer's own keyframe axis, else reads the
 * static value the row passes in.
 */

import { useActiveWorkspace } from '@stores/projectStore';
import { defaultAnimation } from '@motion/animation';
import { readPropertyValue } from '@core/inspector/multiSelection';
import { scalarValueCommands, stopwatchCommands } from './inspectorEdits';
import { useEngineEdit } from './useEngineEdit';

export interface KeyedParam {
  animated: boolean;
  /** The value at the playhead. */
  display: number;
  /** Write a value (a key at the playhead when animated). */
  onChange: (v: number) => void;
  /** The stopwatch. */
  toggle: () => void;
  /** ValueField scrub props: a drag is one gesture. */
  scrub: { onScrubStart: () => void; onScrubEnd: () => void };
}

export function useKeyedParam(nodeId: string, track: string, label: string, staticValue: number, autoKeyframe = false): KeyedParam {
  const time = useActiveWorkspace()?.time ?? 0;
  const e = useEngineEdit();
  const animated = defaultAnimation.isAnimated(nodeId, track);
  const display = readPropertyValue(nodeId, track, time, { read: () => staticValue }) ?? staticValue;
  return {
    animated,
    display,
    onChange: (v) => {
      if (!Number.isFinite(v)) return;
      e.send(`Set ${label}`, scalarValueCommands(track, [{ nodeId, value: v }], { seconds: time, autoKeyframe }));
    },
    toggle: () => e.send(animated ? `Remove ${label} animation` : `Animate ${label}`, stopwatchCommands([nodeId], [track], time)),
    scrub: e.scrub(`Set ${label}`),
  };
}

export default useKeyedParam;
