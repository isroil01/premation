/**
 * Test helper: the keyframe SELECTION id (core/mirror/keySelection.ts) the
 * timeline gives the diamond of row `prop` at STORED time `t` on `layer` —
 * the engine key id there, with the member index on a member row (Scale X);
 * the merged Position row names the whole key. Read from the session's
 * document mirror, so call it after the fixture's keys have landed.
 *
 * A row with no key at `t` gets an id that names nothing (a stale selection).
 */

import { POSITION_PSEUDO_PROP } from '@motion/animation';
import { selectionKeyId, storedTimeOf, trackSelectionId } from '@core/mirror/keySelection';
import { memberKeysOf } from '@core/mirror/memberKeys';
import { documentMirror } from '@stores/documentMirror';

export function rowSelectionId(layer: string, prop: string, t: number): string {
  const m = documentMirror();
  const track = prop === POSITION_PSEUDO_PROP ? 'x' : prop;
  const k = memberKeysOf(m, layer, track, storedTimeOf(layer))?.keys.find((x) => Math.abs(x.t - t) < 1e-9);
  if (!k) return selectionKeyId(layer, `missing-${prop}-${t}`);
  return prop === POSITION_PSEUDO_PROP ? selectionKeyId(layer, k.key.id) : trackSelectionId(m, layer, prop, k.key.id);
}
