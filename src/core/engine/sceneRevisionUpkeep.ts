/**
 * Keep the TypeScript engine's scene revision moving on keyframe edits.
 *
 * The TS engine's own consumers — the in-page renderer's snapshot cache, the
 * viewport shell, the timeline tracks the legacy writers still feed — key on
 * the scene revision (`bumpScene`), and an animation edit (`AnimationChanged`)
 * does not bump it by itself. That is upkeep OF the engine, not a UI read: the
 * panels re-render from the document mirror's events (docs/B4_MIRROR.md). It
 * moved here from the editor shell (Providers.tsx) and leaves with the TS
 * engine (D1), like the legacy timeline sync (LocalEngine.attachBus) and
 * `expressionProviders.ts`.
 *
 * Media decode / upload repaints arrive on the same event at the source's frame
 * rate and are NOT edits: bumping the scene for each one ran a full scene-graph
 * walk, content re-hash and React reconcile per decoded video frame. The
 * viewport still repaints for them through its own render loop.
 */

import { getEventBus } from '@core/events/EventBus';
import { isMediaDecodeRepaint } from '@core/engine/mediaRepaint';
import { bumpScene } from '@stores/sceneStore';

/** Subscribe; returns the unsubscribe. */
export function installSceneRevisionUpkeep(): () => void {
  const sub = getEventBus().on('AnimationChanged', (payload) => {
    if (isMediaDecodeRepaint(payload)) return;
    bumpScene();
  });
  return () => sub.dispose();
}
