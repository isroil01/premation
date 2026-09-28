/**
 * The multicam angle cut through the engine API (B4 round 5): hold-keyframe
 * every angle's Opacity at the playhead so only the chosen angle is visible
 * from there to the next cut — ONE `addKeyframes`, one undo entry. The angles
 * come from the document mirror (`mirrorMulticamAngles`: the active
 * composition's layers tagged `multicamAngle`).
 */

import type { KeyframeInsert } from '@motion/engine-api';
import { edit } from '@core/engine/uiEdits';
import { mirrorMulticamAngles, type MulticamAngle } from '@core/mirror/multicam';
import { documentMirror } from '@stores/documentMirror';
import { getTime } from '@stores/playbackClockStore';
import { activeCompIdNow } from '@hooks/useMirror';
import { trackWrites } from '@layout/Inspector/inspectorEdits';

/** The active composition's multicam angles, by angle number. */
export function activeMulticamAngles(): MulticamAngle[] {
  return mirrorMulticamAngles(documentMirror(), activeCompIdNow() ?? '');
}

/**
 * Cut to `angle` (1-based) at `seconds` (default: the playhead): Opacity 100
 * on that angle, 0 on the others, as hold keys. Resolves false when there is
 * no such angle or the engine refused (toasted by `edit`).
 */
export async function switchMulticamAngleEdit(
  angle: number,
  angles: ReadonlyArray<Pick<MulticamAngle, 'id' | 'angle'>> = activeMulticamAngles(),
  seconds: number = getTime(),
): Promise<boolean> {
  const target = angles.find((a) => a.angle === angle);
  if (!target) return false;
  const keys: KeyframeInsert[] = [];
  for (const a of angles) {
    for (const w of trackWrites(a.id, { opacity: a.id === target.id ? 100 : 0 }, seconds)) {
      keys.push({ prop: w.prop, time: w.time!, value: w.value, easing: 'hold', spatialIn: [], spatialOut: [] });
    }
  }
  if (keys.length === 0) return false;
  const res = await edit(`Multicam cut → angle ${angle}`, { type: 'addKeyframes', keys });
  return res.ok;
}
