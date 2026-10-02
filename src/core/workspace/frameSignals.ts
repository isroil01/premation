/**
 * "The picture's inputs changed" — the document signals the viewport chrome
 * repaints on (handles, motion paths, guides drawn over the engine's frame).
 *
 * The engine draws the composition; the page's chrome still has to follow an
 * edit, a keyframe change or a moved clip bar, and it hears about them on the
 * app bus. `media` is a decode landing (a video frame arriving), which changes
 * pixels but not geometry.
 */

import { getEventBus } from '@core/events/EventBus';
import { isMediaDecodeRepaint } from '@core/engine/mediaRepaint';

export type DocumentFrameChange =
  /** A clip bar moved, trimmed or split (the Timeline's `DocumentChanged`). */
  | 'clips'
  /** A keyframe, an expression or a property value changed. */
  | 'animation'
  /** A media decode landed: pixels, not geometry. */
  | 'media'
  /** A node's own fields changed (name, switches, structure). */
  | 'node';

export function onDocumentFrameChanged(cb: (change: DocumentFrameChange) => void): () => void {
  const bus = getEventBus();
  const subs = [
    bus.on('DocumentChanged', (payload) => {
      if (payload?.source === 'timeline') cb('clips');
    }),
    bus.on('AnimationChanged', (payload) => cb(isMediaDecodeRepaint(payload) ? 'media' : 'animation')),
    bus.on('NodeUpdated', () => cb('node')),
  ];
  return () => {
    for (const s of subs) s.dispose();
  };
}
