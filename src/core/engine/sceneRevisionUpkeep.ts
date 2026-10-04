/**
 * Keep the page's scene revision moving on view-only repaint signals.
 *
 * The page-side `AnimationChanged` bus event no longer carries document edits
 * (the C++ engine owns the document; panels re-render from the document
 * mirror's events, docs/B4_MIRROR.md). What still emits it is page state that
 * changes the picture without changing the document — colour management and
 * the viewer LUT — and consumers keyed on the scene revision (`bumpScene`) must
 * repaint for those.
 *
 * Media decode / upload repaints arrive on the same event at the source's frame
 * rate and are NOT edits: bumping the scene for each one would re-render every
 * revision consumer per decoded frame. The viewport repaints for them through
 * its own render loop.
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
