/**
 * Track values EVALUATED at a composition time, asked of the engine (B4): what
 * a write composer needs when it derives the new value from the current one
 * (Centre Anchor Point, a reflow that holds the text still, …). The mirror's
 * `valueAt` answers the last known value for an animated property; a write
 * must not start from a stale one, so this asks `getPropertyValues` for the
 * properties the tracks live in and reads each member back in STORED units.
 */

import { engine } from '@core/engine/engineInstance';
import { compTime } from '@core/engine/propRefs';
import { storedNumber, trackRefIn } from '@core/mirror/trackIndex';
import { documentMirror, type MirrorTree } from './documentMirror';

/** The layer's property tree, fetched when the mirror has not loaded it yet. */
export async function mirrorTreeOf(id: string): Promise<MirrorTree | undefined> {
  const m = documentMirror();
  const now = m.tree(id);
  if (now) return now;
  await m.whenIdle();
  return m.tree(id);
}

/** Each track's evaluated value at comp `seconds` (stored units), undefined where the layer has no such track. */
export async function trackValuesAt(layer: string, tracks: ReadonlyArray<string>, seconds: number): Promise<Array<number | undefined>> {
  const tree = await mirrorTreeOf(layer);
  const refs = tracks.map((t) => trackRefIn(tree, t));
  const paths = [...new Set(refs.flatMap((r) => (r ? [r.path] : [])))];
  if (paths.length === 0) return tracks.map(() => undefined);
  const res = await engine().query({ type: 'getPropertyValues', props: paths.map((path) => ({ layer, path })), time: compTime(seconds), evaluated: true });
  const byPath = new Map((res.ok ? res.value.values : []).map((v) => [v.prop.path, v.value]));
  return refs.map((r) => (r ? storedNumber(r, byPath.get(r.path)) : undefined));
}
