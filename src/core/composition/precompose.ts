/* eslint-disable no-restricted-syntax -- F11: the `.props` writes and the
 * `components.push` in this file are on a node literal from `makeNode` that has
 * not been added to the graph yet — the case the rule's own message calls
 * legitimate. Every write to a node the graph already owns goes through
 * `defaultSceneGraph.writeProp` / the SceneGraph API, as the rule intends.
 */
/**
 * Pre-compose — After Effects' Layer ▸ Pre-compose (Ctrl+Shift+C).
 *
 * The selected layers go into a NEW COMPOSITION — a real one: it has its own
 * settings record and scene root, it is listed with the project's comps, and it
 * can be placed again anywhere. A comp instance referencing it takes the
 * layers' place in the stack. That is what makes a precomp reusable ("edit it
 * once, every use updates"), and it is the difference from the older in-place
 * precomp GROUP (`precomposeSelected` in sceneInsert), which is still what the
 * AI facade builds.
 *
 * AE's two modes:
 *
 *   • MOVE ALL ATTRIBUTES — the layers move into the new comp with everything on
 *     them (transform, effects, masks, keyframes, clip timing). The new comp is
 *     the size of this one and the instance sits centred, so every layer lands
 *     exactly where it was on screen. "Adjust composition duration to the time
 *     span of the selected layers" trims the new comp to the layers' bars and
 *     slides them to its start; the instance's bar starts where they did.
 *   • LEAVE ALL ATTRIBUTES — one footage-like layer: only its CONTENT (the
 *     media, the vector, the solid's colour) moves into a comp the size of the
 *     layer; the layer itself stays, and becomes the comp instance. It keeps
 *     its id, so its stack slot, timeline bar, keyframes, effects, masks,
 *     matte and every reference to it survive untouched — the keys do not even
 *     change axis, because the bar they were sampled through is the same bar.
 *
 * Keyframes are keyed by node id and stored on the clip's own time axis
 * (`compToKeyframeTime`), so moving a node — and sliding its clip — carries its
 * animation without rewriting a single key.
 *
 * The whole operation is ONE undo step (`runAsOneHistoryEntry`): it touches the
 * scene, the comp table, two timelines and possibly the tabs, and no smaller
 * inverse describes that.
 */

import { useProjectStore } from '@stores/projectStore';

export type PrecomposeMode = 'leave' | 'move';

export interface PrecomposeOptions {
  /** Name of the new composition — and of the layer that replaces the selection. */
  name: string;
  mode: PrecomposeMode;
  /** Move mode only: size the new comp's duration to the selected layers' bars. */
  adjustDuration: boolean;
  /** Open the new composition afterwards (AE's "Open New Composition"). */
  openNew: boolean;
  /**
   * Engine API (src/core/engine): the composition to precompose in (default:
   * the active tab's), the ids to create (default: freshly minted), and
   * `quiet` — no selection change, no tab opened. The engine must be
   * deterministic and must not touch editor state.
   */
  hostId?: string;
  mint?: { compId: string; instanceId: string; contentId: string };
  quiet?: boolean;
}

export interface PrecomposeResult {
  compId: string;
  instanceId: string;
}

/** "Pre-comp N", the first N no composition is already called. */
export function defaultPrecompName(): string {
  const taken = new Set(Object.values(useProjectStore.getState().comps).map((c) => c.name.trim().toLowerCase()));
  let n = 1;
  while (taken.has(`pre-comp ${n}`)) n += 1;
  return `Pre-comp ${n}`;
}
