/**
 * useKeyedParam — one keyframeable numeric parameter of ONE layer, written
 * through the engine API (B3): the value at the playhead for display, a write
 * that keys the property when it is animated (AE setValueAtTime) and sets the
 * static value otherwise, the stopwatch, and the scrub gesture (one undo entry
 * per drag). For rows whose track is always in the engine's property catalog
 * (path-operator and polystar params: `contents/<id>/<param>`).
 *
 * The display read is the document MIRROR's (B4): an animated track's value at
 * the playhead (comp time), else the static value the row passes in; the row
 * wakes on this track only.
 */

import { useActiveWorkspace } from '@stores/projectStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorTrackWatch } from '@hooks/useMirror';
import { isTrackAnimated, readTrack } from '@core/mirror/selection';
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
  useMirrorTrackWatch([nodeId], [track]);
  const m = documentMirror();
  const animated = isTrackAnimated(m, nodeId, track);
  const display = animated ? readTrack(m, nodeId, track, time) ?? staticValue : staticValue;
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
