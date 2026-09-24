/**
 * Keep the Timeline Engine's bars seeded for layers a legacy writer adds
 * around the engine API (the engine's own handlers sync themselves).
 *
 * WRITE-side upkeep of the TypeScript engine — the bars are where layer timing
 * lives until the controller moves into the engine — and never drives a
 * render: the timeline rows re-render from the document mirror's events
 * (docs/B4_MIRROR.md). Installed once by the editor shell (App.tsx); it moved
 * here from there so the UI no longer subscribes to scene-graph traffic itself.
 */

import { getEventBus } from '@core/events/EventBus';
import { getTimelineController } from '@core/timeline/TimelineController';

/** Subscribe; returns the unsubscribe. */
export function installLegacyTimelineSync(): () => void {
  const sub = getEventBus().on('SceneGraphChanged', () => {
    getTimelineController().syncFromScene();
  });
  return () => sub.dispose();
}
